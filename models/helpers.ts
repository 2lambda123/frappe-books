import { Fyo, t } from 'fyo';
import { Doc } from 'fyo/model/doc';
import { Action, ColumnConfig, DocStatus, RenderData } from 'fyo/model/types';
import { DateTime } from 'luxon';
import { Money } from 'pesa';
import { safeParseFloat } from 'utils/index';
import { Router } from 'vue-router';
import {
  AccountRootType,
  AccountRootTypeEnum,
} from './baseModels/Account/types';
import {
  Defaults,
  numberSeriesDefaultsMap,
} from './baseModels/Defaults/Defaults';
import { Invoice } from './baseModels/Invoice/Invoice';
import { StockMovement } from './inventory/StockMovement';
import { StockTransfer } from './inventory/StockTransfer';
import { InvoiceItem } from './baseModels/InvoiceItem/InvoiceItem';
import { InvoiceStatus, ModelNameEnum } from './types';
import { DocValueMap } from 'fyo/core/types';

export function getInvoiceActions(
  fyo: Fyo,
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice
): Action[] {
  return [
    getMakePaymentAction(fyo),
    getMakeCreditNoteAction(fyo, schemaName),
    getMakeDebitNoteAction(fyo, schemaName),
    getMakeStockTransferAction(fyo, schemaName),
    getLedgerLinkAction(fyo),
  ];
}

export function getMakeStockTransferAction(
  fyo: Fyo,
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice
): Action {
  let label = fyo.t`Shipment`;
  if (schemaName === ModelNameEnum.PurchaseInvoice) {
    label = fyo.t`Purchase Receipt`;
  }

  return {
    label,
    group: fyo.t`Create`,
    condition: (doc: Doc) => doc.isSubmitted && !!doc.stockNotTransferred,
    action: async (doc: Doc) => {
      const transfer = await (doc as Invoice).getStockTransfer();
      if (!transfer) {
        return;
      }

      const { routeTo } = await import('src/utils/ui');
      const path = `/edit/${transfer.schemaName}/${transfer.name}`;
      await routeTo(path);
    },
  };
}

export function getMakePaymentAction(fyo: Fyo): Action {
  return {
    label: fyo.t`Payment`,
    group: fyo.t`Create`,
    condition: (doc: Doc) =>
      doc.isSubmitted &&
      !doc.isReturn &&
      !(doc.outstandingAmount as Money).isZero(),
    action: async (doc, router) => {
      const payment = (doc as Invoice).getPayment();
      if (!payment) {
        return;
      }

      const currentRoute = router.currentRoute.value.fullPath;
      payment.once('afterSync', async () => {
        await payment.submit();
        await doc.load();
        await router.push(currentRoute);
      });

      const hideFields = ['party', 'paymentType', 'for'];
      if (doc.schemaName === ModelNameEnum.SalesInvoice) {
        hideFields.push('account');
      } else {
        hideFields.push('paymentAccount');
      }

      await payment.runFormulas();
      const { openQuickEdit } = await import('src/utils/ui');
      await openQuickEdit({
        doc: payment,
        hideFields,
      });
    },
  };
}

export function getLedgerLinkAction(
  fyo: Fyo,
  isStock: boolean = false
): Action {
  let label = fyo.t`Accounting Entries`;
  let reportClassName: 'GeneralLedger' | 'StockLedger' = 'GeneralLedger';

  if (isStock) {
    label = fyo.t`Stock Entries`;
    reportClassName = 'StockLedger';
  }

  return {
    label,
    group: fyo.t`View`,
    condition: (doc: Doc) => doc.isSubmitted,
    action: async (doc: Doc, router: Router) => {
      const route = getLedgerLink(doc, reportClassName);
      router.push(route);
    },
  };
}

export function getLedgerLink(
  doc: Doc,
  reportClassName: 'GeneralLedger' | 'StockLedger'
) {
  return {
    name: 'Report',
    params: {
      reportClassName,
      defaultFilters: JSON.stringify({
        referenceType: doc.schemaName,
        referenceName: doc.name,
      }),
    },
  };
}

function getMakeCreditNoteAction(
  fyo: Fyo,
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice
): Action {
  return {
    label: fyo.t`Return / Credit Note`,
    group: fyo.t`Create`,
    condition: (doc: Doc) =>
      schemaName === ModelNameEnum.SalesInvoice &&
      doc.isSubmitted &&
      !doc.isReturn &&
      !doc.returnCompleted,
    action: async (doc: Doc) => {
      const salesInvoice = doc.getValidDict(true, true) as DocValueMap;
      const rawCreditNote = (await createReturnDoc(
        salesInvoice,
        ModelNameEnum.SalesInvoice,
        fyo
      )) as DocValueMap;

      const rawCreditNoteDoc = doc.fyo.doc.getNewDoc(
        doc.schemaName,
        rawCreditNote,
        true
      ) as Invoice;

      const { openEdit } = await import('src/utils/ui');
      await openEdit(rawCreditNoteDoc);
    },
  };
}
export async function updateReturnCompleteStatus(doc: Invoice) {
  if (!doc.isReturn || !doc.returnAgainst || !doc.items) {
    return;
  }

  for (const item of doc.items) {
    if (!item.item) {
      return;
    }

    const invoiceItem = await doc.fyo.db.getAll(`${doc.schemaName}Item`, {
      filters: {
        item: item.item,
        parent: doc.returnAgainst as string,
      },
      fields: ['quantity'],
    });

    if (!invoiceItem) {
      return;
    }

    const invoiceItemQty = (invoiceItem[0].quantity as number) ?? 0;

    const returnedItemQty = await doc.fyo.db.getInvoiceReturnedItemQty(
      doc.schemaName,
      item.item,
      doc.returnAgainst as string
    );
    if (returnedItemQty !== invoiceItemQty) {
      return;
    }
  }
  doc.fyo.db.update(doc.schemaName, {
    name: doc.returnAgainst,
    returnCompleted: true,
  });
}

function getMakeDebitNoteAction(
  fyo: Fyo,
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice
): Action {
  return {
    label: fyo.t`Return / Debit Note`,
    group: fyo.t`Create`,
    condition: (doc: Doc) =>
      schemaName === ModelNameEnum.PurchaseInvoice &&
      doc.isSubmitted &&
      !doc.isReturn &&
      !doc.returnCompleted,
    action: async (doc: Doc) => {
      const purchaseInvoice = doc.getValidDict(true, true) as DocValueMap;
      const rawDebitNote = (await createReturnDoc(
        purchaseInvoice,
        ModelNameEnum.PurchaseInvoice,
        fyo
      )) as DocValueMap;

      const rawDebitNoteDoc = doc.fyo.doc.getNewDoc(
        doc.schemaName,
        rawDebitNote,
        true
      ) as Invoice;

      const { openEdit } = await import('src/utils/ui');
      await openEdit(rawDebitNoteDoc);
    },
  };
}

export async function createReturnDoc(
  doc: DocValueMap,
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice,
  fyo: Fyo
): Promise<DocValueMap> {
  doc.isReturn = true;
  doc.returnAgainst = doc.name;
  doc.netTotal = (doc.netTotal as Money).neg();
  doc.baseGrandTotal = (doc.baseGrandTotal as Money).neg();
  doc.grandTotal = (doc.grandTotal as Money).neg();
  doc.outstandingAmount = 0;
  delete doc.name;

  for (const item of doc.items as InvoiceItem[]) {
    if (!item.item || !item.quantity) {
      continue;
    }

    const returnedQty =
      (await fyo.db.getInvoiceReturnedItemQty(
        schemaName,
        item.item,
        doc.returnAgainst as string
      )) ?? 0;

    delete item.name;
    item.quantity = -1 * safeParseFloat(item.quantity - returnedQty);
    item.transferQuantity = -1 * safeParseFloat(item.transferQuantity);
    item.amount = item.rate?.mul(item.quantity);
  }
  return doc;
}

export function getTransactionStatusColumn(): ColumnConfig {
  return {
    label: t`Status`,
    fieldname: 'status',
    fieldtype: 'Select',
    render(doc) {
      const status = getDocStatus(doc) as InvoiceStatus;
      const color = statusColor[status];
      const label = getStatusText(status);

      return {
        template: `<Badge class="text-xs" color="${color}">${label}</Badge>`,
      };
    },
  };
}

export const statusColor: Record<
  DocStatus | InvoiceStatus,
  string | undefined
> = {
  '': 'gray',
  Draft: 'gray',
  Unpaid: 'orange',
  Paid: 'green',
  Saved: 'gray',
  NotSaved: 'gray',
  Submitted: 'green',
  Cancelled: 'red',
  Return: 'gray',
  CreditNoteIssued: 'gray',
  DebitNoteIssued: 'gray',
  PartlyPaid: 'orange',
};

export function getStatusText(status: DocStatus | InvoiceStatus): string {
  switch (status) {
    case 'Draft':
      return t`Draft`;
    case 'Saved':
      return t`Saved`;
    case 'NotSaved':
      return t`Not Saved`;
    case 'Submitted':
      return t`Submitted`;
    case 'Cancelled':
      return t`Cancelled`;
    case 'Paid':
      return t`Paid`;
    case 'Unpaid':
      return t`Unpaid`;
    case 'Return':
      return t`Return`;
    case 'CreditNoteIssued':
      return t`Credit Note Issued`;
    case 'DebitNoteIssued':
      return t`Debit Note Issued`;
    case 'PartlyPaid':
      return t`Partly Paid`;
    default:
      return '';
  }
}

export function getDocStatus(
  doc?: RenderData | Doc
): DocStatus | InvoiceStatus {
  if (!doc) {
    return '';
  }

  if (doc.notInserted) {
    return 'Draft';
  }

  if (doc.dirty) {
    return 'NotSaved';
  }

  if (!doc.schema?.isSubmittable) {
    return 'Saved';
  }

  return getSubmittableDocStatus(doc);
}

function getSubmittableDocStatus(doc: RenderData | Doc) {
  if (
    [ModelNameEnum.SalesInvoice, ModelNameEnum.PurchaseInvoice].includes(
      doc.schema.name as ModelNameEnum
    )
  ) {
    return getInvoiceStatus(doc);
  }

  if (!!doc.submitted && !doc.cancelled) {
    return 'Submitted';
  }

  if (!!doc.submitted && !!doc.cancelled) {
    return 'Cancelled';
  }

  return 'Saved';
}

export function getInvoiceStatus(doc: RenderData | Doc): InvoiceStatus {
  if (
    doc.schema.name === ModelNameEnum.SalesInvoice &&
    doc.returnCompleted &&
    !doc.cancelled
  ) {
    return 'CreditNoteIssued';
  }

  if (
    doc.schema.name === ModelNameEnum.PurchaseInvoice &&
    doc.returnCompleted &&
    !doc.cancelled
  ) {
    return 'DebitNoteIssued';
  }

  if (doc.submitted && !doc.cancelled && doc.isReturn) {
    return 'Return';
  }

  if (
    doc.submitted &&
    !doc.cancelled &&
    (doc.outstandingAmount as Money).isZero()
  ) {
    return 'Paid';
  }

  if (
    doc.submitted &&
    !doc.cancelled &&
    (doc.outstandingAmount as Money) < (doc.grandTotal as Money)
  ) {
    return 'PartlyPaid';
  }

  if (
    doc.submitted &&
    !doc.cancelled &&
    (doc.outstandingAmount as Money).isPositive()
  ) {
    return 'Unpaid';
  }

  if (doc.cancelled) {
    return 'Cancelled';
  }

  return 'Saved';
}

export function getSerialNumberStatusColumn(): ColumnConfig {
  return {
    label: t`Status`,
    fieldname: 'status',
    fieldtype: 'Select',
    render(doc) {
      let status = doc.status;
      if (typeof status !== 'string') {
        status = 'Inactive';
      }

      const color = serialNumberStatusColor[status] ?? 'gray';
      const label = getSerialNumberStatusText(status);

      return {
        template: `<Badge class="text-xs" color="${color}">${label}</Badge>`,
      };
    },
  };
}

export const serialNumberStatusColor: Record<string, string | undefined> = {
  Inactive: 'gray',
  Active: 'green',
  Delivered: 'blue',
};

export function getSerialNumberStatusText(status: string): string {
  switch (status) {
    case 'Inactive':
      return t`Inactive`;
    case 'Active':
      return t`Active`;
    case 'Delivered':
      return t`Delivered`;
    default:
      return t`Inactive`;
  }
}

export async function getExchangeRate({
  fromCurrency,
  toCurrency,
  date,
}: {
  fromCurrency: string;
  toCurrency: string;
  date?: string;
}) {
  if (!fetch) {
    return 1;
  }

  if (!date) {
    date = DateTime.local().toISODate();
  }

  const cacheKey = `currencyExchangeRate:${date}:${fromCurrency}:${toCurrency}`;

  let exchangeRate = 0;
  if (localStorage) {
    exchangeRate = safeParseFloat(
      localStorage.getItem(cacheKey as string) as string
    );
  }

  if (exchangeRate && exchangeRate !== 1) {
    return exchangeRate;
  }

  try {
    const res = await fetch(
      `https://api.vatcomply.com/rates?date=${date}&base=${fromCurrency}&symbols=${toCurrency}`
    );
    const data = await res.json();
    exchangeRate = data.rates[toCurrency];
  } catch (error) {
    console.error(error);
    exchangeRate ??= 1;
  }

  if (localStorage) {
    localStorage.setItem(cacheKey, String(exchangeRate));
  }

  return exchangeRate;
}

export function isCredit(rootType: AccountRootType) {
  switch (rootType) {
    case AccountRootTypeEnum.Asset:
      return false;
    case AccountRootTypeEnum.Liability:
      return true;
    case AccountRootTypeEnum.Equity:
      return true;
    case AccountRootTypeEnum.Expense:
      return false;
    case AccountRootTypeEnum.Income:
      return true;
    default:
      return true;
  }
}

export function getNumberSeries(schemaName: string, fyo: Fyo) {
  const numberSeriesKey = numberSeriesDefaultsMap[schemaName];
  if (!numberSeriesKey) {
    return undefined;
  }

  const defaults = fyo.singles.Defaults as Defaults | undefined;
  const field = fyo.getField(schemaName, 'numberSeries');
  const value = defaults?.[numberSeriesKey] as string | undefined;
  return value ?? (field?.default as string | undefined);
}

export function getDocStatusListColumn(): ColumnConfig {
  return {
    label: t`Status`,
    fieldname: 'status',
    fieldtype: 'Select',
    render(doc) {
      const status = getDocStatus(doc);
      const color = statusColor[status] ?? 'gray';
      const label = getStatusText(status);

      return {
        template: `<Badge class="text-xs" color="${color}">${label}</Badge>`,
      };
    },
  };
}

type ModelsWithItems = Invoice | StockTransfer | StockMovement;
export async function addItem<M extends ModelsWithItems>(name: string, doc: M) {
  if (!doc.canEdit) {
    return;
  }

  const items = (doc.items ?? []) as NonNullable<M['items']>[number][];

  let item = items.find((i) => i.item === name);
  if (item) {
    const q = item.quantity ?? 0;
    await item.set('quantity', q + 1);
    return;
  }

  await doc.append('items');
  item = doc.items?.at(-1);
  if (!item) {
    return;
  }

  await item.set('item', name);
}

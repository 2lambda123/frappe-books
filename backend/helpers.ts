import { app } from 'electron';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { DatabaseMethod } from 'utils/db/types';
import { CUSTOM_EVENTS } from 'utils/messages';
import { PluginInfo } from 'utils/types';
import { KnexColumnType } from './database/types';

export const sqliteTypeMap: Record<string, KnexColumnType> = {
  AutoComplete: 'text',
  Currency: 'text',
  Int: 'integer',
  Float: 'float',
  Percent: 'float',
  Check: 'boolean',
  Code: 'text',
  Date: 'date',
  Datetime: 'datetime',
  Time: 'time',
  Text: 'text',
  Data: 'text',
  Link: 'text',
  DynamicLink: 'text',
  Password: 'text',
  Select: 'text',
  Attachment: 'text',
  AttachImage: 'text',
  Color: 'text',
  Blob: 'text', // base-64 encoded
};

export const SYSTEM = '__SYSTEM__';
export const validTypes = Object.keys(sqliteTypeMap);
export function getDefaultMetaFieldValueMap() {
  const now = new Date().toISOString();
  return {
    createdBy: SYSTEM,
    modifiedBy: SYSTEM,
    created: now,
    modified: now,
  };
}

export const databaseMethodSet: Set<DatabaseMethod> = new Set([
  'insert',
  'get',
  'getAll',
  'getSingleValues',
  'rename',
  'update',
  'delete',
  'deleteAll',
  'close',
  'exists',
]);

export function emitMainProcessError(
  error: unknown,
  more?: Record<string, unknown>
) {
  (
    process.emit as (
      event: string,
      error: unknown,
      more?: Record<string, unknown>
    ) => void
  )(CUSTOM_EVENTS.MAIN_PROCESS_ERROR, error, more);
}

export async function checkFileAccess(filePath: string, mode?: number) {
  mode ??= constants.W_OK;
  return await fs
    .access(filePath, mode)
    .then(() => true)
    .catch(() => false);
}

export async function unlinkIfExists(filePath: unknown) {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  const exists = await checkFileAccess(filePath);
  if (exists) {
    await fs.unlink(filePath);
    return true;
  }

  return false;
}

export function getPluginFolderNameFromInfo(
  { name, version }: PluginInfo,
  noVersion = false
) {
  const folderPrefix = name.replaceAll(' ', '');
  if (noVersion) {
    return folderPrefix;
  }

  return `${folderPrefix}-${version}`;
}

export function getAppPath(type: 'root' | 'backups' | 'plugins' = 'root') {
  /**
   * app will be undefined if this function is not running in electron
   */
  let root: string;
  if (process.env.NODE_ENV === 'development' || !app) {
    root = 'dbs';
  } else {
    root = app.getPath('documents');
  }

  if (type === 'root') {
    return path.join(root, 'Frappe Books');
  }

  return path.join(root, 'Frappe Books', type);
}

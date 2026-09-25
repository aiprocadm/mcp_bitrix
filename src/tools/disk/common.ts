/**
 * Общее для инструментов Диска (ТЗ §9.12, §8.5): нормализация объектов disk.*.getChildren/disk.file.get.
 * DOWNLOAD_URL (содержит auth/token) не выдаётся никогда; DETAIL_URL — только ссылка интерфейса
 * на хост портала без параметров запроса. Иначе ссылка отбрасывается.
 */
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, num } from '../shared.js';
import type { ToolContext } from '../types.js';

export interface DiskObject {
  id: number;
  name: string;
  type: 'file' | 'folder';
  storageId?: number | undefined;
  parentId?: number | undefined;
  size?: number | undefined;
  createTime?: string | undefined;
  updateTime?: string | undefined;
  createdBy?: number | undefined;
  updatedBy?: number | undefined;
  deleted: boolean;
  detailUrl?: string | undefined;
}

/** Ссылка интерфейса без секретов: тот же origin, что у портала, без query/fragment. */
export function safeDetailUrl(raw: unknown, portalOrigin: string): string | undefined {
  const s = asText(raw);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    const portal = new URL(portalOrigin);
    if (u.protocol !== 'https:' || u.host !== portal.host || u.search || u.hash || u.username || u.password)
      return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function normalizeDiskObject(
  o: Record<string, JsonValue>,
  portalOrigin: string,
): DiskObject | undefined {
  const id = idOf(o['ID']);
  const type = asText(o['TYPE']);
  if (id === undefined || (type !== 'file' && type !== 'folder')) return undefined;
  const detailUrl = safeDetailUrl(o['DETAIL_URL'], portalOrigin);
  const deletedType = asText(o['DELETED_TYPE']);
  return {
    id,
    name: asText(o['NAME']),
    type,
    ...(idOf(o['STORAGE_ID']) !== undefined ? { storageId: idOf(o['STORAGE_ID']) } : {}),
    ...(idOf(o['PARENT_ID']) !== undefined ? { parentId: idOf(o['PARENT_ID']) } : {}),
    ...(type === 'file' && num(o['SIZE']) !== undefined ? { size: num(o['SIZE']) } : {}),
    ...(asText(o['CREATE_TIME']) ? { createTime: asText(o['CREATE_TIME']) } : {}),
    ...(asText(o['UPDATE_TIME']) ? { updateTime: asText(o['UPDATE_TIME']) } : {}),
    ...(idOf(o['CREATED_BY']) !== undefined ? { createdBy: idOf(o['CREATED_BY']) } : {}),
    ...(idOf(o['UPDATED_BY']) !== undefined ? { updatedBy: idOf(o['UPDATED_BY']) } : {}),
    deleted: deletedType !== '' && deletedType !== '0',
    ...(detailUrl ? { detailUrl } : {}),
  };
}

/** Файл по ID (disk.file.get); нет/не файл → NOT_FOUND. */
export async function getFile(ctx: ToolContext, fileId: number): Promise<Record<string, JsonValue>> {
  const r = await ctx.bitrix.call(
    'legacy',
    'disk.file.get',
    { id: fileId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const f = isObj(r.result) ? r.result : undefined;
  if (!f || idOf(f['ID']) === undefined || asText(f['TYPE']) !== 'file') {
    throw new AppError('NOT_FOUND', `Файл #${String(fileId)} не найден или недоступен`, {
      field: 'fileId',
      method: 'disk.file.get',
      apiVersion: 'legacy',
    });
  }
  return f;
}

/** Хеш состояния файла: имя, размер, версия содержимого, дата изменения, папка, признак удаления. */
export function fileStateHash(f: Record<string, JsonValue>): string {
  return stateHash({
    id: asText(f['ID']),
    name: asText(f['NAME']),
    size: asText(f['SIZE']),
    version: asText(f['GLOBAL_CONTENT_VERSION']),
    updateTime: asText(f['UPDATE_TIME']),
    parentId: asText(f['PARENT_ID']),
    deletedType: asText(f['DELETED_TYPE']),
  });
}

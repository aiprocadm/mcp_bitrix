/**
 * Чтение Диска (ТЗ §9.12, §11 п.4): disk_storages_list, disk_children_list, disk_search_files.
 * Поиск — ограниченный обход папок через disk.storage.getChildren / disk.folder.getChildren по имени
 * в выбранной области (глобальный поиск не заявляется). Очередь обхода хранится в серверном курсоре,
 * привязанном к пользователю и параметрам; лимиты maxDepth ≤ 5 и maxVisited ≤ 500 честно отражаются в coverage.
 * DOWNLOAD_URL никогда не выдаётся и не сохраняется в курсоре.
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { isObj, legacyListPage, pageMeta, pageSizeOf, statefulPage, upstreamShapeError } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { normalizeDiskObject, type DiskObject } from './common.js';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const diskObjectOut = z.object({
  id: z.number(),
  name: z.string(),
  type: z.enum(['file', 'folder']),
  storageId: z.number().optional(),
  parentId: z.number().optional(),
  size: z.number().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  createdBy: z.number().optional(),
  updatedBy: z.number().optional(),
  deleted: z.boolean(),
  detailUrl: z.string().optional(),
});

function normalizeList(ctx: ToolContext, method: string) {
  return (result: JsonValue): JsonValue[] | undefined => {
    if (!Array.isArray(result)) return undefined;
    const origin = ctx.bitrix.auth.portalOrigin;
    return result.flatMap((o) => {
      const n = isObj(o) ? normalizeDiskObject(o, origin) : undefined;
      if (!n && isObj(o)) ctx.logger.debug({ method }, 'disk object skipped: unexpected shape');
      return n ? [n as unknown as JsonValue] : [];
    });
  };
}

// ---------- disk_storages_list ----------

export const diskStoragesListTool = defineTool({
  name: 'disk_storages_list',
  module: 'disk',
  title: 'Хранилища Диска',
  description:
    'Доступные текущему пользователю хранилища Диска Bitrix24 (disk.storage.getList): личные, общие документы компании, диски групп. ' +
    'Использовать, чтобы найти storageId и корневую папку (rootFolderId) перед disk_children_list или disk_search_files. ' +
    'entityType сужает список (user | common | group). Страница до 50, продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.enum(['user', 'common', 'group']).optional().describe('Тип владельца хранилища'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        code: z.string().optional(),
        entityType: z.string(),
        entityId: z.number().optional(),
        rootFolderId: z.number().optional(),
        moduleId: z.string().optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const filter = args.entityType ? { ENTITY_TYPE: args.entityType } : undefined;
    const page = await legacyListPage(ctx, {
      tool: 'disk_storages_list',
      method: 'disk.storage.getlist',
      params: filter ? { filter } : {},
      bindingParts: { entityType: args.entityType ?? null },
      pageSize,
      cursor: args.cursor,
      extract: (result) => {
        if (!Array.isArray(result)) return undefined;
        return result.flatMap((s) => {
          if (!isObj(s)) return [];
          const id = Number(s['ID']);
          if (!Number.isSafeInteger(id) || id <= 0) return [];
          const entityId = Number(s['ENTITY_ID']);
          const root = Number(s['ROOT_OBJECT_ID']);
          const code = typeof s['CODE'] === 'string' ? s['CODE'] : '';
          const moduleId = typeof s['MODULE_ID'] === 'string' ? s['MODULE_ID'] : '';
          return [
            {
              id,
              name: typeof s['NAME'] === 'string' ? s['NAME'] : '',
              ...(code ? { code } : {}),
              entityType: typeof s['ENTITY_TYPE'] === 'string' ? s['ENTITY_TYPE'] : '',
              ...(Number.isSafeInteger(entityId) && entityId > 0 ? { entityId } : {}),
              ...(Number.isSafeInteger(root) && root > 0 ? { rootFolderId: root } : {}),
              ...(moduleId ? { moduleId } : {}),
            },
          ];
        });
      },
    });
    return ok(
      { items: page.items, returnedCount: page.items.length },
      pageMeta(ctx, 'disk.storage.getlist', page),
    );
  },
});

// ---------- disk_children_list ----------

function exactlyOne(
  d: { storageId?: number | undefined; folderId?: number | undefined },
  c: z.RefinementCtx,
) {
  if ((d.storageId ? 1 : 0) + (d.folderId ? 1 : 0) !== 1) {
    c.addIssue({ code: 'custom', path: ['folderId'], message: 'укажите ровно одно: storageId или folderId' });
  }
}

export const diskChildrenListTool = defineTool({
  name: 'disk_children_list',
  module: 'disk',
  title: 'Содержимое папки Диска',
  description:
    'Папки и файлы в корне хранилища (storageId, disk.storage.getChildren) или в папке (folderId, disk.folder.getChildren): ' +
    'ID, имя, тип, размер, даты, ссылка интерфейса портала. Использовать для навигации по Диску и выбора folderId для загрузки. ' +
    'Укажите ровно одно из storageId и folderId. Ссылки на скачивание не выдаются. Страница до 50, продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      storageId: positiveId.optional().describe('ID хранилища (disk_storages_list): корень хранилища'),
      folderId: positiveId.optional().describe('ID папки'),
      ...pageArgsShape,
    })
    .strict()
    .superRefine(exactlyOne),
  outputDataSchema: z.object({
    storageId: z.number().optional(),
    folderId: z.number().optional(),
    items: z.array(diskObjectOut),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const method = args.storageId ? 'disk.storage.getchildren' : 'disk.folder.getchildren';
    const id = args.storageId ?? args.folderId ?? 0;
    const page = await legacyListPage(ctx, {
      tool: 'disk_children_list',
      method,
      params: { id },
      bindingParts: { method, id },
      pageSize,
      cursor: args.cursor,
      extract: normalizeList(ctx, method),
    });
    return ok(
      {
        ...(args.storageId ? { storageId: args.storageId } : { folderId: args.folderId }),
        items: page.items,
        returnedCount: page.items.length,
      },
      pageMeta(ctx, method, page),
    );
  },
});

// ---------- disk_search_files ----------

interface ScanNode {
  kind: 'storage' | 'folder';
  id: number;
  depth: number;
  path: string;
}

type Found = DiskObject & { path: string };

interface ScanState {
  queue: ScanNode[];
  /** Смещение start внутри листинга queue[0]. */
  start: number;
  /** Найденные, но ещё не выданные совпадения. */
  found: Found[];
  scanned: number;
  foldersListed: number;
  depthLimited: number;
  limitReached: boolean;
}

/** Не больше стольких upstream-страниц за один вызов инструмента; остаток — по cursor. */
const MAX_CALLS_PER_REQUEST = 10;

export const diskSearchFilesTool = defineTool({
  name: 'disk_search_files',
  module: 'disk',
  title: 'Поиск файлов по имени в папке',
  description:
    'Найти файлы (и при необходимости папки) по части имени в выбранной области Диска: корень хранилища (storageId) или папка ' +
    '(rootFolderId). Использовать, когда пользователь помнит название файла и примерное место. Это ограниченный обход через ' +
    'disk.*.getChildren, а не глобальный поиск по порталу и не поиск по содержимому. recursive=false — только сама папка; ' +
    'recursive=true — вложенные папки до maxDepth (≤5), всего не больше maxVisited (≤500) просмотренных объектов. ' +
    'Если лимит достигнут, ответ помечается partial с причиной SCAN_LIMIT_REACHED. Продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      storageId: positiveId.optional().describe('Искать от корня хранилища'),
      rootFolderId: positiveId.optional().describe('Искать от этой папки'),
      nameQuery: z.string().trim().min(1).max(100).describe('Часть имени, без учёта регистра'),
      recursive: z.boolean().default(false),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(3)
        .describe('Глубина вложенных папок при recursive=true'),
      maxVisited: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(200)
        .describe('Сколько объектов просмотреть максимум'),
      objectType: z.enum(['file', 'folder', 'all']).default('file'),
      ...pageArgsShape,
    })
    .strict()
    .superRefine((d, c) => {
      if ((d.storageId ? 1 : 0) + (d.rootFolderId ? 1 : 0) !== 1) {
        c.addIssue({
          code: 'custom',
          path: ['rootFolderId'],
          message: 'укажите ровно одно: storageId или rootFolderId',
        });
      }
    }),
  outputDataSchema: z.object({
    items: z.array(diskObjectOut.extend({ path: z.string() })),
    returnedCount: z.number(),
    coverage: z.object({
      scannedObjects: z.number(),
      foldersListed: z.number(),
      pendingFolders: z.number(),
      depthLimitedFolders: z.number(),
      maxDepth: z.number(),
      maxVisited: z.number(),
      recursive: z.boolean(),
      scanLimitReached: z.boolean(),
      scanFinished: z.boolean(),
      reason: z.literal('SCAN_LIMIT_REACHED').optional(),
    }),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const needle = args.nameQuery.normalize('NFC').toLocaleLowerCase('ru');
    const origin = ctx.bitrix.auth.portalOrigin;
    const root: ScanNode = args.storageId
      ? { kind: 'storage', id: args.storageId, depth: 0, path: '' }
      : { kind: 'folder', id: args.rootFolderId ?? 0, depth: 0, path: '' };
    let last: ScanState | undefined;
    const page = await statefulPage<ScanState>(ctx, {
      tool: 'disk_search_files',
      bindingParts: {
        storageId: args.storageId ?? null,
        rootFolderId: args.rootFolderId ?? null,
        nameQuery: needle,
        recursive: args.recursive,
        maxDepth: args.maxDepth,
        maxVisited: args.maxVisited,
        objectType: args.objectType,
        pageSize,
      },
      cursor: args.cursor,
      initial: {
        queue: [root],
        start: 0,
        found: [],
        scanned: 0,
        foldersListed: 0,
        depthLimited: 0,
        limitReached: false,
      },
      fetch: async (state) => {
        const s: ScanState = { ...state, queue: [...state.queue], found: [...state.found] };
        let calls = 0;
        while (
          s.found.length < pageSize &&
          s.queue.length &&
          !s.limitReached &&
          calls < MAX_CALLS_PER_REQUEST
        ) {
          const node = s.queue[0];
          if (!node) break;
          const method = node.kind === 'storage' ? 'disk.storage.getchildren' : 'disk.folder.getchildren';
          const r = await ctx.bitrix.call(
            'legacy',
            method,
            { id: node.id, start: s.start },
            { requestId: ctx.requestId, signal: ctx.signal },
          );
          calls += 1;
          if (!Array.isArray(r.result)) throw upstreamShapeError(method, 'legacy');
          let stoppedAt: number | undefined;
          for (let i = 0; i < r.result.length; i++) {
            const raw = r.result[i];
            if (s.scanned >= args.maxVisited) {
              s.limitReached = true;
              stoppedAt = i;
              break;
            }
            s.scanned += 1;
            const obj = isObj(raw) ? normalizeDiskObject(raw, origin) : undefined;
            if (!obj || obj.deleted) continue;
            const path = node.path ? `${node.path}/${obj.name}` : obj.name;
            const typeOk = args.objectType === 'all' || args.objectType === obj.type;
            if (typeOk && obj.name.normalize('NFC').toLocaleLowerCase('ru').includes(needle)) {
              s.found.push({ ...obj, path });
            }
            // Имя папки не фильтрует обход: вложенные файлы могут совпасть и в «несовпавшей» папке.
            if (obj.type === 'folder' && args.recursive) {
              if (node.depth + 1 <= args.maxDepth)
                s.queue.push({ kind: 'folder', id: obj.id, depth: node.depth + 1, path });
              else s.depthLimited += 1;
            }
          }
          if (stoppedAt !== undefined) break;
          if (typeof r.next === 'number' && r.next > s.start) {
            s.start = r.next;
          } else {
            s.queue.shift();
            s.start = 0;
            s.foldersListed += 1;
          }
        }
        const items = s.found.splice(0, pageSize);
        last = s;
        const more = s.found.length > 0 || (s.queue.length > 0 && !s.limitReached);
        return { items: items as unknown as JsonValue[], next: more ? s : undefined };
      },
    });
    const s = last;
    if (!s) throw new AppError('INTERNAL_ERROR', 'disk_search_files: состояние обхода не получено');
    const scanFinished = s.queue.length === 0;
    const warnings: string[] = [
      'Поиск только по именам в выбранной области; содержимое файлов не индексируется',
    ];
    let reason: 'SCAN_LIMIT_REACHED' | undefined;
    if (s.limitReached) {
      reason = 'SCAN_LIMIT_REACHED';
      warnings.push(
        `SCAN_LIMIT_REACHED: просмотрено ${String(s.scanned)} объектов (maxVisited=${String(args.maxVisited)}); ` +
          `не просмотрено папок: ${String(s.queue.length)}. Сузьте область или увеличьте maxVisited`,
      );
    }
    if (s.depthLimited) {
      warnings.push(
        `Не просмотрено вложенных папок глубже maxDepth=${String(args.maxDepth)}: ${String(s.depthLimited)}`,
      );
    }
    if (!args.recursive) warnings.push('recursive=false: вложенные папки не просматривались');
    const complete = scanFinished && !s.limitReached && s.depthLimited === 0 && !page.hasMore;
    return ok(
      {
        items: page.items,
        returnedCount: page.items.length,
        coverage: {
          scannedObjects: s.scanned,
          foldersListed: s.foldersListed,
          pendingFolders: s.queue.length,
          depthLimitedFolders: s.depthLimited,
          maxDepth: args.maxDepth,
          maxVisited: args.maxVisited,
          recursive: args.recursive,
          scanLimitReached: s.limitReached,
          scanFinished,
          ...(reason ? { reason } : {}),
        },
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: args.storageId ? 'disk.storage.getchildren' : 'disk.folder.getchildren',
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: complete ? 'complete' : 'partial',
        warnings,
      },
    );
  },
});

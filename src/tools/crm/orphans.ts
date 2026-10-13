/**
 * crm_orphans (заявка 2026-10-13, п. 2): компании или контакты без связей — без сделок, без лидов или без дел
 * за последние N дней. Раньше это делалось вручную: выгрузить ID и проверять пачками по 100 через `@COMPANY_ID`.
 * Сервер обходит выборку пачками по 50 (bulk.scanBatch), для каждой пачки одним-двумя запросами ищет связанные
 * сделки/лиды/дела и складывает записи без связей в файл (как crm_export). В ответ — число и путь к файлу.
 *
 * Контакт может быть привязан к сделке не основным контактом: такие кандидаты проверяются отдельным запросом
 * с фильтром CONTACT_ID по одному контакту. Для дел учитываются дела, где запись — владелец (OWNER_ID).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { checkFolder, downloadRoot, ensureFolder } from '../../files/download-store.js';
import { appendPart, finalizeTable, freeFileName, previewPart, rewindPart } from '../../files/table-file.js';
import { ok } from '../../mcp/result.js';
import { cursorBinding, idOf, isObj, upstreamShapeError } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { deadlineOf, scanBatch, UPSTREAM_PAGE } from './bulk.js';
import { classicEntity, type ClassicEntity } from './entities.js';
import {
  buildColumns,
  continueCursorArg,
  fetchSelect,
  filterSchema,
  folderArg,
  formatSchema,
  maxSecondsArg,
  prepareScan,
  rowOf,
} from './export.js';
import { NameResolver } from './names.js';

type Without = 'deals' | 'leads' | 'activities';

/** Все значения поля `field` у записей `method`, отобранных фильтром, — с обходом по ID. */
async function collectLinked(
  ctx: ToolContext,
  method: string,
  filter: JsonObject,
  field: string,
  wanted: ReadonlySet<number>,
): Promise<Set<number>> {
  const found = new Set<number>();
  let after = 0;
  for (;;) {
    const r = await ctx.bitrix.call(
      'legacy',
      method,
      { filter: { ...filter, '>ID': after }, order: { ID: 'ASC' }, select: ['ID', field], start: -1 },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError(method, 'legacy');
    const rows = r.result.filter(isObj);
    let last = after;
    for (const row of rows) {
      const id = idOf(row['ID']);
      if (id !== undefined && id > last) last = id;
      const link = idOf(row[field]);
      if (link !== undefined && wanted.has(link)) found.add(link);
    }
    if (rows.length < UPSTREAM_PAGE || last === after || found.size === wanted.size) return found;
    after = last;
  }
}

/** Есть ли хотя бы одна запись по фильтру (одна страница без подсчёта). */
async function anyExists(ctx: ToolContext, method: string, filter: JsonObject): Promise<boolean> {
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { filter, order: { ID: 'ASC' }, select: ['ID'], start: -1 },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError(method, 'legacy');
  return r.result.length > 0;
}

/** ID записей пачки, у которых есть связь. */
async function linkedOf(
  ctx: ToolContext,
  entity: ClassicEntity,
  ids: number[],
  without: Without,
  since: string | undefined,
): Promise<Set<number>> {
  const wanted = new Set(ids);
  if (ids.length === 0) return new Set();
  if (without === 'activities') {
    return collectLinked(
      ctx,
      'crm.activity.list',
      {
        OWNER_TYPE_ID: entity.entityTypeId,
        '@OWNER_ID': ids,
        ...(since ? { '>=CREATED': since } : {}),
      },
      'OWNER_ID',
      wanted,
    );
  }
  const child = classicEntity(without === 'deals' ? 'deal' : 'lead');
  const method = `${child.methodBase}.list`;
  const field = entity.type === 'company' ? 'COMPANY_ID' : 'CONTACT_ID';
  const found = await collectLinked(ctx, method, { [`@${field}`]: ids }, field, wanted);
  if (entity.type === 'contact') {
    // В ответе списка CONTACT_ID — только основной контакт; остальных проверяем по одному.
    for (const id of ids) {
      if (!found.has(id) && (await anyExists(ctx, method, { CONTACT_ID: id }))) found.add(id);
    }
  }
  return found;
}

interface OrphanState {
  afterId: number;
  scanned: number;
  written: number;
  fileName: string;
  partBytes: number;
}

export const crmOrphansTool = defineTool({
  name: 'crm_orphans',
  module: 'crm',
  title: 'Компании и контакты без связей',
  description:
    'Найти компании или контакты БЕЗ сделок (without=deals), без лидов (leads) или без дел за последние activityDays дней (activities) — по всей базе или по фильтру ' +
    '(например {">=DATE_CREATE": "2026-01-01"}). Сервер сам перебирает записи и проверяет связи пачками; результат — файл XLSX/CSV в DOWNLOAD_DIR ' +
    '(ID, название, ответственный, дата, ссылка) и число найденных. Использовать для вопросов «компании без сделок за всё время», ' +
    '«контакты без дел за полгода» — вместо выгрузки ID и ручной проверки. Долгий обход: complete=false и cursor — повторить с ним. Портал не меняется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.enum(['company', 'contact']).describe('company — компании, contact — контакты'),
      without: z
        .enum(['deals', 'leads', 'activities'])
        .default('deals')
        .describe('Какой связи нет: deals — сделок, leads — лидов, activities — дел за activityDays дней'),
      activityDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(180)
        .describe('Для without=activities: за сколько дней'),
      filter: filterSchema,
      fields: z
        .array(z.string().max(100))
        .max(60)
        .optional()
        .describe('Колонки файла; по умолчанию ключевые поля'),
      format: formatSchema,
      folder: folderArg,
      fileName: z.string().min(1).max(120).optional().describe('Имя файла без расширения'),
      maxSeconds: maxSecondsArg,
      cursor: continueCursorArg,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.string(),
    without: z.string(),
    complete: z.boolean(),
    cursor: z.string().nullable(),
    scanned: z.number(),
    found: z.number(),
    path: z.string().nullable(),
    fileName: z.string(),
    preview: z.array(z.record(z.string(), z.unknown())),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const entity = classicEntity(args.entityType);
    const dir = await ensureFolder(root, checkFolder(args.folder));
    const prep = await prepareScan(ctx, entity, args.filter, args.fields);
    const columns = buildColumns(entity, prep.meta, prep.fields, true, true);
    const header = columns.map((c) => c.title);
    const select = fetchSelect(columns);
    const since =
      args.without === 'activities'
        ? new Date(Date.now() - args.activityDays * 86_400_000).toISOString().slice(0, 10)
        : undefined;
    const binding = cursorBinding(ctx, 'crm_orphans', {
      entity: entity.type,
      without: args.without,
      since: since ?? null,
      filter: args.filter,
      fields: prep.fields,
      format: args.format,
      folder: args.folder,
    });
    const state: OrphanState = args.cursor
      ? await ctx.cursors.peek<OrphanState>(args.cursor, binding)
      : {
          afterId: 0,
          scanned: 0,
          written: 0,
          partBytes: 0,
          fileName: await freeFileName(
            dir,
            args.fileName ??
              `${entity.type}-без-${{ deals: 'сделок', leads: 'лидов', activities: 'дел' }[args.without]}-${new Date().toISOString().slice(0, 10)}`,
            args.format,
          ),
        };
    if (args.cursor) await rewindPart(dir, state.fileName, state.partBytes);
    const names = new NameResolver(ctx);
    const refs = columns.flatMap((c) => (c.kind === 'ref' ? [c.ref] : []));
    const deadline = deadlineOf(ctx, args.maxSeconds);
    let done = false;
    while (Date.now() < deadline) {
      const batch = await scanBatch(ctx, entity, {
        filter: prep.upstream,
        local: prep.local,
        select,
        afterId: state.afterId,
      });
      const ids = batch.rows.map((r) => idOf(r['ID'])).filter((n): n is number => n !== undefined);
      const linked = await linkedOf(ctx, entity, ids, args.without, since);
      const orphans = batch.rows.filter((r) => {
        const id = idOf(r['ID']);
        return id !== undefined && !linked.has(id);
      });
      await names.prepare(orphans, refs);
      state.partBytes += await appendPart(
        dir,
        state.fileName,
        orphans.map((r) => rowOf(ctx, entity, columns, names, r)),
      );
      state.written += orphans.length;
      state.scanned += batch.rows.length;
      state.afterId = batch.lastId;
      if (batch.done) {
        done = true;
        break;
      }
    }
    if (args.cursor) await ctx.cursors.discard(args.cursor);
    const preview = (await previewPart(dir, state.fileName, 5)).map((r) =>
      Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])),
    );
    const warnings = [...names.warnings];
    if (args.without === 'activities')
      warnings.push(`Учтены дела, созданные с ${since ?? ''}, где запись — владелец дела`);
    const base = {
      entityType: entity.type,
      without: args.without,
      scanned: state.scanned,
      found: state.written,
      fileName: state.fileName,
      preview,
    };
    const method = `${entity.methodBase}.list`;
    if (!done) {
      const cursor = await ctx.cursors.create(binding, state);
      warnings.push(
        `Проверено ${String(state.scanned)} записей за ${String(args.maxSeconds)} с: повторите с cursor — поиск продолжится`,
      );
      return ok(
        { ...base, complete: false, cursor, path: null },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          method,
          apiVersion: 'legacy',
          completeness: 'partial',
          warnings,
        },
      );
    }
    const file = await finalizeTable(dir, state.fileName, header, args.format);
    return ok(
      { ...base, complete: true, cursor: null, path: file.path },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method,
        apiVersion: 'legacy',
        completeness: 'complete',
        warnings,
      },
    );
  },
});

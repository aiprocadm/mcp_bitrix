/**
 * crm_export (заявка 2026-10-13, п. 1): выгрузка всей выборки классической сущности CRM в файл CSV/XLSX
 * в DOWNLOAD_DIR одной командой. Сервер сам листает все страницы (bulk.scanBatch), подставляет имена
 * (ответственный → ФИО, компания → название, стадия → название) и ссылку на карточку; в разговор возвращаются
 * только путь, число строк и первые 5 строк. Длинная выгрузка идёт частями: по пределу времени ответ
 * complete=false и cursor — повтор с ним продолжает тот же файл. Портал только читается.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { checkFolder, downloadRoot, ensureFolder } from '../../files/download-store.js';
import {
  appendPart,
  finalizeTable,
  freeFileName,
  previewPart,
  rewindPart,
  type Cell,
} from '../../files/table-file.js';
import { ok } from '../../mcp/result.js';
import { asText, cursorBinding, isObj } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { deadlineOf, scanBatch, splitNotContains, type LocalCondition } from './bulk.js';
import { getFieldsMeta, type FieldsMeta } from './crm-service.js';
import { validateFilter, validateSelect } from './deal-fields.js';
import { classicEntity, entityTypeSchema, type ClassicEntity } from './entities.js';
import { NameResolver, refColumnFor, type RefColumn } from './names.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);

export const filterSchema = z
  .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
  .default({})
  .describe(
    'Фильтр как в crm_list_records: {">=DATE_CREATE": "2026-01-01", "ASSIGNED_BY_ID": 5, "!%TITLE": "тест"}',
  );

export const formatSchema = z
  .enum(['csv', 'xlsx'])
  .default('xlsx')
  .describe('Формат файла: xlsx (Excel) или csv');

export const folderArg = z
  .string()
  .min(1)
  .max(200)
  .default('выгрузки')
  .describe('Подпапка внутри DOWNLOAD_DIR: до 3 частей через «/»');

export const maxSecondsArg = z
  .number()
  .int()
  .min(1)
  .max(600)
  .default(90)
  .describe('Сколько секунд работать за вызов; не успел — complete=false и cursor для продолжения');

export const continueCursorArg = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'cursor из прошлого ответа с complete=false: продолжить ту же выгрузку (остальные параметры те же)',
  );

/** Колонка итоговой таблицы: поле записи, имя по справочнику или ссылка на карточку. */
export type Column =
  | { kind: 'field'; field: string; title: string }
  | { kind: 'ref'; ref: RefColumn; title: string }
  | { kind: 'link'; title: string };

/** Значение поля Bitrix → ячейка: множественные поля и мультиполя (телефон, email) — через запятую. */
export function cellOf(v: JsonValue | undefined): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  if (typeof v === 'string') return v;
  if (Array.isArray(v))
    return v
      .map((x) => (isObj(x) ? asText(x['VALUE']) : asText(x)))
      .filter((s) => s !== '')
      .join(', ');
  return isObj(v) && 'VALUE' in v ? asText(v['VALUE']) : JSON.stringify(v);
}

export function cardLink(ctx: ToolContext, entity: ClassicEntity, id: unknown): string | null {
  const n = Number(asText(id));
  if (!Number.isSafeInteger(n) || n <= 0 || !ctx.bitrix.auth.portalOrigin) return null;
  return `${ctx.bitrix.auth.portalOrigin}/crm/${entity.type}/details/${String(n)}/`;
}

export function buildColumns(
  entity: ClassicEntity,
  meta: FieldsMeta,
  fields: readonly string[],
  withNames: boolean,
  withLinks: boolean,
): Column[] {
  const cols: Column[] = [];
  const used = new Set<string>();
  const title = (t: string, fallback: string) => {
    const name = used.has(t) ? `${t} (${fallback})` : t;
    used.add(name);
    return name;
  };
  for (const f of fields) {
    const metaTitle = meta[f]?.title;
    cols.push({ kind: 'field', field: f, title: title(metaTitle && metaTitle !== f ? metaTitle : f, f) });
    const ref = withNames ? refColumnFor(entity.type, f) : undefined;
    if (ref) cols.push({ kind: 'ref', ref, title: title(`${ref.title}: имя`, f) });
  }
  if (withLinks) cols.push({ kind: 'link', title: title('Ссылка', 'link') });
  return cols;
}

/** Поля, нужные для расчёта колонок (CATEGORY_ID для названия стадии сделки). */
export function fetchSelect(columns: readonly Column[]): string[] {
  const out = new Set<string>(['ID']);
  for (const c of columns) {
    if (c.kind === 'field') out.add(c.field);
    if (c.kind === 'ref') {
      out.add(c.ref.field);
      if (c.ref.statusEntity === 'DEAL_STAGE_BY_CATEGORY') out.add('CATEGORY_ID');
    }
  }
  return [...out];
}

export function rowOf(
  ctx: ToolContext,
  entity: ClassicEntity,
  columns: readonly Column[],
  names: NameResolver,
  rec: Record<string, JsonValue>,
): Cell[] {
  return columns.map((c) => {
    if (c.kind === 'field') return cellOf(rec[c.field]);
    if (c.kind === 'ref') return names.label(c.ref, rec) || null;
    return cardLink(ctx, entity, rec['ID']);
  });
}

/** Проверка и подготовка фильтра/полей сущности для обхода. */
export async function prepareScan(
  ctx: ToolContext,
  entity: ClassicEntity,
  filter: Record<string, unknown>,
  fields: readonly string[] | undefined,
): Promise<{ meta: FieldsMeta; upstream: JsonObject; local: LocalCondition[]; fields: string[] }> {
  const meta = await getFieldsMeta(ctx, entity);
  const { upstream, local } = splitNotContains(validateFilter(filter, meta));
  const chosen = fields?.length ? fields : [...entity.defaultSelect];
  if (chosen.some((f) => f === '*' || f === 'UF_*'))
    throw new AppError('VALIDATION_ERROR', 'fields: перечислите поля явно («*» и «UF_*» не поддерживаются)', {
      field: 'fields',
      nextAction: 'Список полей — crm_fields_get',
    });
  return { meta, upstream, local, fields: validateSelect([...new Set(chosen)], meta) };
}

interface ExportState {
  afterId: number;
  scanned: number;
  written: number;
  fileName: string;
  partBytes: number;
}

const previewObjects = (header: readonly string[], rows: readonly Cell[][]) =>
  rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));

export const crmExportTool = defineTool({
  name: 'crm_export',
  module: 'crm',
  title: 'Выгрузить записи CRM в файл',
  description:
    'Выгрузить ВСЕ записи CRM по фильтру (сделки, лиды, контакты, компании) в файл XLSX или CSV в папке скачиваний сервера (DOWNLOAD_DIR) одной командой: ' +
    'сервер сам перебирает все страницы, добавляет колонки с именами (ответственный → ФИО, компания → название, стадия, источник) и ссылку на карточку. ' +
    'Использовать вместо листания crm_list_records, когда записей больше пары страниц или нужна таблица: «все компании Иванова», «все лиды за год». ' +
    'В ответе — путь к файлу, число строк и первые 5 строк. Фильтр как в crm_list_records; «!%ПОЛЕ» (не содержит) проверяется сервером. ' +
    'За вызов — до maxSeconds секунд; если complete=false — повторить с cursor (тот же файл продолжится). Портал не меняется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      filter: filterSchema,
      fields: z
        .array(z.string().max(100))
        .max(60)
        .optional()
        .describe('Колонки (поля портала); по умолчанию ключевые поля сущности'),
      format: formatSchema,
      withNames: z
        .boolean()
        .default(true)
        .describe('Добавить колонки с именами для ID сотрудников, компаний, контактов, стадий'),
      withLinks: z.boolean().default(true).describe('Колонка со ссылкой на карточку'),
      folder: folderArg,
      fileName: z.string().min(1).max(120).optional().describe('Имя файла без расширения'),
      maxRows: z.number().int().min(1).max(300_000).default(100_000).describe('Предел строк файла'),
      maxSeconds: maxSecondsArg,
      cursor: continueCursorArg,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.string(),
    complete: z.boolean(),
    cursor: z.string().nullable(),
    rows: z.number(),
    scanned: z.number(),
    path: z.string().nullable(),
    fileName: z.string(),
    columns: z.array(z.string()),
    preview: z.array(z.record(z.string(), z.unknown())),
    truncatedByMaxRows: z.boolean(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const entity = classicEntity(args.entityType);
    const dir = await ensureFolder(root, checkFolder(args.folder));
    const prep = await prepareScan(ctx, entity, args.filter, args.fields);
    const columns = buildColumns(entity, prep.meta, prep.fields, args.withNames, args.withLinks);
    const header = columns.map((c) => c.title);
    const select = fetchSelect(columns);
    const binding = cursorBinding(ctx, 'crm_export', {
      entity: entity.type,
      filter: args.filter,
      fields: prep.fields,
      format: args.format,
      withNames: args.withNames,
      withLinks: args.withLinks,
      folder: args.folder,
      maxRows: args.maxRows,
    });
    const state: ExportState = args.cursor
      ? await ctx.cursors.peek<ExportState>(args.cursor, binding)
      : {
          afterId: 0,
          scanned: 0,
          written: 0,
          fileName: await freeFileName(
            dir,
            args.fileName ?? `${entity.type}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
            args.format,
          ),
          partBytes: 0,
        };
    if (args.cursor) await rewindPart(dir, state.fileName, state.partBytes);
    const names = new NameResolver(ctx);
    const deadline = deadlineOf(ctx, args.maxSeconds);
    let done = false;
    while (Date.now() < deadline && state.written < args.maxRows) {
      const batch = await scanBatch(ctx, entity, {
        filter: prep.upstream,
        local: prep.local,
        select,
        afterId: state.afterId,
      });
      const rows = batch.rows.slice(0, args.maxRows - state.written);
      if (args.withNames)
        await names.prepare(
          rows,
          columns.flatMap((c) => (c.kind === 'ref' ? [c.ref] : [])),
        );
      state.partBytes += await appendPart(
        dir,
        state.fileName,
        rows.map((r) => rowOf(ctx, entity, columns, names, r)),
      );
      state.written += rows.length;
      state.scanned += batch.rows.length;
      state.afterId = batch.lastId;
      if (batch.done) {
        done = true;
        break;
      }
    }
    if (args.cursor) await ctx.cursors.discard(args.cursor);
    const truncated = !done && state.written >= args.maxRows;
    const warnings = [...names.warnings];
    if (prep.local.length)
      warnings.push('Условия «!%» (не содержит) проверены сервером MCP, без учёта регистра');
    if (!done && !truncated) {
      const cursor = await ctx.cursors.create(binding, state);
      warnings.push(
        `Выгрузка не закончена за ${String(args.maxSeconds)} с: повторите вызов с cursor — файл продолжится`,
      );
      return ok(
        {
          entityType: entity.type,
          complete: false,
          cursor,
          rows: state.written,
          scanned: state.scanned,
          path: null,
          fileName: state.fileName,
          columns: header,
          preview: previewObjects(header, await previewPart(dir, state.fileName, 5)),
          truncatedByMaxRows: false,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          method: `${entity.methodBase}.list`,
          apiVersion: 'legacy',
          completeness: 'partial',
          warnings,
        },
      );
    }
    const preview = previewObjects(header, await previewPart(dir, state.fileName, 5));
    const file = await finalizeTable(dir, state.fileName, header, args.format);
    if (truncated)
      warnings.push(`Достигнут предел maxRows=${String(args.maxRows)}: в файле не все записи выборки`);
    return ok(
      {
        entityType: entity.type,
        complete: !truncated,
        cursor: null,
        rows: file.rows,
        scanned: state.scanned,
        path: file.path,
        fileName: state.fileName,
        columns: header,
        preview,
        truncatedByMaxRows: truncated,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: `${entity.methodBase}.list`,
        apiVersion: 'legacy',
        completeness: truncated ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

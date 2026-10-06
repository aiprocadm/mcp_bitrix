/**
 * crm_pipelines_overview: сводка сразу по всем воронкам сделок или по лидам (стадии + источники).
 * Как и crm_pipeline_summary — ограниченный проход списка (maxRecords, MAX_AGGREGATION_SECONDS) с честным охватом;
 * суммы разных валют не складываются; это снимок текущих стадий, а не историческая конверсия.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { asText } from './deal-fields.js';
import { dealStageEntityId } from './entities.js';
import { listCategories, listStatuses, type StatusItem } from './crm-service.js';

const DEAL_DATE_FIELDS = ['DATE_CREATE', 'CLOSEDATE', 'BEGINDATE', 'DATE_MODIFY'] as const;
const LEAD_DATE_FIELDS = ['DATE_CREATE', 'DATE_MODIFY', 'DATE_CLOSED'] as const;
const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'ожидается дата ISO 8601, например 2026-09-01');

const moneySchema = z.object({ currency: z.string(), amount: z.number() });
const stageSchema = z.object({
  stageId: z.string(),
  name: z.string(),
  semantics: z.enum(['P', 'S', 'F']),
  count: z.number(),
  sums: z.array(moneySchema),
});
const groupSchema = z.object({
  categoryId: z.number().nullable(),
  name: z.string(),
  count: z.number(),
  sums: z.array(moneySchema),
  won: z.number(),
  lost: z.number(),
  inProgress: z.number(),
  stages: z.array(stageSchema),
});

type Semantics = 'P' | 'S' | 'F';
const semanticsOf = (v: string | undefined): Semantics => (v === 'S' || v === 'F' ? v : 'P');

function sums(map: Map<string, number>): { currency: string; amount: number }[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, amount: Math.round(cents) / 100 }));
}

export interface ScanRow {
  categoryId: number | null;
  stageId: string;
  sourceId: string;
  cents: number;
  currency: string;
}

/**
 * Ограниченный проход crm.deal.list / crm.lead.list (по 50, порядок ID): останавливается на maxRecords
 * или по времени. Выбираются только поля для подсчёта — без имён, телефонов и прочих данных клиента.
 */
export async function scanForOverview(
  ctx: ToolContext,
  entity: 'deal' | 'lead',
  filter: JsonObject,
  maxRecords: number,
  maxSeconds: number,
  now: () => number = () => Date.now(),
): Promise<{ rows: ScanRow[]; hasMore: boolean; stoppedBy: 'complete' | 'maxRecords' | 'timeLimit' }> {
  const method = entity === 'deal' ? 'crm.deal.list' : 'crm.lead.list';
  const select =
    entity === 'deal'
      ? ['ID', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID']
      : ['ID', 'STATUS_ID', 'SOURCE_ID', 'OPPORTUNITY', 'CURRENCY_ID'];
  const deadline = now() + maxSeconds * 1000;
  const rows: ScanRow[] = [];
  let start: number | undefined = 0;
  while (start !== undefined) {
    if (rows.length >= maxRecords) return { rows, hasMore: true, stoppedBy: 'maxRecords' };
    if (now() >= deadline) return { rows, hasMore: true, stoppedBy: 'timeLimit' };
    const r = await ctx.bitrix.call(
      'legacy',
      method,
      { filter, select, order: { ID: 'ASC' }, start },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) {
      throw new AppError('BITRIX_UPSTREAM_ERROR', `${method} вернул не массив`, {
        method,
        apiVersion: 'legacy',
      });
    }
    const page = (r.result as unknown[]).filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
    );
    for (const x of page) {
      if (rows.length >= maxRecords) return { rows, hasMore: true, stoppedBy: 'maxRecords' };
      const cat = entity === 'deal' ? Number(asText(x['CATEGORY_ID']) || '0') : null;
      rows.push({
        categoryId: cat,
        stageId: asText(entity === 'deal' ? x['STAGE_ID'] : x['STATUS_ID']),
        sourceId: entity === 'lead' ? asText(x['SOURCE_ID']) : '',
        cents: Math.round((Number(asText(x['OPPORTUNITY'])) || 0) * 100),
        currency: asText(x['CURRENCY_ID']) || 'UNKNOWN',
      });
    }
    start = page.length === 0 ? undefined : r.next;
  }
  return { rows, hasMore: false, stoppedBy: 'complete' };
}

/** Группа (воронка или лиды): стадии справочника по порядку, неизвестные — кодом в конце. */
export function buildGroup(
  categoryId: number | null,
  name: string,
  stageList: StatusItem[],
  rows: ScanRow[],
  warnings: string[],
): z.infer<typeof groupSchema> {
  const byStage = new Map<string, { count: number; sums: Map<string, number> }>();
  const total = new Map<string, number>();
  for (const row of rows) {
    const slot = byStage.get(row.stageId) ?? { count: 0, sums: new Map<string, number>() };
    slot.count += 1;
    slot.sums.set(row.currency, (slot.sums.get(row.currency) ?? 0) + row.cents);
    total.set(row.currency, (total.get(row.currency) ?? 0) + row.cents);
    byStage.set(row.stageId, slot);
  }
  const stages = stageList.map((s) => ({
    stageId: s.statusId,
    name: s.name,
    semantics: semanticsOf(s.semantics),
    count: byStage.get(s.statusId)?.count ?? 0,
    sums: sums(byStage.get(s.statusId)?.sums ?? new Map<string, number>()),
  }));
  const known = new Set(stageList.map((s) => s.statusId));
  for (const [stageId, slot] of byStage) {
    if (known.has(stageId)) continue;
    stages.push({ stageId, name: stageId, semantics: 'P', count: slot.count, sums: sums(slot.sums) });
    warnings.push(`${name}: стадия ${stageId} отсутствует в справочнике; показана кодом`);
  }
  const by = (sem: Semantics) => stages.filter((s) => s.semantics === sem).reduce((n, s) => n + s.count, 0);
  return {
    categoryId,
    name,
    count: rows.length,
    sums: sums(total),
    won: by('S'),
    lost: by('F'),
    inProgress: by('P'),
    stages,
  };
}

export const crmPipelinesOverviewTool = defineTool({
  name: 'crm_pipelines_overview',
  module: 'crm',
  title: 'Сводка по всем воронкам или по лидам',
  description:
    'entityType=deal — количество и суммы сделок по КАЖДОЙ воронке и её стадиям за период (выиграно/проиграно/в работе); ' +
    'entityType=lead — лиды по стадиям и по источникам (откуда пришли). Использовать для вопросов «как дела во всех воронках», ' +
    '«сколько лидов за месяц и откуда», «сколько лидов провалено». Одна воронка подробно — crm_pipeline_summary. ' +
    'Считается по ограниченной выборке (maxRecords, лимит времени): ответ сообщает scannedCount, hasMore и полноту — сужайте период. ' +
    'Суммы в разных валютах не складываются. Это снимок текущих стадий, не историческая конверсия.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.enum(['deal', 'lead']).describe('deal — все воронки сделок, lead — лиды'),
      dateField: z
        .enum(['DATE_CREATE', 'CLOSEDATE', 'BEGINDATE', 'DATE_MODIFY', 'DATE_CLOSED'])
        .default('DATE_CREATE')
        .describe(
          'Поле даты периода: сделки — DATE_CREATE/CLOSEDATE/BEGINDATE/DATE_MODIFY, лиды — DATE_CREATE/DATE_MODIFY/DATE_CLOSED',
        ),
      from: isoDate.describe('Начало периода (включительно)'),
      to: isoDate.describe('Конец периода (включительно)'),
      assignedById: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe('Только этого ответственного'),
      maxRecords: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .optional()
        .describe('Предел просмотренных записей; по умолчанию MAX_AGGREGATION_RECORDS'),
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.enum(['deal', 'lead']),
    dateField: z.string(),
    from: z.string(),
    to: z.string(),
    assignedById: z.number().optional(),
    asOf: z.string(),
    scannedCount: z.number(),
    hasMore: z.boolean(),
    stoppedBy: z.enum(['complete', 'maxRecords', 'timeLimit']),
    groups: z.array(groupSchema),
    sources: z.array(z.object({ sourceId: z.string(), name: z.string(), count: z.number() })).optional(),
    totals: z.object({ count: z.number(), sums: z.array(moneySchema) }),
  }),
  handler: async (args, ctx) => {
    if (Date.parse(args.from) > Date.parse(args.to)) {
      throw new AppError('VALIDATION_ERROR', 'from позже to', { field: 'from' });
    }
    const allowed: readonly string[] = args.entityType === 'deal' ? DEAL_DATE_FIELDS : LEAD_DATE_FIELDS;
    if (!allowed.includes(args.dateField)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `dateField: для ${args.entityType} допустимо ${allowed.join(', ')}`,
        {
          field: 'dateField',
        },
      );
    }
    const limit = ctx.config.limits.maxAggregationRecords;
    if (args.maxRecords !== undefined && args.maxRecords > limit) {
      throw new AppError(
        'VALIDATION_ERROR',
        `maxRecords больше серверного предела MAX_AGGREGATION_RECORDS=${String(limit)}`,
        {
          field: 'maxRecords',
        },
      );
    }
    const filter: JsonObject = { [`>=${args.dateField}`]: args.from, [`<=${args.dateField}`]: args.to };
    if (args.assignedById !== undefined) filter['ASSIGNED_BY_ID'] = args.assignedById;
    const scan = await scanForOverview(
      ctx,
      args.entityType,
      filter,
      args.maxRecords ?? limit,
      ctx.config.limits.maxAggregationSeconds,
    );
    const warnings: string[] = [];
    const groups: z.infer<typeof groupSchema>[] = [];
    let sources: { sourceId: string; name: string; count: number }[] | undefined;

    if (args.entityType === 'deal') {
      const categories = await listCategories(ctx, 2);
      const ids = new Set<number>([
        ...categories.map((c) => c.id),
        ...scan.rows.map((r) => r.categoryId ?? 0),
      ]);
      for (const id of [...ids].sort((a, b) => a - b)) {
        const cat = categories.find((c) => c.id === id);
        if (!cat) warnings.push(`Воронка ${String(id)} не найдена в crm.category.list`);
        const stageList = await listStatuses(ctx, dealStageEntityId(id));
        groups.push(
          buildGroup(
            id,
            cat?.name ?? `Воронка ${String(id)}`,
            stageList,
            scan.rows.filter((r) => (r.categoryId ?? 0) === id),
            warnings,
          ),
        );
      }
    } else {
      groups.push(buildGroup(null, 'Лиды', await listStatuses(ctx, 'STATUS'), scan.rows, warnings));
      const names = new Map((await listStatuses(ctx, 'SOURCE')).map((s) => [s.statusId, s.name]));
      const counts = new Map<string, number>();
      for (const r of scan.rows) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
      sources = [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([sourceId, count]) => ({
          sourceId,
          name: sourceId === '' ? 'Не указан' : (names.get(sourceId) ?? sourceId),
          count,
        }));
    }

    const totals = new Map<string, number>();
    for (const r of scan.rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.cents);
    if (totals.size > 1)
      warnings.push('Суммы в разных валютах не складываются: итоги даны по каждой валюте отдельно');
    if (scan.stoppedBy !== 'complete') {
      warnings.push(
        scan.stoppedBy === 'maxRecords'
          ? `Просмотр остановлен на maxRecords: сводка неполная (${String(scan.rows.length)} записей)`
          : `Просмотр остановлен по времени (MAX_AGGREGATION_SECONDS=${String(ctx.config.limits.maxAggregationSeconds)}): сводка неполная — сузьте период`,
      );
    }
    return ok(
      {
        entityType: args.entityType,
        dateField: args.dateField,
        from: args.from,
        to: args.to,
        ...(args.assignedById !== undefined ? { assignedById: args.assignedById } : {}),
        asOf: new Date().toISOString(),
        scannedCount: scan.rows.length,
        hasMore: scan.hasMore,
        stoppedBy: scan.stoppedBy,
        groups,
        ...(sources ? { sources } : {}),
        totals: { count: scan.rows.length, sums: sums(totals) },
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: args.entityType === 'deal' ? 'crm.deal.list' : 'crm.lead.list',
        apiVersion: 'legacy',
        completeness: scan.hasMore ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

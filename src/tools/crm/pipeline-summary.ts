/**
 * crm_pipeline_summary (ТЗ §9.4, T33): сводка по воронке сделок по ограниченной выборке.
 * Универсального REST-метода «сводка» нет — сервер сам проходит crm.deal.list по фильтру,
 * останавливается на maxRecords/времени и честно сообщает охват. Суммы разных валют не складываются;
 * это снимок текущих стадий, а не историческая конверсия.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { dealStageEntityId } from './entities.js';
import { listCategories, listStatuses } from './crm-service.js';
import { scanDeals } from './related-service.js';

const DATE_FIELDS = ['DATE_CREATE', 'CLOSEDATE', 'BEGINDATE', 'DATE_MODIFY'] as const;
const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'ожидается дата ISO 8601, например 2026-09-01');

const moneySchema = z.object({ currency: z.string(), amount: z.number() });

/** Семантика стадии: S — успех, F — провал, остальное — в работе (P). */
function semanticsOf(v: string | undefined): 'P' | 'S' | 'F' {
  return v === 'S' || v === 'F' ? v : 'P';
}

/** Сумма в копейках по валютам → массив {currency, amount}. */
function sums(map: Map<string, number>): { currency: string; amount: number }[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, amount: Math.round(cents) / 100 }));
}

export const crmPipelineSummaryTool = defineTool({
  name: 'crm_pipeline_summary',
  module: 'crm',
  title: 'Сводка по воронке сделок',
  description:
    'Количество сделок и суммы по стадиям одной воронки за период по выбранному полю даты (создание, закрытие, начало, изменение), ' +
    'опционально по ответственному. Использовать для вопросов «сколько сделок и на какую сумму на каждой стадии». ' +
    'Считается по ограниченной выборке (maxRecords, лимит времени): ответ сообщает scannedCount, hasMore и полноту. ' +
    'Суммы в разных валютах показываются раздельно, не складываются. Это снимок текущих стадий, не историческая конверсия.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      categoryId: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .describe('Воронка (0 — общая); список — crm_stages_and_statuses'),
      dateField: z
        .enum(DATE_FIELDS)
        .describe('Поле даты для периода: DATE_CREATE, CLOSEDATE, BEGINDATE или DATE_MODIFY'),
      from: isoDate.describe('Начало периода (включительно)'),
      to: isoDate.describe('Конец периода (включительно)'),
      assignedById: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe('Только сделки этого ответственного'),
      maxRecords: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .optional()
        .describe('Предел просмотренных сделок; по умолчанию MAX_AGGREGATION_RECORDS'),
    })
    .strict(),
  outputDataSchema: z.object({
    categoryId: z.number(),
    categoryName: z.string().optional(),
    dateField: z.enum(DATE_FIELDS),
    from: z.string(),
    to: z.string(),
    assignedById: z.number().optional(),
    asOf: z.string(),
    scannedCount: z.number(),
    hasMore: z.boolean(),
    stoppedBy: z.enum(['complete', 'maxRecords', 'timeLimit']),
    stages: z.array(
      z.object({
        stageId: z.string(),
        name: z.string(),
        semantics: z.enum(['P', 'S', 'F']),
        count: z.number(),
        sums: z.array(moneySchema),
      }),
    ),
    totals: z.object({ count: z.number(), sums: z.array(moneySchema) }),
  }),
  handler: async (args, ctx) => {
    if (Date.parse(args.from) > Date.parse(args.to)) {
      throw new AppError('VALIDATION_ERROR', 'from позже to', { field: 'from' });
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
    const maxRecords = args.maxRecords ?? limit;
    const categories = await listCategories(ctx, 2);
    const category = categories.find((c) => c.id === args.categoryId);
    const warnings: string[] = [];
    if (!category) warnings.push(`Воронка ${String(args.categoryId)} не найдена в crm.category.list`);
    const stageList = await listStatuses(ctx, dealStageEntityId(args.categoryId));

    const filter: JsonObject = {
      CATEGORY_ID: args.categoryId,
      [`>=${args.dateField}`]: args.from,
      [`<=${args.dateField}`]: args.to,
    };
    if (args.assignedById !== undefined) filter['ASSIGNED_BY_ID'] = args.assignedById;
    const scan = await scanDeals(ctx, filter, maxRecords, ctx.config.limits.maxAggregationSeconds);

    const byStage = new Map<string, { count: number; sums: Map<string, number> }>();
    const totals = new Map<string, number>();
    for (const d of scan.deals) {
      const slot = byStage.get(d.stageId) ?? { count: 0, sums: new Map<string, number>() };
      slot.count += 1;
      const currency = d.currency || 'UNKNOWN';
      const cents = Math.round(d.opportunity * 100);
      slot.sums.set(currency, (slot.sums.get(currency) ?? 0) + cents);
      totals.set(currency, (totals.get(currency) ?? 0) + cents);
      byStage.set(d.stageId, slot);
    }
    const known = new Set(stageList.map((s) => s.statusId));
    const stages = stageList.map((s) => ({
      stageId: s.statusId,
      name: s.name,
      semantics: semanticsOf(s.semantics),
      count: byStage.get(s.statusId)?.count ?? 0,
      sums: sums(byStage.get(s.statusId)?.sums ?? new Map<string, number>()),
    }));
    for (const [stageId, slot] of byStage) {
      if (known.has(stageId)) continue;
      stages.push({ stageId, name: stageId, semantics: 'P', count: slot.count, sums: sums(slot.sums) });
      warnings.push(`Стадия ${stageId} отсутствует в справочнике воронки; показана кодом`);
    }
    if (totals.size > 1)
      warnings.push('Суммы в разных валютах не складываются: итоги даны по каждой валюте отдельно');
    if (scan.stoppedBy === 'maxRecords')
      warnings.push(`Просмотр остановлен на maxRecords=${String(maxRecords)}: сводка неполная`);
    if (scan.stoppedBy === 'timeLimit') {
      warnings.push(
        `Просмотр остановлен по времени (MAX_AGGREGATION_SECONDS=${String(ctx.config.limits.maxAggregationSeconds)}): сводка неполная`,
      );
    }

    return ok(
      {
        categoryId: args.categoryId,
        ...(category ? { categoryName: category.name } : {}),
        dateField: args.dateField,
        from: args.from,
        to: args.to,
        ...(args.assignedById !== undefined ? { assignedById: args.assignedById } : {}),
        asOf: new Date().toISOString(),
        scannedCount: scan.scannedCount,
        hasMore: scan.hasMore,
        stoppedBy: scan.stoppedBy,
        stages,
        totals: { count: scan.scannedCount, sums: sums(totals) },
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.deal.list',
        apiVersion: 'legacy',
        completeness: scan.hasMore ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

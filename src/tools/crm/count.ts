/**
 * crm_count (заявка 2026-10-13, п. 2): подсчёт записей классической сущности CRM на сервере с группировкой —
 * «лиды за сентябрь по источникам», «сделки по ответственным», «компании по месяцам создания».
 * В разговор возвращается таблица итогов (группа, название, количество, сумма), а не записи.
 * Без groupBy — один запрос (total портала). С groupBy сервер обходит выборку (bulk.scanBatch, только нужные поля);
 * долгий подсчёт продолжается по cursor с накопленными итогами.
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { asText, cursorBinding, num, upstreamShapeError } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { deadlineOf, scanBatch } from './bulk.js';
import { continueCursorArg, filterSchema, maxSecondsArg, prepareScan } from './export.js';
import { classicEntity, entityTypeSchema } from './entities.js';
import { NameResolver, refColumnFor } from './names.js';

const MAX_GROUPS = 20_000;
const DATE_TYPES = new Set(['date', 'datetime']);

/** Ключ группы для даты Bitrix («2026-09-15T10:00:00+03:00») без перевода зон: день/неделя/месяц/год. */
export function dateKey(value: string, period: 'day' | 'week' | 'month' | 'year'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return '';
  const [, y, mo, d] = m;
  if (period === 'year') return y ?? '';
  if (period === 'month') return `${y ?? ''}-${mo ?? ''}`;
  if (period === 'day') return `${y ?? ''}-${mo ?? ''}-${d ?? ''}`;
  // ISO-неделя: четверг той же недели определяет год.
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(date.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

interface CountState {
  afterId: number;
  scanned: number;
  groups: [string, number, number][];
}

const groupOut = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number(),
  sum: z.number().optional(),
});

export const crmCountTool = defineTool({
  name: 'crm_count',
  module: 'crm',
  title: 'Подсчёт записей CRM по группам',
  description:
    'Посчитать записи CRM (сделки, лиды, контакты, компании) по фильтру на сервере и сгруппировать: по ответственному, стадии, источнику, воронке, ' +
    'любому полю или по дате (groupBy=DATE_CREATE, period=month). Ответ — таблица итогов: группа, название (ФИО, название стадии), количество, ' +
    'сумма поля sumField (например OPPORTUNITY). Использовать для вопросов «сколько лидов за сентябрь по источникам», «сделки по менеджерам», ' +
    '«сколько компаний создано по месяцам» — вместо листания записей. Без groupBy — просто число. ' +
    'Фильтр как в crm_list_records. Долгий подсчёт: complete=false и cursor — повторить с ним.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      filter: filterSchema,
      groupBy: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
        .optional()
        .describe(
          'Поле группировки: ASSIGNED_BY_ID, STAGE_ID, STATUS_ID, SOURCE_ID, CATEGORY_ID, DATE_CREATE…',
        ),
      period: z
        .enum(['day', 'week', 'month', 'year'])
        .default('month')
        .describe('Шаг для группировки по дате'),
      sumField: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
        .optional()
        .describe('Числовое поле для суммы по группам, например OPPORTUNITY'),
      top: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Сколько групп показать; остальные — одной строкой'),
      maxSeconds: maxSecondsArg,
      cursor: continueCursorArg,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.string(),
    total: z.number(),
    groupBy: z.string().nullable(),
    groups: z.array(groupOut),
    groupCount: z.number(),
    sumTotal: z.number().optional(),
    complete: z.boolean(),
    cursor: z.string().nullable(),
  }),
  handler: async (args, ctx) => {
    const entity = classicEntity(args.entityType);
    const prep = await prepareScan(ctx, entity, args.filter, ['ID']);
    const method = `${entity.methodBase}.list`;
    for (const f of [args.groupBy, args.sumField]) {
      if (f && !Object.hasOwn(prep.meta, f))
        throw new AppError('VALIDATION_ERROR', `${f}: поле неизвестно порталу`, {
          field: f === args.groupBy ? 'groupBy' : 'sumField',
          reason: 'UNKNOWN_FIELD',
          nextAction: 'Сверьтесь со схемой полей: crm_fields_get',
        });
    }
    const meta = (extra: string[] = [], partial = false) => ({
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      method,
      apiVersion: 'legacy' as const,
      completeness: partial ? ('partial' as const) : ('complete' as const),
      warnings: extra,
    });

    // Просто число: total портала, без обхода.
    if (!args.groupBy && !args.sumField && prep.local.length === 0) {
      const r = await ctx.bitrix.call(
        'legacy',
        method,
        { filter: prep.upstream, select: ['ID'], order: { ID: 'ASC' }, start: 0 },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      if (!Array.isArray(r.result)) throw upstreamShapeError(method, 'legacy');
      const total = r.total ?? r.result.length;
      return ok(
        {
          entityType: entity.type,
          total,
          groupBy: null,
          groups: [],
          groupCount: 0,
          complete: true,
          cursor: null,
        },
        meta(),
      );
    }

    const groupField = args.groupBy;
    const isDate = groupField ? DATE_TYPES.has(prep.meta[groupField]?.type ?? '') : false;
    const select = [
      groupField,
      args.sumField,
      entity.type === 'deal' && groupField === 'STAGE_ID' ? 'CATEGORY_ID' : undefined,
    ].filter((f): f is string => !!f);
    const binding = cursorBinding(ctx, 'crm_count', {
      entity: entity.type,
      filter: args.filter,
      groupBy: groupField ?? null,
      period: isDate ? args.period : null,
      sumField: args.sumField ?? null,
    });
    const state: CountState = args.cursor
      ? await ctx.cursors.peek<CountState>(args.cursor, binding)
      : { afterId: 0, scanned: 0, groups: [] };
    const groups = new Map<string, { count: number; sum: number }>(
      state.groups.map(([k, c, s]) => [k, { count: c, sum: s }]),
    );
    const keyOf = (row: Record<string, JsonValue>): string => {
      if (!groupField) return '';
      const v = row[groupField];
      if (isDate) return dateKey(asText(v), args.period);
      if (Array.isArray(v)) return v.map(asText).join(', ');
      return asText(v);
    };
    const deadline = deadlineOf(ctx, args.maxSeconds);
    let done = false;
    while (Date.now() < deadline) {
      const batch = await scanBatch(ctx, entity, {
        filter: prep.upstream,
        local: prep.local,
        select,
        afterId: state.afterId,
      });
      for (const row of batch.rows) {
        const key = keyOf(row);
        const g = groups.get(key) ?? { count: 0, sum: 0 };
        g.count += 1;
        if (args.sumField) g.sum += num(row[args.sumField]) ?? 0;
        groups.set(key, g);
      }
      if (groups.size > MAX_GROUPS)
        throw new AppError(
          'VALIDATION_ERROR',
          `Слишком много групп (>${String(MAX_GROUPS)}): выберите другое поле`,
          {
            field: 'groupBy',
          },
        );
      state.scanned += batch.rows.length;
      state.afterId = batch.lastId;
      if (batch.done) {
        done = true;
        break;
      }
    }
    if (args.cursor) await ctx.cursors.discard(args.cursor);
    state.groups = [...groups].map(([k, g]) => [k, g.count, Math.round(g.sum * 100) / 100]);

    const sorted = [...groups].sort((a, b) =>
      isDate ? a[0].localeCompare(b[0]) : b[1].count - a[1].count || a[0].localeCompare(b[0]),
    );
    const shown = sorted.slice(0, args.top);
    const rest = sorted.slice(args.top);

    // Названия групп: ФИО, стадии, источники, воронки, компании.
    const names = new NameResolver(ctx);
    const ref = groupField && !isDate ? refColumnFor(entity.type, groupField) : undefined;
    const fakeRow = (key: string): Record<string, JsonValue> => {
      const cat = /^C(\d+):/.exec(key);
      return { [groupField ?? 'ID']: key, CATEGORY_ID: cat ? (cat[1] ?? '0') : '0' };
    };
    if (ref)
      await names.prepare(
        shown.map(([k]) => fakeRow(k)),
        [ref],
      );
    const enumItems = groupField ? prep.meta[groupField]?.items : undefined;
    const labelOf = (key: string): string => {
      if (!groupField) return 'всего';
      if (key === '') return '(не заполнено)';
      if (ref) return names.label(ref, fakeRow(key)) || key;
      const item = enumItems?.find((i) => i.ID === key);
      return item?.VALUE ?? key;
    };
    const round = (n: number) => Math.round(n * 100) / 100;
    const out = shown.map(([key, g]) => ({
      key,
      label: labelOf(key),
      count: g.count,
      ...(args.sumField ? { sum: round(g.sum) } : {}),
    }));
    if (rest.length)
      out.push({
        key: '*',
        label: `прочие (${String(rest.length)} групп)`,
        count: rest.reduce((s, [, g]) => s + g.count, 0),
        ...(args.sumField ? { sum: round(rest.reduce((s, [, g]) => s + g.sum, 0)) } : {}),
      });
    const total = [...groups.values()].reduce((s, g) => s + g.count, 0);
    const warnings = [...names.warnings];
    if (prep.local.length)
      warnings.push('Условия «!%» (не содержит) проверены сервером MCP, без учёта регистра');
    let cursor: string | null = null;
    if (!done) {
      cursor = await ctx.cursors.create(binding, state);
      warnings.push(
        `Подсчёт не закончен за ${String(args.maxSeconds)} с (просмотрено ${String(state.scanned)}): повторите с cursor — итоги накопятся`,
      );
    }
    return ok(
      {
        entityType: entity.type,
        total,
        groupBy: groupField ? (isDate ? `${groupField}:${args.period}` : groupField) : null,
        groups: out,
        groupCount: groups.size,
        ...(args.sumField ? { sumTotal: round([...groups.values()].reduce((s, g) => s + g.sum, 0)) } : {}),
        complete: done,
        cursor,
      },
      meta(warnings, !done),
    );
  },
});

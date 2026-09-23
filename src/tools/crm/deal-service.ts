/**
 * Сервис сделок: единственное место, где инструменты CRM обращаются к клиенту Bitrix.
 * Классический REST: crm.deal.fields / list / get / add (ТЗ §9.4, §10.2: MVP = entityType deal).
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { bindingHash, paginateLegacy, type PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import type { ToolContext } from '../types.js';
import { asText, parseFieldsResult, type DealFieldsMeta } from './deal-fields.js';

const FIELDS_CACHE_KIND = 'fields';
const FIELDS_CACHE_ID = 'crm.deal';

export async function getDealFieldsMeta(ctx: ToolContext, refresh = false): Promise<DealFieldsMeta> {
  if (!refresh) {
    const cached = ctx.capabilities.getCached<DealFieldsMeta>(FIELDS_CACHE_KIND, FIELDS_CACHE_ID);
    if (cached) return cached;
  }
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.deal.fields',
    {},
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const meta = parseFieldsResult(r.result);
  ctx.capabilities.setCached(FIELDS_CACHE_KIND, FIELDS_CACHE_ID, meta);
  return meta;
}

export interface ListDealsArgs {
  filter: JsonObject;
  order: Record<string, 'ASC' | 'DESC'>;
  select: string[] | undefined;
  pageSize: number;
  cursor: string | undefined;
}

export type DealRecord = Record<string, JsonValue>;

export async function listDeals(ctx: ToolContext, args: ListDealsArgs): Promise<PageResult> {
  const binding = {
    principalId: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    tool: 'crm_list_records',
    bindingHash: bindingHash({
      entityType: 'deal',
      filter: args.filter,
      order: args.order,
      select: args.select,
      pageSize: args.pageSize,
    }),
  };
  return paginateLegacy({
    store: ctx.cursors,
    binding,
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: async (start) => {
      const params: JsonObject = { filter: args.filter, order: args.order, start };
      if (args.select) params['select'] = args.select;
      const r = await ctx.bitrix.call('legacy', 'crm.deal.list', params, {
        requestId: ctx.requestId,
        signal: ctx.signal,
      });
      if (!Array.isArray(r.result)) {
        throw new AppError('BITRIX_UPSTREAM_ERROR', 'crm.deal.list вернул не массив', {
          method: 'crm.deal.list',
          apiVersion: 'legacy',
        });
      }
      return { items: r.result, next: r.next, total: r.total };
    },
  });
}

export async function getDeal(ctx: ToolContext, id: number): Promise<DealRecord> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.deal.get',
    { id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) {
    // Bitrix возвращает ошибку NOT_FOUND в теле; пустой/ложный result трактуем так же, не раскрывая существование.
    throw new AppError('NOT_FOUND', 'Сделка не найдена или недоступна', {
      method: 'crm.deal.get',
      apiVersion: 'legacy',
    });
  }
  return r.result;
}

export function pickFields(record: DealRecord, select: string[] | undefined): DealRecord {
  if (!select || select.includes('*')) return record;
  const out: DealRecord = {};
  for (const s of select) {
    if (s === 'UF_*') {
      for (const [k, v] of Object.entries(record)) if (k.startsWith('UF_')) out[k] = v;
      continue;
    }
    const v = record[s];
    if (v !== undefined) out[s] = v;
  }
  return out;
}

/** Хеш состояния для expectedStateHash: все поля записи, кроме служебных дат изменения. */
export function dealStateHash(record: DealRecord): string {
  const { DATE_MODIFY: _dm, ...rest } = record;
  return stateHash(rest);
}

/** Ключевые поля, попадающие в план и в сверку после создания (§15.3). */
export const DEAL_KEY_FIELDS = [
  'TITLE',
  'CATEGORY_ID',
  'STAGE_ID',
  'ASSIGNED_BY_ID',
  'OPPORTUNITY',
  'CURRENCY_ID',
] as const;

export async function createDeal(ctx: ToolContext, fields: JsonObject): Promise<number> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.deal.add',
    { fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const id =
    typeof r.result === 'number'
      ? r.result
      : typeof r.result === 'string' && /^\d+$/.test(r.result)
        ? Number(r.result)
        : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('OPERATION_OUTCOME_UNKNOWN', 'crm.deal.add вернул ответ без ID; исход неизвестен', {
      method: 'crm.deal.add',
      apiVersion: 'legacy',
      reason: 'outcome-unknown',
      nextAction: 'Проверьте список сделок в Bitrix24 перед повторной попыткой',
    });
  }
  return id;
}

/** Сверка созданной сделки с планом: по ключевым полям, переданным в запросе. */
export function compareKeyFields(
  requested: JsonObject,
  actual: DealRecord,
): { verified: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const key of DEAL_KEY_FIELDS) {
    if (!(key in requested)) continue;
    const want = asText(requested[key]);
    const got = asText(actual[key]);
    const same = key === 'OPPORTUNITY' ? Number(want.replace(',', '.')) === Number(got) : want === got;
    if (!same)
      warnings.push(
        `Поле ${key}: запрошено «${want}», в портале «${got}» (возможна автоматизация или значение по умолчанию)`,
      );
  }
  return { verified: asText(actual['TITLE']) === asText(requested['TITLE']), warnings };
}

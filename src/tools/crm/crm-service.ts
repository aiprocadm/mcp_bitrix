/**
 * Сервис классического CRM: единственное место, где инструменты CRM обращаются к клиенту Bitrix.
 * Методы crm.<entity>.fields / list / get / add / update для deal|lead|contact|company (ТЗ §9.4),
 * справочники crm.category.list / crm.status.list / crm.status.entity.types и поиск дублей
 * crm.duplicate.findbycomm. Только методы из реестра; результаты нормализуются, форма проверяется.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { bindingHash, paginateLegacy, type PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import type { ToolContext } from '../types.js';
import { asText, parseFieldsResult, type DealFieldsMeta } from './deal-fields.js';
import { dealStageEntityId, type ClassicEntity } from './entities.js';

const FIELDS_CACHE_KIND = 'fields';
const STATUS_CACHE_KIND = 'statuses';

export type CrmRecord = Record<string, JsonValue>;
export type FieldsMeta = DealFieldsMeta;

function upstream(method: string, message: string): AppError {
  return new AppError('BITRIX_UPSTREAM_ERROR', message, { method, apiVersion: 'legacy' });
}

export async function getFieldsMeta(
  ctx: ToolContext,
  entity: ClassicEntity,
  refresh = false,
): Promise<FieldsMeta> {
  const method = `${entity.methodBase}.fields`;
  if (!refresh) {
    const cached = ctx.capabilities.getCached<FieldsMeta>(FIELDS_CACHE_KIND, entity.methodBase);
    if (cached) return cached;
  }
  const r = await ctx.bitrix.call('legacy', method, {}, { requestId: ctx.requestId, signal: ctx.signal });
  const meta = parseFieldsResult(r.result, method);
  ctx.capabilities.setCached(FIELDS_CACHE_KIND, entity.methodBase, meta);
  return meta;
}

export interface ListArgs {
  filter: JsonObject;
  order: Record<string, 'ASC' | 'DESC'>;
  select: string[] | undefined;
  pageSize: number;
  cursor: string | undefined;
}

export async function listRecords(
  ctx: ToolContext,
  entity: ClassicEntity,
  args: ListArgs,
): Promise<PageResult> {
  const method = `${entity.methodBase}.list`;
  const binding = {
    principalId: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    tool: 'crm_list_records',
    bindingHash: bindingHash({
      entityType: entity.type,
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
      const r = await ctx.bitrix.call('legacy', method, params, {
        requestId: ctx.requestId,
        signal: ctx.signal,
      });
      if (!Array.isArray(r.result)) throw upstream(method, `${method} вернул не массив`);
      return { items: r.result, next: r.next, total: r.total };
    },
  });
}

/** Одна страница списка без курсора (поиск, выборка по ID): до `limit` записей. */
export async function listOnce(
  ctx: ToolContext,
  entity: ClassicEntity,
  filter: JsonObject,
  select: readonly string[],
  limit: number,
): Promise<{ items: CrmRecord[]; hasMore: boolean }> {
  const method = `${entity.methodBase}.list`;
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { filter, order: { ID: 'DESC' }, select: [...select], start: 0 },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstream(method, `${method} вернул не массив`);
  const items = (r.result as unknown[]).filter(
    (x): x is CrmRecord => !!x && typeof x === 'object' && !Array.isArray(x),
  );
  return { items: items.slice(0, limit), hasMore: items.length > limit || r.next !== undefined };
}

export async function getRecord(ctx: ToolContext, entity: ClassicEntity, id: number): Promise<CrmRecord> {
  const method = `${entity.methodBase}.get`;
  const r = await ctx.bitrix.call('legacy', method, { id }, { requestId: ctx.requestId, signal: ctx.signal });
  if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) {
    // Bitrix возвращает ошибку NOT_FOUND в теле; пустой/ложный result трактуем так же, не раскрывая существование.
    throw new AppError('NOT_FOUND', `Запись (${entity.label}) не найдена или недоступна`, {
      method,
      apiVersion: 'legacy',
    });
  }
  return r.result;
}

export function pickFields(record: CrmRecord, select: string[] | undefined): CrmRecord {
  if (!select || select.includes('*')) return record;
  const out: CrmRecord = {};
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
export function recordStateHash(record: CrmRecord): string {
  const { DATE_MODIFY: _dm, ...rest } = record;
  return stateHash(rest);
}

function idFromResult(result: unknown): number {
  const id =
    typeof result === 'number'
      ? result
      : typeof result === 'string' && /^\d+$/.test(result)
        ? Number(result)
        : NaN;
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

export async function createRecord(
  ctx: ToolContext,
  entity: ClassicEntity,
  fields: JsonObject,
): Promise<number> {
  const method = `${entity.methodBase}.add`;
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const id = idFromResult(r.result);
  if (Number.isNaN(id)) {
    throw new AppError('OPERATION_OUTCOME_UNKNOWN', `${method} вернул ответ без ID; исход неизвестен`, {
      method,
      apiVersion: 'legacy',
      reason: 'outcome-unknown',
      nextAction: `Проверьте список (${entity.label}) в Bitrix24 перед повторной попыткой`,
    });
  }
  return id;
}

/** crm.<entity>.update возвращает true; иное — исход неизвестен (запись могла пройти). */
export async function updateRecord(
  ctx: ToolContext,
  entity: ClassicEntity,
  id: number,
  fields: JsonObject,
): Promise<void> {
  const method = `${entity.methodBase}.update`;
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { id, fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (r.result !== true) {
    throw new AppError('OPERATION_OUTCOME_UNKNOWN', `${method} не подтвердил изменение; исход неизвестен`, {
      method,
      apiVersion: 'legacy',
      reason: 'outcome-unknown',
      nextAction: 'Прочитайте запись crm_get_record и сверьте поля перед повторной попыткой',
    });
  }
}

function sameValue(key: string, want: unknown, got: unknown): boolean {
  const w = asText(want);
  const g = asText(got);
  if (key === 'OPPORTUNITY' || key === 'REVENUE')
    return Number(w.replace(',', '.')) === Number(g.replace(',', '.'));
  return w === g;
}

/** Сверка записи с запрошенными полями (§15.3): verified — по названию/имени, остальное — warnings. */
export function compareFields(
  entity: ClassicEntity,
  requested: JsonObject,
  actual: CrmRecord,
  keys: readonly string[] = entity.keyFields,
): { verified: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let verified = true;
  const titleKeys = entity.type === 'contact' ? ['NAME', 'LAST_NAME'] : ['TITLE'];
  for (const key of keys) {
    if (!(key in requested)) continue;
    const want = requested[key];
    if (want !== null && typeof want === 'object') continue; // множественные/составные поля не сверяем построчно
    if (!sameValue(key, want, actual[key])) {
      if (titleKeys.includes(key)) verified = false;
      warnings.push(
        `Поле ${key}: запрошено «${asText(want)}», в портале «${asText(actual[key])}» (возможна автоматизация или значение по умолчанию)`,
      );
    }
  }
  return { verified, warnings };
}

// ---------- справочники ----------

export interface StatusItem {
  statusId: string;
  name: string;
  sort: number;
  entityId: string;
  semantics: string | undefined;
  categoryId: number | undefined;
}

export async function listStatuses(
  ctx: ToolContext,
  entityId: string,
  refresh = false,
): Promise<StatusItem[]> {
  if (!refresh) {
    const cached = ctx.capabilities.getCached<StatusItem[]>(STATUS_CACHE_KIND, entityId);
    if (cached) return cached;
  }
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.status.list',
    { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstream('crm.status.list', 'crm.status.list вернул не массив');
  const items: StatusItem[] = (r.result as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      statusId: asText(x['STATUS_ID']),
      name: asText(x['NAME']),
      sort: Number(asText(x['SORT'])) || 0,
      entityId: asText(x['ENTITY_ID']) || entityId,
      semantics: asText(x['SEMANTICS']) || undefined,
      categoryId:
        x['CATEGORY_ID'] === undefined || x['CATEGORY_ID'] === null
          ? undefined
          : Number(asText(x['CATEGORY_ID'])),
    }))
    .filter((s) => s.statusId !== '');
  ctx.capabilities.setCached(STATUS_CACHE_KIND, entityId, items);
  return items;
}

export interface CategoryItem {
  id: number;
  name: string;
  sort: number;
  isDefault: boolean;
}

export async function listCategories(ctx: ToolContext, entityTypeId: number): Promise<CategoryItem[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.category.list',
    { entityTypeId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const raw =
    r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result['categories'] : undefined;
  if (!Array.isArray(raw)) throw upstream('crm.category.list', 'crm.category.list вернул неожиданную форму');
  return (raw as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: Number(asText(x['id'])),
      name: asText(x['name']),
      sort: Number(asText(x['sort'])) || 0,
      isDefault: x['isDefault'] === true || asText(x['isDefault']) === 'Y',
    }))
    .filter((c) => Number.isInteger(c.id));
}

export interface StatusEntityType {
  id: string;
  name: string;
  entityTypeId: number | undefined;
  categoryId: number | undefined;
}

export async function listStatusEntityTypes(ctx: ToolContext): Promise<StatusEntityType[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.status.entity.types',
    {},
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result))
    throw upstream('crm.status.entity.types', 'crm.status.entity.types вернул не массив');
  return (r.result as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: asText(x['ID']),
      name: asText(x['NAME']),
      entityTypeId: x['ENTITY_TYPE_ID'] === undefined ? undefined : Number(asText(x['ENTITY_TYPE_ID'])),
      categoryId: x['CATEGORY_ID'] === undefined ? undefined : Number(asText(x['CATEGORY_ID'])),
    }))
    .filter((s) => s.id !== '');
}

/**
 * INVALID_STAGE (§9.4): STAGE_ID сделки должен принадлежать её воронке, STATUS_ID лида — справочнику STATUS.
 * Проверяется до плана; справочник читается с портала (кэш 5 минут).
 */
export async function assertStageValid(
  ctx: ToolContext,
  entity: ClassicEntity,
  fields: JsonObject,
  current: CrmRecord | undefined,
): Promise<void> {
  if (!entity.stageField || !(entity.stageField in fields)) return;
  const wanted = asText(fields[entity.stageField]);
  const entityId =
    entity.type === 'deal'
      ? dealStageEntityId(Number(asText(fields['CATEGORY_ID'] ?? current?.['CATEGORY_ID'] ?? 0)) || 0)
      : 'STATUS';
  const statuses = await listStatuses(ctx, entityId);
  if (!statuses.some((s) => s.statusId === wanted)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${entity.stageField}: стадия «${wanted}» отсутствует в справочнике ${entityId}; допустимо: ${statuses.map((s) => s.statusId).join(', ') || 'нет данных'}`,
      {
        field: entity.stageField,
        reason: 'INVALID_STAGE',
        nextAction: 'Проверьте стадии: crm_stages_and_statuses',
      },
    );
  }
}

export type CommType = 'PHONE' | 'EMAIL';

/** crm.duplicate.findbycomm: ID лидов/контактов/компаний по телефону или email (до 20 значений). */
export async function findByComm(
  ctx: ToolContext,
  type: CommType,
  values: string[],
  entityType?: 'LEAD' | 'CONTACT' | 'COMPANY',
): Promise<Record<'LEAD' | 'CONTACT' | 'COMPANY', number[]>> {
  const params: JsonObject = { type, values };
  if (entityType) params['entity_type'] = entityType;
  const r = await ctx.bitrix.call('legacy', 'crm.duplicate.findbycomm', params, {
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  const out: Record<'LEAD' | 'CONTACT' | 'COMPANY', number[]> = { LEAD: [], CONTACT: [], COMPANY: [] };
  if (r.result && typeof r.result === 'object' && !Array.isArray(r.result)) {
    for (const key of ['LEAD', 'CONTACT', 'COMPANY'] as const) {
      const ids = r.result[key];
      if (Array.isArray(ids))
        out[key] = ids.map((v) => Number(asText(v))).filter((n) => Number.isInteger(n) && n > 0);
    }
  }
  return out;
}

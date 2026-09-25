/**
 * Реквизиты CRM, их шаблоны, адреса и банковские реквизиты (ТЗ §9.4, S12).
 * Только методы из src/bitrix/registry/crm-requisites.ts; формы ответов проверяются по документации:
 *  - crm.requisite.list / preset.list / address.list — result: массив, total, next (страницы по 50);
 *  - crm.requisite.get / bankdetail.get — result: объект полей;
 *  - crm.requisite.fields / bankdetail.fields — result: описание полей (как crm.deal.fields);
 *  - crm.requisite.add / bankdetail.add — result: ID; crm.requisite.update, crm.address.add/update — result: true.
 * Привязки (ТЗ §9.4): реквизит принадлежит контакту (ENTITY_TYPE_ID=3) или компании (4);
 * адрес принадлежит РЕКВИЗИТУ (ENTITY_TYPE_ID=8, ENTITY_ID = ID реквизита), а не компании.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import type { PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, legacyListPage, num, outcomeUnknown, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';
import { parseFieldsResult, type DealFieldsMeta } from './deal-fields.js';

const opts = (ctx: ToolContext) => ({ requestId: ctx.requestId, signal: ctx.signal });

/** Владелец реквизита по документации crm.requisite.add: только контакт (3) или компания (4). */
export const REQUISITE_OWNER_TYPES = { 3: 'contact', 4: 'company' } as const;
export type RequisiteOwnerTypeId = keyof typeof REQUISITE_OWNER_TYPES;

/**
 * Тип владельца адреса «реквизит» — 8 (документация crm.address.*: «ENTITY_TYPE_ID: 8 — requisite, 1 — lead»).
 * Не путать с ENTITY_TYPE_ID компании/контакта и не подставлять ID компании в ENTITY_ID адреса.
 */
export const ADDRESS_OWNER_REQUISITE = 8;

/**
 * Страна шаблона «Россия»: COUNTRY_ID=1, CODE=RU (пример ответа crm.requisite.preset.countries).
 * Используется только для базовой проверки форматов российских банковских реквизитов.
 */
export const COUNTRY_ID_RU = 1;

export type Requisite = Record<string, JsonValue>;

// ---------- метаданные полей ----------

const FIELDS_CACHE_KIND = 'fields';

async function fieldsMeta(ctx: ToolContext, method: string): Promise<DealFieldsMeta> {
  const cached = ctx.capabilities.getCached<DealFieldsMeta>(FIELDS_CACHE_KIND, method);
  if (cached) return cached;
  const r = await ctx.bitrix.call('legacy', method, {}, opts(ctx));
  const meta = parseFieldsResult(r.result, method);
  ctx.capabilities.setCached(FIELDS_CACHE_KIND, method, meta);
  return meta;
}

export const requisiteFieldsMeta = (ctx: ToolContext) => fieldsMeta(ctx, 'crm.requisite.fields');
export const bankDetailFieldsMeta = (ctx: ToolContext) => fieldsMeta(ctx, 'crm.requisite.bankdetail.fields');

// ---------- реквизиты ----------

/**
 * Поля реквизита, которые список отдаёт по умолчанию: идентификация организации/ИП без персональных документов.
 * Паспортные данные (RQ_IDENT_DOC*), персональные номера (PESEL/CPF/DRFO) не запрашиваются вообще (§8.4).
 */
export const REQUISITE_DEFAULT_SELECT = [
  'ID',
  'ENTITY_TYPE_ID',
  'ENTITY_ID',
  'PRESET_ID',
  'NAME',
  'ACTIVE',
  'SORT',
  'RQ_COMPANY_NAME',
  'RQ_COMPANY_FULL_NAME',
  'RQ_INN',
  'RQ_KPP',
  'RQ_OGRN',
  'RQ_OGRNIP',
  'RQ_DIRECTOR',
  'RQ_ACCOUNTANT',
  'DATE_CREATE',
  'DATE_MODIFY',
] as const;

/** Персональные идентификаторы и документы: не читаются и не выдаются этим сервером (§8.4). */
export const REQUISITE_SENSITIVE_FIELD = /^RQ_(IDENT_|PESEL$|CPF$|DRFO$)/;

export async function requisitesPage(
  ctx: ToolContext,
  args: {
    ownerEntityTypeId: number;
    ownerId: number;
    select: readonly string[];
    pageSize: number;
    cursor: string | undefined;
  },
): Promise<PageResult> {
  return legacyListPage(ctx, {
    tool: 'crm_requisites_list',
    method: 'crm.requisite.list',
    params: {
      filter: { ENTITY_TYPE_ID: args.ownerEntityTypeId, ENTITY_ID: args.ownerId },
      select: [...args.select],
      order: { SORT: 'ASC', ID: 'ASC' },
    },
    bindingParts: {
      ownerEntityTypeId: args.ownerEntityTypeId,
      ownerId: args.ownerId,
      select: args.select,
    },
    pageSize: args.pageSize,
    cursor: args.cursor,
  });
}

export async function getRequisite(ctx: ToolContext, id: number): Promise<Requisite> {
  const r = await ctx.bitrix.call('legacy', 'crm.requisite.get', { id }, opts(ctx));
  if (!isObj(r.result) || idOf(r.result['ID']) === undefined) {
    throw new AppError('NOT_FOUND', 'Реквизит не найден или недоступен', {
      method: 'crm.requisite.get',
      apiVersion: 'legacy',
      nextAction: 'Найдите ID реквизита через crm_requisites_list',
    });
  }
  // Персональные документы не покидают сервис даже во внутренних планах.
  const out: Requisite = {};
  for (const [k, v] of Object.entries(r.result)) if (!REQUISITE_SENSITIVE_FIELD.test(k)) out[k] = v;
  return out;
}

/** Хеш состояния реквизита: все поля, кроме служебных отметок изменения. */
export function requisiteStateHash(r: Requisite): string {
  const { DATE_MODIFY: _dm, MODIFY_BY_ID: _mb, ...rest } = r;
  return stateHash(rest);
}

export async function addRequisite(ctx: ToolContext, fields: JsonObject): Promise<number> {
  const r = await ctx.bitrix.call('legacy', 'crm.requisite.add', { fields }, opts(ctx));
  const id = idOf(r.result);
  if (id === undefined) {
    throw outcomeUnknown(
      'crm.requisite.add',
      'legacy',
      'Проверьте реквизиты владельца (crm_requisites_list) перед повторной попыткой',
    );
  }
  return id;
}

export async function updateRequisite(ctx: ToolContext, id: number, fields: JsonObject): Promise<void> {
  const r = await ctx.bitrix.call('legacy', 'crm.requisite.update', { id, fields }, opts(ctx));
  if (r.result !== true) {
    throw outcomeUnknown(
      'crm.requisite.update',
      'legacy',
      'Прочитайте реквизит (crm_requisites_list) и сверьте с планом перед повтором',
    );
  }
}

// ---------- шаблоны ----------

export interface Preset {
  id: number;
  name: string;
  countryId: number | undefined;
  active: boolean;
  entityTypeId: number | undefined;
}

export function normalizePreset(raw: JsonValue): Preset | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  return {
    id,
    name: asText(raw['NAME']),
    countryId: num(raw['COUNTRY_ID']),
    active: raw['ACTIVE'] === undefined ? true : asText(raw['ACTIVE']).toUpperCase() === 'Y',
    entityTypeId: num(raw['ENTITY_TYPE_ID']),
  };
}

const PRESET_SELECT = ['ID', 'NAME', 'COUNTRY_ID', 'ACTIVE', 'ENTITY_TYPE_ID', 'SORT'];

export async function presetsPage(
  ctx: ToolContext,
  args: { countryId: number | undefined; activeOnly: boolean; pageSize: number; cursor: string | undefined },
): Promise<PageResult> {
  const filter: JsonObject = {};
  if (args.countryId !== undefined) filter['COUNTRY_ID'] = args.countryId;
  if (args.activeOnly) filter['ACTIVE'] = 'Y';
  return legacyListPage(ctx, {
    tool: 'crm_requisite_presets_list',
    method: 'crm.requisite.preset.list',
    params: { filter, select: PRESET_SELECT, order: { SORT: 'ASC', ID: 'ASC' } },
    bindingParts: { countryId: args.countryId ?? null, activeOnly: args.activeOnly },
    pageSize: args.pageSize,
    cursor: args.cursor,
  });
}

/** Шаблон по ID через crm.requisite.preset.list (документированный способ получить шаблоны). */
export async function findPreset(ctx: ToolContext, presetId: number): Promise<Preset | undefined> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.requisite.preset.list',
    { filter: { ID: presetId }, select: PRESET_SELECT },
    opts(ctx),
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError('crm.requisite.preset.list', 'legacy');
  return r.result.map(normalizePreset).find((p) => p?.id === presetId);
}

export interface PresetField {
  fieldName: string;
  title: string;
  sort: number;
}

/** Настраиваемые поля шаблона (crm.requisite.preset.field.list, параметр preset: {ID}). */
export async function presetFields(ctx: ToolContext, presetId: number): Promise<PresetField[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.requisite.preset.field.list',
    { preset: { ID: presetId } },
    opts(ctx),
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError('crm.requisite.preset.field.list', 'legacy');
  return r.result
    .filter(isObj)
    .map((f) => ({
      fieldName: asText(f['FIELD_NAME']),
      title: asText(f['FIELD_TITLE']),
      sort: num(f['SORT']) ?? 0,
    }))
    .filter((f) => f.fieldName !== '' && !REQUISITE_SENSITIVE_FIELD.test(f.fieldName))
    .sort((a, b) => a.sort - b.sort);
}

// ---------- адреса ----------

export const ADDRESS_TEXT_FIELDS = [
  'ADDRESS_1',
  'ADDRESS_2',
  'CITY',
  'POSTAL_CODE',
  'REGION',
  'PROVINCE',
  'COUNTRY',
] as const;
export type AddressTextField = (typeof ADDRESS_TEXT_FIELDS)[number];
export type AddressText = Partial<Record<AddressTextField, string>>;

export interface AddressType {
  id: number;
  name: string;
}

export async function addressTypes(ctx: ToolContext): Promise<AddressType[]> {
  const r = await ctx.bitrix.call('legacy', 'crm.enum.addresstype', {}, opts(ctx));
  if (!Array.isArray(r.result)) throw upstreamShapeError('crm.enum.addresstype', 'legacy');
  return r.result
    .filter(isObj)
    .map((t) => ({ id: idOf(t['ID']), name: asText(t['NAME']) }))
    .filter((t): t is AddressType => t.id !== undefined);
}

export function addressText(raw: Record<string, JsonValue>): Record<AddressTextField, string> {
  const out = {} as Record<AddressTextField, string>;
  for (const f of ADDRESS_TEXT_FIELDS) out[f] = asText(raw[f]);
  return out;
}

/** Адреса реквизита (ENTITY_TYPE_ID=8); typeId сужает до одного типа. Реквизит — не более 1 адреса каждого типа. */
export async function requisiteAddresses(
  ctx: ToolContext,
  requisiteIds: readonly number[],
  typeId?: number,
): Promise<Record<string, JsonValue>[]> {
  if (requisiteIds.length === 0) return [];
  const filter: JsonObject = {
    ENTITY_TYPE_ID: ADDRESS_OWNER_REQUISITE,
    ...(requisiteIds.length === 1
      ? { ENTITY_ID: requisiteIds[0] ?? 0 }
      : { '@ENTITY_ID': [...requisiteIds] }),
  };
  if (typeId !== undefined) filter['TYPE_ID'] = typeId;
  const out: Record<string, JsonValue>[] = [];
  let start: number | undefined = 0;
  // Адресов у реквизита немного (по одному на тип); 4 страницы по 50 — с запасом для страницы списка реквизитов.
  for (let i = 0; i < 4 && start !== undefined; i += 1) {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.address.list',
      { filter, select: ['TYPE_ID', 'ENTITY_TYPE_ID', 'ENTITY_ID', ...ADDRESS_TEXT_FIELDS], start },
      opts(ctx),
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError('crm.address.list', 'legacy');
    out.push(...r.result.filter(isObj));
    start = r.result.length === 0 ? undefined : r.next;
  }
  return out;
}

export async function writeAddress(
  ctx: ToolContext,
  mode: 'create' | 'update',
  fields: JsonObject,
): Promise<void> {
  const method = mode === 'create' ? 'crm.address.add' : 'crm.address.update';
  const r = await ctx.bitrix.call('legacy', method, { fields }, opts(ctx));
  if (r.result !== true) {
    throw outcomeUnknown(method, 'legacy', 'Прочитайте адреса реквизита и сверьте с планом перед повтором');
  }
}

// ---------- банковские реквизиты ----------

export async function addBankDetail(ctx: ToolContext, fields: JsonObject): Promise<number> {
  const r = await ctx.bitrix.call('legacy', 'crm.requisite.bankdetail.add', { fields }, opts(ctx));
  const id = idOf(r.result);
  if (id === undefined) {
    throw outcomeUnknown(
      'crm.requisite.bankdetail.add',
      'legacy',
      'Проверьте банковские реквизиты в карточке перед повторной попыткой',
    );
  }
  return id;
}

export async function getBankDetail(ctx: ToolContext, id: number): Promise<Record<string, JsonValue>> {
  const r = await ctx.bitrix.call('legacy', 'crm.requisite.bankdetail.get', { id }, opts(ctx));
  if (!isObj(r.result)) {
    throw new AppError('NOT_FOUND', 'Банковский реквизит не найден', {
      method: 'crm.requisite.bankdetail.get',
      apiVersion: 'legacy',
    });
  }
  return r.result;
}

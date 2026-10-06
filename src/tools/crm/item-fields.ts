/**
 * Метаданные полей универсального адаптера crm.item.* (ТЗ §9.1 fields, §9.4, §9.7, §10.2).
 * Схема crm.item.fields — СОБСТВЕННАЯ camelCase-схема метода (title, stageId, assignedById, ufCrm2_…);
 * автоматическое «переведение регистра» из UPPER_CASE классических методов запрещено: имя поля либо есть
 * в метаданных портала, либо это ошибка UNKNOWN_FIELD.
 * Источник: https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-fields.html
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { asText, isObj, own } from '../shared.js';
import type { FieldMeta } from './deal-fields.js';

export type ItemFieldsMeta = Record<string, FieldMeta>;

/** camelCase-имя поля crm.item.*: id, stageId, ufCrm2_1639669411830, parentId1220. */
export const ITEM_FIELD_NAME_RE = /^[a-z][A-Za-z0-9_]{0,99}$/;

/** result.fields → метаданные; форма проверяется, поле `id` обязано присутствовать. */
export function parseItemFieldsResult(result: unknown): ItemFieldsMeta {
  const raw = isObj(result) ? result['fields'] : undefined;
  if (!isObj(raw)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'crm.item.fields вернул неожиданную форму ответа', {
      method: 'crm.item.fields',
      apiVersion: 'legacy',
    });
  }
  const meta: ItemFieldsMeta = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!ITEM_FIELD_NAME_RE.test(name) || !isObj(v)) continue;
    const items = Array.isArray(v['items'])
      ? v['items'].filter(isObj).map((i) => ({ ID: asText(i['ID']), VALUE: asText(i['VALUE']) }))
      : undefined;
    meta[name] = {
      name,
      type: typeof v['type'] === 'string' ? v['type'] : 'string',
      title: typeof v['title'] === 'string' ? v['title'] : name,
      isRequired: v['isRequired'] === true,
      isReadOnly: v['isReadOnly'] === true,
      isImmutable: v['isImmutable'] === true,
      isMultiple: v['isMultiple'] === true,
      isDynamic: v['isDynamic'] === true,
      ...(typeof v['statusType'] === 'string' ? { statusType: v['statusType'] } : {}),
      ...(items ? { items } : {}),
    };
  }
  if (!meta['id']) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Схема полей crm.item.fields не содержит id', {
      method: 'crm.item.fields',
      apiVersion: 'legacy',
    });
  }
  return meta;
}

/**
 * Обязательность для create: isRequired && !isReadOnly. Поля типа boolean исключены: по странице crm.item.add
 * у них есть значение по умолчанию (например, opened — «Default — Y»), а crm.item.fields помечает их isRequired.
 */
export function isRequiredOnCreate(f: FieldMeta): boolean {
  return f.isRequired && !f.isReadOnly && f.type !== 'boolean';
}

function bad(field: string, message: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', `${field}: ${message}`, {
    field,
    ...(reason ? { reason } : {}),
    nextAction:
      'Сверьтесь со схемой полей: crm_fields_get (entityType smart/invoice/quote) — имена в camelCase',
  });
}

const INT_TYPES = new Set([
  'integer',
  'user',
  'crm_category',
  'crm_company',
  'crm_contact',
  'crm_lead',
  'crm_deal',
  'crm_quote',
  'crm_entity',
  'iblock_element',
  'iblock_section',
  'employee',
]);
const isIntLike = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v));
const isNumLike = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v));

function normalizeValue(f: FieldMeta, v: unknown): JsonValue {
  const t = f.type;
  if (INT_TYPES.has(t)) {
    if (!isIntLike(v)) throw bad(f.name, `ожидается целочисленный ID (тип ${t})`);
    return typeof v === 'number' ? v : Number(v);
  }
  if (t === 'double' || t === 'money') {
    if (!isNumLike(v)) throw bad(f.name, 'ожидается число');
    return typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  }
  if (t === 'boolean' || t === 'char') {
    if (v === true || v === 'Y' || v === 'y' || v === 1) return 'Y';
    if (v === false || v === 'N' || v === 'n' || v === 0) return 'N';
    throw bad(f.name, 'ожидается Y/N или boolean');
  }
  if (t === 'date' || t === 'datetime') {
    if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) {
      throw bad(f.name, 'ожидается дата ISO 8601 (например 2026-10-01 или 2026-10-01T10:00:00+03:00)');
    }
    return v;
  }
  if (t === 'enumeration') {
    const id = String(v);
    if (!f.items?.some((i) => i.ID === id)) {
      throw bad(
        f.name,
        `допустимые значения: ${(f.items ?? []).map((i) => `${i.ID} (${i.VALUE})`).join(', ') || 'нет'}`,
      );
    }
    return Number.isSafeInteger(Number(id)) ? Number(id) : id;
  }
  if (t === 'file' || t === 'crm_multifield' || t === 'location') {
    // Файлы (структура загрузки) и мультиполя через этот адаптер не пишутся: минимальный риск и ПДн (§8.4, §8.5).
    throw bad(f.name, `поле типа ${t} не поддерживается для записи через MCP`, 'UNSUPPORTED_FIELD_TYPE');
  }
  // string, text, url, crm_status, crm_currency и прочие строковые
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') throw bad(f.name, `ожидается строка (тип ${t})`);
  if (v.length > 20_000) throw bad(f.name, 'длиннее 20000 символов');
  return v;
}

/**
 * Проверка полей записи по метаданным портала: неизвестные (в т.ч. UPPER_CASE) → UNKNOWN_FIELD,
 * read-only → READ_ONLY_FIELD, immutable при update → IMMUTABLE_FIELD, обязательные при create → REQUIRED_FIELD_MISSING.
 */
export function validateItemFieldsForWrite(
  fields: Record<string, unknown>,
  meta: ItemFieldsMeta,
  mode: 'create' | 'update',
): JsonObject {
  const out: JsonObject = {};
  const keys = Object.keys(fields);
  if (keys.length === 0)
    throw new AppError('VALIDATION_ERROR', 'fields не может быть пустым', { field: 'fields' });
  if (keys.length > 200)
    throw new AppError('VALIDATION_ERROR', 'слишком много полей (>200)', { field: 'fields' });
  for (const key of keys) {
    const f = own(meta, key);
    if (!f) {
      throw bad(
        key,
        /^[A-Z]/.test(key)
          ? 'поле неизвестно порталу: у crm.item.* имена в camelCase (например title, stageId), регистр автоматически не переводится'
          : 'поле неизвестно порталу',
        'UNKNOWN_FIELD',
      );
    }
    if (key === 'id' || f.isReadOnly) throw bad(key, 'поле только для чтения', 'READ_ONLY_FIELD');
    if (mode === 'update' && f.isImmutable)
      throw bad(key, 'поле нельзя изменить после создания', 'IMMUTABLE_FIELD');
    const v = fields[key];
    if (v === undefined) continue;
    if (f.isMultiple) {
      if (!Array.isArray(v)) throw bad(key, 'множественное поле: ожидается массив');
      if (v.length > 100) throw bad(key, 'больше 100 значений');
      out[key] = v.map((x) => normalizeValue(f, x));
    } else {
      if (Array.isArray(v)) throw bad(key, 'поле не множественное: массив недопустим');
      out[key] = v === null ? null : normalizeValue(f, v);
    }
  }
  if (mode === 'create') {
    for (const f of Object.values(meta)) {
      if (isRequiredOnCreate(f) && (!(f.name in out) || out[f.name] === null || out[f.name] === '')) {
        throw new AppError('VALIDATION_ERROR', `${f.name} («${f.title}»): обязательное поле не заполнено`, {
          field: f.name,
          reason: 'REQUIRED_FIELD_MISSING',
          nextAction: 'Заполните поле; список обязательных — crm_fields_get',
        });
      }
    }
  }
  return out;
}

/** Префиксы фильтра crm.item.list (страница метода): >=, >, <=, <, @, !@, %, =%, %=, !%, !=%, !%=, =, !=, !. */
const FILTER_KEY_RE = /^(>=|<=|!=%|!%=|=%|%=|!%|!@|!=|@|!|%|>|<|=)?([a-z][A-Za-z0-9_]{0,99})$/;
const LIST_PREFIXES = new Set(['@', '!@']);

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar =>
  (typeof v === 'string' && v.length <= 500) ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  typeof v === 'boolean';

export function validateItemFilter(filter: Record<string, unknown>, meta: ItemFieldsMeta): JsonObject {
  const out: JsonObject = {};
  const entries = Object.entries(filter);
  if (entries.length > 30)
    throw new AppError('VALIDATION_ERROR', 'слишком много условий фильтра (>30)', { field: 'filter' });
  for (const [key, value] of entries) {
    const m = FILTER_KEY_RE.exec(key);
    if (!m)
      throw bad(
        `filter.${key.slice(0, 40)}`,
        'недопустимый ключ фильтра; формат crm.item.list: [префикс]имяПоля в camelCase, например >=createdTime или %title',
      );
    const prefix = m[1] ?? '';
    const field = m[2] ?? '';
    if (!own(meta, field)) throw bad(`filter.${field}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
    if (LIST_PREFIXES.has(prefix)) {
      if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every(isScalar)) {
        throw bad(`filter.${key}`, 'ожидается непустой массив скалярных значений (до 100)');
      }
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0 || value.length > 100 || !value.every(isScalar))
        throw bad(`filter.${key}`, 'массив: только скаляры, 1..100');
      out[key] = value;
      continue;
    }
    if (!isScalar(value))
      throw bad(`filter.${key}`, 'значение должно быть строкой (≤500), числом или boolean');
    out[key] = value;
  }
  return out;
}

export function validateItemOrder(
  order: Record<string, unknown>,
  meta: ItemFieldsMeta,
): Record<string, 'ASC' | 'DESC'> {
  const out: Record<string, 'ASC' | 'DESC'> = {};
  for (const [field, dir] of Object.entries(order)) {
    if (!own(meta, field))
      throw bad(`order.${field.slice(0, 40)}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
    const d = String(dir).toUpperCase();
    if (d !== 'ASC' && d !== 'DESC') throw bad(`order.${field}`, 'допустимо ASC или DESC');
    out[field] = d;
  }
  return out;
}

export function validateItemSelect(select: string[], meta: ItemFieldsMeta): string[] {
  if (select.length > 100)
    throw new AppError('VALIDATION_ERROR', 'select: больше 100 полей', { field: 'select' });
  for (const s of select) {
    if (s === '*') continue;
    if (!own(meta, s)) throw bad(`select.${s.slice(0, 40)}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
  }
  return select;
}

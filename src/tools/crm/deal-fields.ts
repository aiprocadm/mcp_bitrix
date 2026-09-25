/**
 * Метаданные полей сделки (crm.deal.fields) и metadata-validator (ТЗ §15.1 п.2, §9.4):
 * `fields`, `filter`, `order`, `select` принимают только известные порталу поля;
 * read-only поля не пишутся; обязательные — проверяются при создании; типы — по схеме.
 * Источник: https://apidocs.bitrix24.ru/api-reference/crm/deals/crm-deal-fields.html
 */
import { AppError } from '../../errors/app-error.js';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { own } from '../shared.js';

export interface FieldMeta {
  name: string;
  type: string;
  title: string;
  isRequired: boolean;
  isReadOnly: boolean;
  isImmutable: boolean;
  isMultiple: boolean;
  isDynamic: boolean;
  statusType?: string;
  items?: { ID: string; VALUE: string }[];
}

export type DealFieldsMeta = Record<string, FieldMeta>;

const FIELD_NAME_RE = /^[A-Z][A-Z0-9_]{0,99}$/;

/** Строка из скаляра Bitrix; объекты/массивы/null → пустая строка (без «[object Object]»). */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function parseFieldsResult(result: unknown, method = 'crm.deal.fields'): DealFieldsMeta {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', `${method} вернул неожиданную форму`, {
      method,
      apiVersion: 'legacy',
    });
  }
  const meta: DealFieldsMeta = {};
  for (const [name, raw] of Object.entries(result as Record<string, unknown>)) {
    if (!FIELD_NAME_RE.test(name) || !raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const items = Array.isArray(f['items'])
      ? (f['items'] as unknown[])
          .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
          .map((i) => ({ ID: asText(i['ID']), VALUE: asText(i['VALUE']) }))
      : undefined;
    meta[name] = {
      name,
      type: typeof f['type'] === 'string' ? f['type'] : 'string',
      title: typeof f['title'] === 'string' ? f['title'] : name,
      isRequired: f['isRequired'] === true,
      isReadOnly: f['isReadOnly'] === true,
      isImmutable: f['isImmutable'] === true,
      isMultiple: f['isMultiple'] === true,
      isDynamic: f['isDynamic'] === true,
      ...(typeof f['statusType'] === 'string' ? { statusType: f['statusType'] } : {}),
      ...(items ? { items } : {}),
    };
  }
  // У контакта нет TITLE (имя = NAME/LAST_NAME); минимальный инвариант любой схемы — поле ID.
  if (!meta['ID']) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', `Схема полей (${method}) не содержит ID`, {
      method,
      apiVersion: 'legacy',
    });
  }
  return meta;
}

function bad(field: string, message: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', `${field}: ${message}`, {
    field,
    ...(reason ? { reason } : {}),
    nextAction: 'Сверьтесь со схемой полей: crm_fields_get',
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
  'iblock_element',
  'iblock_section',
  'employee',
]);
const isIntLike = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v));
const isNumLike = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v));

/** Проверяет одно значение по типу поля; возвращает нормализованное значение. */
function normalizeValue(f: FieldMeta, v: unknown): JsonValue {
  const t = f.type;
  if (INT_TYPES.has(t)) {
    if (!isIntLike(v)) throw bad(f.name, `ожидается целочисленный ID (тип ${t})`);
    return typeof v === 'number' ? v : Number(v);
  }
  if (t === 'double' || t === 'money') {
    if (!isNumLike(v)) throw bad(f.name, 'ожидается число');
    return typeof v === 'number' ? v : String(v).replace(',', '.');
  }
  if (t === 'boolean' || t === 'char') {
    if (v === true || v === 'Y' || v === 'y' || v === 1) return 'Y';
    if (v === false || v === 'N' || v === 'n' || v === 0) return 'N';
    throw bad(f.name, 'ожидается Y/N или boolean');
  }
  if (t === 'date' || t === 'datetime') {
    if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) {
      throw bad(f.name, 'ожидается дата в ISO 8601 (например 2026-10-01 или 2026-10-01T10:00:00+03:00)');
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
    return id;
  }
  if (t === 'crm_multifield') {
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw bad(f.name, 'ожидается объект {VALUE, VALUE_TYPE}');
    const o = v as Record<string, unknown>;
    if (typeof o['VALUE'] !== 'string') throw bad(f.name, 'VALUE должен быть строкой');
    return {
      VALUE: o['VALUE'],
      ...(typeof o['VALUE_TYPE'] === 'string' ? { VALUE_TYPE: o['VALUE_TYPE'] } : {}),
    };
  }
  // string, text, url, crm_status, crm_currency, location, file и прочие строковые
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') throw bad(f.name, `ожидается строка (тип ${t})`);
  if (v.length > 20_000) throw bad(f.name, 'длиннее 20000 символов');
  return v;
}

/**
 * Проверка полей для записи. Неизвестные и read-only поля отклоняются; при создании
 * обязательные поля должны присутствовать (T31: понятная ошибка с именем поля).
 */
export function validateFieldsForWrite(
  fields: Record<string, unknown>,
  meta: DealFieldsMeta,
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
    if (!f)
      throw bad(
        key,
        'поле неизвестно порталу (проверьте регистр: поля классического CRM — ВЕРХНИЙ_РЕГИСТР)',
        'UNKNOWN_FIELD',
      );
    if (f.isReadOnly) throw bad(key, 'поле только для чтения', 'READ_ONLY_FIELD');
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
      out[key] = v === null ? '' : normalizeValue(f, v);
    }
  }
  if (mode === 'create') {
    for (const f of Object.values(meta)) {
      if (f.isRequired && !f.isReadOnly && !(f.name in out)) {
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

/** Префиксы фильтра классического CRM: =, %, >, <, >=, <=, !, @, !@, ><, !>< , !% */
const FILTER_KEY_RE = /^(>=|<=|!><|><|!%|!@|!=|@|!|%|>|<|=)?([A-Z][A-Z0-9_]{0,99})$/;
const RANGE_PREFIXES = new Set(['><', '!><']);
const LIST_PREFIXES = new Set(['@', '!@']);

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar =>
  (typeof v === 'string' && v.length <= 500) ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  typeof v === 'boolean';

export function validateFilter(filter: Record<string, unknown>, meta: DealFieldsMeta): JsonObject {
  const out: JsonObject = {};
  const entries = Object.entries(filter);
  if (entries.length > 30)
    throw new AppError('VALIDATION_ERROR', 'слишком много условий фильтра (>30)', { field: 'filter' });
  for (const [key, value] of entries) {
    const m = FILTER_KEY_RE.exec(key);
    if (!m)
      throw bad(
        `filter.${key.slice(0, 40)}`,
        'недопустимый ключ фильтра; формат: [префикс]ИМЯ_ПОЛЯ, например >=DATE_CREATE или %TITLE',
      );
    const prefix = m[1] ?? '';
    const field = m[2] ?? '';
    if (!own(meta, field)) throw bad(`filter.${field}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
    if (RANGE_PREFIXES.has(prefix)) {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(isScalar)) {
        throw bad(`filter.${key}`, 'диапазон: ожидается массив ровно из двух значений [от, до]');
      }
      out[key] = value;
      continue;
    }
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

export function validateOrder(
  order: Record<string, unknown>,
  meta: DealFieldsMeta,
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

export function validateSelect(select: string[], meta: DealFieldsMeta): string[] {
  if (select.length > 100)
    throw new AppError('VALIDATION_ERROR', 'select: больше 100 полей', { field: 'select' });
  for (const s of select) {
    if (s === '*' || s === 'UF_*') continue;
    if (!own(meta, s)) throw bad(`select.${s.slice(0, 40)}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
  }
  return select;
}

/** Компактное представление схемы для ответа модели (без служебных флагов Bitrix). */
export function describeFields(meta: DealFieldsMeta): {
  name: string;
  title: string;
  type: string;
  isRequired: boolean;
  isReadOnly: boolean;
  isMultiple: boolean;
  items?: { ID: string; VALUE: string }[];
}[] {
  return Object.values(meta).map((f) => ({
    name: f.name,
    title: f.title,
    type: f.type,
    isRequired: f.isRequired,
    isReadOnly: f.isReadOnly,
    isMultiple: f.isMultiple,
    ...(f.items ? { items: f.items } : {}),
  }));
}

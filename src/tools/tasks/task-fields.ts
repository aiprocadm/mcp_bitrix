/**
 * Метаданные полей задачи (tasks.task.getfields) и валидатор (ТЗ §9.8, §15.1 п.2).
 * Особенность legacy `tasks.task.*`: параметры filter/select/order — ИМЕНА_В_ВЕРХНЕМ_РЕГИСТРЕ,
 * а ответы (`result.task`, `result.tasks[]`) — в camelCase. Валидатор работает с UPPER_CASE.
 * Источник: https://apidocs.bitrix24.ru/api-reference/tasks/tasks-task-get-fields.html
 */
import { AppError } from '../../errors/app-error.js';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { asText, type FieldMeta } from '../crm/deal-fields.js';
import { own } from '../shared.js';

export type TaskFieldsMeta = Record<string, FieldMeta>;

const FIELD_NAME_RE = /^[A-Z][A-Z0-9_]{0,99}$/;

/** Поля, которые портал ведёт сам; писать их нельзя даже если getfields не помечает их. */
const SERVER_MANAGED = new Set([
  'ID',
  'CREATED_DATE',
  'CHANGED_DATE',
  'CHANGED_BY',
  'STATUS_CHANGED_DATE',
  'STATUS_CHANGED_BY',
  'CLOSED_DATE',
  'CLOSED_BY',
  'DATE_START',
  'DURATION_FACT',
  'ACTIVITY_DATE',
  'VIEWED_DATE',
  'COMMENTS_COUNT',
  'NEW_COMMENTS_COUNT',
  'SUBORDINATE',
  'FAVORITE',
  'IS_MUTED',
  'IS_PINNED',
  'SERVICE_COMMENTS_COUNT',
  'GUID',
  'XML_ID',
  'STAGE_ID',
  'FORUM_TOPIC_ID',
  'FORUM_ID',
  'SITE_ID',
]);

/** Статусы задачи Bitrix24 (поле STATUS). */
export const TASK_STATUS = {
  new: 1,
  pending: 2,
  inProgress: 3,
  awaitingControl: 4,
  completed: 5,
  deferred: 6,
} as const;
export type TaskStatusName = keyof typeof TASK_STATUS;

export function taskStatusName(code: unknown): TaskStatusName | undefined {
  const n = Number(code);
  return (Object.keys(TASK_STATUS) as TaskStatusName[]).find((k) => TASK_STATUS[k] === n);
}

/** tasks.task.getfields → {result:{fields:{ID:{title,type,primary?,required?}, ...}}} */
export function parseTaskFieldsResult(result: unknown): TaskFieldsMeta {
  const obj =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const fields = obj?.['fields'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'tasks.task.getfields вернул неожиданную форму', {
      method: 'tasks.task.getfields',
      apiVersion: 'legacy',
    });
  }
  const meta: TaskFieldsMeta = {};
  for (const [name, raw] of Object.entries(fields as Record<string, unknown>)) {
    if (!FIELD_NAME_RE.test(name) || !raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const values = f['values'];
    const items =
      values && typeof values === 'object' && !Array.isArray(values)
        ? Object.entries(values as Record<string, unknown>).map(([ID, VALUE]) => ({
            ID,
            VALUE: asText(VALUE),
          }))
        : undefined;
    meta[name] = {
      name,
      type: typeof f['type'] === 'string' ? f['type'] : 'string',
      title: typeof f['title'] === 'string' ? f['title'] : name,
      isRequired: f['required'] === true,
      isReadOnly: f['primary'] === true || SERVER_MANAGED.has(name),
      isImmutable: false,
      isMultiple:
        name === 'AUDITORS' ||
        name === 'ACCOMPLICES' ||
        name === 'TAGS' ||
        name === 'UF_CRM_TASK' ||
        f['multiple'] === true,
      isDynamic: name.startsWith('UF_'),
      ...(items ? { items } : {}),
    };
  }
  if (!meta['ID'] || !meta['TITLE'] || !meta['RESPONSIBLE_ID']) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Схема полей задачи не содержит ID/TITLE/RESPONSIBLE_ID', {
      method: 'tasks.task.getfields',
      apiVersion: 'legacy',
    });
  }
  return meta;
}

function bad(field: string, message: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', `${field}: ${message}`, {
    field,
    ...(reason ? { reason } : {}),
    nextAction: 'Сверьтесь со схемой полей задачи (tasks.task.getfields через bitrix_rest_call)',
  });
}

const isIntLike = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v));

/** Дата-время задачи: ISO 8601 с явной зоной (Z или ±hh:mm), иначе неоднозначно (ТЗ §9.3/§9.8 «срок/зона»). */
export function assertDateTimeWithZone(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) {
    throw bad(field, 'ожидается дата-время ISO 8601, например 2026-10-01T18:00:00+03:00');
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    throw bad(
      field,
      'укажите часовой пояс явно: ...T18:00:00+03:00 или ...Z (дата без зоны неоднозначна)',
      'TIMEZONE_REQUIRED',
    );
  }
  return v;
}

function normalizeValue(f: FieldMeta, v: unknown): JsonValue {
  switch (f.type) {
    case 'integer':
      if (!isIntLike(v)) throw bad(f.name, 'ожидается целое число/ID');
      return typeof v === 'number' ? v : Number(v);
    case 'datetime':
    case 'date':
      return assertDateTimeWithZone(f.name, v);
    case 'enum':
      if (f.items && !f.items.some((i) => i.ID === String(v))) {
        throw bad(f.name, `допустимые значения: ${f.items.map((i) => `${i.ID} (${i.VALUE})`).join(', ')}`);
      }
      return typeof v === 'number' ? v : asText(v);
    case 'boolean':
      if (v === true || v === 'Y' || v === 'y') return 'Y';
      if (v === false || v === 'N' || v === 'n') return 'N';
      throw bad(f.name, 'ожидается Y/N или boolean');
    default:
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v !== 'string') throw bad(f.name, `ожидается строка (тип ${f.type})`);
      if (v.length > 20_000) throw bad(f.name, 'длиннее 20000 символов');
      return v;
  }
}

/**
 * Проверка полей для tasks.task.add / tasks.task.update: только известные, не серверные; типы нормализуются.
 * В режиме 'update' обязательные поля не требуются (меняются только переданные).
 */
export function validateTaskFieldsForWrite(
  fields: Record<string, unknown>,
  meta: TaskFieldsMeta,
  mode: 'create' | 'update' = 'create',
): JsonObject {
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const f = own(meta, key);
    if (!f)
      throw bad(
        key,
        'поле неизвестно порталу (имена — ВЕРХНИЙ_РЕГИСТР, пользовательские — UF_*)',
        'UNKNOWN_FIELD',
      );
    if (f.isReadOnly) throw bad(key, 'поле ведёт сам портал, задать нельзя', 'READ_ONLY_FIELD');
    if (f.isMultiple) {
      if (!Array.isArray(v)) throw bad(key, 'множественное поле: ожидается массив');
      if (v.length > 100) throw bad(key, 'больше 100 значений');
      out[key] = v.map((x) => normalizeValue(f, x));
    } else {
      if (Array.isArray(v)) throw bad(key, 'поле не множественное: массив недопустим');
      out[key] = v === null ? '' : normalizeValue(f, v);
    }
    const written = out[key];
    if (f.isRequired && (written === '' || (Array.isArray(written) && written.length === 0))) {
      throw bad(key, `обязательное поле «${f.title}» нельзя очистить`, 'REQUIRED_FIELD_MISSING');
    }
  }
  if (mode === 'update') return out;
  for (const f of Object.values(meta)) {
    if (f.isRequired && !f.isReadOnly && !(f.name in out)) {
      throw new AppError('VALIDATION_ERROR', `${f.name} («${f.title}»): обязательное поле не заполнено`, {
        field: f.name,
        reason: 'REQUIRED_FIELD_MISSING',
      });
    }
  }
  return out;
}

const FILTER_KEY_RE = /^(>=|<=|!><|><|!%|!@|!=|@|!|%|>|<|=)?([A-Z][A-Z0-9_]{0,99})$/;
type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar =>
  (typeof v === 'string' && v.length <= 500) ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  typeof v === 'boolean';

export function validateTaskFilter(filter: Record<string, unknown>, meta: TaskFieldsMeta): JsonObject {
  const out: JsonObject = {};
  const entries = Object.entries(filter);
  if (entries.length > 30)
    throw new AppError('VALIDATION_ERROR', 'слишком много условий фильтра (>30)', { field: 'filter' });
  for (const [key, value] of entries) {
    const m = FILTER_KEY_RE.exec(key);
    if (!m) throw bad(`filter.${key.slice(0, 40)}`, 'недопустимый ключ фильтра; формат: [префикс]ИМЯ_ПОЛЯ');
    const prefix = m[1] ?? '';
    const field = m[2] ?? '';
    if (!own(meta, field)) throw bad(`filter.${field}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
    if (prefix === '><' || prefix === '!><') {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(isScalar))
        throw bad(`filter.${key}`, 'диапазон: массив ровно из двух значений');
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

export function validateTaskOrder(
  order: Record<string, unknown>,
  meta: TaskFieldsMeta,
): Record<string, 'asc' | 'desc'> {
  const out: Record<string, 'asc' | 'desc'> = {};
  for (const [field, dir] of Object.entries(order)) {
    if (!own(meta, field)) throw bad(`order.${field.slice(0, 40)}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
    const d = String(dir).toLowerCase();
    if (d !== 'asc' && d !== 'desc') throw bad(`order.${field}`, 'допустимо asc или desc');
    out[field] = d;
  }
  return out;
}

export function validateTaskSelect(select: string[], meta: TaskFieldsMeta): string[] {
  if (select.length > 100)
    throw new AppError('VALIDATION_ERROR', 'select: больше 100 полей', { field: 'select' });
  for (const s of select) {
    if (s === '*' || s === 'UF_*') continue;
    if (!own(meta, s)) throw bad(`select.${s.slice(0, 40)}`, 'поле неизвестно порталу', 'UNKNOWN_FIELD');
  }
  return select;
}

/** Привязки к CRM в формате Bitrix: L_<id> лид, D_<id> сделка, C_<id> контакт, CO_<id> компания. */
export const CRM_BINDING_RE = /^(L|D|C|CO)_\d{1,15}$/;

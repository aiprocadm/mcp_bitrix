/**
 * Общее для инструментов календаря (ТЗ §9.3, T28): тип календаря и владелец, интервал дат,
 * нормализация события calendar.event.get/getbyid, хеш состояния события, текущая Bitrix-личность.
 * Моменты времени берутся из DATE_FROM_TS_UTC/DATE_TO_TS_UTC (формат DATE_FROM зависит от языка портала).
 * Источник полей: https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-event-get-by-id.html
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, num, yn } from '../shared.js';
import type { ToolContext } from '../types.js';
import {
  addDays,
  assertTimeZone,
  bitrixDateTimeToUnix,
  dateInZone,
  parseIsoWithZone,
  unixToIsoInZone,
  zonedDayStart,
} from './time.js';

export const calendarTypeSchema = z
  .enum(['user', 'group', 'company'])
  .describe('user — календарь сотрудника, group — рабочей группы, company — общий календарь компании');

export const ownerIdSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe('ID сотрудника (user) или группы (group); для company игнорируется (0)');

export const eventIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Тип и владелец календаря в терминах Bitrix: company → company_calendar с ownerId=0 (по документации). */
export function calendarRef(
  type: 'user' | 'group' | 'company',
  ownerId: number | undefined,
): { type: string; ownerId: number } {
  if (type === 'company') return { type: 'company_calendar', ownerId: 0 };
  if (!ownerId) {
    throw new AppError('VALIDATION_ERROR', `ownerId обязателен для календаря типа ${type}`, {
      field: 'ownerId',
    });
  }
  return { type, ownerId };
}

// ---------- интервал ----------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface TimeRange {
  fromTs: number;
  toTs: number;
  dateOnly: boolean;
  timezone: string;
  /** Даты для запроса Bitrix (YYYY-MM-DD) с запасом в сутки на разницу зон; точный отбор — по моменту. */
  bitrixFrom: string;
  bitrixTo: string;
}

/**
 * from/to: обе даты YYYY-MM-DD (включительно, в зоне timezone) либо обе ISO с явным смещением.
 * to раньше from или равно ему → INVALID_DATE_RANGE; локальная дата-время без зоны → TIMEZONE_REQUIRED.
 */
export function parseRange(from: string, to: string, timezone: string, maxDays: number): TimeRange {
  const tz = assertTimeZone(timezone);
  const fromDate = DATE_ONLY.test(from);
  const toDate = DATE_ONLY.test(to);
  if (fromDate !== toDate) {
    throw new AppError(
      'VALIDATION_ERROR',
      'from и to должны быть в одном формате: обе даты YYYY-MM-DD или обе ISO с зоной',
      {
        field: 'to',
      },
    );
  }
  let fromTs: number;
  let toTs: number;
  if (fromDate) {
    if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
      throw new AppError('VALIDATION_ERROR', 'неверная дата YYYY-MM-DD', { field: 'from' });
    }
    if (to < from) throw invalidRange();
    fromTs = zonedDayStart(from, tz);
    toTs = zonedDayStart(addDays(to, 1), tz);
  } else {
    fromTs = parseIsoWithZone('from', from);
    toTs = parseIsoWithZone('to', to);
    if (toTs <= fromTs) throw invalidRange();
  }
  if (toTs - fromTs > maxDays * 86_400 + 3_600) {
    throw new AppError('VALIDATION_ERROR', `интервал длиннее ${String(maxDays)} дней; сузьте период`, {
      field: 'to',
      reason: 'RANGE_TOO_LONG',
    });
  }
  return {
    fromTs,
    toTs,
    dateOnly: fromDate,
    timezone: tz,
    bitrixFrom: dateInZone(fromTs - 86_400, 'UTC'),
    bitrixTo: dateInZone(toTs + 86_400, 'UTC'),
  };
}

function invalidRange(): AppError {
  return new AppError('VALIDATION_ERROR', 'to должно быть позже from', {
    field: 'to',
    reason: 'INVALID_DATE_RANGE',
  });
}

// ---------- событие ----------

export type AttendeeStatus = 'accepted' | 'declined' | 'pending' | 'host' | 'unknown';

const STATUS: Record<string, AttendeeStatus> = { Y: 'accepted', N: 'declined', Q: 'pending', H: 'host' };
export const attendeeStatus = (v: unknown): AttendeeStatus => STATUS[asText(v)] ?? 'unknown';

/** Дата события на весь день из строки Bitrix: DD.MM.YYYY, MM/DD/YYYY (пример документации) или YYYY-MM-DD. */
export function allDayDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (m) return `${m[3] ?? ''}-${m[2] ?? ''}-${m[1] ?? ''}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3] ?? ''}-${m[1] ?? ''}-${m[2] ?? ''}`;
  m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m?.[1];
}

export function isRecurring(ev: Record<string, JsonValue>): boolean {
  const r = ev['RRULE'];
  if (isObj(r)) return asText(r['FREQ']) !== '';
  return typeof r === 'string' && /FREQ=/i.test(r);
}

export function eventAttendees(ev: Record<string, JsonValue>): { id: number; status: AttendeeStatus }[] {
  const list = ev['ATTENDEE_LIST'];
  if (!Array.isArray(list)) return [];
  const out: { id: number; status: AttendeeStatus }[] = [];
  for (const a of list) {
    if (!isObj(a)) continue;
    const id = idOf(a['id']);
    if (id !== undefined) out.push({ id, status: attendeeStatus(a['status']) });
  }
  return out;
}

export interface CalendarEvent {
  id: number;
  name: string;
  /** ISO со смещением в зоне ответа либо YYYY-MM-DD для события на весь день. */
  from: string;
  to: string;
  fromTs?: number | undefined;
  toTs?: number | undefined;
  allDay: boolean;
  eventTimezone?: string | undefined;
  sectionId?: number | undefined;
  recurring: boolean;
  recurrence?: string | undefined;
  isMeeting: boolean;
  hostId?: number | undefined;
  myStatus?: AttendeeStatus | undefined;
  attendees: { id: number; status: AttendeeStatus }[];
  location?: string | undefined;
  accessibility?: string | undefined;
  importance?: string | undefined;
  private: boolean;
  description?: string | undefined;
}

export function eventTimes(ev: Record<string, JsonValue>): {
  fromTs?: number;
  toTs?: number;
  allDay: boolean;
  tz?: string;
} {
  const allDay = yn(ev['DT_SKIP_TIME']);
  const tz = asText(ev['TZ_FROM']) || undefined;
  let fromTs = num(ev['DATE_FROM_TS_UTC']);
  let toTs = num(ev['DATE_TO_TS_UTC']);
  if (fromTs === undefined && tz) fromTs = bitrixDateTimeToUnix(asText(ev['DATE_FROM']), tz) ?? undefined;
  if (toTs === undefined && tz)
    toTs = bitrixDateTimeToUnix(asText(ev['DATE_TO']), asText(ev['TZ_TO']) || tz) ?? undefined;
  return {
    ...(fromTs !== undefined ? { fromTs } : {}),
    ...(toTs !== undefined ? { toTs } : {}),
    allDay,
    ...(tz ? { tz } : {}),
  };
}

/** Событие Bitrix → минимальное представление; даты — в зоне outTz, весь день — датой. */
export function normalizeEvent(
  ev: Record<string, JsonValue>,
  outTz: string,
  meId?: number,
): CalendarEvent | undefined {
  const id = idOf(ev['ID']);
  if (id === undefined) return undefined;
  const t = eventTimes(ev);
  const render = (ts: number | undefined, raw: string): string => {
    if (t.allDay) {
      return (
        allDayDate(raw) ?? (ts !== undefined ? dateInZone(ts, t.tz && isZone(t.tz) ? t.tz : outTz) : raw)
      );
    }
    return ts !== undefined ? unixToIsoInZone(ts, outTz) : raw;
  };
  const attendees = eventAttendees(ev);
  const me = meId !== undefined ? attendees.find((a) => a.id === meId) : undefined;
  const description = asText(ev['DESCRIPTION']);
  const rr = asText(ev['~RRULE_DESCRIPTION']);
  const recurring = isRecurring(ev);
  return {
    id,
    name: asText(ev['NAME']),
    from: render(t.fromTs, asText(ev['DATE_FROM'])),
    to: render(t.toTs, asText(ev['DATE_TO'])),
    ...(t.fromTs !== undefined ? { fromTs: t.fromTs } : {}),
    ...(t.toTs !== undefined ? { toTs: t.toTs } : {}),
    allDay: t.allDay,
    ...(t.tz ? { eventTimezone: t.tz } : {}),
    ...(idOf(ev['SECTION_ID'] ?? ev['SECT_ID']) !== undefined
      ? { sectionId: idOf(ev['SECTION_ID'] ?? ev['SECT_ID']) }
      : {}),
    recurring,
    ...(recurring && rr ? { recurrence: rr.slice(0, 300) } : {}),
    isMeeting: yn(ev['IS_MEETING']),
    ...(idOf(ev['MEETING_HOST']) !== undefined ? { hostId: idOf(ev['MEETING_HOST']) } : {}),
    ...(me ? { myStatus: me.status } : {}),
    attendees,
    ...(asText(ev['LOCATION']) ? { location: asText(ev['LOCATION']).slice(0, 255) } : {}),
    ...(asText(ev['ACCESSIBILITY']) ? { accessibility: asText(ev['ACCESSIBILITY']) } : {}),
    ...(asText(ev['IMPORTANCE']) ? { importance: asText(ev['IMPORTANCE']) } : {}),
    private: yn(ev['PRIVATE_EVENT']),
    ...(description ? { description: description.slice(0, 1000) } : {}),
  };
}

function isZone(tz: string): boolean {
  try {
    assertTimeZone(tz);
    return true;
  } catch {
    return false;
  }
}

/** Хеш состояния события для expectedStateHash: то, что меняет смысл встречи (без статусов ответов). */
export function eventStateHash(ev: Record<string, JsonValue>): string {
  const t = eventTimes(ev);
  return stateHash({
    id: asText(ev['ID']),
    name: asText(ev['NAME']),
    fromTs: t.fromTs ?? asText(ev['DATE_FROM']),
    toTs: t.toTs ?? asText(ev['DATE_TO']),
    tzFrom: asText(ev['TZ_FROM']),
    tzTo: asText(ev['TZ_TO']),
    allDay: t.allDay,
    section: asText(ev['SECTION_ID'] ?? ev['SECT_ID']),
    description: asText(ev['DESCRIPTION']),
    location: asText(ev['LOCATION']),
    accessibility: asText(ev['ACCESSIBILITY']),
    importance: asText(ev['IMPORTANCE']),
    private: yn(ev['PRIVATE_EVENT']),
    rrule: ev['RRULE'] ?? null,
    exdate: asText(ev['EXDATE']),
    host: asText(ev['MEETING_HOST']),
    attendees: eventAttendees(ev)
      .map((a) => a.id)
      .sort((a, b) => a - b),
    version: asText(ev['VERSION']),
  });
}

/** Событие по ID (calendar.event.getbyid); отсутствует/удалено → NOT_FOUND без подготовки плана. */
export async function getEvent(ctx: ToolContext, eventId: number): Promise<Record<string, JsonValue>> {
  const r = await ctx.bitrix.call(
    'legacy',
    'calendar.event.getbyid',
    { id: eventId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const ev = isObj(r.result) ? r.result : undefined;
  if (!ev || idOf(ev['ID']) === undefined || yn(ev['DELETED'])) {
    throw new AppError('NOT_FOUND', `Событие #${String(eventId)} не найдено или недоступно`, {
      field: 'eventId',
      method: 'calendar.event.getbyid',
      apiVersion: 'legacy',
    });
  }
  return ev;
}

/** Событие удалено/не читается — для сверки удаления. */
export async function eventGone(ctx: ToolContext, eventId: number): Promise<boolean> {
  try {
    await getEvent(ctx, eventId);
    return false;
  } catch (e) {
    if (e instanceof AppError && e.code === 'NOT_FOUND') return true;
    throw e;
  }
}

/** Событие принадлежит указанному календарю (если портал вернул тип/владельца). */
export function assertEventInCalendar(
  ev: Record<string, JsonValue>,
  ref: { type: string; ownerId: number },
): void {
  const calType = asText(ev['CAL_TYPE']);
  const owner = asText(ev['OWNER_ID']);
  const typeOk = !calType || calType === ref.type;
  const ownerOk = ref.type === 'company_calendar' || !owner || owner === String(ref.ownerId);
  if (!typeOk || !ownerOk) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Событие находится в другом календаре (${calType || '?'}/${owner || '?'}), а не в ${ref.type}/${String(ref.ownerId)}`,
      { field: 'ownerId', reason: 'CALENDAR_MISMATCH' },
    );
  }
}

/** ID текущей Bitrix-личности (владелец вебхука): из конфигурации либо profile. */
export async function currentUserId(ctx: ToolContext): Promise<number> {
  const known = ctx.bitrix.auth.identityUserId;
  if (known) return known;
  const r = await ctx.bitrix.call('legacy', 'profile', {}, { requestId: ctx.requestId, signal: ctx.signal });
  const id = isObj(r.result) ? idOf(r.result['ID']) : undefined;
  if (id === undefined) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Не удалось определить текущего пользователя Bitrix24', {
      method: 'profile',
      apiVersion: 'legacy',
    });
  }
  return id;
}

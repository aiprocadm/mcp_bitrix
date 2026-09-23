/**
 * Даты календаря (ТЗ §9.3, T28): ISO 8601 с явным смещением + IANA-зона хранится отдельно;
 * даты Bitrix «DD.MM.YYYY HH:MM:SS» в зоне TZ_FROM/TZ_TO переводятся в момент времени для сверки.
 */
import { AppError } from '../../errors/app-error.js';

const ZONES = new Set(Intl.supportedValuesOf('timeZone'));

export function isValidTimeZone(tz: string): boolean {
  return ZONES.has(tz);
}

export function assertTimeZone(tz: string): string {
  if (!isValidTimeZone(tz)) {
    throw new AppError('VALIDATION_ERROR', `timezone: неизвестная IANA-зона «${tz.slice(0, 40)}»`, {
      field: 'timezone',
      reason: 'INVALID_TIMEZONE',
      nextAction: 'Используйте IANA-имя, например Europe/Moscow',
    });
  }
  return tz;
}

/** ISO 8601 с явной зоной → unix seconds. */
export function parseIsoWithZone(field: string, v: string): number {
  if (v.length > 40 || Number.isNaN(Date.parse(v))) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${field}: ожидается дата-время ISO 8601, например 2026-10-01T10:00:00+03:00`,
      { field },
    );
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${field}: укажите часовой пояс явно (+03:00 или Z), локальная дата неоднозначна`,
      {
        field,
        reason: 'TIMEZONE_REQUIRED',
      },
    );
  }
  return Math.floor(Date.parse(v) / 1000);
}

/** Дата без времени YYYY-MM-DD для событий на весь день. */
export function parseAllDayDate(field: string, v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new AppError('VALIDATION_ERROR', `${field}: для allDay ожидается дата YYYY-MM-DD`, { field });
  }
  return v;
}

/** Смещение зоны (мс) для данного момента. */
function offsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(atMs)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(
    p['year'] ?? 1970,
    (p['month'] ?? 1) - 1,
    p['day'] ?? 1,
    p['hour'] ?? 0,
    p['minute'] ?? 0,
    p['second'] ?? 0,
  );
  return asUtc - atMs;
}

/** «DD.MM.YYYY HH:MM:SS» (формат Bitrix) в зоне tz → unix seconds; null, если формат не распознан. */
export function bitrixDateTimeToUnix(value: string, tz: string): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const naive = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  // два прохода: смещение зависит от момента (DST)
  let guess = naive - offsetMs(tz, naive);
  guess = naive - offsetMs(tz, guess);
  return Math.floor(guess / 1000);
}

/** unix seconds → «DD.MM.YYYY HH:MM:SS» в зоне tz (для показа в плане). */
export function unixToZoned(unix: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return dtf.format(new Date(unix * 1000)).replace(',', '');
}

import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import {
  assertTimeZone,
  bitrixDateTimeToUnix,
  isValidTimeZone,
  parseAllDayDate,
  parseIsoWithZone,
  unixToZoned,
} from '../../src/tools/calendar/time.js';

describe('даты календаря (T28)', () => {
  it('ISO только с явной зоной; allDay — YYYY-MM-DD', () => {
    expect(parseIsoWithZone('from', '2026-10-01T10:00:00+03:00')).toBe(
      Date.parse('2026-10-01T07:00:00Z') / 1000,
    );
    expect(parseIsoWithZone('from', '2026-10-01T07:00:00Z')).toBe(Date.parse('2026-10-01T07:00:00Z') / 1000);
    expect(() => parseIsoWithZone('from', '2026-10-01T10:00:00')).toThrow(AppError);
    expect(() => parseIsoWithZone('from', 'завтра')).toThrow(AppError);
    expect(parseAllDayDate('from', '2026-10-01')).toBe('2026-10-01');
    expect(() => parseAllDayDate('from', '2026-10-01T10:00:00+03:00')).toThrow(AppError);
    expect(() => parseAllDayDate('from', '2026-13-45')).toThrow(AppError);
  });

  it('IANA-зоны проверяются', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Moscow')).toBe(false);
    expect(assertTimeZone('Asia/Yekaterinburg')).toBe('Asia/Yekaterinburg');
    expect(() => assertTimeZone('GMT+3')).toThrow(AppError);
  });

  it('формат Bitrix DD.MM.YYYY HH:MM:SS переводится в момент с учётом зоны и DST', () => {
    expect(bitrixDateTimeToUnix('01.10.2026 10:00:00', 'Europe/Moscow')).toBe(
      Date.parse('2026-10-01T07:00:00Z') / 1000,
    );
    // Берлин: лето (+02:00) и зима (+01:00)
    expect(bitrixDateTimeToUnix('15.07.2026 12:00:00', 'Europe/Berlin')).toBe(
      Date.parse('2026-07-15T10:00:00Z') / 1000,
    );
    expect(bitrixDateTimeToUnix('15.01.2026 12:00:00', 'Europe/Berlin')).toBe(
      Date.parse('2026-01-15T11:00:00Z') / 1000,
    );
    expect(bitrixDateTimeToUnix('15.01.2026', 'Europe/Berlin')).toBe(
      Date.parse('2026-01-14T23:00:00Z') / 1000,
    );
    expect(bitrixDateTimeToUnix('2026-01-15 12:00', 'Europe/Berlin')).toBeNull();
    expect(bitrixDateTimeToUnix('15.01.2026 12:00:00', 'Nope/Zone')).toBeNull();
  });

  it('обратное представление для плана', () => {
    const unix = Date.parse('2026-10-01T07:00:00Z') / 1000;
    expect(unixToZoned(unix, 'Europe/Moscow')).toBe('01.10.2026 10:00:00');
    expect(bitrixDateTimeToUnix(unixToZoned(unix, 'Asia/Yekaterinburg'), 'Asia/Yekaterinburg')).toBe(unix);
  });
});

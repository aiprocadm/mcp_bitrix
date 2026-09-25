/**
 * Деньги и периоды биллинга (SaaS-ТЗ §10.1, Б§9.6): только целые копейки, никакого float.
 * Сумма для API ЮKassa — строка с двумя знаками после точки (объект Amount: value "990.00", currency "RUB";
 * yookassa-python src/yookassa/domain/models/amount.py, https://yookassa.ru/developers/api#payment_object_amount).
 */
import { AppError } from '../../errors/app-error.js';

/** 99000 → "990.00". */
export function kopecksToAmount(kopecks: number): string {
  if (!Number.isSafeInteger(kopecks) || kopecks < 0)
    throw new AppError('VALIDATION_ERROR', 'Сумма должна быть целым неотрицательным числом копеек');
  const rub = Math.trunc(kopecks / 100);
  const kop = kopecks % 100;
  return `${String(rub)}.${String(kop).padStart(2, '0')}`;
}

/** "990.00" / "990.5" / "990" → копейки; разбор строки без float. */
export function amountToKopecks(value: unknown): number {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string') throw new AppError('INTERNAL_ERROR', 'Сумма провайдера в неожиданном формате');
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m?.[1]) throw new AppError('INTERNAL_ERROR', 'Сумма провайдера в неожиданном формате');
  const kop = (m[2] ?? '').padEnd(2, '0');
  const n = Number(m[1]) * 100 + Number(kop);
  if (!Number.isSafeInteger(n)) throw new AppError('INTERNAL_ERROR', 'Сумма провайдера слишком велика');
  return n;
}

/**
 * Доплата при повышении тарифа (§10.2): разница цен × остаток периода / длина периода,
 * округление до копейки по правилу «половина вверх»; целочисленно (BigInt), без float.
 */
export function prorateKopecks(priceDiffKopecks: number, remainingMs: number, periodMs: number): number {
  if (priceDiffKopecks <= 0 || remainingMs <= 0 || periodMs <= 0) return 0;
  const rem = BigInt(Math.min(Math.trunc(remainingMs), Math.trunc(periodMs)));
  const total = BigInt(Math.trunc(periodMs));
  const diff = BigInt(priceDiffKopecks);
  return Number((diff * rem * 2n + total) / (2n * total));
}

/** Прибавить календарные месяцы (UTC); 31 января + 1 месяц = последний день февраля. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

export const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** Период учёта использования: календарный месяц UTC `YYYY-MM` и день `YYYY-MM-DD`. */
export function usagePeriods(at: Date): { month: string; day: string } {
  const iso = at.toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

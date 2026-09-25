/**
 * Денежные суммы каталога как десятичные строки (ТЗ §9.6: «decimal-арифметика, не двоичный float»).
 * Сумма принимается только строкой вида `1234.10`: без знака, экспоненты, пробелов и разделителей тысяч.
 * Сравнение — по канонической строке (без хвостовых нулей дробной части), без арифметики с float.
 *
 * Отправка в Bitrix: поле `price` в catalog.price.add/update документировано как double, поэтому
 * передаётся JSON-число. Длина ограничена 15 значащими цифрами (12 целых + до 3 дробных), а для таких
 * значений десятичная строка → IEEE-754 → кратчайшая строка (JSON.stringify) восстанавливается
 * без искажений; это дополнительно проверяется перед отправкой (toUpstreamNumber).
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';

/** Не более 12 целых цифр без ведущих нулей и до 3 знаков после точки. */
export const DECIMAL_RE = /^(0|[1-9]\d{0,11})(\.\d{1,3})?$/;

export const decimalAmountSchema = z
  .string()
  .max(16)
  .regex(
    DECIMAL_RE,
    'сумма — десятичная строка без знака и экспоненты, точка как разделитель, например "1234.10"',
  )
  .describe('Сумма строкой: "1234.10" (не число; не "1e3", не отрицательная; точность — по валюте)');

/** Число знаков после точки во входной строке (по записи, включая хвостовые нули). */
export function fractionDigits(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Каноническая форма: без хвостовых нулей дробной части и без точки у целых. */
export function canonicalDecimal(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Значение цены из ответа Bitrix (JSON-число или строка) → каноническая десятичная строка.
 * Экспоненциальная или нечисловая запись → undefined (форма неожиданна, сравнивать нельзя).
 */
export function decimalFromUpstream(v: unknown): string | undefined {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return undefined;
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)) return undefined;
  return canonicalDecimal(s);
}

export const sameDecimal = (a: string, b: string): boolean => canonicalDecimal(a) === canonicalDecimal(b);

/** Десятичная строка → число для JSON с проверкой, что сериализация не исказит значение. */
export function toUpstreamNumber(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || canonicalDecimal(String(n)) !== canonicalDecimal(s)) {
    throw new AppError('VALIDATION_ERROR', 'Сумму нельзя передать без искажения точности', {
      field: 'amount',
      reason: 'INVALID_AMOUNT',
    });
  }
  return n;
}

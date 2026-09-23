/**
 * Политика повторов (ТЗ §14.2): только для чтения, только на временные ошибки,
 * экспоненциальная задержка с jitter: старт 500 мс, потолок 8 с, учёт Retry-After и общего бюджета.
 * Мутации никогда не повторяются автоматически.
 */
import { AppError } from '../errors/app-error.js';

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8000 };

export function isRetryableReadError(err: AppError): boolean {
  if (err.code === 'BITRIX_TIMEOUT' || err.code === 'BITRIX_RATE_LIMITED') return true;
  if (err.code === 'BITRIX_UPSTREAM_ERROR') {
    const s = err.details.httpStatus;
    return s === 502 || s === 503 || s === 504 || err.details.retryable === true;
  }
  return false;
}

export function computeDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jitter = exp * (0.5 + random() * 0.5);
  const withRetryAfter = retryAfterMs !== undefined ? Math.max(jitter, retryAfterMs) : jitter;
  return Math.min(policy.maxDelayMs, Math.round(withRetryAfter));
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

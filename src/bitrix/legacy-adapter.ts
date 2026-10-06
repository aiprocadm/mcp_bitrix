/**
 * Адаптер классического REST (ТЗ §14.1):
 *  URL {base}{method}.json, JSON POST, ответ {result, next?, total?, time} либо {error, error_description}.
 */
import { AppError } from '../errors/app-error.js';
import { mapUpstreamError, sanitizeCode } from './errors.js';
import type { MethodDescriptor } from './method-registry.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export interface LegacyResponse {
  readonly result: JsonValue;
  readonly next: number | undefined;
  readonly total: number | undefined;
  readonly timeMs: number | undefined;
}

export interface PreparedRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Поля, которыми клиент не вправе управлять транспортом/авторизацией (ТЗ §14.1). */
const FORBIDDEN_PARAM_KEYS = new Set([
  'auth',
  'access_token',
  'refresh_token',
  'client_endpoint',
  'server_endpoint',
  'domain',
  'member_id',
]);

export function assertSafeParams(params: JsonObject): void {
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_PARAM_KEYS.has(key.toLowerCase())) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Параметр ${key} управляет авторизацией/транспортом и запрещён`,
        { field: key },
      );
    }
  }
}

export function buildLegacyRequest(
  baseUrl: string,
  descriptor: MethodDescriptor,
  params: JsonObject,
  authFields: Readonly<Record<string, string>>,
): PreparedRequest {
  assertSafeParams(params);
  const url = `${baseUrl}${descriptor.method}.json`;
  const body: Record<string, unknown> = { ...params, ...authFields };
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  };
}

export function parseLegacyResponse(
  httpStatus: number,
  bodyText: string,
  retryAfterMs: number | undefined,
  descriptor: MethodDescriptor,
): LegacyResponse {
  let json: unknown;
  try {
    json = bodyText.length ? JSON.parse(bodyText) : {};
  } catch {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Bitrix24 вернул ответ не в формате JSON', {
      method: descriptor.method,
      apiVersion: 'legacy',
      httpStatus,
      retryable: httpStatus === 502 || httpStatus === 503 || httpStatus === 504,
    });
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  // Код ошибки обычно строка; у catalog.* — число (например 200040300010).
  const rawError = obj['error'];
  const errorField = typeof rawError === 'number' && Number.isFinite(rawError) ? String(rawError) : rawError;
  if (typeof errorField === 'string' && errorField.length > 0) {
    throw mapUpstreamError(
      { httpStatus, upstreamCode: sanitizeCode(errorField), retryAfterMs },
      descriptor.method,
      'legacy',
      descriptor.scope,
    );
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    // Часть методов CRM (crm.deal.contact.*, crm.contact.company.*) отвечает на отсутствующую запись пустым
    // кодом и текстом «Not found.» (живой портал 2026-10-06, официальные страницы методов) — это NOT_FOUND.
    const description = obj['error_description'];
    const notFound =
      errorField === '' && typeof description === 'string' && /^not found\.?$/i.test(description.trim());
    throw mapUpstreamError(
      { httpStatus, upstreamCode: notFound ? 'NOT_FOUND' : undefined, retryAfterMs },
      descriptor.method,
      'legacy',
      descriptor.scope,
    );
  }
  if (!('result' in obj)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Ответ Bitrix24 не содержит поля result', {
      method: descriptor.method,
      apiVersion: 'legacy',
      httpStatus,
    });
  }
  const next = typeof obj['next'] === 'number' ? obj['next'] : undefined;
  const total = typeof obj['total'] === 'number' ? obj['total'] : undefined;
  const time = obj['time'];
  const timeMs =
    time && typeof time === 'object' && typeof (time as Record<string, unknown>)['duration'] === 'number'
      ? Math.round(((time as Record<string, number>)['duration'] ?? 0) * 1000)
      : undefined;
  return { result: obj['result'] as JsonValue, next, total, timeMs };
}

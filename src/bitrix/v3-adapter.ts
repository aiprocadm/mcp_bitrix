/**
 * Адаптер REST 3.0 (ТЗ §14.1, S23):
 *  URL {base}{method} (без .json), JSON POST, свои структуры ответа/ошибки и native cursor.
 * Одноимённые методы legacy/v3 не взаимозаменяемы (T03).
 *
 * Форма ответа v3 проверяется по OpenAPI конкретного портала (`rest.documentation.openapi`);
 * до этой проверки адаптер разбирает два задокументированных варианта: `{result, ...}` и
 * `{error: {code, message}}` / `{errors: [...]}`.
 */
import { AppError } from '../errors/app-error.js';
import { mapUpstreamError, sanitizeCode } from './errors.js';
import { assertSafeParams, type JsonObject, type JsonValue, type PreparedRequest } from './legacy-adapter.js';
import type { MethodDescriptor } from './method-registry.js';

export interface V3Response {
  readonly result: JsonValue;
  /** Непрозрачный native cursor, если метод его вернул. */
  readonly nextCursor: string | undefined;
  readonly raw: Record<string, unknown>;
}

export function buildV3Request(
  baseUrl: string,
  descriptor: MethodDescriptor,
  params: JsonObject,
  authFields: Readonly<Record<string, string>>,
  idempotencyKey?: string,
): PreparedRequest {
  assertSafeParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (idempotencyKey) {
    if (!descriptor.supportsNativeIdempotency) {
      throw new AppError('INTERNAL_ERROR', 'Idempotency-Key передан методу без подтверждённой поддержки', {
        method: descriptor.method,
        apiVersion: 'v3',
      });
    }
    headers['idempotency-key'] = idempotencyKey;
  }
  return {
    url: `${baseUrl}${descriptor.method}`,
    method: 'POST',
    headers,
    body: JSON.stringify({ ...params, ...authFields }),
  };
}

export function parseV3Response(
  httpStatus: number,
  bodyText: string,
  retryAfterMs: number | undefined,
  descriptor: MethodDescriptor,
): V3Response {
  let json: unknown;
  try {
    json = bodyText.length ? JSON.parse(bodyText) : {};
  } catch {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Bitrix24 (REST 3.0) вернул ответ не в формате JSON', {
      method: descriptor.method,
      apiVersion: 'v3',
      httpStatus,
      retryable: httpStatus === 502 || httpStatus === 503 || httpStatus === 504,
    });
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const upstreamCode = extractV3ErrorCode(obj);
  if (upstreamCode !== undefined || httpStatus < 200 || httpStatus >= 300) {
    throw mapUpstreamError(
      { httpStatus, upstreamCode, retryAfterMs },
      descriptor.method,
      'v3',
      descriptor.scope,
    );
  }
  if (!('result' in obj)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Ответ REST 3.0 не содержит поля result', {
      method: descriptor.method,
      apiVersion: 'v3',
      httpStatus,
    });
  }
  const cursor =
    obj['nextCursor'] ??
    obj['next_cursor'] ??
    (obj['pagination'] as Record<string, unknown> | undefined)?.['nextCursor'];
  return {
    result: obj['result'] as JsonValue,
    nextCursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined,
    raw: obj,
  };
}

function extractV3ErrorCode(obj: Record<string, unknown>): string | undefined {
  const err = obj['error'];
  if (typeof err === 'string' && err) return sanitizeCode(err);
  if (err && typeof err === 'object') {
    const code = (err as Record<string, unknown>)['code'];
    if (typeof code === 'string' && code) return sanitizeCode(code);
    return 'V3_ERROR';
  }
  const errors = obj['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | string;
    if (typeof first === 'string') return sanitizeCode(first);
    const code = first['code'];
    return typeof code === 'string' && code ? sanitizeCode(code) : 'V3_ERROR';
  }
  return undefined;
}

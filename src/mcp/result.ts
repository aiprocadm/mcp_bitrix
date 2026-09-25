/**
 * Единый формат ответа (ТЗ §14.4) и его преобразование в MCP CallToolResult:
 * `structuredContent` + компактный текстовый fallback + `isError` для ошибок выполнения.
 */
import { z } from 'zod';
import { AppError, ERROR_CODES, type ErrorDetails } from '../errors/app-error.js';
import type { ApiVersion } from '../bitrix/method-registry.js';

export type Completeness = 'complete' | 'partial' | 'unknown';

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SuccessMeta {
  requestId: string;
  method?: string;
  apiVersion?: ApiVersion;
  durationMs: number;
  attempts?: number;
  page?: PageMeta;
  completeness: Completeness;
  warnings: string[];
}

export interface SuccessEnvelope<T = unknown> {
  success: true;
  data: T;
  meta: SuccessMeta;
}

export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details: ErrorDetails };
  meta: { requestId: string; apiVersion?: ApiVersion; durationMs: number };
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(
  data: T,
  meta: Partial<SuccessMeta> & { requestId: string; durationMs: number },
): SuccessEnvelope<T> {
  return { success: true, data, meta: { completeness: 'complete', warnings: [], ...meta } };
}

export function fail(
  err: AppError,
  meta: { requestId: string; durationMs: number; apiVersion?: ApiVersion },
): ErrorEnvelope {
  return {
    success: false,
    error: { code: err.code, message: err.message, details: err.details },
    meta: {
      requestId: meta.requestId,
      durationMs: meta.durationMs,
      ...(err.details.apiVersion
        ? { apiVersion: err.details.apiVersion }
        : meta.apiVersion
          ? { apiVersion: meta.apiVersion }
          : {}),
    },
  };
}

/** outputSchema инструмента: success/error варианты (ТЗ §14.4). */
export function envelopeSchema(dataSchema: z.ZodType): z.ZodType {
  const meta = z.object({
    requestId: z.string(),
    method: z.string().optional(),
    apiVersion: z.enum(['legacy', 'v3']).optional(),
    durationMs: z.number(),
    attempts: z.number().optional(),
    page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }).optional(),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    warnings: z.array(z.string()),
  });
  return z.union([
    z.object({ success: z.literal(true), data: dataSchema, meta }),
    z.object({
      success: z.literal(false),
      error: z.object({
        code: z.enum(ERROR_CODES),
        message: z.string(),
        details: z.record(z.string(), z.unknown()),
      }),
      meta: z.object({
        requestId: z.string(),
        apiVersion: z.enum(['legacy', 'v3']).optional(),
        durationMs: z.number(),
      }),
    }),
  ]);
}

export interface CallToolResultLike {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Ограничение объёма (ТЗ §14.3): JSON остаётся валидным; если `data.items` — массив,
 * элементы отбрасываются с конца до попадания в лимит и ответ помечается partial.
 */
export function enforceResponseLimit(envelope: Envelope, maxBytes: number): Envelope {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(envelope) <= maxBytes) return envelope;
  if (!envelope.success) {
    // Большой план не должен терять operationId/срок: без них подтверждение невозможно.
    // План целиком остаётся в хранилище операций и показывается в approval:review / панели.
    const keep: Record<string, unknown> = {};
    for (const k of ['operationId', 'expiresAt', 'field', 'reason', 'method', 'apiVersion', 'upstreamCode']) {
      const v = (envelope.error.details as Record<string, unknown>)[k];
      if (v !== undefined) keep[k] = v;
    }
    const plan = (envelope.error.details as Record<string, unknown>)['plan'];
    if (plan && typeof plan === 'object') {
      const p = plan as Record<string, unknown>;
      keep['plan'] = {
        ...(p['action'] !== undefined ? { action: p['action'] } : {}),
        ...(p['target'] !== undefined ? { target: p['target'] } : {}),
        truncated: true,
      };
    }
    keep['nextAction'] =
      'План не поместился в ответ (MAX_RESPONSE_BYTES): полный план — в npm run approval:review -- --id <operationId>';
    const slim: Envelope = { ...envelope, error: { ...envelope.error, details: keep as ErrorDetails } };
    return size(slim) <= maxBytes ? slim : { ...envelope, error: { ...envelope.error, details: {} } };
  }
  const data = envelope.data as { items?: unknown[] } | null;
  if (data && typeof data === 'object' && Array.isArray(data.items) && data.items.length > 1) {
    let items = data.items;
    while (items.length > 1) {
      items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
      const candidate: Envelope = {
        ...envelope,
        data: { ...data, items },
        meta: {
          ...envelope.meta,
          completeness: 'partial',
          warnings: [
            ...envelope.meta.warnings,
            `Ответ усечён до ${items.length} элементов по лимиту MAX_RESPONSE_BYTES; уменьшите pageSize или select`,
          ],
        },
      };
      if (size(candidate) <= maxBytes) return candidate;
    }
  }
  const err = new AppError(
    'VALIDATION_ERROR',
    'Ответ превышает MAX_RESPONSE_BYTES; уменьшите объём запроса (pageSize, select, include)',
    {
      nextAction: 'Запросите меньше данных за один вызов',
    },
  );
  return fail(err, { requestId: envelope.meta.requestId, durationMs: envelope.meta.durationMs });
}

export function toCallToolResult(envelope: Envelope): CallToolResultLike {
  const structured = envelope as unknown as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: structured,
    ...(envelope.success ? {} : { isError: true }),
  };
}

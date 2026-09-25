/**
 * Общие части инструментов полной версии (ТЗ §9.1, §11): схемы ID/дат, разбор ответов Bitrix,
 * страницы с серверным курсором и единый ответ на запись через MutationExecutor.
 * Здесь нет обращений к сети: всё идёт через ctx.bitrix и ctx.mutations.
 */
import { z } from 'zod';
import type { ApiVersion } from '../bitrix/method-registry.js';
import type { JsonObject, JsonValue } from '../bitrix/legacy-adapter.js';
import { bindingHash, paginateLegacy, type CursorBinding, type PageResult } from '../bitrix/pagination.js';
import { AppError } from '../errors/app-error.js';
import { ok, type Envelope } from '../mcp/result.js';
import type { MutationOutcome, MutationPrincipal } from '../security/mutation-executor.js';
import type { ToolContext } from './types.js';

// ---------- схемы ----------

/** Положительный безопасный для JSON целый ID (ТЗ §9.1). */
export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Дата/время ISO 8601; смещение зоны рекомендуется. */
export const isoDateSchema = z
  .string()
  .max(40)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)),
    'ожидается дата ISO 8601, например 2026-09-01 или 2026-09-01T00:00:00+03:00',
  );

/** Поля ответа любого инструмента записи: план (dryRun) или результат выполнения. */
export const mutationOutputShape = {
  dryRun: z.boolean().optional(),
  plan: z.record(z.string(), z.unknown()).optional(),
  validationLevel: z.string().optional(),
  operationId: z.string().optional(),
  verified: z.boolean().optional(),
  replayed: z.boolean().optional(),
};

// ---------- разбор ответов ----------

export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export const isObj = (x: unknown): x is Record<string, JsonValue> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** Число из строки/числа Bitrix; пустое и нечисловое → undefined. */
export const num = (v: unknown): number | undefined => {
  const s = asText(v);
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : undefined;
};

/** Положительный целый ID из ответа; иначе undefined. */
export const idOf = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** Y/N/true → boolean. */
export const yn = (v: unknown): boolean => v === true || asText(v).toUpperCase() === 'Y';

export function upstreamShapeError(method: string, apiVersion: ApiVersion, message?: string): AppError {
  return new AppError('BITRIX_UPSTREAM_ERROR', message ?? `${method} вернул неожиданную форму ответа`, {
    method,
    apiVersion,
  });
}

/** Запись выполнена (или могла быть выполнена), но ответ не подтверждает результат → unknown, без повтора. */
export function outcomeUnknown(method: string, apiVersion: ApiVersion, nextAction: string): AppError {
  return new AppError(
    'OPERATION_OUTCOME_UNKNOWN',
    `${method}: ответ не подтверждает результат; исход неизвестен`,
    {
      method,
      apiVersion,
      reason: 'outcome-unknown',
      nextAction,
    },
  );
}

// ---------- страницы ----------

export function pageSizeOf(ctx: ToolContext, requested: number | undefined): number {
  return Math.min(requested ?? ctx.config.limits.defaultPageSize, ctx.config.limits.maxPageSize);
}

export function cursorBinding(ctx: ToolContext, tool: string, parts: Record<string, unknown>): CursorBinding {
  return {
    principalId: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    tool,
    bindingHash: bindingHash(parts),
  };
}

export function pageMeta(
  ctx: ToolContext,
  method: string,
  page: { nextCursor: string | null; hasMore: boolean },
  apiVersion: ApiVersion = 'legacy',
  warnings: string[] = [],
) {
  return {
    requestId: ctx.requestId,
    durationMs: Date.now() - ctx.startedAt,
    method,
    apiVersion,
    page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    completeness: page.hasMore ? ('partial' as const) : ('complete' as const),
    warnings,
  };
}

/**
 * Страница legacy-списка с серверным курсором (start/next, буфер остатка — T20).
 * `extract` достаёт массив из result (по умолчанию result сам массив); форма проверяется.
 */
export async function legacyListPage(
  ctx: ToolContext,
  opts: {
    tool: string;
    method: string;
    params: JsonObject;
    /** Всё, что определяет выборку (фильтр, порядок, pageSize): курсор к ним привязан (T21). */
    bindingParts: Record<string, unknown>;
    pageSize: number;
    cursor: string | undefined;
    extract?: (result: JsonValue) => JsonValue[] | undefined;
  },
): Promise<PageResult> {
  return paginateLegacy({
    store: ctx.cursors,
    binding: cursorBinding(ctx, opts.tool, { ...opts.bindingParts, pageSize: opts.pageSize }),
    cursor: opts.cursor,
    pageSize: opts.pageSize,
    fetchPage: async (start) => {
      const r = await ctx.bitrix.call(
        'legacy',
        opts.method,
        { ...opts.params, start },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      const items = opts.extract ? opts.extract(r.result) : Array.isArray(r.result) ? r.result : undefined;
      if (!Array.isArray(items)) throw upstreamShapeError(opts.method, 'legacy');
      return { items, next: r.next, total: r.total };
    },
  });
}

/**
 * Страница с произвольным непрозрачным состоянием продолжения (native cursor REST 3.0, ID-курсоры и т. п.).
 * Состояние хранится на сервере зашифрованным и привязано к principal/tool/выборке; модель видит только ключ.
 */
export async function statefulPage<S>(
  ctx: ToolContext,
  opts: {
    tool: string;
    bindingParts: Record<string, unknown>;
    cursor: string | undefined;
    initial: S;
    fetch: (state: S) => Promise<{ items: JsonValue[]; next: S | undefined }>;
  },
): Promise<PageResult> {
  const binding = cursorBinding(ctx, opts.tool, opts.bindingParts);
  const state = opts.cursor ? ctx.cursors.consume<S>(opts.cursor, binding) : opts.initial;
  const page = await opts.fetch(state);
  const hasMore = page.next !== undefined;
  return {
    items: page.items,
    nextCursor: hasMore ? ctx.cursors.create(binding, page.next) : null,
    hasMore,
    upstreamTotal: undefined,
    upstreamCalls: 1,
  };
}

// ---------- запись ----------

export function mutationPrincipal(ctx: ToolContext): MutationPrincipal {
  return {
    id: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    portalOrigin: ctx.bitrix.auth.portalOrigin,
  };
}

/**
 * Единый ответ инструмента записи: план при dryRun либо результат с operationId/verified/replayed.
 * `base` — идентифицирующие поля ответа (например, { taskId }); `resultFields` — что взять из сохранённого результата.
 */
export function mutationResponse(
  ctx: ToolContext,
  outcome: MutationOutcome,
  opts: {
    base: Record<string, unknown>;
    method: string;
    apiVersion?: ApiVersion;
    resultFields?: readonly string[];
    dryRunExtra?: Record<string, unknown>;
    warnings?: string[];
  },
): Envelope {
  if (outcome.kind === 'dry-run') {
    return ok(
      {
        ...opts.base,
        dryRun: true,
        plan: outcome.plan,
        validationLevel: outcome.validationLevel,
        ...(opts.dryRunExtra ?? {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
      },
    );
  }
  const picked: Record<string, unknown> = {};
  for (const f of opts.resultFields ?? []) {
    if (outcome.result[f] !== undefined) picked[f] = outcome.result[f];
  }
  return ok(
    {
      ...opts.base,
      ...picked,
      operationId: outcome.operationId,
      verified: outcome.verified,
      replayed: outcome.replayed,
    },
    {
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      method: opts.method,
      apiVersion: opts.apiVersion ?? 'legacy',
      warnings: [...outcome.warnings, ...(opts.warnings ?? [])],
      completeness: outcome.verified ? 'complete' : 'unknown',
    },
  );
}

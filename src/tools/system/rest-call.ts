/**
 * bitrix_rest_call — контролируемый прямой вызов (ТЗ §8.3, T11).
 * Разрешён только положительный allowlist конкретных пар (apiVersion, method) из policy,
 * которые к тому же есть в реестре с rawCallable=true и типом read/diagnostic.
 * batch, cmd, произвольные URL, auth-поля, casing/path-обход — отказ до обращения к API.
 */
import { z } from 'zod';
import { assertSafeParams, type JsonObject, type JsonValue } from '../../bitrix/legacy-adapter.js';
import { findMethod, isValidMethodName } from '../../bitrix/method-registry.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';

const MAX_PARAMS_BYTES = 32 * 1024;
const MAX_DEPTH = 6;

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(10_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(500),
    z.record(z.string().max(100), jsonValue),
  ]),
);

function depthOf(v: unknown, d = 0): number {
  if (d > MAX_DEPTH) return d;
  if (Array.isArray(v)) return Math.max(d, ...v.map((x) => depthOf(x, d + 1)));
  if (v && typeof v === 'object')
    return Math.max(d, ...Object.values(v as Record<string, unknown>).map((x) => depthOf(x, d + 1)));
  return d;
}

/** Ключи, которые превращают запрос в пакетный или управляющий (batch/cmd/events). */
const FORBIDDEN_KEYS = new Set(['cmd', 'halt', 'batch', 'event', 'handler', 'auth_type']);

export function checkRawCall(
  method: string,
  apiVersion: 'legacy' | 'v3',
  params: JsonObject,
  allowlist: readonly { apiVersion: 'legacy' | 'v3'; method: string }[],
): ReturnType<typeof findMethod> {
  if (!isValidMethodName(method)) {
    throw new AppError('METHOD_NOT_ALLOWED', 'Недопустимое имя метода', { method: method.slice(0, 40) });
  }
  const descriptor = findMethod(apiVersion, method);
  if (!descriptor?.rawCallable) {
    throw new AppError(
      'METHOD_NOT_ALLOWED',
      'Метод не входит в реестр методов, разрешённых для прямого вызова',
      { method, apiVersion },
    );
  }
  if (descriptor.operation !== 'read' && descriptor.operation !== 'admin/diagnostic') {
    throw new AppError('METHOD_NOT_ALLOWED', 'Прямой вызов разрешён только для методов чтения', {
      method,
      apiVersion,
    });
  }
  if (!allowlist.some((a) => a.apiVersion === apiVersion && a.method === method)) {
    throw new AppError(
      'METHOD_NOT_ALLOWED',
      'Метод отсутствует в allowlist политики (policies/methods.json)',
      {
        method,
        apiVersion,
        nextAction: 'Не расширяйте allowlist автоматически; это решение владельца',
      },
    );
  }
  assertSafeParams(params);
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new AppError('METHOD_NOT_ALLOWED', `Параметр ${key} запрещён для прямого вызова`, {
        method,
        field: key,
      });
    }
  }
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_PARAMS_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'Параметры превышают 32 КиБ', { field: 'params' });
  }
  if (depthOf(params) > MAX_DEPTH) {
    throw new AppError('VALIDATION_ERROR', `Вложенность параметров превышает ${MAX_DEPTH}`, {
      field: 'params',
    });
  }
  return descriptor;
}

export const restCallTool = defineTool({
  name: 'bitrix_rest_call',
  module: 'system',
  title: 'Прямой REST-вызов (диагностика)',
  description:
    'Контролируемый вызов одного REST-метода Bitrix24 из положительного allowlist (только чтение в MVP). ' +
    'Использовать для диагностики (profile, method.get) и чтения, для которого ещё нет именованного инструмента. ' +
    'Нельзя: batch, произвольные методы/URL, поля auth, запись. Отказ происходит до обращения к порталу.',
  operation: 'admin/diagnostic',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      method: z.string().min(1).max(100).describe('Точное имя метода, например profile или crm.deal.list'),
      apiVersion: z.enum(['legacy', 'v3']).default('legacy'),
      params: z.record(z.string().max(100), jsonValue).default({}).describe('Параметры по схеме метода'),
    })
    .strict(),
  outputDataSchema: z.object({
    result: z.unknown(),
    next: z.number().optional(),
    total: z.number().optional(),
    nextCursor: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    if (!ctx.config.policy.enableRawRest || ctx.config.policy.rawRestMode !== 'read-only') {
      throw new AppError('METHOD_NOT_ALLOWED', 'Прямой REST выключен конфигурацией');
    }
    const descriptor = checkRawCall(
      args.method,
      args.apiVersion,
      args.params,
      ctx.policies.methods.rawAllowlist,
    );
    if (!descriptor) throw new AppError('METHOD_NOT_ALLOWED', 'Метод не разрешён');
    const r = await ctx.bitrix.callDescriptor(descriptor, args.params, {
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    const warnings: string[] = [];
    if (r.next !== undefined)
      warnings.push(
        `Есть следующая страница: upstream next=${r.next}; для полного обхода используйте именованный инструмент с cursor`,
      );
    return ok(
      {
        result: r.result,
        ...(r.next !== undefined ? { next: r.next } : {}),
        ...(r.total !== undefined ? { total: r.total } : {}),
        ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: descriptor.method,
        apiVersion: descriptor.apiVersion,
        attempts: r.meta.attempts,
        completeness: r.next !== undefined ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

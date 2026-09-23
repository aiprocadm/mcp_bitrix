/**
 * Канонизация аргументов и хеши (ТЗ §8.2 п.2, §14.2).
 * Управляющие поля (dryRun, idempotencyKey, approvalId) в хеш не входят: один и тот же план
 * должен совпадать при подготовке и при повторе с approvalId.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../bitrix/pagination.js';
import { CONTROL_FIELDS } from '../schemas/common.js';

export function canonicalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (CONTROL_FIELDS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function argsHash(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson(canonicalArgs(args)))
    .digest('hex');
}

/** Хеш состояния объекта для expectedStateHash: канонический JSON выбранных полей. */
export function stateHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export function idempotencyScope(principalId: string, portalKey: string, tool: string, key: string): string {
  return `${principalId}|${portalKey}|${tool}|${key}`;
}

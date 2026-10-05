/**
 * Проверка доступности методов на портале (ТЗ §9.2 bitrix_capabilities).
 * `method.get` показывает, существует ли метод и доступен ли он текущей авторизации,
 * но НЕ доступ ко всем его объектам. Кэш 5 минут в SQLite.
 */
import { AppError } from '../errors/app-error.js';
import type { MemoryTtlCache } from '../storage/memory-cache.js';
import type { BitrixClient } from './client.js';
import { listMethods, type MethodDescriptor } from './method-registry.js';

export type CapabilityStatus = 'supported' | 'unavailable' | 'unchecked' | 'forbidden-by-policy' | 'error';

export interface MethodCapability {
  method: string;
  apiVersion: 'legacy' | 'v3';
  scope: string | undefined;
  status: CapabilityStatus;
  reason?: string;
}

interface ProbeResult {
  isExisting: boolean;
  isAvailable: boolean;
}

/** TTL кэша метаданных портала (Б§9.2: 5 минут). */
export const CAPABILITIES_TTL_MS = 5 * 60_000;

/**
 * Методы, для которых `method.get` портала отвечает `isAvailable=false`, хотя вызов работает.
 * Живой портал (облако, 2026-10-05, вебхук со scope `task`): все семь legacy `tasks.task.*`
 * из реестра — false, а `tasks.task.list`/`getfields` отдают данные; `task.checklistitem.*`,
 * `task.commentitem.*` и методы других модулей — true. Для них доступность решает выданный scope.
 */
export function methodGetUnreliable(descriptor: MethodDescriptor): boolean {
  return descriptor.apiVersion === 'legacy' && /^tasks\.task\.[a-z]+$/.test(descriptor.method);
}

export class CapabilityService {
  constructor(
    private readonly cache: MemoryTtlCache,
    private readonly client: BitrixClient,
  ) {}

  private cacheKey(kind: string, id: string): string {
    return `${this.client.auth.portalKey}:${kind}:${id}`;
  }

  private readCache<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  private writeCache(key: string, value: unknown): void {
    this.cache.set(key, value);
  }

  invalidate(): void {
    this.cache.deletePrefix(`${this.client.auth.portalKey}:`);
  }

  /** Кэш метаданных портала (поля CRM и т. п.), TTL 5 минут, привязан к порталу. */
  getCached<T>(kind: string, id: string): T | undefined {
    return this.readCache<T>(this.cacheKey(kind, id));
  }

  setCached(kind: string, id: string, value: unknown): void {
    this.writeCache(this.cacheKey(kind, id), value);
  }

  /** Список scope, доступных авторизации (метод `scope`, legacy). */
  async scopes(requestId: string, refresh = false): Promise<string[]> {
    const key = this.cacheKey('scopes', 'all');
    if (!refresh) {
      const cached = this.readCache<string[]>(key);
      if (cached) return cached;
    }
    const r = await this.client.call('legacy', 'scope', {}, { requestId });
    const scopes = Array.isArray(r.result) ? r.result.filter((s): s is string => typeof s === 'string') : [];
    this.writeCache(key, scopes);
    return scopes;
  }

  async probe(descriptor: MethodDescriptor, requestId: string, refresh = false): Promise<MethodCapability> {
    if (descriptor.apiVersion === 'v3') {
      return {
        method: descriptor.method,
        apiVersion: 'v3',
        scope: descriptor.scope,
        status: 'unchecked',
        reason: 'Проверка REST 3.0 выполняется через OpenAPI портала на следующем этапе',
      };
    }
    const key = this.cacheKey('method', descriptor.method);
    let probe = refresh ? undefined : this.readCache<ProbeResult>(key);
    if (!probe) {
      try {
        const r = await this.client.call('legacy', 'method.get', { name: descriptor.method }, { requestId });
        const obj = (
          r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : {}
        ) as Record<string, unknown>;
        probe = { isExisting: obj['isExisting'] === true, isAvailable: obj['isAvailable'] === true };
        this.writeCache(key, probe);
      } catch (e) {
        const err = AppError.from(e);
        return {
          method: descriptor.method,
          apiVersion: 'legacy',
          scope: descriptor.scope,
          status: 'error',
          reason: err.code,
        };
      }
    }
    if (!probe.isExisting)
      return {
        method: descriptor.method,
        apiVersion: 'legacy',
        scope: descriptor.scope,
        status: 'unavailable',
        reason: 'метод отсутствует на портале',
      };
    if (!probe.isAvailable && methodGetUnreliable(descriptor) && descriptor.scope) {
      let granted: string[];
      try {
        granted = await this.scopes(requestId, refresh);
      } catch (e) {
        return {
          method: descriptor.method,
          apiVersion: 'legacy',
          scope: descriptor.scope,
          status: 'error',
          reason: AppError.from(e).code,
        };
      }
      if (granted.includes(descriptor.scope))
        return {
          method: descriptor.method,
          apiVersion: 'legacy',
          scope: descriptor.scope,
          status: 'supported',
          reason: `method.get портала отвечает «недоступен» для tasks.task.*; scope ${descriptor.scope} выдан`,
        };
      return {
        method: descriptor.method,
        apiVersion: 'legacy',
        scope: descriptor.scope,
        status: 'unavailable',
        reason: `нет scope ${descriptor.scope}`,
      };
    }
    if (!probe.isAvailable)
      return {
        method: descriptor.method,
        apiVersion: 'legacy',
        scope: descriptor.scope,
        status: 'unavailable',
        reason: 'метод недоступен текущей авторизации (scope/права)',
      };
    return { method: descriptor.method, apiVersion: 'legacy', scope: descriptor.scope, status: 'supported' };
  }

  async probeAll(
    requestId: string,
    filter: (d: MethodDescriptor) => boolean,
    refresh = false,
  ): Promise<MethodCapability[]> {
    const out: MethodCapability[] = [];
    for (const d of listMethods().filter(filter)) out.push(await this.probe(d, requestId, refresh));
    return out;
  }
}

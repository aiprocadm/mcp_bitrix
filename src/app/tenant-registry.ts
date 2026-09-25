/**
 * Реестр контекстов арендаторов (SaaS-ТЗ §5.2): TenantScope собирается по токену пользователя на запрос,
 * кэшируется LRU с TTL и сбрасывается сразу при отзыве/смене тарифа (invalidate).
 * В режиме single реестр не нужен: единственный арендатор собран при старте.
 *
 * Ключ кэша — пара (арендатор, пользователь): у каждого пользователя свой OAuth-токен Bitrix24 (D3),
 * поэтому клиент портала у разных пользователей одного арендатора разный.
 */
import type { TenantScope } from './container.js';

export interface TenantScopeRegistryOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

interface Entry {
  readonly scope: Promise<TenantScope>;
  readonly tenantId: string;
  readonly expiresAt: number;
}

export class TenantScopeRegistry {
  private readonly map = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly opts: TenantScopeRegistryOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Контекст пользователя арендатора; одновременные запросы делят одну сборку. */
  async get(tenantId: string, userId: string, build: () => Promise<TenantScope>): Promise<TenantScope> {
    const key = `${tenantId}\u0000${userId}`;
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.scope;
    }
    const scope = build();
    this.map.set(key, { scope, tenantId, expiresAt: this.now() + this.opts.ttlMs });
    // Неудачная сборка не кэшируется: следующий запрос попробует снова.
    scope.catch(() => {
      if (this.map.get(key)?.scope === scope) this.map.delete(key);
    });
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return scope;
  }

  /** Отзыв доступа, смена тарифа/настроек, удаление приложения: все контексты арендатора (или пользователя). */
  invalidate(tenantId: string, userId?: string): number {
    let n = 0;
    for (const [key, e] of [...this.map.entries()]) {
      if (e.tenantId !== tenantId) continue;
      if (userId !== undefined && key !== `${tenantId}\u0000${userId}`) continue;
      this.map.delete(key);
      n += 1;
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }
}

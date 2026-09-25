/** SaaS-ТЗ §5.2: реестр TenantScope — LRU, TTL, общая сборка, инвалидация по арендатору/пользователю. */
import { describe, expect, it } from 'vitest';
import type { TenantScope } from '../../src/app/container.js';
import { TenantScopeRegistry } from '../../src/app/tenant-registry.js';

const fake = (tenantId: string) => ({ tenantId }) as unknown as TenantScope;

describe('TenantScopeRegistry', () => {
  it('кэширует на TTL, одновременные запросы делят одну сборку', async () => {
    let clock = 0;
    let builds = 0;
    const r = new TenantScopeRegistry({ ttlMs: 60_000, maxEntries: 10, now: () => clock });
    const build = () => {
      builds += 1;
      return Promise.resolve(fake('t1'));
    };
    const [x, y] = await Promise.all([r.get('t1', 'u1', build), r.get('t1', 'u1', build)]);
    expect(x).toBe(y);
    expect(builds).toBe(1);
    clock = 59_000;
    await r.get('t1', 'u1', build);
    expect(builds).toBe(1);
    clock = 61_000;
    await r.get('t1', 'u1', build);
    expect(builds).toBe(2);
  });

  it('разные пользователи одного арендатора — разные контексты; invalidate по пользователю и по арендатору', async () => {
    const r = new TenantScopeRegistry({ ttlMs: 60_000, maxEntries: 10 });
    await r.get('t1', 'u1', () => Promise.resolve(fake('t1')));
    await r.get('t1', 'u2', () => Promise.resolve(fake('t1')));
    await r.get('t2', 'u1', () => Promise.resolve(fake('t2')));
    expect(r.size).toBe(3);
    expect(r.invalidate('t1', 'u1')).toBe(1);
    expect(r.invalidate('t1')).toBe(1);
    expect(r.size).toBe(1);
  });

  it('LRU вытесняет давно не использованные; неудачная сборка не кэшируется', async () => {
    const r = new TenantScopeRegistry({ ttlMs: 60_000, maxEntries: 2 });
    await r.get('a', 'u', () => Promise.resolve(fake('a')));
    await r.get('b', 'u', () => Promise.resolve(fake('b')));
    await r.get('a', 'u', () => Promise.reject(new Error('не должно вызываться')));
    await r.get('c', 'u', () => Promise.resolve(fake('c')));
    expect(r.size).toBe(2);
    let rebuilt = false;
    await r.get('b', 'u', () => {
      rebuilt = true;
      return Promise.resolve(fake('b'));
    });
    expect(rebuilt).toBe(true);

    await expect(r.get('x', 'u', () => Promise.reject(new Error('portal down')))).rejects.toThrow(
      'portal down',
    );
    await Promise.resolve();
    let retried = false;
    await r.get('x', 'u', () => {
      retried = true;
      return Promise.resolve(fake('x'));
    });
    expect(retried).toBe(true);
  });
});

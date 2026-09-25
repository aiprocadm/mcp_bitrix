/**
 * Хранилище OAuth-токенов Bitrix24 пользователей (SaaS-ТЗ §6.2 `bitrix_tokens`, §7.3, D7).
 * access/refresh — только шифротекст под DEK арендатора (SecretBox из TenantKeyRing) с AAD
 * `bitrix-token:<tenant>:<user>`: строку одного пользователя нельзя подставить другому или другому арендатору.
 * Таблица под RLS: все запросы — через withTenant и с явным `tenant_id = ?`.
 * `generation` растёт при каждой записи новой пары — основа single-flight обновления между экземплярами.
 */
import { toNumber, type SqlDb, type SqlExecutor } from '../../storage/sql.js';
import type { TenantKeyRing } from '../keyring.js';
import type { BitrixOAuthTokens } from './oauth-client.js';

export interface StoredBitrixTokens {
  readonly tenantId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Момент истечения access_token, мс Unix. */
  readonly accessExpiresAt: number;
  readonly refreshIssuedAt: string;
  readonly scope: string;
  readonly clientEndpoint: string;
  readonly generation: number;
}

interface TokenRow {
  tenant_id: string;
  user_id: string;
  access_encrypted: string;
  refresh_encrypted: string;
  access_expires_at: string;
  refresh_issued_at: string;
  scope: string;
  client_endpoint: string;
  generation: number | string;
}

export const tokenAad = (tenantId: string, userId: string) => `bitrix-token:${tenantId}:${userId}`;

export class BitrixTokenStore {
  constructor(
    private readonly db: SqlDb,
    private readonly keys: TenantKeyRing,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(tenantId: string, userId: string): Promise<StoredBitrixTokens | undefined> {
    const row = await this.db.withTenant(tenantId, (x) =>
      x.get<TokenRow>('SELECT * FROM bitrix_tokens WHERE tenant_id = ? AND user_id = ?', tenantId, userId),
    );
    if (!row) return undefined;
    const box = await this.keys.boxFor(this.db, tenantId);
    const aad = tokenAad(tenantId, userId);
    return {
      tenantId,
      userId,
      accessToken: box.decrypt(row.access_encrypted, aad),
      refreshToken: box.decrypt(row.refresh_encrypted, aad),
      accessExpiresAt: Date.parse(row.access_expires_at),
      refreshIssuedAt: row.refresh_issued_at,
      scope: row.scope,
      clientEndpoint: row.client_endpoint,
      generation: toNumber(row.generation),
    };
  }

  /** Новая пара после входа/установки: вставка или замена, поколение +1. Возвращает новое поколение. */
  async save(tenantId: string, userId: string, t: BitrixOAuthTokens): Promise<number> {
    const enc = await this.encrypt(tenantId, userId, t);
    return this.db.withTenant(tenantId, async (x) => {
      await x.run(
        `INSERT INTO bitrix_tokens (tenant_id, user_id, access_encrypted, refresh_encrypted, access_expires_at, refresh_issued_at, scope, client_endpoint, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET access_encrypted = excluded.access_encrypted,
           refresh_encrypted = excluded.refresh_encrypted, access_expires_at = excluded.access_expires_at,
           refresh_issued_at = excluded.refresh_issued_at, scope = excluded.scope, client_endpoint = excluded.client_endpoint,
           generation = bitrix_tokens.generation + 1, updated_at = excluded.updated_at`,
        tenantId,
        userId,
        enc.access,
        enc.refresh,
        enc.expiresAt,
        enc.issuedAt,
        t.scope,
        t.clientEndpoint,
        enc.issuedAt,
      );
      return this.generation(x, tenantId, userId);
    });
  }

  /**
   * Запись обновлённой пары при условии, что с момента чтения никто не записал новую (поколение совпадает).
   * undefined — поколение уже сменилось (пару обновил другой экземпляр): нужно перечитать.
   */
  async saveRefreshed(
    tenantId: string,
    userId: string,
    t: BitrixOAuthTokens,
    expectedGeneration: number,
  ): Promise<number | undefined> {
    const enc = await this.encrypt(tenantId, userId, t);
    return this.db.withTenant(tenantId, async (x) => {
      const n = await x.run(
        `UPDATE bitrix_tokens SET access_encrypted = ?, refresh_encrypted = ?, access_expires_at = ?, refresh_issued_at = ?,
           scope = ?, client_endpoint = ?, generation = generation + 1, updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND generation = ?`,
        enc.access,
        enc.refresh,
        enc.expiresAt,
        enc.issuedAt,
        t.scope,
        t.clientEndpoint,
        enc.issuedAt,
        tenantId,
        userId,
        expectedGeneration,
      );
      return n === 1 ? this.generation(x, tenantId, userId) : undefined;
    });
  }

  async delete(tenantId: string, userId: string): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.run('DELETE FROM bitrix_tokens WHERE tenant_id = ? AND user_id = ?', tenantId, userId),
    );
  }

  /** Удаление всех токенов арендатора (удаление приложения, §7.4). Возвращает число удалённых пар. */
  async deleteAllForTenant(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, (x) =>
      x.run('DELETE FROM bitrix_tokens WHERE tenant_id = ?', tenantId),
    );
  }

  /** Пользователи арендатора, у которых есть токены (для app.info и обслуживания). */
  async usersWithTokens(tenantId: string): Promise<string[]> {
    const rows = await this.db.withTenant(tenantId, (x) =>
      x.all<{ user_id: string }>(
        'SELECT user_id FROM bitrix_tokens WHERE tenant_id = ? ORDER BY updated_at DESC',
        tenantId,
      ),
    );
    return rows.map((r) => r.user_id);
  }

  private async generation(x: SqlExecutor, tenantId: string, userId: string): Promise<number> {
    const r = await x.get<{ generation: unknown }>(
      'SELECT generation FROM bitrix_tokens WHERE tenant_id = ? AND user_id = ?',
      tenantId,
      userId,
    );
    return toNumber(r?.generation);
  }

  private async encrypt(tenantId: string, userId: string, t: BitrixOAuthTokens) {
    const box = await this.keys.boxFor(this.db, tenantId);
    const aad = tokenAad(tenantId, userId);
    const now = this.now();
    return {
      access: box.encrypt(t.accessToken, aad),
      refresh: box.encrypt(t.refreshToken, aad),
      expiresAt: new Date(now + t.expiresIn * 1000).toISOString(),
      issuedAt: new Date(now).toISOString(),
    };
  }
}

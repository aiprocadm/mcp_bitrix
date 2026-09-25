/**
 * Хранилища сервера авторизации MCP (SaaS-ТЗ §6.2, §7.1) на PostgreSQL (схема — миграция 2 и s4.ts).
 *  - mcp_clients, mcp_auth_codes, mcp_refresh_tokens — каталог без RLS (нужны до выбора арендатора), но каждая
 *    строка кода и refresh-токена несёт tenant_id/user_id и сверяется с клиентом;
 *  - mcp_consents — под RLS: только через withTenant и с tenant_id в WHERE.
 * Коды и refresh-токены хранятся только как SHA-256; сами значения не сохраняются и не логируются.
 */
import { randomUUID } from 'node:crypto';
import { toNumber, type SqlDb, type SqlExecutor } from '../../storage/sql.js';
import { randomToken, sha256Hex } from './crypto.js';

const iso = (ms: number) => new Date(ms).toISOString();

export type ClientKind = 'dcr' | 'cimd';
export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface ClientMetadata {
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  application_type?: 'native' | 'web';
  client_uri?: string;
  software_id?: string;
  software_version?: string;
}

export interface OAuthClient {
  clientId: string;
  kind: ClientKind;
  clientName: string;
  redirectUris: string[];
  metadata: ClientMetadata;
  secretHash: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  metadataExpiresAt: string | null;
}

interface ClientRow {
  client_id: string;
  kind: ClientKind;
  client_name: string;
  redirect_uris_json: string;
  metadata_json: string;
  secret_hash: string | null;
  created_at: string;
  last_used_at: string | null;
  metadata_expires_at: string | null;
}

const toClient = (r: ClientRow): OAuthClient => ({
  clientId: r.client_id,
  kind: r.kind,
  clientName: r.client_name,
  redirectUris: JSON.parse(r.redirect_uris_json) as string[],
  metadata: JSON.parse(r.metadata_json) as ClientMetadata,
  secretHash: r.secret_hash,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  metadataExpiresAt: r.metadata_expires_at,
});

export class OAuthClientsRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** DCR (RFC 7591): новый client_id; секрет — только для конфиденциальных клиентов, в БД — хеш. */
  async registerDynamic(input: {
    clientName: string;
    redirectUris: string[];
    metadata: ClientMetadata;
  }): Promise<{ client: OAuthClient; clientSecret: string | undefined }> {
    const clientId = `mcp_${randomToken(18)}`;
    const clientSecret =
      input.metadata.token_endpoint_auth_method === 'none' ? undefined : `mcps_${randomToken(32)}`;
    await this.db.run(
      `INSERT INTO mcp_clients (client_id, client_name, redirect_uris_json, created_at, last_used_at, kind, metadata_json, secret_hash, metadata_expires_at)
       VALUES (?, ?, ?, ?, NULL, 'dcr', ?, ?, NULL)`,
      clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      iso(this.now()),
      JSON.stringify(input.metadata),
      clientSecret ? sha256Hex(clientSecret) : null,
    );
    const client = await this.get(clientId);
    if (!client) throw new Error('Клиент не сохранён');
    return { client, clientSecret };
  }

  /** Кэш документа Client ID Metadata Document: client_id = URL документа. */
  async upsertCimd(input: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    metadata: ClientMetadata;
    expiresAtMs: number;
  }): Promise<OAuthClient> {
    await this.db.run(
      `INSERT INTO mcp_clients (client_id, client_name, redirect_uris_json, created_at, last_used_at, kind, metadata_json, secret_hash, metadata_expires_at)
       VALUES (?, ?, ?, ?, NULL, 'cimd', ?, NULL, ?)
       ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris_json = excluded.redirect_uris_json,
         metadata_json = excluded.metadata_json, metadata_expires_at = excluded.metadata_expires_at
       WHERE mcp_clients.kind = 'cimd'`,
      input.clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      iso(this.now()),
      JSON.stringify(input.metadata),
      iso(input.expiresAtMs),
    );
    const client = await this.get(input.clientId);
    if (!client) throw new Error('Клиент не сохранён');
    return client;
  }

  async get(clientId: string): Promise<OAuthClient | undefined> {
    const r = await this.db.get<ClientRow>('SELECT * FROM mcp_clients WHERE client_id = ?', clientId);
    return r ? toClient(r) : undefined;
  }

  /** Отметка использования (выдача токенов): неиспользуемые клиенты удаляются через 30 дней. */
  async touch(clientId: string): Promise<void> {
    await this.db.run(
      'UPDATE mcp_clients SET last_used_at = ? WHERE client_id = ?',
      iso(this.now()),
      clientId,
    );
  }

  /**
   * Задача worker (ТЗ §7.1): удалить клиентов, не использованных `days` дней (по last_used_at, иначе created_at).
   * Их коды, refresh-токены и согласия удаляются каскадом. Возвращает число удалённых клиентов.
   */
  async purgeUnused(days: number): Promise<number> {
    return this.db.run(
      'DELETE FROM mcp_clients WHERE COALESCE(last_used_at, created_at) < ?',
      iso(this.now() - days * 86_400_000),
    );
  }
}

export interface AuthCodeRecord {
  clientId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  familyId: string;
  tokenGeneration: number;
  expiresAt: string;
}

interface CodeRow {
  client_id: string;
  tenant_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  family_id: string;
  token_generation: number | string;
  expires_at: string;
  used_at: string | null;
}

export type ConsumeCodeResult =
  | { status: 'ok'; code: AuthCodeRecord }
  | { status: 'reused'; code: AuthCodeRecord }
  | { status: 'expired' | 'unknown' };

export class AuthCodesRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Новый одноразовый код; в БД — только SHA-256. */
  async create(input: Omit<AuthCodeRecord, 'expiresAt' | 'familyId'>, ttlSec: number): Promise<string> {
    const code = randomToken(32);
    await this.db.run(
      `INSERT INTO mcp_auth_codes (code_hash, client_id, tenant_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at, family_id, token_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      sha256Hex(code),
      input.clientId,
      input.tenantId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.scope,
      input.resource,
      iso(this.now() + ttlSec * 1000),
      randomUUID(),
      input.tokenGeneration,
    );
    return code;
  }

  /**
   * Погасить код атомарно: первый вызов — `ok`; повторный — `reused` (вызывающий отзывает выданное по коду);
   * истёкший — `expired`. Сверку клиента/redirect/PKCE делает вызывающий уже после гашения (код одноразовый
   * при любой ошибке, OAuth 2.1 §4.1.3).
   */
  async consume(code: string): Promise<ConsumeCodeResult> {
    const hash = sha256Hex(code);
    const nowIso = iso(this.now());
    return this.db.transaction(async (x) => {
      const updated = await x.run(
        'UPDATE mcp_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
        nowIso,
        hash,
      );
      const row = await x.get<CodeRow>('SELECT * FROM mcp_auth_codes WHERE code_hash = ?', hash);
      if (!row) return { status: 'unknown' };
      const rec: AuthCodeRecord = {
        clientId: row.client_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        familyId: row.family_id,
        tokenGeneration: toNumber(row.token_generation),
        expiresAt: row.expires_at,
      };
      if (updated === 0) return { status: 'reused', code: rec };
      if (row.expires_at <= nowIso) return { status: 'expired' };
      return { status: 'ok', code: rec };
    });
  }

  /** Задача worker: удалить истёкшие коды (погашенные храним до истечения — для обнаружения повтора). */
  async purgeExpired(): Promise<number> {
    return this.db.run('DELETE FROM mcp_auth_codes WHERE expires_at < ?', iso(this.now() - 3600_000));
  }
}

export interface RefreshRecord {
  familyId: string;
  clientId: string;
  tenantId: string;
  userId: string;
  scope: string;
  resource: string;
  tokenGeneration: number;
}

interface RefreshRow {
  family_id: string;
  client_id: string;
  tenant_id: string;
  user_id: string;
  scope: string;
  resource: string;
  token_generation: number | string;
  expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

const toRefresh = (r: RefreshRow): RefreshRecord => ({
  familyId: r.family_id,
  clientId: r.client_id,
  tenantId: r.tenant_id,
  userId: r.user_id,
  scope: r.scope,
  resource: r.resource,
  tokenGeneration: toNumber(r.token_generation),
});

export type RotateResult =
  | { status: 'ok'; record: RefreshRecord }
  /** Повтор уже ротированного токена: вся семья отозвана (S06). */
  | { status: 'reuse_detected'; record: RefreshRecord }
  | { status: 'invalid' };

export class RefreshTokensRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  private async insert(x: SqlExecutor, rec: RefreshRecord, ttlSec: number): Promise<string> {
    const token = `mcpr_${randomToken(32)}`;
    await x.run(
      `INSERT INTO mcp_refresh_tokens (token_hash, family_id, client_id, tenant_id, user_id, scope, resource, created_at, expires_at, rotated_at, revoked_at, token_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      sha256Hex(token),
      rec.familyId,
      rec.clientId,
      rec.tenantId,
      rec.userId,
      rec.scope,
      rec.resource,
      iso(this.now()),
      iso(this.now() + ttlSec * 1000),
      rec.tokenGeneration,
    );
    return token;
  }

  async issue(rec: RefreshRecord, ttlSec: number): Promise<string> {
    return this.insert(this.db, rec, ttlSec);
  }

  /**
   * Ротация (OAuth 2.1 §4.3.1): старый токен помечается rotated и выдаётся новый той же семьи.
   * Повтор уже ротированного токена → отзыв всей семьи (кража токена: легитимный клиент и атакующий
   * не различимы — отзываются оба). Отозванный, истёкший и чужого клиента — `invalid`.
   * `narrowScope` — запрошенное сужение прав (RFC 6749 §6), уже проверенное вызывающим.
   */
  async rotate(
    token: string,
    clientId: string,
    ttlSec: number,
    check: (rec: RefreshRecord) => Promise<{ scope: string } | undefined>,
  ): Promise<RotateResult & { token?: string }> {
    const hash = sha256Hex(token);
    const nowIso = iso(this.now());
    const outcome = await this.db.transaction(async (x) => {
      const row = await x.get<RefreshRow>('SELECT * FROM mcp_refresh_tokens WHERE token_hash = ?', hash);
      if (row?.client_id !== clientId) return { status: 'invalid' as const };
      if (row.rotated_at !== null) {
        await x.run(
          'UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
          nowIso,
          row.family_id,
        );
        return { status: 'reuse_detected' as const, record: toRefresh(row) };
      }
      if (row.revoked_at !== null || row.expires_at <= nowIso) return { status: 'invalid' as const };
      // Условное обновление — защита от гонки двух одновременных ротаций одного токена.
      const claimed = await x.run(
        'UPDATE mcp_refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL',
        nowIso,
        hash,
      );
      if (claimed !== 1) return { status: 'invalid' as const };
      const rec = toRefresh(row);
      const allowed = await check(rec);
      if (!allowed) {
        // Пользователь отключён/поколение сменилось: семья больше не нужна.
        await x.run(
          'UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
          nowIso,
          row.family_id,
        );
        return { status: 'invalid' as const };
      }
      const next: RefreshRecord = { ...rec, scope: allowed.scope };
      const newToken = await this.insert(x, next, ttlSec);
      return { status: 'ok' as const, record: next, token: newToken };
    });
    return outcome;
  }

  /** Запись по токену без изменений (для /revoke). */
  async find(token: string): Promise<RefreshRecord | undefined> {
    const r = await this.db.get<RefreshRow>(
      'SELECT * FROM mcp_refresh_tokens WHERE token_hash = ?',
      sha256Hex(token),
    );
    return r ? toRefresh(r) : undefined;
  }

  async revokeFamily(familyId: string): Promise<number> {
    return this.db.run(
      'UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      iso(this.now()),
      familyId,
    );
  }

  async revokeUser(tenantId: string, userId: string): Promise<number> {
    return this.db.run(
      'UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL',
      iso(this.now()),
      tenantId,
      userId,
    );
  }

  async revokeTenant(tenantId: string): Promise<number> {
    return this.db.run(
      'UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL',
      iso(this.now()),
      tenantId,
    );
  }

  /** Живые (не отозванные, не ротированные, не истёкшие) токены семьи — для проверок и тестов. */
  async activeInFamily(familyId: string): Promise<number> {
    const r = await this.db.get<{ n: unknown }>(
      'SELECT COUNT(*) AS n FROM mcp_refresh_tokens WHERE family_id = ? AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > ?',
      familyId,
      iso(this.now()),
    );
    return toNumber(r?.n);
  }

  /** Задача worker: удалить истёкшие записи (ротированные храним до истечения — для обнаружения повтора). */
  async purgeExpired(): Promise<number> {
    return this.db.run('DELETE FROM mcp_refresh_tokens WHERE expires_at < ?', iso(this.now()));
  }
}

export class ConsentsRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Разрешённые scope для пары пользователь–клиент (RLS: только в контексте арендатора). */
  async get(tenantId: string, userId: string, clientId: string): Promise<string[] | undefined> {
    const r = await this.db.withTenant(tenantId, (x) =>
      x.get<{ scope: string }>(
        'SELECT scope FROM mcp_consents WHERE tenant_id = ? AND user_id = ? AND client_id = ?',
        tenantId,
        userId,
        clientId,
      ),
    );
    return r ? r.scope.split(' ').filter(Boolean) : undefined;
  }

  async save(tenantId: string, userId: string, clientId: string, scopes: readonly string[]): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.run(
        `INSERT INTO mcp_consents (tenant_id, user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id, client_id) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at`,
        tenantId,
        userId,
        clientId,
        [...scopes].sort().join(' '),
        iso(this.now()),
      ),
    );
  }

  /** Отзыв согласий пользователя (всех или одного клиента). */
  async revoke(tenantId: string, userId: string, clientId?: string): Promise<number> {
    return this.db.withTenant(tenantId, (x) =>
      clientId
        ? x.run(
            'DELETE FROM mcp_consents WHERE tenant_id = ? AND user_id = ? AND client_id = ?',
            tenantId,
            userId,
            clientId,
          )
        : x.run('DELETE FROM mcp_consents WHERE tenant_id = ? AND user_id = ?', tenantId, userId),
    );
  }
}

/**
 * Сессии кабинета клиента и состояния входа через Bitrix24 (SaaS-ТЗ §11.1, §12 п.5; миграция PG 50).
 *
 * Сессия: cookie `<tenantId>.<секрет>`; в БД — только SHA-256 секрета (`id_hash`) и хеш CSRF-токена. Таблица под RLS:
 * поиск идёт в контексте арендатора из cookie, поэтому подставленный чужой id арендатора ничего не находит.
 * CSRF-токен выводится из секрета сессии (HMAC-подобная производная SHA-256), в БД хранится его хеш.
 *
 * Состояние входа: одноразовый `state` (префикс `cab.`), привязанный к браузеру cookie `bind` (в БД — хеши обоих),
 * с доменом портала и адресом возврата; срок — 10 минут; используется ровно один раз (DELETE … с проверкой числа строк).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlDb } from '../../storage/sql.js';

export const CABINET_STATE_PREFIX = 'cab.';
export const SESSION_TTL_MS = 8 * 3600_000;
export const LOGIN_STATE_TTL_MS = 10 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface CabinetSession {
  readonly tenantId: string;
  readonly userId: string;
  /** CSRF-токен форм этой сессии. */
  readonly csrf: string;
  /** Время входа через Bitrix24 (свежесть входа для удалений и массовых замен). */
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

interface SessionRow {
  tenant_id: string;
  user_id: string;
  csrf: string;
  authenticated_at: string;
  expires_at: string;
}

const csrfFor = (secret: string) => sha256(`cabinet-csrf:${secret}`).slice(0, 43);

/** Разбор cookie сессии: `<uuid арендатора>.<секрет 32 байта base64url>`. */
export function parseSessionCookie(
  value: string | undefined,
): { tenantId: string; secret: string } | undefined {
  if (!value) return undefined;
  const i = value.indexOf('.');
  if (i <= 0) return undefined;
  const tenantId = value.slice(0, i);
  const secret = value.slice(i + 1);
  if (!UUID_RE.test(tenantId) || !SECRET_RE.test(secret)) return undefined;
  return { tenantId, secret };
}

export class CabinetSessionStore {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Новая сессия после входа через Bitrix24; заодно удаляются истёкшие сессии арендатора. */
  async open(tenantId: string, userId: string): Promise<{ cookieValue: string; session: CabinetSession }> {
    const secret = randomToken(32);
    const t = this.now();
    const at = new Date(t).toISOString();
    const expiresAt = new Date(t + SESSION_TTL_MS).toISOString();
    const csrf = csrfFor(secret);
    await this.db.withTenant(tenantId, async (x) => {
      await x.run('DELETE FROM cabinet_sessions WHERE tenant_id = ? AND expires_at < ?', tenantId, at);
      await x.run(
        `INSERT INTO cabinet_sessions (id_hash, tenant_id, user_id, csrf, authenticated_at, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sha256(secret),
        tenantId,
        userId,
        sha256(csrf),
        at,
        at,
        expiresAt,
        at,
      );
    });
    return {
      cookieValue: `${tenantId}.${secret}`,
      session: { tenantId, userId, csrf, authenticatedAt: at, expiresAt },
    };
  }

  /** Сессия по cookie; истёкшая, чужая или подделанная — undefined (без различий). */
  async byCookie(value: string | undefined): Promise<CabinetSession | undefined> {
    const parsed = parseSessionCookie(value);
    if (!parsed) return undefined;
    const row = await this.db.withTenant(parsed.tenantId, (x) =>
      x.get<SessionRow>(
        'SELECT tenant_id, user_id, csrf, authenticated_at, expires_at FROM cabinet_sessions WHERE tenant_id = ? AND id_hash = ?',
        parsed.tenantId,
        sha256(parsed.secret),
      ),
    );
    if (!row || Date.parse(row.expires_at) <= this.now()) return undefined;
    const csrf = csrfFor(parsed.secret);
    if (!safeEqualStr(sha256(csrf), row.csrf)) return undefined;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      csrf,
      authenticatedAt: row.authenticated_at,
      expiresAt: row.expires_at,
    };
  }

  async close(value: string | undefined): Promise<void> {
    const parsed = parseSessionCookie(value);
    if (!parsed) return;
    await this.db.withTenant(parsed.tenantId, (x) =>
      x.run(
        'DELETE FROM cabinet_sessions WHERE tenant_id = ? AND id_hash = ?',
        parsed.tenantId,
        sha256(parsed.secret),
      ),
    );
  }

  /** Отключение пользователя: все его сессии кабинета закрываются сразу. */
  async closeAllForUser(tenantId: string, userId: string): Promise<number> {
    return this.db.withTenant(tenantId, (x) =>
      x.run('DELETE FROM cabinet_sessions WHERE tenant_id = ? AND user_id = ?', tenantId, userId),
    );
  }
}

export interface LoginState {
  readonly portal: string;
  readonly returnTo: string;
}

export class CabinetLoginStates {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Новое состояние входа; возвращает `state` для Bitrix24. */
  async create(bind: string, portal: string, returnTo: string): Promise<string> {
    const state = CABINET_STATE_PREFIX + randomToken(32);
    const t = this.now();
    await this.db.run('DELETE FROM cabinet_login_states WHERE expires_at < ?', new Date(t).toISOString());
    await this.db.run(
      'INSERT INTO cabinet_login_states (state_hash, bind_hash, portal, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(state),
      sha256(bind),
      portal,
      returnTo,
      new Date(t).toISOString(),
      new Date(t + LOGIN_STATE_TTL_MS).toISOString(),
    );
    return state;
  }

  /**
   * Одноразовое использование: состояние удаляется в любом случае; годится, только если не истекло и
   * создано в этом же браузере (cookie bind).
   */
  async consume(state: string, bind: string | undefined): Promise<LoginState | undefined> {
    if (!state.startsWith(CABINET_STATE_PREFIX) || state.length > 128) return undefined;
    const hash = sha256(state);
    return this.db.transaction(async (x) => {
      const row = await x.get<{ bind_hash: string; portal: string; return_to: string; expires_at: string }>(
        'SELECT bind_hash, portal, return_to, expires_at FROM cabinet_login_states WHERE state_hash = ? FOR UPDATE',
        hash,
      );
      if (!row) return undefined;
      const n = await x.run('DELETE FROM cabinet_login_states WHERE state_hash = ?', hash);
      if (n !== 1) return undefined;
      if (Date.parse(row.expires_at) <= this.now()) return undefined;
      if (!bind || !safeEqualStr(sha256(bind), row.bind_hash)) return undefined;
      return { portal: row.portal, returnTo: row.return_to };
    });
  }
}

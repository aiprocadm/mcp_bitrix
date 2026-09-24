/**
 * Учётные записи и сессии панели /admin (ТЗ §4.5: «отдельный пользовательский вход, CSRF-защита»).
 * Это НЕ OAuth-токены MCP и НЕ Bitrix: пароль владельца, scrypt-хеш в SQLite, сессия — случайный
 * cookie (в БД хранится только его SHA-256), CSRF-токен на сессию. Ничего из этого не печатается в логи.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from '../config/policy.js';
import { AppError } from '../errors/app-error.js';
import type { Database } from '../storage/database.js';

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
const SESSION_TTL_SECONDS = 8 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export interface AdminUser {
  name: string;
  principalId: string;
  createdAt: string;
}

export interface AdminSession {
  user: AdminUser;
  csrf: string;
  expiresAt: string;
}

interface UserRow {
  name: string;
  principal_id: string;
  password_hash: string;
  created_at: string;
}

interface SessionRow {
  id_hash: string;
  user_name: string;
  csrf: string;
  expires_at: string;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

function encodeHash(salt: Buffer, hash: Buffer): string {
  return `scrypt$${String(SCRYPT.N)}$${String(SCRYPT.r)}$${String(SCRYPT.p)}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Постоянный «пустой» хеш для выравнивания времени ответа, когда пользователя нет. */
const DUMMY_SALT = Buffer.alloc(16, 1);
const DUMMY_HASH = hashPassword('dummy-password-for-timing', DUMMY_SALT);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new AppError('VALIDATION_ERROR', `Пароль короче ${String(ADMIN_PASSWORD_MIN_LENGTH)} символов`, {
      field: 'password',
    });
  }
  if (/^\s|\s$/.test(password)) {
    throw new AppError('VALIDATION_ERROR', 'Пароль не должен начинаться или заканчиваться пробелом', {
      field: 'password',
    });
  }
}

export class AdminAccounts {
  constructor(
    private readonly db: Database,
    private readonly roleOf: (principalId: string) => Role | undefined,
  ) {}

  /** Создать или сменить пароль. Только из интерактивной CLI (admin:user). */
  upsert(name: string, principalId: string, password: string): AdminUser {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(name)) {
      throw new AppError('VALIDATION_ERROR', 'Имя пользователя: 2–64 символа, латиница/цифры/._-', {
        field: 'name',
      });
    }
    if (!this.roleOf(principalId)) {
      throw new AppError('VALIDATION_ERROR', 'principalId отсутствует в policies/access.json', {
        field: 'principal',
        nextAction: 'Добавьте principal с ролью в access policy, затем создайте пользователя',
      });
    }
    assertPasswordPolicy(password);
    const salt = randomBytes(16);
    const encoded = encodeHash(salt, hashPassword(password, salt));
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO admin_users (name, principal_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET principal_id = excluded.principal_id, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      name,
      principalId,
      encoded,
      now,
      now,
    );
    // Смена пароля закрывает все сессии пользователя.
    this.db.run('DELETE FROM admin_sessions WHERE user_name = ?', name);
    const row = this.db.get<UserRow>('SELECT * FROM admin_users WHERE name = ?', name);
    if (!row) throw new AppError('INTERNAL_ERROR', 'Пользователь не сохранён');
    return {
      name: row.name,
      principal_id: row.principal_id,
      createdAt: row.created_at,
    } as unknown as AdminUser;
  }

  list(): AdminUser[] {
    return this.db
      .all<UserRow>('SELECT * FROM admin_users ORDER BY name')
      .map((r) => ({ name: r.name, principalId: r.principal_id, createdAt: r.created_at }));
  }

  remove(name: string): boolean {
    this.db.run('DELETE FROM admin_sessions WHERE user_name = ?', name);
    return this.db.run('DELETE FROM admin_users WHERE name = ?', name).changes > 0;
  }

  /** Проверка пароля с постоянным временем; неизвестное имя тоже «считает» хеш. */
  verify(name: string, password: string): AdminUser | undefined {
    const row = this.db.get<UserRow>('SELECT * FROM admin_users WHERE name = ?', name);
    const parts = row?.password_hash.split('$');
    if (!row || parts?.length !== 6 || parts[0] !== 'scrypt') {
      hashPassword(password, DUMMY_SALT);
      timingSafeEqual(DUMMY_HASH, DUMMY_HASH);
      return undefined;
    }
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
    });
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    return { name: row.name, principalId: row.principal_id, createdAt: row.created_at };
  }

  role(user: AdminUser): Role {
    return this.roleOf(user.principalId) ?? 'reader';
  }

  openSession(user: AdminUser): { cookieValue: string; session: AdminSession } {
    this.cleanupExpired();
    const cookieValue = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    this.db.run(
      'INSERT INTO admin_sessions (id_hash, user_name, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(cookieValue),
      user.name,
      csrf,
      new Date().toISOString(),
      expiresAt,
    );
    return { cookieValue, session: { user, csrf, expiresAt } };
  }

  sessionByCookie(cookieValue: string | undefined): AdminSession | undefined {
    if (!cookieValue || !/^[A-Za-z0-9_-]{20,128}$/.test(cookieValue)) return undefined;
    const row = this.db.get<SessionRow>(
      'SELECT * FROM admin_sessions WHERE id_hash = ?',
      sha256(cookieValue),
    );
    if (!row) return undefined;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.db.run('DELETE FROM admin_sessions WHERE id_hash = ?', row.id_hash);
      return undefined;
    }
    const user = this.db.get<UserRow>('SELECT * FROM admin_users WHERE name = ?', row.user_name);
    if (!user) return undefined;
    return {
      user: { name: user.name, principalId: user.principal_id, createdAt: user.created_at },
      csrf: row.csrf,
      expiresAt: row.expires_at,
    };
  }

  closeSession(cookieValue: string | undefined): void {
    if (!cookieValue) return;
    this.db.run('DELETE FROM admin_sessions WHERE id_hash = ?', sha256(cookieValue));
  }

  cleanupExpired(): void {
    this.db.run('DELETE FROM admin_sessions WHERE expires_at < ?', new Date().toISOString());
  }
}

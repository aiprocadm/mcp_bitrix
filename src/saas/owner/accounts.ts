/**
 * Учётные записи и сессии панели владельца `/owner` (SaaS-ТЗ §11.3, §4 роли service_owner/support).
 *
 * Вход — отдельная учётная запись владельца, НЕ через Bitrix24: email + пароль (scrypt) + TOTP (RFC 6238).
 *  - пароль: scrypt N=16384, r=8, p=1, соль 16 байт; неизвестный email тоже «считает» хеш (одинаковое время);
 *  - TOTP: секрет под ключом, выведенным из KEK (HKDF, отдельная цель), AAD = имя учётной записи;
 *    окно ±1 шаг; повтор кода (шаг ≤ последнего принятого) отклоняется условным UPDATE — даже при гонке двух запросов;
 *  - блокировка: MAX_FAILED неудач подряд → вход закрыт на LOCK_MS (в БД, переживает перезапуск);
 *  - сессия: случайный cookie (в БД только SHA-256), CSRF-токен на сессию, абсолютный срок 8 ч и 30 мин бездействия.
 * Пароль, секрет TOTP, код и cookie в логи не попадают.
 */
import {
  createHash,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError } from '../../errors/app-error.js';
import { SecretBox } from '../../security/crypto.js';
import { toNumber, type SqlDb } from '../../storage/sql.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export type OwnerRole = 'service_owner' | 'support';

export interface OwnerUser {
  readonly name: string;
  readonly role: OwnerRole;
}

export interface OwnerSession {
  readonly owner: OwnerUser;
  readonly csrf: string;
  readonly expiresAt: string;
}

export type OwnerLoginResult =
  { ok: true; owner: OwnerUser } | { ok: false; reason: 'invalid' | 'locked' | 'disabled' };

export const OWNER_PASSWORD_MIN_LENGTH = 14;
export const OWNER_MAX_FAILED = 5;
export const OWNER_LOCK_MS = 15 * 60_000;
export const OWNER_SESSION_TTL_MS = 8 * 3600_000;
export const OWNER_SESSION_IDLE_MS = 30 * 60_000;
/** Издатель в otpauth-URI: ASCII (не все приложения-аутентификаторы корректно показывают кириллицу). */
export const TOTP_ISSUER = 'MCP Bitrix24 Owner';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;
const COOKIE_RE = /^[A-Za-z0-9_-]{40,64}$/;

function scrypt(password: string, salt: Buffer, keylen: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, o, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const totpAad = (name: string) => `owner-totp:${name}`;

/** Ключ шифрования секретов TOTP владельцев: выводится из KEK (HKDF-SHA256), отдельно от DEK арендаторов. */
export function ownerSecretsBox(kek: Buffer): SecretBox {
  if (kek.length !== 32)
    throw new AppError('CONFIG_INVALID', 'KEK должен быть 32 байта', { field: 'KEK_FILE' });
  return new SecretBox(Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), 'mcp-owner-totp-v1', 32)));
}

/**
 * Чтение KEK из файла KEK_FILE для CLI владельца: 64 hex-символа (как ключ `SECRETS_KEY_FILE` базового режима)
 * либо ровно 32 байта. Сборка режима saas обязана передавать в `ownerSecretsBox` те же 32 байта, что и в
 * `TenantKeyRing`, иначе секреты TOTP, записанные CLI, не расшифруются.
 */
export function readKekFile(filePath: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch {
    throw new AppError('CONFIG_INVALID', 'Файл KEK не читается', { field: 'KEK_FILE' });
  }
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (raw.length === 32) return raw;
  throw new AppError('CONFIG_INVALID', 'KEK: ожидается 64 hex-символа или 32 байта', { field: 'KEK_FILE' });
}

/** Email владельца: нижний регистр, простой формат. */
export function normalizeOwnerEmail(input: string): string {
  const e = input.trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254)
    throw new AppError('VALIDATION_ERROR', 'Укажите email учётной записи владельца', { field: 'email' });
  return e;
}

export function assertOwnerPasswordPolicy(password: string): void {
  if (password.length < OWNER_PASSWORD_MIN_LENGTH)
    throw new AppError(
      'VALIDATION_ERROR',
      `Пароль владельца — не короче ${String(OWNER_PASSWORD_MIN_LENGTH)} символов`,
      { field: 'password' },
    );
  if (password.length > 1024)
    throw new AppError('VALIDATION_ERROR', 'Пароль слишком длинный', { field: 'password' });
  if (/^\s|\s$/.test(password))
    throw new AppError('VALIDATION_ERROR', 'Пароль не должен начинаться или заканчиваться пробелом', {
      field: 'password',
    });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${String(SCRYPT.N)}$${String(SCRYPT.r)}$${String(SCRYPT.p)}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const DUMMY_SALT = Buffer.alloc(16, 7);

async function checkPassword(password: string, encoded: string | undefined): Promise<boolean> {
  const parts = encoded?.split('$');
  if (parts?.length !== 6 || parts[0] !== 'scrypt') {
    await scrypt(password, DUMMY_SALT, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  const actual = await scrypt(password, Buffer.from(parts[4] ?? '', 'base64'), expected.length, {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface OwnerRow {
  name: string;
  role: OwnerRole;
  password_hash: string;
  totp_secret_encrypted: string;
  failed_attempts: number | string;
  locked_until: string | null;
  last_totp_step: number | string;
  last_login_at: string | null;
  disabled: number | string;
  created_at: string;
}

export interface OwnerAccountInfo {
  name: string;
  role: OwnerRole;
  disabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface OwnerAccountsOptions {
  readonly db: SqlDb;
  /** `ownerSecretsBox(kek)`. */
  readonly secrets: SecretBox;
  readonly now?: () => number;
}

export class OwnerAccounts {
  private readonly now: () => number;

  constructor(private readonly o: OwnerAccountsOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  /**
   * Новая учётная запись (CLI `npm run owner -- create`). Возвращает секрет TOTP и otpauth-URI — их показывают
   * ОДИН раз в терминале; в БД секрет только зашифрован.
   */
  async create(input: {
    email: string;
    role: OwnerRole;
    password: string;
  }): Promise<{ name: string; secret: Buffer; otpauthUri: string }> {
    const name = normalizeOwnerEmail(input.email);
    assertOwnerPasswordPolicy(input.password);
    const secret = newTotpSecret();
    const at = this.iso();
    const n = await this.o.db.run(
      `INSERT INTO owner_users (name, role, password_hash, totp_secret_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
      name,
      input.role,
      await hashPassword(input.password),
      this.o.secrets.encrypt(secret.toString('base64'), totpAad(name)),
      at,
      at,
    );
    if (n !== 1)
      throw new AppError('CONFLICT', 'Учётная запись с таким email уже есть', {
        field: 'email',
        nextAction: 'Для смены пароля или TOTP используйте reset-password / reset-totp',
      });
    return { name, secret, otpauthUri: otpauthUri(secret, name, TOTP_ISSUER) };
  }

  /** Смена пароля: закрывает все сессии и снимает блокировку. */
  async resetPassword(email: string, password: string): Promise<void> {
    const name = normalizeOwnerEmail(email);
    assertOwnerPasswordPolicy(password);
    const n = await this.o.db.run(
      'UPDATE owner_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE name = ?',
      await hashPassword(password),
      this.iso(),
      name,
    );
    if (n !== 1) throw new AppError('NOT_FOUND', 'Учётная запись не найдена');
    await this.closeAllSessions(name);
  }

  /** Новый секрет TOTP (потерян телефон): закрывает все сессии. */
  async resetTotp(email: string): Promise<{ secret: Buffer; otpauthUri: string }> {
    const name = normalizeOwnerEmail(email);
    const secret = newTotpSecret();
    const n = await this.o.db.run(
      'UPDATE owner_users SET totp_secret_encrypted = ?, last_totp_step = 0, updated_at = ? WHERE name = ?',
      this.o.secrets.encrypt(secret.toString('base64'), totpAad(name)),
      this.iso(),
      name,
    );
    if (n !== 1) throw new AppError('NOT_FOUND', 'Учётная запись не найдена');
    await this.closeAllSessions(name);
    return { secret, otpauthUri: otpauthUri(secret, name, TOTP_ISSUER) };
  }

  async setDisabled(email: string, disabled: boolean): Promise<void> {
    const name = normalizeOwnerEmail(email);
    const n = await this.o.db.run(
      'UPDATE owner_users SET disabled = ?, updated_at = ? WHERE name = ?',
      disabled ? 1 : 0,
      this.iso(),
      name,
    );
    if (n !== 1) throw new AppError('NOT_FOUND', 'Учётная запись не найдена');
    if (disabled) await this.closeAllSessions(name);
  }

  async list(): Promise<OwnerAccountInfo[]> {
    const rows = await this.o.db.all<OwnerRow>('SELECT * FROM owner_users ORDER BY name');
    return rows.map((r) => ({
      name: r.name,
      role: r.role,
      disabled: toNumber(r.disabled) === 1,
      lockedUntil: r.locked_until,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Проверка входа: пароль, затем TOTP с защитой от повтора. Любая неудача по существующей учётной записи
   * увеличивает счётчик; на OWNER_MAX_FAILED — блокировка на OWNER_LOCK_MS. Ответ не раскрывает, что именно неверно.
   */
  async authenticate(emailRaw: string, password: string, code: string): Promise<OwnerLoginResult> {
    let name: string;
    try {
      name = normalizeOwnerEmail(emailRaw);
    } catch {
      await checkPassword(password, undefined);
      return { ok: false, reason: 'invalid' };
    }
    const row = await this.o.db.get<OwnerRow>('SELECT * FROM owner_users WHERE name = ?', name);
    const nowMs = this.now();
    if (!row) {
      await checkPassword(password, undefined);
      return { ok: false, reason: 'invalid' };
    }
    if (toNumber(row.disabled) === 1) {
      await checkPassword(password, undefined);
      return { ok: false, reason: 'disabled' };
    }
    if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
      await checkPassword(password, undefined);
      return { ok: false, reason: 'locked' };
    }
    const passwordOk = await checkPassword(password, row.password_hash);
    let step: number | undefined;
    if (passwordOk) {
      const secret = Buffer.from(this.o.secrets.decrypt(row.totp_secret_encrypted, totpAad(name)), 'base64');
      step = verifyTotp(secret, code, nowMs, { window: 1 });
    }
    // Повтор: принимается только шаг строго больше последнего принятого (атомарно, без гонки).
    const accepted =
      step !== undefined &&
      (await this.o.db.run(
        'UPDATE owner_users SET last_totp_step = ?, failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE name = ? AND last_totp_step < ?',
        step,
        this.iso(nowMs),
        this.iso(nowMs),
        name,
        step,
      )) === 1;
    if (!accepted) {
      await this.o.db.run(
        `UPDATE owner_users SET
           locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END,
           failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END,
           updated_at = ?
         WHERE name = ?`,
        OWNER_MAX_FAILED,
        this.iso(nowMs + OWNER_LOCK_MS),
        OWNER_MAX_FAILED,
        this.iso(nowMs),
        name,
      );
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, owner: { name: row.name, role: row.role } };
  }

  async openSession(owner: OwnerUser): Promise<{ cookieValue: string; session: OwnerSession }> {
    await this.o.db.run('DELETE FROM owner_sessions WHERE expires_at < ?', this.iso());
    const cookieValue = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = this.iso(this.now() + OWNER_SESSION_TTL_MS);
    await this.o.db.run(
      'INSERT INTO owner_sessions (id_hash, owner_name, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(cookieValue),
      owner.name,
      csrf,
      this.iso(),
      this.iso(),
      expiresAt,
    );
    return { cookieValue, session: { owner, csrf, expiresAt } };
  }

  /** Сессия по cookie: истёкшая (абсолютно или по бездействию) и отключённая учётная запись — нет сессии. */
  async sessionByCookie(cookieValue: string | undefined): Promise<OwnerSession | undefined> {
    if (!cookieValue || !COOKIE_RE.test(cookieValue)) return undefined;
    const idHash = sha256(cookieValue);
    const row = await this.o.db.get<{
      csrf: string;
      expires_at: string;
      last_seen_at: string;
      name: string;
      role: OwnerRole;
      disabled: number | string;
    }>(
      `SELECT s.csrf, s.expires_at, s.last_seen_at, u.name, u.role, u.disabled
       FROM owner_sessions s JOIN owner_users u ON u.name = s.owner_name WHERE s.id_hash = ?`,
      idHash,
    );
    if (!row) return undefined;
    const nowMs = this.now();
    if (
      Date.parse(row.expires_at) <= nowMs ||
      Date.parse(row.last_seen_at) + OWNER_SESSION_IDLE_MS <= nowMs ||
      toNumber(row.disabled) === 1
    ) {
      await this.o.db.run('DELETE FROM owner_sessions WHERE id_hash = ?', idHash);
      return undefined;
    }
    if (nowMs - Date.parse(row.last_seen_at) > 60_000)
      await this.o.db.run(
        'UPDATE owner_sessions SET last_seen_at = ? WHERE id_hash = ?',
        this.iso(nowMs),
        idHash,
      );
    return { owner: { name: row.name, role: row.role }, csrf: row.csrf, expiresAt: row.expires_at };
  }

  async closeSession(cookieValue: string | undefined): Promise<void> {
    if (!cookieValue || !COOKIE_RE.test(cookieValue)) return;
    await this.o.db.run('DELETE FROM owner_sessions WHERE id_hash = ?', sha256(cookieValue));
  }

  async closeAllSessions(name: string): Promise<void> {
    await this.o.db.run('DELETE FROM owner_sessions WHERE owner_name = ?', name);
  }
}

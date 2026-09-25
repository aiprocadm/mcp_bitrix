/**
 * Криптографические примитивы сервера авторизации: непрозрачные токены (в БД — только SHA-256),
 * PKCE S256 (RFC 7636 §4.2), запечатанное состояние авторизации (AES-256-GCM, назначение в AAD, срок внутри).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Случайный токен base64url (32 байта = 256 бит). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** RFC 7636 §4.1: code_verifier = 43–128 символов из [A-Z a-z 0-9 - . _ ~]. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** RFC 7636 §4.2: S256 — BASE64URL(SHA256(verifier)) без выравнивания = ровно 43 символа. */
export const CODE_CHALLENGE_S256_RE = /^[A-Za-z0-9_-]{43}$/;

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  return CODE_VERIFIER_RE.test(verifier) && safeEqual(pkceS256(verifier), challenge);
}

/**
 * Запечатанное состояние: base64url(iv | tag | ciphertext). Назначение (`purpose`) входит в AAD —
 * состояние входа нельзя подставить как состояние согласия. Срок (`exp`, мс epoch) проверяется при вскрытии.
 */
export class StateSealer {
  /** Раздельные подключи для шифрования и для CSRF (из одного секрета каталога ключей). */
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: Buffer) {
    if (secret.length !== 32) throw new Error('Ключ состояния должен быть 32 байта');
    this.encKey = createHmac('sha256', secret).update('mcp-as state enc').digest();
    this.macKey = createHmac('sha256', secret).update('mcp-as state csrf').digest();
  }

  seal(purpose: string, payload: object, expiresAtMs: number): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(`mcp-as:${purpose}`, 'utf8'));
    const ct = Buffer.concat([
      cipher.update(JSON.stringify({ ...payload, exp: expiresAtMs }), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  /** undefined — подделка, чужое назначение, повреждение или истёк срок. */
  open<T extends object>(purpose: string, sealed: string, nowMs: number): T | undefined {
    if (!/^[A-Za-z0-9_-]{40,8192}$/.test(sealed)) return undefined;
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`mcp-as:${purpose}`, 'utf8'));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      const value = JSON.parse(text) as T & { exp?: unknown };
      if (typeof value.exp !== 'number' || value.exp <= nowMs) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  /** CSRF-токен формы, привязанный к браузеру (bind) и к конкретному состоянию. */
  csrf(bind: string, sealed: string): string {
    return createHmac('sha256', this.macKey)
      .update('csrf\u0000')
      .update(bind)
      .update('\u0000')
      .update(sealed)
      .digest('base64url');
  }
}

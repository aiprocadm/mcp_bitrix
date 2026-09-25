/**
 * Одноразовые пароли для входа владельца (SaaS-ТЗ §11.3): TOTP по RFC 6238 поверх HOTP RFC 4226, только node:crypto.
 *
 *  - HOTP(K, C) = Truncate(HMAC(K, C)) mod 10^digits, C — 8 байт big-endian (RFC 4226 §5.3, динамическое усечение);
 *  - TOTP: C = floor((unix − T0) / X), T0 = 0, X = 30 с (RFC 6238 §4); алгоритм по умолчанию HMAC-SHA1 — его
 *    понимают все приложения-аутентификаторы (формат `otpauth://`, ключ в Base32 RFC 4648 без выравнивания);
 *  - проверка допускает ±1 шаг (рассинхронизация часов, RFC 6238 §5.2) и возвращает принятый шаг: вызывающий
 *    обязан отклонить шаг, не больший последнего принятого (защита от повторного использования кода, §5.2).
 *
 * Секрет — 20 случайных байт (160 бит, рекомендация RFC 4226 §4 R6). В логи и ответы не попадает никогда.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  readonly algorithm?: TotpAlgorithm;
  readonly digits?: number;
  /** Шаг, секунды (X). */
  readonly stepSeconds?: number;
}

const DEFAULTS = { algorithm: 'sha1' as TotpAlgorithm, digits: 6, stepSeconds: 30 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648 §6) без символов выравнивания `=`. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Разбор Base32: регистр, пробелы и `=` игнорируются; прочие символы — ошибка. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Некорректный символ Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226 §5.3). counter — неотрицательное целое (до 2^53). */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Счётчик HOTP — целое ≥ 0');
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('Разрядность HOTP — 6–10');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Номер шага TOTP для момента времени (мс). */
export function totpStep(atMs: number, stepSeconds = DEFAULTS.stepSeconds): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

export function totp(key: Buffer, atMs: number, opts: TotpOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  return hotp(key, totpStep(atMs, o.stepSeconds), o.digits, o.algorithm);
}

/**
 * Проверка кода в окне ±window шагов. Возвращает принятый шаг (для защиты от повтора) или undefined.
 * Сравнение — в постоянное время для каждого кандидата; перебираются все шаги окна.
 */
export function verifyTotp(
  key: Buffer,
  code: string,
  atMs: number,
  opts: TotpOptions & { window?: number } = {},
): number | undefined {
  const o = { ...DEFAULTS, ...opts };
  const window = opts.window ?? 1;
  const clean = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${String(o.digits)}}$`).test(clean)) return undefined;
  const given = Buffer.from(clean);
  const now = totpStep(atMs, o.stepSeconds);
  let matched: number | undefined;
  for (let d = -window; d <= window; d += 1) {
    const step = now + d;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, o.digits, o.algorithm));
    if (timingSafeEqual(expected, given) && matched === undefined) matched = step;
  }
  return matched;
}

/** Новый секрет TOTP: 20 случайных байт. */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * URI для приложения-аутентификатора (формат Key Uri Format Google Authenticator, де-факто стандарт):
 * `otpauth://totp/<issuer>:<account>?secret=<BASE32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30`.
 */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULTS.digits),
    period: String(DEFAULTS.stepSeconds),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * TOTP/HOTP панели владельца (SaaS-ТЗ §11.3): эталонные векторы RFC 4226 (приложение D), RFC 6238 (приложение B),
 * Base32 RFC 4648 (§10), окно ±1 шаг, формат otpauth.
 */
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totp,
  totpStep,
  verifyTotp,
} from '../../src/saas/owner/totp.js';

const SEED20 = Buffer.from('12345678901234567890', 'ascii');
const SEED32 = Buffer.from('12345678901234567890123456789012', 'ascii');
const SEED64 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');

describe('HOTP RFC 4226', () => {
  it('приложение D: счётчики 0–9', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, i) => hotp(SEED20, i))).toEqual(expected);
  });
});

describe('TOTP RFC 6238, приложение B (8 цифр, шаг 30 с)', () => {
  const table: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(table)('T=%i', (t, sha1, sha256, sha512) => {
    const ms = t * 1000;
    expect(totp(SEED20, ms, { digits: 8, algorithm: 'sha1' })).toBe(sha1);
    expect(totp(SEED32, ms, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(totp(SEED64, ms, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });

  it('проверка: окно ±1 шаг, вне окна — отказ, возвращается принятый шаг', () => {
    const t = 1111111111_000;
    const step = totpStep(t);
    const code = totp(SEED20, t);
    expect(verifyTotp(SEED20, code, t)).toBe(step);
    expect(verifyTotp(SEED20, code, t + 30_000)).toBe(step); // клиент отстаёт на шаг
    expect(verifyTotp(SEED20, code, t - 30_000)).toBe(step); // клиент спешит на шаг
    expect(verifyTotp(SEED20, code, t + 60_000)).toBeUndefined();
    expect(verifyTotp(SEED20, code, t - 60_000)).toBeUndefined();
    expect(verifyTotp(SEED20, code, t, { window: 0 })).toBe(step);
    expect(verifyTotp(SEED20, '12345', t)).toBeUndefined();
    expect(verifyTotp(SEED20, 'abcdef', t)).toBeUndefined();
    expect(verifyTotp(SEED20, `${code.slice(0, 3)} ${code.slice(3)}`, t)).toBe(step);
  });
});

describe('Base32 RFC 4648 §10 и otpauth', () => {
  it('эталонные строки', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, enc] of cases) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZ1')).toThrow();
    expect(base32Encode(SEED20)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('otpauth URI: секрет в Base32, SHA1, 6 цифр, 30 с', () => {
    const uri = new URL(otpauthUri(SEED20, 'owner@example.ru', 'MCP'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});

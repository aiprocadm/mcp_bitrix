import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSecretsForTests,
  redactString,
  redactValue,
  registerSecret,
} from '../../src/security/redaction.js';

afterEach(() => _resetSecretsForTests());

describe('redaction (T19)', () => {
  it('скрывает секрет вебхука в URL обоих поколений REST', () => {
    expect(redactString('https://p.bitrix24.invalid/rest/12/abcdefgh12345678/profile.json')).toBe(
      'https://p.bitrix24.invalid/rest/12/[REDACTED]/profile.json',
    );
    expect(redactString('https://p.bitrix24.invalid/rest/api/12/abcdefgh12345678/crm.item.get')).toBe(
      'https://p.bitrix24.invalid/rest/api/12/[REDACTED]/crm.item.get',
    );
  });

  it('скрывает зарегистрированные секреты даже вне URL', () => {
    registerSecret('ZzTopSecretValue99');
    expect(redactString('token=ZzTopSecretValue99 and again ZzTopSecretValue99')).not.toContain(
      'ZzTopSecretValue99',
    );
  });

  it('скрывает auth/access_token в query и Bearer', () => {
    expect(redactString('?auth=abc123def&x=1')).toBe('?auth=[REDACTED]&x=1');
    expect(redactString('Authorization: Bearer eyJhbGciOi.abc.def')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('скрывает e-mail и телефоны', () => {
    expect(redactString('ivan.testov@example.com')).toBe('[EMAIL]');
    expect(redactString('звоните +7 999 123-45-67')).toBe('звоните [PHONE]');
    expect(redactString('тел 8(999)1234567')).toBe('тел [PHONE]');
  });

  it('не принимает за телефон хеши, даты ISO и UUID', () => {
    const sha = 'a26377fc7bbc5555555555bcfbeb53af618d464db431b35c772b084a950d0d0';
    expect(redactString(`sha256 ${sha}`)).toBe(`sha256 ${sha}`);
    expect(redactString('до 2026-09-24T16:03:54.813Z')).toBe('до 2026-09-24T16:03:54.813Z');
    expect(redactString('id 11111111-1111-4111-8111-111111111111')).toBe(
      'id 11111111-1111-4111-8111-111111111111',
    );
    expect(redactString('заказ 12345')).toBe('заказ 12345');
  });

  it('редактирует значения рекурсивно и скрывает чувствительные ключи целиком', () => {
    const out = redactValue({
      ok: 1,
      nested: { url: 'https://p.invalid/rest/1/secretsecret/x' },
      message: 'текст письма',
      list: ['a@b.io'],
    });
    expect(out).toEqual({
      ok: 1,
      nested: { url: 'https://p.invalid/rest/1/[REDACTED]/x' },
      message: '[REDACTED]',
      list: ['[EMAIL]'],
    });
  });

  it('Error превращается в {name, message} без stack', () => {
    const out = redactValue(new Error('fail at https://p.invalid/rest/1/secretsecret/'));
    expect(out).toEqual({ name: 'Error', message: 'fail at https://p.invalid/rest/1/[REDACTED]/' });
  });
});

/**
 * SaaS-ТЗ S5: чистые функции кабинета без PostgreSQL — адрес возврата после входа, cookie сессии, код сверки,
 * «повышенный риск», проверка output policy арендатора, разбор форм, суммы, состояние входа.
 */
import { describe, expect, it } from 'vitest';
import {
  approvalShortCode,
  approvalUrl,
  isCabinetState,
  isHighRiskOperation,
  parseSessionCookie,
  validateTenantOutputPolicy,
} from '../../src/saas/cabinet/index.js';
import { rub } from '../../src/saas/cabinet/html.js';
import { parseForm, safeReturnTo } from '../../src/saas/cabinet/kit.js';
import { PG_MIGRATIONS, RLS_TABLES } from '../../src/storage/pg-migrations.js';
import { S5S9_MIGRATIONS } from '../../src/storage/pg-migrations/s5s9.js';

describe('S5: функции кабинета', () => {
  it('адрес возврата — только страницы кабинета', () => {
    expect(safeReturnTo('/app/approvals/5edeba12-dcb2-4fcb-9b70-313dfc017961')).toBe(
      '/app/approvals/5edeba12-dcb2-4fcb-9b70-313dfc017961',
    );
    expect(safeReturnTo('/app/connect?check=1')).toBe('/app/connect?check=1');
    for (const bad of [
      undefined,
      'https://evil.example/app',
      '//evil.example/app',
      '/app//evil.example',
      '/app/../admin',
      '/admin/operations',
      '/app/<script>',
      '/app?next=https://x',
    ])
      expect(safeReturnTo(bad)).toBe('/app');
  });

  it('cookie сессии: только «uuid арендатора . 32 байта base64url»', () => {
    const secret = 'A'.repeat(43);
    expect(parseSessionCookie(`5edeba12-dcb2-4fcb-9b70-313dfc017961.${secret}`)).toEqual({
      tenantId: '5edeba12-dcb2-4fcb-9b70-313dfc017961',
      secret,
    });
    for (const bad of [
      undefined,
      '',
      secret,
      `local.${secret}`,
      '5edeba12-dcb2-4fcb-9b70-313dfc017961.short',
      "x'.y",
    ])
      expect(parseSessionCookie(bad)).toBeUndefined();
  });

  it('ссылка и короткий код подтверждения стабильны; код — 6 символов без похожих букв', () => {
    const id = '5edeba12-dcb2-4fcb-9b70-313dfc017961';
    expect(approvalUrl('https://mcp.example.ru/', id)).toBe(`https://mcp.example.ru/app/approvals/${id}`);
    expect(approvalShortCode(id)).toBe(approvalShortCode(id));
    expect(approvalShortCode(id)).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(approvalShortCode(id)).not.toBe(approvalShortCode('00000000-0000-4000-8000-000000000000'));
  });

  it('повышенный риск: удаление и инструменты с destructiveHint (массовые замены)', () => {
    expect(isHighRiskOperation('crm_item_delete', 'delete')).toBe(true);
    expect(isHighRiskOperation('crm_deal_products_replace', 'update')).toBe(true);
    expect(isHighRiskOperation('company_employee_departments_set', 'update')).toBe(true);
    expect(isHighRiskOperation('task_create', 'create')).toBe(false);
  });

  it('состояние входа кабинета отличается от состояния сервера авторизации', () => {
    expect(isCabinetState('cab.abc')).toBe(true);
    expect(isCabinetState('mcpas.abc')).toBe(false);
    expect(isCabinetState(undefined)).toBe(false);
  });

  it('output policy арендатора: схема базового ТЗ, корректные ограниченные regex, пусто — политика сервиса', () => {
    expect(validateTenantOutputPolicy('  ')).toBeNull();
    expect(
      JSON.parse(validateTenantOutputPolicy('{"version":"1","deniedFieldPatterns":["^PHONE$"]}') ?? ''),
    ).toEqual({
      version: '1',
      deniedFieldPatterns: ['^PHONE$'],
      profiles: {},
    });
    for (const bad of [
      '{',
      '{"deniedFieldPatterns":[]}',
      '{"version":"1","deniedFieldPatterns":["("]}',
      '{"version":"1","extra":1}',
      JSON.stringify({ version: '1', deniedFieldPatterns: ['x'.repeat(201)] }),
      JSON.stringify({ version: '1', deniedFieldPatterns: Array.from({ length: 101 }, () => 'A') }),
    ])
      expect(() => validateTenantOutputPolicy(bad)).toThrow();
  });

  it('разбор формы: повтор поля — массив; суммы в копейках без float', () => {
    expect(parseForm('a=1&m=crm&m=tasks&w=%D0%9F')).toEqual({ a: '1', m: ['crm', 'tasks'], w: 'П' });
    expect(rub(299000)).toBe('2 990,00 ₽');
    expect(rub(5)).toBe('0,05 ₽');
    expect(rub(1234567899)).toBe('12 345 678,99 ₽');
  });

  it('миграции S5 — в диапазоне 50–54; сессии кабинета под RLS', () => {
    expect(S5S9_MIGRATIONS.map((m) => m.id).every((id) => id >= 50 && id <= 54)).toBe(true);
    expect(PG_MIGRATIONS.some((m) => m.id === 50)).toBe(true);
    expect(RLS_TABLES).toContain('cabinet_sessions');
    expect(S5S9_MIGRATIONS[0]?.sql).not.toContain('?');
  });
});

/** Контракт реестра инструментов (ТЗ §15.1): имена, описания, annotations, строгие схемы, envelope. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors/app-error.js';
import { enforceResponseLimit, envelopeSchema, fail, ok } from '../../src/mcp/result.js';
import { OutputPolicyEngine } from '../../src/security/output-policy.js';
import { allTools } from '../../src/tools/index.js';
import { isWriteOperation } from '../../src/tools/types.js';

describe('реестр инструментов', () => {
  it('каждый инструмент: snake_case имя, русское описание с «использовать», annotations по типу операции', () => {
    const names = new Set<string>();
    for (const t of allTools()) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toMatch(/[Ии]спользовать/);
      const write = isWriteOperation(t.operation);
      expect(t.annotations.readOnlyHint).toBe(!write);
      if (t.operation === 'delete') expect(t.annotations.destructiveHint).toBe(true);
      const json = z.toJSONSchema(t.inputSchema) as { additionalProperties?: boolean; type: string };
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
      // outputSchema сериализуется в JSON Schema без исключений
      expect(() =>
        z.toJSONSchema(envelopeSchema(t.outputDataSchema), { unrepresentable: 'any' }),
      ).not.toThrow();
    }
  });
});

describe('envelope и лимит ответа (ТЗ §14.3–14.4)', () => {
  it('success/error проходят outputSchema', () => {
    const schema = envelopeSchema(z.object({ x: z.number() }));
    expect(schema.safeParse(ok({ x: 1 }, { requestId: 'r', durationMs: 1 })).success).toBe(true);
    expect(
      schema.safeParse(fail(new AppError('NOT_FOUND', 'нет'), { requestId: 'r', durationMs: 1 })).success,
    ).toBe(true);
    expect(schema.safeParse({ success: true, data: { x: 'no' }, meta: {} }).success).toBe(false);
  });

  it('усечение по байтам сохраняет валидный JSON и помечает partial', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'x'.repeat(100) }));
    const env = enforceResponseLimit(ok({ items }, { requestId: 'r', durationMs: 1 }), 5000);
    expect(env.success).toBe(true);
    if (env.success) {
      const data = env.data as { items: unknown[] };
      expect(data.items.length).toBeLessThan(200);
      expect(data.items.length).toBeGreaterThan(0);
      expect(env.meta.completeness).toBe('partial');
      expect(env.meta.warnings[0]).toContain('усечён');
      expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThanOrEqual(5000);
    }
  });

  it('APPROVAL_REQUIRED с огромным планом сохраняет operationId и срок, план — только заголовок', () => {
    const env = enforceResponseLimit(
      fail(
        new AppError('APPROVAL_REQUIRED', 'нужно подтверждение', {
          operationId: '11111111-1111-4111-8111-111111111111',
          expiresAt: '2026-09-25T10:00:00.000Z',
          plan: {
            action: 'Обновить документ',
            target: 'note.document:1',
            details: { text: 'z'.repeat(100_000) },
          },
        }),
        { requestId: 'r', durationMs: 1 },
      ),
      5000,
    );
    expect(env.success).toBe(false);
    if (!env.success) {
      expect(env.error.code).toBe('APPROVAL_REQUIRED');
      expect(env.error.details['operationId']).toBe('11111111-1111-4111-8111-111111111111');
      expect(env.error.details['expiresAt']).toBe('2026-09-25T10:00:00.000Z');
      expect(env.error.details['plan']).toEqual({
        action: 'Обновить документ',
        target: 'note.document:1',
        truncated: true,
      });
      expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThanOrEqual(5000);
    }
  });

  it('одиночное большое поле без items → понятная ошибка вместо обрезанного JSON', () => {
    const env = enforceResponseLimit(
      ok({ text: 'y'.repeat(10_000) }, { requestId: 'r', durationMs: 1 }),
      1000,
    );
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('output policy (ТЗ §8.4)', () => {
  it('удаляет запрещённые ключи рекурсивно, allowlist действует на верхнем уровне', () => {
    const engine = new OutputPolicyEngine({
      version: '1',
      deniedFieldPatterns: ['PASSPORT', '^PERSONAL_PHONE$'],
      profiles: { restricted: { crm: { deal: ['ID', 'TITLE'] } } },
    });
    const out = engine.apply({
      ID: 1,
      TITLE: 't',
      UF_PASSPORT_NO: 'x',
      CONTACT: { PERSONAL_PHONE: '1', NAME: 'n' },
    });
    expect(out).toEqual({ ID: 1, TITLE: 't', CONTACT: { NAME: 'n' } });
    const allow = engine.allowedFields('reader', 'crm', 'deal');
    expect(engine.apply({ ID: 1, TITLE: 't', STAGE_ID: 'NEW' }, allow)).toEqual({ ID: 1, TITLE: 't' });
    expect(engine.allowedFields('reader', 'crm', 'lead')).toBeUndefined();
  });
});

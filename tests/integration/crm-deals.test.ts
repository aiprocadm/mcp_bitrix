/**
 * MVP CRM (ТЗ §10.1, §9.4, §15.3): crm_fields_get, crm_list_records, crm_get_record, crm_create_record
 * через официальный MCP-клиент и мок Bitrix. Полный путь записи: план → подтверждение → выполнение → сверка.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  DEAL_FIELDS_WITH_REQUIRED_UF,
  dealRecord,
  deals,
  legacyError,
  legacyListPage,
  legacyOk,
} from '../helpers/mock-bitrix.js';
import { STATUS_LISTS } from '../helpers/mock-crm.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[] };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

const ALL_DEALS = deals(1, 50).map((d) => dealRecord(Number(d.ID)));

function setup(overrides: Record<string, string> = {}) {
  t = createTestApp(overrides);
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.status.list', legacyOk(STATUS_LISTS['DEAL_STAGE']))
    .on('crm.deal.list', (c) => legacyListPage(ALL_DEALS, Number(c.body['start'] ?? 0), 50))
    .on('crm.deal.get', (c) => {
      const id = Number(c.body['id']);
      return id >= 1 && id <= 50 ? legacyOk(ALL_DEALS[id - 1]) : legacyError('NOT_FOUND', 400, 'Not found');
    })
    .on('crm.deal.add', legacyOk(777));
}

beforeEach(async () => {
  setup();
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('crm_fields_get', () => {
  it('возвращает схему с обязательными полями и кэширует её', async () => {
    const env = await call('crm_fields_get', { entityType: 'deal' });
    expect(env.success).toBe(true);
    expect(env.data?.['required']).toEqual(['TITLE']);
    expect((env.data?.['fields'] as { name: string }[]).map((f) => f.name)).toContain('UF_CRM_PRIORITY');
    await call('crm_fields_get', { entityType: 'deal' });
    expect(t.bitrix.callsTo('crm.deal.fields')).toHaveLength(1);
    await call('crm_fields_get', { entityType: 'deal', refresh: true });
    expect(t.bitrix.callsTo('crm.deal.fields')).toHaveLength(2);
  });

  it('неизвестный entityType отклоняется схемой; smart без entityTypeId — VALIDATION_ERROR без обращения к порталу', async () => {
    for (const entityType of ['quote', 'DEAL']) {
      const r = await client.callTool({ name: 'crm_fields_get', arguments: { entityType } });
      expect(r.isError, entityType).toBe(true);
    }
    const before = t.bitrix.calls.length;
    const smart = await call('crm_fields_get', { entityType: 'smart' });
    expect(smart.error?.code).toBe('VALIDATION_ERROR');
    expect(smart.error?.details['reason']).toBe('ENTITY_TYPE_ID_REQUIRED');
    const classic = await call('crm_fields_get', { entityType: 'deal', entityTypeId: 2 });
    expect(classic.error?.details['reason']).toBe('UNEXPECTED_ENTITY_TYPE_ID');
    expect(t.bitrix.calls.length).toBe(before);
  });
});

describe('crm_list_records', () => {
  it('T20 через MCP: 50 сделок по 20 — три страницы без пропусков, один запрос к порталу', async () => {
    const p1 = await call('crm_list_records', {
      entityType: 'deal',
      pageSize: 20,
      filter: { '%TITLE': 'MCP TEST' },
    });
    expect(p1.success).toBe(true);
    expect(p1.data?.['returnedCount']).toBe(20);
    expect(p1.data?.['upstreamTotal']).toBe(50);
    expect(p1.meta['completeness']).toBe('partial');
    const page1 = p1.meta['page'] as { nextCursor: string | null; hasMore: boolean };
    expect(page1.hasMore).toBe(true);
    const p2 = await call('crm_list_records', {
      entityType: 'deal',
      pageSize: 20,
      filter: { '%TITLE': 'MCP TEST' },
      cursor: page1.nextCursor,
    });
    const p3 = await call('crm_list_records', {
      entityType: 'deal',
      pageSize: 20,
      filter: { '%TITLE': 'MCP TEST' },
      cursor: (p2.meta['page'] as { nextCursor: string }).nextCursor,
    });
    expect(p3.data?.['returnedCount']).toBe(10);
    expect((p3.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
    const ids = [p1, p2, p3].flatMap((p) => (p.data?.['items'] as { ID: string }[]).map((i) => i.ID));
    expect(ids).toEqual(ALL_DEALS.map((d) => d.ID));
    expect(t.bitrix.callsTo('crm.deal.list')).toHaveLength(1);
    const sent = t.bitrix.callsTo('crm.deal.list')[0]?.body;
    expect(sent).toMatchObject({ filter: { '%TITLE': 'MCP TEST' }, order: { ID: 'DESC' }, start: 0 });
    expect(sent?.['select'] as string[]).toContain('TITLE');
  });

  it('T21 через MCP: курсор с другим фильтром отклоняется', async () => {
    const p1 = await call('crm_list_records', { entityType: 'deal', pageSize: 20 });
    const cursor = (p1.meta['page'] as { nextCursor: string }).nextCursor;
    const env = await call('crm_list_records', {
      entityType: 'deal',
      pageSize: 20,
      filter: { STAGE_ID: 'WON' },
      cursor,
    });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['field']).toBe('cursor');
  });

  it('фильтр по неизвестному полю, инъекция и неверная сортировка — VALIDATION_ERROR до обращения к порталу', async () => {
    const before = t.bitrix.callsTo('crm.deal.list').length;
    for (const args of [
      { entityType: 'deal', filter: { 'TITLE; DROP': 'x' } },
      { entityType: 'deal', filter: { SECRET_FIELD: 'x' } },
      { entityType: 'deal', order: { TITLE: 'ASC', FOO: 'DESC' } },
      { entityType: 'deal', select: ['ID', 'PASSWORD'] },
      { entityType: 'deal', pageSize: 500 },
    ]) {
      const r = await client.callTool({ name: 'crm_list_records', arguments: args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(t.bitrix.callsTo('crm.deal.list')).toHaveLength(before);
  });

  it('T47: политика выдачи вырезает паспортное поле из списка', async () => {
    const env = await call('crm_list_records', {
      entityType: 'deal',
      pageSize: 2,
      select: ['ID', 'TITLE', 'UF_*'],
    });
    const first = (env.data?.['items'] as Record<string, unknown>[])[0];
    expect(first?.['UF_CRM_PASSPORT']).toBeUndefined();
    expect(first?.['TITLE']).toContain('MCP TEST');
  });
});

describe('crm_get_record', () => {
  it('карточка по ID со stateHash; select ограничивает поля', async () => {
    const env = await call('crm_get_record', { entityType: 'deal', id: 5 });
    expect(env.success).toBe(true);
    expect(env.data?.['record']).toMatchObject({ ID: '5', TITLE: '[MCP TEST] Сделка 5', STAGE_ID: 'NEW' });
    expect(env.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    const narrow = await call('crm_get_record', { entityType: 'deal', id: 5, select: ['ID', 'TITLE'] });
    expect(Object.keys(narrow.data?.['record'] as object)).toEqual(['ID', 'TITLE']);
  });

  it('несуществующая сделка → NOT_FOUND без раскрытия деталей', async () => {
    const env = await call('crm_get_record', { entityType: 'deal', id: 999 });
    expect(env.success).toBe(false);
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(JSON.stringify(env)).not.toContain('supersecretcode');
  });
});

describe('crm_create_record (§15.3, §8.2)', () => {
  it('в READ_ONLY_MODE инструмент скрыт и прямой вызов отказывает', async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('crm_create_record');
    expect(names).toEqual(expect.arrayContaining(['crm_list_records', 'crm_get_record', 'crm_fields_get']));
    const r = await client
      .callTool({
        name: 'crm_create_record',
        arguments: { entityType: 'deal', fields: { TITLE: 'x' }, idempotencyKey: randomUUID() },
      })
      .catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(0);
  });

  describe('с включённой записью', () => {
    beforeEach(async () => {
      await close();
      t.app.close();
      setup({ READ_ONLY_MODE: 'false' });
      const c = await connectInMemory(t.app);
      client = c.client;
      close = () => c.close();
    });

    it('dryRun: план с полями и рисками, ledger пуст, портал не тронут', async () => {
      const env = await call('crm_create_record', {
        entityType: 'deal',
        fields: { TITLE: '[MCP TEST] dry', OPPORTUNITY: 10 },
        dryRun: true,
      });
      expect(env.success).toBe(true);
      expect(env.data?.['dryRun']).toBe(true);
      expect(env.data?.['validationLevel']).toBe('local+metadata');
      expect(env.data?.['plan']).toMatchObject({
        action: 'Создать сделку «[MCP TEST] dry»',
        details: { fields: { TITLE: '[MCP TEST] dry', OPPORTUNITY: 10 } },
      });
      expect((env.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain('CATEGORY_ID');
      expect(t.app.operations.countByStatus()).toEqual({});
      expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(0);
    });

    it('неизвестное поле и обязательное пользовательское поле (T31) отклоняются до подготовки плана', async () => {
      const bad = await call('crm_create_record', {
        entityType: 'deal',
        fields: { TITLE: 'x', NAME: 'y' },
        idempotencyKey: randomUUID(),
      });
      expect(bad.error?.code).toBe('VALIDATION_ERROR');
      expect(bad.error?.details['reason']).toBe('UNKNOWN_FIELD');
      t.bitrix.on('crm.deal.fields', legacyOk(DEAL_FIELDS_WITH_REQUIRED_UF));
      await call('crm_fields_get', { entityType: 'deal', refresh: true });
      const req = await call('crm_create_record', {
        entityType: 'deal',
        fields: { TITLE: 'x' },
        idempotencyKey: randomUUID(),
      });
      expect(req.error?.code).toBe('VALIDATION_ERROR');
      expect(req.error?.details['field']).toBe('UF_CRM_SOURCE_DOC');
      expect(req.error?.message).toContain('Документ-основание');
      expect(t.app.operations.countByStatus()).toEqual({});
    });

    it('полный путь: APPROVAL_REQUIRED → подтверждение → одна запись → сверка по ID', async () => {
      t.bitrix.on('crm.deal.get', (c) =>
        Number(c.body['id']) === 777
          ? legacyOk(dealRecord(777, { TITLE: '[MCP TEST] Сделка из MCP', ASSIGNED_BY_ID: '7' }))
          : legacyError('NOT_FOUND', 400),
      );
      const key = randomUUID();
      const args = {
        entityType: 'deal',
        fields: { TITLE: '[MCP TEST] Сделка из MCP', ASSIGNED_BY_ID: 7, OPPORTUNITY: '1000' },
        idempotencyKey: key,
      };
      const prep = await call('crm_create_record', args);
      expect(prep.success).toBe(false);
      expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
      const operationId = prep.error?.details['operationId'] as string;
      expect(prep.error?.details['plan']).toMatchObject({
        target: 'crm.deal',
        details: { method: 'crm.deal.add', fields: { TITLE: '[MCP TEST] Сделка из MCP', ASSIGNED_BY_ID: 7 } },
      });
      expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(0);

      t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('crm_create_record', { ...args, approvalId: operationId });
      expect(done.success).toBe(true);
      expect(done.data).toMatchObject({
        entityType: 'deal',
        id: 777,
        operationId,
        verified: true,
        replayed: false,
        record: { ID: '777', TITLE: '[MCP TEST] Сделка из MCP' },
      });
      expect(done.meta['completeness']).toBe('complete');
      expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
      expect(t.bitrix.callsTo('crm.deal.add')[0]?.body).toEqual({
        fields: { TITLE: '[MCP TEST] Сделка из MCP', ASSIGNED_BY_ID: 7, OPPORTUNITY: '1000' },
      });

      // T13: повтор — сохранённый результат, второй сделки нет
      const again = await call('crm_create_record', { ...args, approvalId: operationId });
      expect(again.data).toMatchObject({ id: 777, replayed: true });
      expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
      const status = await call('operation_status', { operationId });
      expect(status.data?.['status']).toBe('succeeded');
    });

    it('портал изменил ключевое поле (робот сменил стадию) → success с warning и verified по названию', async () => {
      t.bitrix.on('crm.deal.get', (c) =>
        Number(c.body['id']) === 777
          ? legacyOk(dealRecord(777, { TITLE: 'x', STAGE_ID: 'PREPARATION' }))
          : legacyError('NOT_FOUND', 400),
      );
      const key = randomUUID();
      const args = { entityType: 'deal', fields: { TITLE: 'x', STAGE_ID: 'NEW' }, idempotencyKey: key };
      const prep = await call('crm_create_record', args);
      const operationId = prep.error?.details['operationId'] as string;
      t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('crm_create_record', { ...args, approvalId: operationId });
      expect(done.success).toBe(true);
      expect(done.data?.['verified']).toBe(true);
      expect((done.meta.warnings ?? []).join(' ')).toContain('STAGE_ID');
    });

    it('ответ crm.deal.add без ID → OPERATION_OUTCOME_UNKNOWN, без повторной записи', async () => {
      t.bitrix.on('crm.deal.add', legacyOk(null));
      const key = randomUUID();
      const args = { entityType: 'deal', fields: { TITLE: 'x' }, idempotencyKey: key };
      const prep = await call('crm_create_record', args);
      const operationId = prep.error?.details['operationId'] as string;
      t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('crm_create_record', { ...args, approvalId: operationId });
      expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      const retry = await call('crm_create_record', { ...args, approvalId: operationId });
      expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
    });
  });
});

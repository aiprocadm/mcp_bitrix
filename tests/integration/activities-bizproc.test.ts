/**
 * Дела CRM по всему порталу, привязки дела, расшифровка звонка, бизнес-процессы (2026-10-07).
 * Формы — официальные страницы методов и живой портал: шаблоны роботов стадий (1, 7) есть в
 * bizproc.workflow.instances, но отсутствуют в bizproc.workflow.template.list; STARTED_BY=0 — автоматический запуск.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { findMethod } from '../../src/bitrix/method-registry.js';
import { flattenActions } from '../../src/tools/bizproc/bizproc.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

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

const ACTS = [
  {
    ID: '501',
    TYPE_ID: '4',
    PROVIDER_ID: 'CRM_EMAIL',
    SUBJECT: 'Оплата по счёту 15',
    DIRECTION: '1',
    COMPLETED: 'N',
    RESPONSIBLE_ID: '33',
    OWNER_TYPE_ID: '2',
    OWNER_ID: '62097',
    CREATED: '2026-10-07T09:00:00+03:00',
    START_TIME: '2026-10-07T09:00:00+03:00',
    DESCRIPTION: '<p>Поступила оплата&nbsp;<b>16 320 ₽</b></p>',
    DESCRIPTION_TYPE: '3',
    COMMUNICATIONS: [{ VALUE: 'noreply@bank.example' }],
  },
  {
    ID: '502',
    TYPE_ID: '2',
    PROVIDER_ID: 'VOXIMPLANT_CALL',
    SUBJECT: 'Входящий звонок',
    DIRECTION: '1',
    COMPLETED: 'Y',
    RESPONSIBLE_ID: '7',
    OWNER_TYPE_ID: '3',
    OWNER_ID: '57097',
    CREATED: '2026-10-06T12:00:00+03:00',
  },
];
const TRANSCRIPT = 'Оператор: Добрый день. Клиент: Пришлите акт за сентябрь. '.repeat(20);

const TEMPLATES = [
  {
    ID: '1001',
    NAME: 'Обработка исходящего звонка',
    MODULE_ID: 'crm',
    DOCUMENT_TYPE: ['crm', 'CCrmDocumentContact', 'CONTACT'],
    AUTO_EXECUTE: '0',
    MODIFIED: '2026-09-01T10:00:00+03:00',
    USER_ID: '1',
    CONSTANTS: { SECRET_TOKEN: { Default: 'не выдавать' } },
    TEMPLATE: [
      {
        Type: 'SequentialWorkflowActivity',
        Properties: { Title: 'Последовательный бизнес-процесс' },
        Children: [
          {
            Type: 'IMNotifyActivity',
            Properties: { Title: 'Уведомление пользователя', MessageSite: 'секрет' },
          },
          { Type: 'CrmCreateDealActivity', Properties: { Title: 'Создать сделку «Повторная покупка»' } },
        ],
      },
    ],
  },
  {
    ID: '995',
    NAME: 'Обновление реквизитов',
    MODULE_ID: 'crm',
    DOCUMENT_TYPE: ['crm', 'CCrmDocumentCompany', 'COMPANY'],
    AUTO_EXECUTE: '3',
    MODIFIED: '2026-08-01T10:00:00+03:00',
    USER_ID: '1',
  },
];
const INSTANCES = [
  {
    ID: 'wf-a',
    DOCUMENT_ID: 'DEAL_62211',
    TEMPLATE_ID: '7',
    STARTED: '2026-10-07T08:00:00+03:00',
    STARTED_BY: '0',
    MODIFIED: '2026-10-07T08:00:01+03:00',
    OWNED_UNTIL: null,
  },
  {
    ID: 'wf-b',
    DOCUMENT_ID: 'COMPANY_51659',
    TEMPLATE_ID: '995',
    STARTED: '2026-10-06T08:00:00+03:00',
    STARTED_BY: '2675',
    MODIFIED: '2026-10-06T08:00:01+03:00',
    OWNED_UNTIL: '2026-01-01T00:00:00+03:00',
  },
];

beforeEach(async () => {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10' });
  t.bitrix
    .on('crm.activity.list', (c) => {
      const select = c.body['select'] as string[];
      return legacyOk(
        ACTS.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => select.includes(k)))),
        { total: ACTS.length },
      );
    })
    .on(
      'crm.activity.binding.list',
      legacyOk([
        { entityTypeId: 2, entityId: 62097 },
        { entityTypeId: 4, entityId: 51659 },
        { entityTypeId: 14, entityId: 4223 },
      ]),
    )
    .on('crm.activity.call.gettranscript', (c) =>
      Number(c.body['activityId']) === 502 ? legacyOk({ transcription: TRANSCRIPT }) : legacyOk(null),
    )
    .on('bizproc.workflow.template.list', (c) => {
      const select = c.body['select'] as string[];
      return legacyOk(
        TEMPLATES.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => select.includes(k)))),
        { total: TEMPLATES.length },
      );
    })
    .on('bizproc.workflow.instances', legacyOk(INSTANCES, { total: INSTANCES.length }));
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('crm_activities_search', () => {
  it('письма за период по всему порталу: TYPE_ID=4, период, часть темы, входящие; тело письма текстом; контакты участников не запрашиваются', async () => {
    const r = await call('crm_activities_search', {
      kind: 'email',
      direction: 'incoming',
      from: '2026-10-07T00:00:00+03:00',
      to: '2026-10-07T23:59:59+03:00',
      subjectContains: 'оплат',
      includeDescription: true,
    });
    const body = t.bitrix.callsTo('crm.activity.list')[0]?.body ?? {};
    expect(body['filter']).toEqual({
      TYPE_ID: 4,
      DIRECTION: 1,
      '>=CREATED': '2026-10-07T00:00:00+03:00',
      '<=CREATED': '2026-10-07T23:59:59+03:00',
      '%SUBJECT': 'оплат',
    });
    expect(body['select']).not.toContain('COMMUNICATIONS');
    expect(body['select']).not.toContain('FILES');
    const first = (r.data?.['items'] as Record<string, unknown>[])[0];
    expect(first).toMatchObject({
      id: 501,
      providerId: 'CRM_EMAIL',
      subject: 'Оплата по счёту 15',
      direction: 'incoming',
      owner: { entityType: 'deal', id: 62097 },
      description: 'Поступила оплата 16 320 ₽',
    });
    expect(JSON.stringify(r.data)).not.toContain('bank.example');
  });

  it('boundTo → BINDINGS (дело находится по любой привязке); todo → PROVIDER_ID=CRM_TODO; без периода — предупреждение', async () => {
    await call('crm_activities_search', {
      kind: 'call',
      boundTo: { entityType: 'contact', recordId: 57097 },
    });
    expect(t.bitrix.callsTo('crm.activity.list')[0]?.body['filter']).toEqual({
      TYPE_ID: 2,
      BINDINGS: [{ OWNER_TYPE_ID: 3, OWNER_ID: 57097 }],
    });
    const todo = await call('crm_activities_search', { kind: 'todo' });
    expect(t.bitrix.callsTo('crm.activity.list')[1]?.body['filter']).toEqual({ PROVIDER_ID: 'CRM_TODO' });
    expect(JSON.stringify(todo.meta['warnings'])).toContain('сузьте');
  });
});

describe('привязки дела и расшифровка звонка', () => {
  it('crm_activity_bindings: тип и ID каждой привязки', async () => {
    const r = await call('crm_activity_bindings', { activityId: 502 });
    expect(r.data?.['items']).toEqual([
      { entityType: 'deal', entityTypeId: 2, entityId: 62097 },
      { entityType: 'company', entityTypeId: 4, entityId: 51659 },
      { entityType: 'order', entityTypeId: 14, entityId: 4223 },
    ]);
  });

  it('crm_call_transcript: текст с обрезкой; нет расшифровки — available=false и пояснение', async () => {
    const r = await call('crm_call_transcript', { activityId: 502, maxChars: 500 });
    expect(r.data).toMatchObject({ available: true, truncated: true, length: TRANSCRIPT.length });
    expect(String(r.data?.['text'])).toHaveLength(500);
    expect(r.meta['completeness']).toBe('partial');
    const none = await call('crm_call_transcript', { activityId: 999 });
    expect(none.data).toMatchObject({ available: false, text: null });
    expect(JSON.stringify(none.meta['warnings'])).toContain('Расшифровки нет');
  });
});

describe('бизнес-процессы', () => {
  it('flattenActions: дерево → плоский список без свойств действий', () => {
    expect(flattenActions(TEMPLATES[0]?.TEMPLATE ?? [])).toEqual([
      { depth: 0, type: 'SequentialWorkflowActivity', title: 'Последовательный бизнес-процесс' },
      { depth: 1, type: 'IMNotifyActivity', title: 'Уведомление пользователя' },
      { depth: 1, type: 'CrmCreateDealActivity', title: 'Создать сделку «Повторная покупка»' },
    ]);
  });

  it('bizproc_templates_list: запуск словами, тип записи, действия по запросу; константы и свойства шагов не выдаются', async () => {
    const r = await call('bizproc_templates_list', { includeActions: true });
    const items = r.data?.['items'] as Record<string, unknown>[];
    expect(items.map((x) => [x['id'], x['documentType'], x['autoExecute']])).toEqual([
      [1001, 'CONTACT', 'manual'],
      [995, 'COMPANY', 'onCreateAndUpdate'],
    ]);
    expect(JSON.stringify(items[0]?.['actions'])).toContain('Повторная покупка');
    expect(JSON.stringify(r.data)).not.toMatch(/SECRET_TOKEN|не выдавать|секрет/);
    expect(t.bitrix.callsTo('bizproc.workflow.template.list')[0]?.body['select']).not.toContain('CONSTANTS');
    const company = await call('bizproc_templates_list', { documentType: 'COMPANY' });
    expect((company.data?.['items'] as unknown[]).length).toBe(1);
  });

  it('bizproc_workflows_list: шаблон вне списка → робот стадии; startedBy=0 → автоматически; запись по DOCUMENT_ID; зависший по OWNED_UNTIL', async () => {
    const r = await call('bizproc_workflows_list', { documentType: 'DEAL', recordId: 62211 });
    expect(t.bitrix.callsTo('bizproc.workflow.instances')[0]?.body['filter']).toEqual({
      MODULE_ID: 'crm',
      DOCUMENT_ID: 'DEAL_62211',
    });
    const items = r.data?.['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      documentType: 'DEAL',
      recordId: 62211,
      templateId: 7,
      templateName: null,
      isStageAutomation: true,
      automatic: true,
      stuck: false,
    });
    expect(items[1]).toMatchObject({
      documentType: 'COMPANY',
      templateName: 'Обновление реквизитов',
      isStageAutomation: false,
      automatic: false,
      startedBy: 2675,
      stuck: true,
    });
    await call('bizproc_workflows_list', { documentType: 'LEAD' });
    expect(t.bitrix.callsTo('bizproc.workflow.instances')[1]?.body['filter']).toEqual({
      MODULE_ID: 'crm',
      ENTITY: 'CCrmDocumentLead',
    });
  });

  it('реестр: шаблоны БП и расшифровка закрыты для прямого вызова; роботы и триггеры не зарегистрированы', () => {
    expect(findMethod('legacy', 'bizproc.workflow.template.list')?.rawCallable).toBe(false);
    expect(findMethod('legacy', 'crm.activity.call.gettranscript')?.rawCallable).toBe(false);
    expect(findMethod('legacy', 'bizproc.robot.list')).toBeUndefined();
    expect(findMethod('legacy', 'crm.automation.trigger.list')).toBeUndefined();
  });
});

/**
 * Сценарий §10.3 на mock: логика live-smoke проверяется без портала (сам сценарий на портале — not-run).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import {
  assertLiveAllowed,
  buildWritePlans,
  executeWrites,
  prepareWrites,
  moduleReadChecks,
  runReadOnly,
  type StepResult,
} from '../../src/live/scenario.js';
import { allTools } from '../../src/tools/index.js';
import { createTestApp, testConfig, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  dealRecord,
  deals,
  legacyListPage,
  legacyOk,
  PROFILE_RESULT,
  TASK_FIELDS,
  taskRecord,
  tasks,
} from '../helpers/mock-bitrix.js';
import { STATUS_LISTS } from '../helpers/mock-crm.js';

const LIVE_ENV = {
  LIVE_TESTS_ENABLED: 'true',
  BITRIX_REQUESTS_PER_SECOND: '10',
  READ_ONLY_MODE: 'false',
  TEST_RESPONSIBLE_USER_ID: '7',
  TEST_CHAT_DIALOG_ID: 'chat42',
  TEST_DISK_FOLDER_ID: '12',
  TEST_CALENDAR_OWNER_ID: '7',
  TEST_CALENDAR_SECTION_ID: '5',
  TEST_CRM_CATEGORY_ID: '0',
  TEST_CRM_STAGE_ID: 'NEW',
};

let t: TestApp;
afterEach(() => t.app.close());

function portal(overrides: Record<string, string> = {}) {
  t = createTestApp({ ...LIVE_ENV, ...overrides });
  const ALL = deals(1, 7).map((d) => dealRecord(Number(d.ID)));
  const created = new Map<string, Record<string, unknown>>();
  t.bitrix
    .on('profile', legacyOk(PROFILE_RESULT))
    .on('scope', legacyOk(['crm', 'task', 'im', 'disk', 'calendar']))
    .on('method.get', legacyOk({ isExisting: true, isAvailable: true }))
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    // срез 10: STAGE_ID сверяется со справочником стадий до плана (INVALID_STAGE)
    .on('crm.status.list', legacyOk(STATUS_LISTS['DEAL_STAGE']))
    .on('crm.deal.list', (c) => legacyListPage(ALL, Number(c.body['start'] ?? 0), 50))
    .on('crm.deal.get', (c) =>
      legacyOk(
        created.get(`deal:${String(c.body['id'])}`) ??
          ALL[Number(c.body['id']) - 1] ??
          dealRecord(Number(c.body['id'])),
      ),
    )
    .on('crm.deal.add', (c) => {
      created.set('deal:901', dealRecord(901, { ...(c.body['fields'] as Record<string, unknown>) }));
      return legacyOk(901);
    })
    .on('tasks.task.getfields', legacyOk(TASK_FIELDS))
    .on('tasks.task.list', () => legacyOk({ tasks: tasks(1, 3) }, { total: 3 }))
    .on('tasks.task.get', (c) =>
      legacyOk({
        task: created.get(`task:${String(c.body['taskId'])}`) ?? taskRecord(Number(c.body['taskId'])),
      }),
    )
    .on('tasks.task.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      const task = taskRecord(902, {
        title: String(f['TITLE']),
        responsibleId: String(f['RESPONSIBLE_ID']),
        deadline: f['DEADLINE'] ?? null,
      });
      created.set('task:902', task);
      return legacyOk({ task });
    })
    .on('im.dialog.get', legacyOk({ id: '42', type: 'chat', title: 'smoke chat', user_counter: 3 }))
    .on('im.message.add', legacyOk(903))
    .on('im.dialog.messages.get', () =>
      legacyOk({
        messages: [
          { id: 903, text: (t.bitrix.callsTo('im.message.add')[0]?.body['MESSAGE'] as string) ?? '' },
        ],
      }),
    )
    .on('disk.folder.get', legacyOk({ ID: '12', NAME: 'smoke', STORAGE_ID: '3' }))
    .on('disk.folder.getchildren', legacyOk([]))
    .on('disk.folder.uploadfile', (c) => {
      const [name, b64] = c.body['fileContent'] as [string, string];
      return legacyOk({
        ID: '904',
        NAME: name,
        SIZE: String(Buffer.from(b64, 'base64').length),
        DETAIL_URL: 'https://mock.bitrix24.invalid/disk/904',
      });
    })
    .on('disk.file.get', () => {
      const up = t.bitrix.callsTo('disk.folder.uploadfile')[0]?.body['fileContent'] as
        [string, string] | undefined;
      return legacyOk({
        ID: '904',
        NAME: up?.[0] ?? '',
        SIZE: String(up ? Buffer.from(up[1], 'base64').length : 0),
      });
    })
    .on('calendar.section.get', legacyOk([{ ID: '5', NAME: 'smoke calendar' }]))
    .on('calendar.event.add', legacyOk(905))
    .on('calendar.event.getbyid', () => {
      const add = t.bitrix.callsTo('calendar.event.add')[0]?.body ?? {};
      return legacyOk({
        ID: '905',
        NAME: add['name'],
        DATE_FROM: '',
        DATE_TO: '',
        TZ_FROM: 'Europe/Moscow',
        TZ_TO: 'Europe/Moscow',
      });
    });
}

describe('live-smoke (§10.3) на mock', () => {
  it('без LIVE_TESTS_ENABLED и без тестовых целей сценарий не запускается', () => {
    portal();
    expect(() => assertLiveAllowed(testConfig(), 'read-only')).toThrow(AppError);
    expect(() => assertLiveAllowed(testConfig({ LIVE_TESTS_ENABLED: 'true' }), 'read-only')).not.toThrow();
    expect(() => assertLiveAllowed(testConfig({ LIVE_TESTS_ENABLED: 'true' }), 'prepare')).toThrow(
      /READ_ONLY_MODE/,
    );
    expect(() =>
      assertLiveAllowed(testConfig({ LIVE_TESTS_ENABLED: 'true', READ_ONLY_MODE: 'false' }), 'prepare'),
    ).toThrow(/TEST_RESPONSIBLE_USER_ID/);
    expect(() => assertLiveAllowed(testConfig(LIVE_ENV), 'execute')).not.toThrow();
  });

  it('read-only: шесть шагов §10.3 п.2–3 проходят, записи нет', async () => {
    portal();
    const steps = await runReadOnly(t.app);
    expect(steps.slice(0, 6).map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(steps[3]?.detail).toContain('получено 5');
    expect(steps[4]?.ids).toEqual({ dealId: 1 });
    for (const m of [
      'crm.deal.add',
      'tasks.task.add',
      'im.message.add',
      'disk.folder.uploadfile',
      'calendar.event.add',
    ])
      expect(t.bitrix.callsTo(m)).toHaveLength(0);
  });

  it('проверки модулей полной версии: аргументы проходят схемы инструментов, модуль совпадает, только чтение', () => {
    portal();
    const checks = moduleReadChecks(7, new Date('2030-01-10T12:00:00Z'));
    expect(new Set(checks.map((c) => c.module)).size).toBeGreaterThanOrEqual(12);
    for (const c of checks) {
      const def = allTools().find((d) => d.name === c.tool);
      expect(def, c.tool).toBeDefined();
      expect(def?.module).toBe(c.module);
      expect(def?.operation).toBe('read');
      expect(def?.inputSchema.safeParse(c.args).success, c.tool).toBe(true);
    }
    expect(moduleReadChecks(0).some((c) => c.tool === 'calendar_list')).toBe(false);
  });

  it('read-only по модулям: только включённые модули; отсутствие модуля/scope → blocked, успех → passed, без записей', async () => {
    portal({ ENABLED_MODULES: 'system,crm,tasks,chat,disk,calendar,company' });
    t.bitrix
      .on('department.get', legacyOk([{ ID: '1', NAME: 'Компания', SORT: 500 }], { total: 1 }))
      .on('disk.storage.getlist', { status: 401, body: { error: 'insufficient_scope' } });
    const steps = (await runReadOnly(t.app)).slice(6);
    const byTool: Record<string, StepResult | undefined> = Object.fromEntries(
      steps.map((s) => [s.step.split(' ')[1] ?? '', s]),
    );
    expect(Object.keys(byTool).sort()).toEqual([
      'calendar_list',
      'chat_recent_list',
      'company_departments_list',
      'crm_list_records',
      'crm_stages_and_statuses',
      'disk_storages_list',
    ]);
    expect(byTool['company_departments_list']?.status).toBe('passed');
    expect(byTool['disk_storages_list']?.status).toBe('blocked');
    expect(byTool['chat_recent_list']?.status).toBe('blocked');
    const writes = t.bitrix.calls.filter((c) =>
      /\.(add|update|delete|set|send|markdeleted)(\.json)?$/.test(c.url),
    );
    expect(writes).toHaveLength(0);
  });

  it('read-only: недоступный метод MVP помечает шаг capabilities как blocked', async () => {
    portal();
    t.bitrix.on('method.get', (c) =>
      legacyOk({ isExisting: true, isAvailable: c.body['name'] !== 'im.message.add' }),
    );
    const steps = await runReadOnly(t.app);
    expect(steps[2]?.status).toBe('blocked');
    expect(steps[2]?.detail).toContain('im.message.add');
  });

  it('prepare → без подтверждения execute blocked → после подтверждения пять объектов один раз + повтор без дублей', async () => {
    portal();
    const plans = buildWritePlans(t.config, new Date('2030-01-10T12:00:00Z'));
    expect(plans.map((p) => p.tool)).toEqual([
      'crm_create_record',
      'task_create',
      'chat_send_message',
      'disk_upload_file',
      'calendar_create_event',
    ]);
    for (const p of plans) expect(JSON.stringify(p.args)).toContain('[MCP TEST]');
    expect((plans[4]?.args as { from: string }).from).toBe('2030-01-11T07:00:00.000Z');

    const prep = await prepareWrites(t.app, plans);
    expect(prep.every((s) => s.status === 'passed')).toBe(true);
    expect(plans.every((p) => typeof p.operationId === 'string')).toBe(true);
    expect(t.app.operations.countByStatus()).toEqual({ prepared: 5 });

    const blocked = await executeWrites(t.app, plans);
    expect(
      blocked.steps.filter((s) => s.step.startsWith('запись')).every((s) => s.status === 'blocked'),
    ).toBe(true);
    for (const m of [
      'crm.deal.add',
      'tasks.task.add',
      'im.message.add',
      'disk.folder.uploadfile',
      'calendar.event.add',
    ])
      expect(t.bitrix.callsTo(m)).toHaveLength(0);

    for (const p of plans) t.app.approvals.approve(p.operationId ?? '', 'owner', t.app.auth.portalKey);
    const done = await executeWrites(t.app, plans);
    expect(done.steps.map((s) => s.status)).toEqual(Array<string>(10).fill('passed'));
    expect(done.createdIds).toEqual({ сделка: 901, задача: 902, сообщение: 903, файл: 904, событие: 905 });
    for (const m of [
      'crm.deal.add',
      'tasks.task.add',
      'im.message.add',
      'disk.folder.uploadfile',
      'calendar.event.add',
    ])
      expect(t.bitrix.callsTo(m)).toHaveLength(1);
    expect(t.app.operations.countByStatus()).toEqual({ succeeded: 5 });
  });
});

/**
 * Этап 13, группа company-chat (ТЗ §9.9, §9.11): telephony_calls_list, workgroups_list, workgroup_members_list на mock.
 * Телефония — только метаданные: CALL_RECORD_URL/RECORD_FILE_ID/CALL_LOG не выдаются, номер маскируется;
 * отсутствие модуля → FEATURE_UNAVAILABLE. Группы: projectOnly локально (PROJECT не фильтруется порталом),
 * участники с ролями, закрытая группа → GROUP_ACCESS_DENIED.
 */
import { dispatch } from '../../src/mcp/register-tools.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk, type RecordedCall } from '../helpers/mock-bitrix.js';
import { companyState, installCompanyMock } from '../helpers/mock-company.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

/** 70 звонков по форме примера voximplant.statistic.get, у каждого ссылки на запись/лог. */
const CALLS = Array.from({ length: 70 }, (_, i) => ({
  ID: String(i + 1),
  PORTAL_USER_ID: i % 2 ? '10' : '11',
  PORTAL_NUMBER: 'reg133788',
  PHONE_NUMBER: '+79061234567',
  CALL_ID: `call.${String(i + 1)}`,
  EXTERNAL_CALL_ID: null,
  CALL_CATEGORY: 'external',
  CALL_LOG: 'https://storage.voximplant.invalid/logs/abc?sessionid=1',
  CALL_DURATION: String(i * 10),
  CALL_START_DATE: '2026-09-10T11:19:38+03:00',
  CALL_RECORD_URL: i === 0 ? 'https://records.invalid/rec.mp3?token=secret' : '',
  CALL_VOTE: null,
  COST: '0.0000',
  COST_CURRENCY: 'RUB',
  CALL_FAILED_CODE: i % 5 ? '200' : '304',
  CALL_FAILED_REASON: i % 5 ? 'Success call' : 'Missed call',
  CRM_ENTITY_TYPE: 'CONTACT',
  CRM_ENTITY_ID: '275',
  CRM_ACTIVITY_ID: '7739',
  REST_APP_ID: null,
  REST_APP_NAME: null,
  TRANSCRIPT_ID: '1',
  TRANSCRIPT_PENDING: 'N',
  SESSION_ID: '3841557776',
  REDIAL_ATTEMPT: null,
  COMMENT: 'комментарий оператора',
  RECORD_DURATION: null,
  RECORD_FILE_ID: i === 1 ? 9079 : null,
  CALL_TYPE: i % 2 ? '1' : '2',
}));

const group = (id: number, project: boolean, extra: Record<string, unknown> = {}) => ({
  ID: String(id),
  SITE_ID: 's1',
  NAME: `Группа ${String(id)}`,
  DESCRIPTION: 'описание',
  DATE_CREATE: '2026-03-19T15:01:27+02:00',
  DATE_UPDATE: '2026-03-19T15:01:27+02:00',
  ACTIVE: 'Y',
  VISIBLE: 'Y',
  OPENED: 'N',
  CLOSED: 'N',
  SUBJECT_ID: '1',
  OWNER_ID: '10',
  KEYWORDS: null,
  NUMBER_OF_MEMBERS: '3',
  DATE_ACTIVITY: '2026-03-19T15:01:27+02:00',
  SUBJECT_NAME: 'Рабочие группы',
  PROJECT: project ? 'Y' : 'N',
  IS_EXTRANET: 'N',
  ...extra,
});
/** 120 групп; проект — каждая десятая (12 проектов). */
const GROUPS = Array.from({ length: 120 }, (_, i) => group(i + 1, (i + 1) % 10 === 0));

const pageOf = (all: unknown[], start: number) => {
  const next = start + 50 < all.length ? start + 50 : undefined;
  return legacyOk(all.slice(start, start + 50), {
    total: all.length,
    ...(next !== undefined ? { next } : {}),
  });
};

beforeEach(async () => {
  t = createTestApp({ ENABLED_MODULES: 'system,telephony,groups', BITRIX_REQUESTS_PER_SECOND: '10' });
  installCompanyMock(t.bitrix, companyState());
  t.bitrix
    .on('voximplant.statistic.get', (c: RecordedCall) => {
      const f = (c.body['FILTER'] ?? {}) as Record<string, unknown>;
      const rows = CALLS.filter(
        (r) =>
          f['PORTAL_USER_ID'] === undefined ||
          r.PORTAL_USER_ID === JSON.stringify(f['PORTAL_USER_ID']).replace(/"/g, ''),
      );
      return pageOf(rows, Number(c.body['start'] ?? 0));
    })
    .on('sonet_group.get', (c: RecordedCall) => pageOf(GROUPS, Number(c.body['start'] ?? 0)))
    .on('sonet_group.user.get', (c: RecordedCall) =>
      Number(c.body['ID']) === 9
        ? { status: 400, body: { error: '', error_description: 'Socialnetwork group not found' } }
        : legacyOk([
            { USER_ID: '10', ROLE: 'A' },
            { USER_ID: '11', ROLE: 'E' },
            { USER_ID: '13', ROLE: 'K' },
          ]),
    );
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('telephony_calls_list', () => {
  it('только метаданные: нет ссылок на записи/логи, расшифровок и комментариев; номер замаскирован; фильтр по периоду и сотруднику', async () => {
    const env = await call('telephony_calls_list', {
      from: '2026-09-01T00:00:00+03:00',
      to: '2026-09-30T23:59:59+03:00',
      userId: 11,
      pageSize: 10,
    });
    expect(env.success).toBe(true);
    expect(t.bitrix.callsTo('voximplant.statistic.get')[0]?.body).toEqual({
      FILTER: {
        '>=CALL_START_DATE': '2026-09-01T00:00:00+03:00',
        '<=CALL_START_DATE': '2026-09-30T23:59:59+03:00',
        PORTAL_USER_ID: 11,
      },
      SORT: 'CALL_START_DATE',
      ORDER: 'DESC',
      start: 0,
    });
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({
      id: 1,
      userId: 11,
      type: 'incoming',
      durationSec: 0,
      resultCode: '304',
      phoneNumber: '***4567',
      crm: { entityType: 'CONTACT', entityId: 275 },
      hasRecording: true,
    });
    const text = JSON.stringify(env);
    for (const leak of [
      'records.invalid',
      'token=secret',
      'voximplant.invalid',
      'RECORD_FILE_ID',
      'CALL_RECORD_URL',
      'комментарий',
      'TRANSCRIPT',
      '+7906',
    ])
      expect(text).not.toContain(leak);
    expect(env.meta.page?.hasMore).toBe(true);
  });

  it('includePhoneNumbers=true — номер полностью с предупреждением; hasRecording по RECORD_FILE_ID; все 70 постранично', async () => {
    const ids: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const env = await call('telephony_calls_list', {
        from: '2026-09-01',
        to: '2026-09-30',
        includePhoneNumbers: true,
        pageSize: 30,
        ...(cursor ? { cursor } : {}),
      });
      const items = env.data?.['items'] as { id: number; phoneNumber: string; hasRecording: boolean }[];
      if (i === 0) {
        expect(items[0]?.phoneNumber).toBe('+79061234567');
        expect(items[1]?.hasRecording).toBe(true);
        expect(items[2]?.hasRecording).toBe(false);
        expect(env.meta.warnings?.join(' ')).toContain('персональные данные');
      }
      ids.push(...items.map((x) => x.id));
      cursor = env.meta.page?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(ids).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  });

  it('ревью: operator без профиля выдачи не получает полные номера (ACCESS_DENIED до обращения к порталу)', async () => {
    const tool = t.app.tools.find((d) => d.name === 'telephony_calls_list');
    if (!tool) throw new Error('нет инструмента');
    const before = t.bitrix.callsTo('voximplant.statistic.get').length;
    const env = await dispatch(
      tool,
      { from: '2026-09-01', to: '2026-09-30', includePhoneNumbers: true },
      t.app,
      undefined,
      { id: 'op', role: 'operator', source: 'local' },
    );
    expect(env.success).toBe(false);
    if (!env.success) {
      expect(env.error.code).toBe('ACCESS_DENIED');
      expect(env.error.details.reason).toBe('PERSONAL_DATA_POLICY');
    }
    expect(t.bitrix.callsTo('voximplant.statistic.get')).toHaveLength(before);
    const masked = await dispatch(tool, { from: '2026-09-01', to: '2026-09-30' }, t.app, undefined, {
      id: 'op',
      role: 'operator',
      source: 'local',
    });
    expect(masked.success).toBe(true);
  });

  it('модуль телефонии отсутствует → FEATURE_UNAVAILABLE; обратный период → ошибка схемы; модуль выключен → FEATURE_UNAVAILABLE', async () => {
    t.bitrix.on('voximplant.statistic.get', legacyError('ERROR_METHOD_NOT_FOUND', 404, 'Method not found!'));
    const env = await call('telephony_calls_list', { from: '2026-09-01', to: '2026-09-30' });
    expect(env.error?.code).toBe('FEATURE_UNAVAILABLE');
    expect(env.error?.details['reason']).toBe('TELEPHONY_UNAVAILABLE');
    const reversed = await client.callTool({
      name: 'telephony_calls_list',
      arguments: { from: '2026-09-30', to: '2026-09-01' },
    });
    expect(reversed.isError).toBe(true);
    await close();
    t.app.close();
    t = createTestApp({ ENABLED_MODULES: 'system,groups' });
    const c = await connectInMemory(t.app);
    client = c.client;
    close = () => c.close();
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('telephony_calls_list');
  });
});

describe('workgroups_list и workgroup_members_list', () => {
  it('фильтр активных по документированным полям; projectOnly локально — 12 проектов без пропусков', async () => {
    const env = await call('workgroups_list', { pageSize: 5 });
    expect(t.bitrix.callsTo('sonet_group.get')[0]?.body).toEqual({
      FILTER: { ACTIVE: 'Y', CLOSED: 'N' },
      ORDER: { NAME: 'ASC' },
      start: 0,
    });
    expect((env.data?.['items'] as unknown[]).length).toBe(5);
    expect(env.data?.['items']).toContainEqual(
      expect.objectContaining({ id: 1, isProject: false, active: true, archived: false, membersCount: 3 }),
    );
    expect(JSON.stringify(env)).not.toContain('описание');

    const ids: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await call('workgroups_list', {
        projectOnly: true,
        pageSize: 5,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...(page.data?.['items'] as { id: number; isProject: boolean }[]).map((g) => g.id));
      cursor = page.meta.page?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 10));
  });

  it('участники с ролями и именами; закрытая/несуществующая группа → GROUP_ACCESS_DENIED', async () => {
    const env = await call('workgroup_members_list', { groupId: 5 });
    expect(t.bitrix.callsTo('sonet_group.user.get')[0]?.body).toEqual({ ID: 5 });
    expect(env.data).toMatchObject({
      groupId: 5,
      totalMembers: 3,
      items: [
        { userId: 10, role: 'owner', roleCode: 'A', name: 'Иванов Иван' },
        { userId: 11, role: 'moderator', roleCode: 'E', name: 'Иванов Иван' },
        { userId: 13, role: 'member', roleCode: 'K', name: 'Сидорова Анна Павловна' },
      ],
    });
    const paged = await call('workgroup_members_list', { groupId: 5, pageSize: 2 });
    expect((paged.data?.['items'] as unknown[]).length).toBe(2);
    const rest = await call('workgroup_members_list', {
      groupId: 5,
      pageSize: 2,
      cursor: paged.meta.page?.nextCursor,
    });
    expect(rest.data?.['items']).toMatchObject([{ userId: 13 }]);
    expect(rest.meta.page?.hasMore).toBe(false);

    const denied = await call('workgroup_members_list', { groupId: 9 });
    expect(denied.error?.code).toBe('BITRIX_ACCESS_DENIED');
    expect(denied.error?.details['reason']).toBe('GROUP_ACCESS_DENIED');
  });
});

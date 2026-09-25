/**
 * Этап 13/14: календарь полной версии (ТЗ §9.3, T28) на mock —
 * calendar_list, calendar_list_events (снимок в курсоре, T21), calendar_update_event (diff участников,
 * RECURRENCE_SCOPE_REQUIRED, CONFLICT), calendar_delete_event (скрыт/не-админ), calendar_respond_invitation
 * (только за себя, INVALID_STATUS), employee_availability (completeness, без «свободен» без данных).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { Principal } from '../../src/auth/principal.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import { calendarListEventsTool } from '../../src/tools/calendar/read.js';
import { calendarDeleteEventTool } from '../../src/tools/calendar/write.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk } from '../helpers/mock-bitrix.js';

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
/** Ошибка схемы входа: SDK отвечает isError без structuredContent. */
const rejected = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })).isError === true;
const opId = (env: Env): string => {
  const id = env.error?.details['operationId'];
  return typeof id === 'string' ? id : '';
};
const ts = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

let events: Record<number, Record<string, unknown>>;
let nextId: number;

function meeting(
  id: number,
  from: string,
  to: string,
  host: number,
  attendees: [number, string][],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ID: String(id),
    PARENT_ID: String(id),
    DELETED: 'N',
    CAL_TYPE: 'user',
    OWNER_ID: String(host),
    NAME: `[MCP TEST] Встреча ${String(id)}`,
    // формат DATE_FROM зависит от языка портала; инструменты опираются на *_TS_UTC
    DATE_FROM: '10/01/2030 10:00:00 am',
    DATE_TO: '10/01/2030 11:00:00 am',
    TZ_FROM: 'Europe/Moscow',
    TZ_TO: 'Europe/Moscow',
    DATE_FROM_TS_UTC: ts(from),
    DATE_TO_TS_UTC: ts(to),
    DT_SKIP_TIME: 'N',
    DESCRIPTION: '',
    PRIVATE_EVENT: '',
    ACCESSIBILITY: 'busy',
    IMPORTANCE: 'normal',
    IS_MEETING: attendees.length > 0,
    MEETING_HOST: String(host),
    LOCATION: '',
    RRULE: '',
    SECTION_ID: '5',
    VERSION: '1',
    ATTENDEE_LIST: attendees.map(([uid, status]) => ({ id: uid, entryId: String(id), status })),
    ...extra,
  };
}

function setup(overrides: Record<string, string> = {}) {
  nextId = 1000;
  events = {
    100: meeting(100, '2030-10-01T10:00:00+03:00', '2030-10-01T11:00:00+03:00', 7, [
      [7, 'H'],
      [8, 'Y'],
      [9, 'Q'],
    ]),
    200: meeting(200, '2030-10-01T12:00:00+03:00', '2030-10-01T13:00:00+03:00', 7, [[7, 'H']], {
      RRULE: { FREQ: 'WEEKLY', BYDAY: { TU: 'TU' }, INTERVAL: 1 },
      '~RRULE_DESCRIPTION': 'каждую неделю по вторникам',
    }),
    300: meeting(300, '2030-10-01T15:00:00+03:00', '2030-10-01T16:00:00+03:00', 8, [
      [8, 'H'],
      [7, 'Q'],
    ]),
    400: meeting(400, '2030-10-01T17:00:00+03:00', '2030-10-01T18:00:00+03:00', 8, [
      [8, 'H'],
      [9, 'Q'],
    ]),
    500: meeting(500, '2030-10-01T00:00:00+03:00', '2030-10-01T00:00:00+03:00', 7, [], {
      DT_SKIP_TIME: 'Y',
      DATE_FROM: '01.10.2030',
      DATE_TO: '01.10.2030',
      NAME: '[MCP TEST] Отпуск',
      ACCESSIBILITY: 'absent',
    }),
    // вне периода
    600: meeting(600, '2030-10-05T10:00:00+03:00', '2030-10-05T11:00:00+03:00', 7, []),
  };
  t = createTestApp({ READ_ONLY_MODE: 'false', BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  t.bitrix
    .on('calendar.section.get', (c) =>
      c.body['type'] === 'user' && Number(c.body['ownerId']) === 7
        ? legacyOk([
            {
              ID: '5',
              NAME: 'Мой календарь',
              COLOR: '#9cbeee',
              CAL_TYPE: 'user',
              OWNER_ID: '7',
              EXTERNAL_TYPE: 'local',
              IS_COLLAB: false,
              ACCESS: { D114: 17 },
              PERM: {
                view_time: true,
                view_title: true,
                view_full: true,
                add: true,
                edit: true,
                edit_section: true,
                access: true,
              },
            },
          ])
        : c.body['type'] === 'company_calendar'
          ? legacyOk([
              {
                ID: '9',
                NAME: 'Компания',
                CAL_TYPE: 'company_calendar',
                OWNER_ID: '0',
                PERM: { view_time: true },
              },
            ])
          : legacyOk([]),
    )
    .on('calendar.event.get', () => legacyOk(Object.values(events)))
    .on('calendar.event.getbyid', (c) => {
      const ev = events[Number(c.body['id'])];
      return ev ? legacyOk(ev) : legacyError('ERROR_NOT_FOUND', 400, 'Event not found');
    })
    .on('calendar.event.update', (c) => {
      const b = c.body;
      const id = Number(b['id']);
      const ev = events[id];
      if (!ev) return legacyError('', 400, 'An error occurred while changing the event.');
      const apply = (target: Record<string, unknown>) => {
        if (typeof b['name'] === 'string') target['NAME'] = b['name'];
        if (b['from_ts'] !== undefined) target['DATE_FROM_TS_UTC'] = String(Number(b['from_ts']));
        if (b['to_ts'] !== undefined) target['DATE_TO_TS_UTC'] = String(Number(b['to_ts']));
        if (typeof b['timezone_from'] === 'string') target['TZ_FROM'] = b['timezone_from'];
        if (Array.isArray(b['attendees'])) {
          target['ATTENDEE_LIST'] = (b['attendees'] as number[]).map((u) => ({
            id: u,
            status: String(u) === target['MEETING_HOST'] ? 'H' : 'Q',
          }));
          target['IS_MEETING'] = true;
        }
        target['VERSION'] = String(Number(target['VERSION']) + 1);
      };
      if (b['recurrence_mode'] === 'this') {
        const newId = nextId++;
        const copy = { ...ev, ID: String(newId), RRULE: '', RECURRENCE_ID: id };
        apply(copy);
        events[newId] = copy;
        return legacyOk({
          originalDate: '10/08/2030 12:00:00 pm',
          instanceTz: 'Europe/Moscow',
          recEventId: newId,
          id,
        });
      }
      apply(ev);
      return legacyOk(id);
    })
    .on('calendar.event.delete', (c) => {
      const id = Number(c.body['id']);
      if (!events[id]) return legacyError('', 400, 'An error occurred while deleting the event');
      events = Object.fromEntries(Object.entries(events).filter(([k]) => Number(k) !== id));
      return legacyOk(true);
    })
    .on('calendar.meeting.status.set', (c) => {
      const ev = events[Number(c.body['eventId'])];
      const list = (ev?.['ATTENDEE_LIST'] ?? []) as { id: number; status: string }[];
      const me = list.find((a) => a.id === 7);
      if (me) me.status = String(c.body['status']);
      return legacyOk(true);
    })
    .on('calendar.meeting.status.get', (c) => {
      const ev = events[Number(c.body['eventId'])];
      const list = (ev?.['ATTENDEE_LIST'] ?? []) as { id: number; status: string }[];
      return legacyOk(list.find((a) => a.id === 7)?.status ?? '');
    })
    .on('calendar.accessibility.get', () =>
      legacyOk({
        '7': [
          {
            ID: '100',
            NAME: 'Секретная встреча',
            DATE_FROM: '01.10.2030 10:00:00',
            DATE_TO: '01.10.2030 11:00:00',
            DATE_FROM_TS_UTC: ts('2030-10-01T10:00:00+03:00'),
            DATE_TO_TS_UTC: ts('2030-10-01T11:00:00+03:00'),
            DT_SKIP_TIME: 'N',
            TZ_FROM: 'Europe/Moscow',
            TZ_TO: 'Europe/Moscow',
            ACCESSIBILITY: 'busy',
          },
          {
            ID: '101',
            NAME: 'Можно пересечь',
            DATE_FROM_TS_UTC: ts('2030-10-01T14:00:00+03:00'),
            DATE_TO_TS_UTC: ts('2030-10-01T15:00:00+03:00'),
            DT_SKIP_TIME: 'N',
            TZ_FROM: 'Europe/Moscow',
            ACCESSIBILITY: 'free',
          },
        ],
        '8': [
          {
            ID: '500',
            NAME: 'Отпуск',
            DATE_FROM: '01.10.2030',
            DATE_TO: '01.10.2030',
            DATE_FROM_TS_UTC: ts('2030-09-30T21:00:00Z'),
            DATE_TO_TS_UTC: ts('2030-09-30T21:00:00Z'),
            DT_SKIP_TIME: 'Y',
            TZ_FROM: 'Europe/Moscow',
            ACCESSIBILITY: 'absent',
          },
        ],
        '10': [],
      }),
    );
}

async function reconnect(overrides: Record<string, string> = {}) {
  setup(overrides);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  await reconnect();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('calendar_list', () => {
  it('разделы с правами; company → company_calendar с ownerId=0 по документации', async () => {
    const env = await call('calendar_list', { type: 'user', ownerId: 7 });
    expect(env.success).toBe(true);
    const sections = env.data?.['sections'] as Record<string, unknown>[];
    expect(sections[0]).toMatchObject({
      id: 5,
      name: 'Мой календарь',
      calendarType: 'user',
      ownerId: 7,
      permissions: { viewTime: true, add: true, edit: true },
    });
    expect(JSON.stringify(env.data)).not.toContain('D114');

    const company = await call('calendar_list', { type: 'company' });
    expect(company.success).toBe(true);
    expect(t.bitrix.callsTo('calendar.section.get')[1]?.body).toEqual({
      type: 'company_calendar',
      ownerId: 0,
    });

    const noOwner = await call('calendar_list', { type: 'group' });
    expect(noOwner.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('calendar_list_events (T28, курсор по снимку)', () => {
  it('период в зоне, отбор по моменту, весь день датой, повторяющееся помечено; постраничная выдача из одного снимка', async () => {
    const first = await call('calendar_list_events', {
      type: 'user',
      ownerId: 7,
      from: '2030-10-01',
      to: '2030-10-01',
      timezone: 'Europe/Moscow',
      pageSize: 2,
    });
    expect(first.success).toBe(true);
    // Bitrix получает даты с запасом в сутки; точный отбор — на сервере
    expect(t.bitrix.callsTo('calendar.event.get')[0]?.body).toMatchObject({
      type: 'user',
      ownerId: 7,
      from: '2030-09-29',
      to: '2030-10-02',
    });
    const items1 = first.data?.['items'] as Record<string, unknown>[];
    expect(items1.map((i) => i['id'])).toEqual([500, 100]);
    expect(items1[0]).toMatchObject({ allDay: true, from: '2030-10-01', to: '2030-10-01' });
    expect(items1[1]).toMatchObject({
      from: '2030-10-01T10:00:00+03:00',
      to: '2030-10-01T11:00:00+03:00',
      isMeeting: true,
      hostId: 7,
      myStatus: 'host',
      attendees: [
        { id: 7, status: 'host' },
        { id: 8, status: 'accepted' },
        { id: 9, status: 'pending' },
      ],
    });
    expect(first.meta.completeness).toBe('partial');
    const cursor = first.meta.page?.nextCursor;
    expect(typeof cursor).toBe('string');

    const second = await call('calendar_list_events', {
      type: 'user',
      ownerId: 7,
      from: '2030-10-01',
      to: '2030-10-01',
      timezone: 'Europe/Moscow',
      pageSize: 2,
      cursor,
    });
    expect(second.success).toBe(true);
    const items2 = second.data?.['items'] as Record<string, unknown>[];
    expect(items2.map((i) => i['id'])).toEqual([200, 300]);
    expect(items2[0]).toMatchObject({ recurring: true, recurrence: 'каждую неделю по вторникам' });
    // продолжение из снимка: второго запроса к Bitrix не было
    expect(t.bitrix.callsTo('calendar.event.get')).toHaveLength(1);
    const third = await call('calendar_list_events', {
      type: 'user',
      ownerId: 7,
      from: '2030-10-01',
      to: '2030-10-01',
      timezone: 'Europe/Moscow',
      pageSize: 2,
      cursor: second.meta.page?.nextCursor,
    });
    expect((third.data?.['items'] as unknown[]).length).toBe(1);
    expect(third.meta.page?.hasMore).toBe(false);
    expect(third.meta.completeness).toBe('complete');
  });

  it('T21: курсор другой выборки или другого пользователя отклоняется без чтения снимка', async () => {
    const args = { type: 'user', ownerId: 7, from: '2030-10-01', to: '2030-10-01', pageSize: 2 };
    const first = await call('calendar_list_events', args);
    const cursor = first.meta.page?.nextCursor ?? '';
    const other: Principal = { id: 'intruder', role: 'administrator', source: 'local' };
    const foreign = await dispatch(calendarListEventsTool, { ...args, cursor }, t.app, undefined, other);
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.error.details.field).toBe('cursor');
    const wrongFilter = await call('calendar_list_events', { ...args, to: '2030-10-02', cursor });
    expect(wrongFilter.error?.code).toBe('VALIDATION_ERROR');
    expect(wrongFilter.error?.details['field']).toBe('cursor');
  });

  it('T28: обратный интервал, дата-время без зоны, смешанный формат, слишком длинный период — отказ до Bitrix', async () => {
    const base = { type: 'user', ownerId: 7 };
    const reversed = await call('calendar_list_events', { ...base, from: '2030-10-02', to: '2030-10-01' });
    expect(reversed.error?.details['reason']).toBe('INVALID_DATE_RANGE');
    const equal = await call('calendar_list_events', {
      ...base,
      from: '2030-10-01T10:00:00+03:00',
      to: '2030-10-01T10:00:00+03:00',
    });
    expect(equal.error?.details['reason']).toBe('INVALID_DATE_RANGE');
    const noZone = await call('calendar_list_events', {
      ...base,
      from: '2030-10-01T10:00:00',
      to: '2030-10-01T12:00:00+03:00',
    });
    expect(noZone.error?.details['reason']).toBe('TIMEZONE_REQUIRED');
    const mixed = await call('calendar_list_events', {
      ...base,
      from: '2030-10-01',
      to: '2030-10-01T12:00:00+03:00',
    });
    expect(mixed.error?.code).toBe('VALIDATION_ERROR');
    const tooLong = await call('calendar_list_events', { ...base, from: '2030-01-01', to: '2030-12-31' });
    expect(tooLong.error?.details['reason']).toBe('RANGE_TOO_LONG');
    const badTz = await call('calendar_list_events', {
      ...base,
      from: '2030-10-01',
      to: '2030-10-01',
      timezone: 'Mars/Base',
    });
    expect(badTz.error?.details['reason']).toBe('INVALID_TIMEZONE');
    expect(t.bitrix.callsTo('calendar.event.get')).toHaveLength(0);
  });

  it('T28 DST: сутки перехода на зимнее время в Europe/Berlin — 25 часов, смещения +02:00/+01:00', async () => {
    events = {
      1: meeting(1, '2030-10-27T00:30:00+02:00', '2030-10-27T01:00:00+02:00', 7, []),
      2: meeting(2, '2030-10-27T11:00:00+01:00', '2030-10-27T12:00:00+01:00', 7, []),
      3: meeting(3, '2030-10-27T23:30:00+01:00', '2030-10-28T00:30:00+01:00', 7, []),
      4: meeting(4, '2030-10-28T00:30:00+01:00', '2030-10-28T01:00:00+01:00', 7, []),
    };
    const env = await call('calendar_list_events', {
      type: 'user',
      ownerId: 7,
      from: '2030-10-27',
      to: '2030-10-27',
      timezone: 'Europe/Berlin',
    });
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((i) => [i['id'], i['from']])).toEqual([
      [1, '2030-10-27T00:30:00+02:00'],
      [2, '2030-10-27T11:00:00+01:00'],
      [3, '2030-10-27T23:30:00+01:00'],
    ]);
  });
});

describe('calendar_update_event', () => {
  const upd = (extra: Record<string, unknown> = {}) => ({
    eventId: 100,
    type: 'user',
    ownerId: 7,
    patch: {
      from: '2030-10-01T14:00:00+03:00',
      to: '2030-10-01T15:00:00+03:00',
      attendeeIds: [8, 10],
    },
    ...extra,
  });

  it('план: diff времени и участников (добавлен 10, удалён 9), уведомления в рисках; approve → одна запись → сверка; replay без второй записи', async () => {
    const dry = await call('calendar_update_event', upd({ dryRun: true }));
    expect(dry.success).toBe(true);
    const hash = dry.data?.['stateHash'] as string;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const plan = dry.data?.['plan'] as Record<string, unknown>;
    const details = plan['details'] as Record<string, unknown>;
    const changes = details['changes'] as Record<string, unknown>[];
    expect(changes.find((c) => c['field'] === 'attendees')).toMatchObject({ added: [10], removed: [9] });
    expect(changes.find((c) => c['field'] === 'dates')).toMatchObject({
      after: {
        from: '2030-10-01T14:00:00+03:00',
        to: '2030-10-01T15:00:00+03:00',
        timezone: 'Europe/Moscow',
      },
    });
    const risks = (plan['risks'] as string[]).join('\n');
    expect(risks).toContain('10');
    expect(risks).toContain('удалены');
    expect(t.bitrix.callsTo('calendar.event.update')).toHaveLength(0);

    const key = randomUUID();
    const args = upd({ idempotencyKey: key, expectedStateHash: hash });
    const prep = await call('calendar_update_event', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ eventId: 100, verified: true, replayed: false });
    const body = t.bitrix.callsTo('calendar.event.update')[0]?.body;
    expect(body).toMatchObject({
      id: 100,
      type: 'user',
      ownerId: 7,
      from_ts: Number(ts('2030-10-01T14:00:00+03:00')),
      timezone_from: 'Europe/Moscow',
      skip_time: 'N',
      is_meeting: 'Y',
      attendees: [7, 8, 10],
    });
    expect(body).not.toHaveProperty('host'); // меняет сам организатор
    expect(done.data?.['stateHash']).not.toBe(hash);

    const again = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('calendar.event.update')).toHaveLength(1);
  });

  it('CONFLICT: expectedStateHash устарел — до плана; изменение между подтверждением и записью — в precheck', async () => {
    const dry = await call('calendar_update_event', upd({ dryRun: true }));
    const hash = dry.data?.['stateHash'] as string;
    const key = randomUUID();
    const args = upd({ idempotencyKey: key, expectedStateHash: hash });
    const prep = await call('calendar_update_event', args);
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    Object.assign(events[100] ?? {}, { NAME: 'Кто-то переименовал' });
    const raced = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('calendar.event.update')).toHaveLength(0);
    const stale = await call(
      'calendar_update_event',
      upd({ idempotencyKey: randomUUID(), expectedStateHash: hash }),
    );
    expect(stale.error?.code).toBe('CONFLICT');
    expect(stale.error?.details['reason']).toBe('STATE_CHANGED');
  });

  it('повторяющееся событие без recurrenceScope → RECURRENCE_SCOPE_REQUIRED; this без occurrenceDate — ошибка; this → новое событие-вхождение', async () => {
    const base = { eventId: 200, type: 'user', ownerId: 7, patch: { name: 'Перенос' } };
    const noScope = await call('calendar_update_event', { ...base, dryRun: true });
    expect(noScope.error?.details['reason']).toBe('RECURRENCE_SCOPE_REQUIRED');
    const noDate = await call('calendar_update_event', { ...base, recurrenceScope: 'this', dryRun: true });
    expect(noDate.error?.details['field']).toBe('occurrenceDate');
    const singleThis = await call('calendar_update_event', {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      patch: { name: 'x' },
      recurrenceScope: 'this',
      dryRun: true,
    });
    expect(singleThis.error?.code).toBe('VALIDATION_ERROR');

    const args = {
      ...base,
      recurrenceScope: 'this',
      occurrenceDate: '2030-10-08',
      idempotencyKey: randomUUID(),
    };
    const prep = await call('calendar_update_event', args);
    expect(
      ((prep.error?.details['plan'] as Record<string, unknown>)['risks'] as string[]).join(' '),
    ).toContain('Изменится только вхождение 2030-10-08');
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ eventId: 200, newEventId: 1000, verified: true });
    expect(t.bitrix.callsTo('calendar.event.update')[0]?.body).toMatchObject({
      recurrence_mode: 'this',
      current_date_from: '2030-10-08',
      name: 'Перенос',
    });
  });

  it('T28: обратный интервал в patch, смена allDay без обеих дат, чужой календарь, пустой patch — отказ до плана', async () => {
    const rev = await call('calendar_update_event', {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      patch: { to: '2030-10-01T09:00:00+03:00' },
      dryRun: true,
    });
    expect(rev.error?.details['reason']).toBe('INVALID_DATE_RANGE');
    const allDay = await call('calendar_update_event', {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      patch: { allDay: true, from: '2030-10-02' },
      dryRun: true,
    });
    expect(allDay.error?.code).toBe('VALIDATION_ERROR');
    const allDayOk = await call('calendar_update_event', {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      patch: { allDay: true, from: '2030-10-02', to: '2030-10-03' },
      dryRun: true,
    });
    expect(allDayOk.success).toBe(true);
    const params = (
      (allDayOk.data?.['plan'] as Record<string, unknown>)['details'] as Record<string, unknown>
    )['params'];
    expect(params).toMatchObject({ from: '2030-10-02', to: '2030-10-03', skip_time: 'Y' });
    const wrongCal = await call('calendar_update_event', {
      eventId: 100,
      type: 'user',
      ownerId: 8,
      patch: { name: 'x' },
      dryRun: true,
    });
    expect(wrongCal.error?.details['reason']).toBe('CALENDAR_MISMATCH');
    expect(
      await rejected('calendar_update_event', {
        eventId: 100,
        type: 'user',
        ownerId: 7,
        patch: {},
        dryRun: true,
      }),
    ).toBe(true);
    const missing = await call('calendar_update_event', {
      eventId: 999,
      type: 'user',
      ownerId: 7,
      patch: { name: 'x' },
      dryRun: true,
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('встреча другого организатора: host передаётся по документации, риск в плане', async () => {
    const env = await call('calendar_update_event', {
      eventId: 300,
      type: 'user',
      ownerId: 8,
      patch: { name: 'Новое имя' },
      dryRun: true,
    });
    expect(env.success).toBe(true);
    const details = (env.data?.['plan'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['params']).toMatchObject({ host: 8, name: 'Новое имя' });
  });

  it('ответ без ID → OPERATION_OUTCOME_UNKNOWN, повтор не выполняется', async () => {
    t.bitrix.on('calendar.event.update', legacyOk({}));
    const args = {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      patch: { name: 'X' },
      idempotencyKey: randomUUID(),
    };
    const prep = await call('calendar_update_event', args);
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const again = await call('calendar_update_event', { ...args, approvalId: opId(prep) });
    expect(again.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('calendar.event.update')).toHaveLength(1);
  });
});

describe('calendar_delete_event', () => {
  it('скрыт без ENABLE_DESTRUCTIVE_TOOLS; не-админу — отказ', async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('calendar_delete_event');
    const hidden = await dispatch(
      calendarDeleteEventTool,
      { eventId: 100, type: 'user', ownerId: 7, dryRun: true },
      t.app,
    );
    expect(hidden.success).toBe(false);
    if (!hidden.success) expect(hidden.error.code).toBe('METHOD_NOT_ALLOWED');

    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('calendar_delete_event');
    const operator: Principal = { id: 'op', role: 'operator', source: 'local' };
    const denied = await dispatch(
      calendarDeleteEventTool,
      { eventId: 100, type: 'user', ownerId: 7, dryRun: true },
      t.app,
      undefined,
      operator,
    );
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('ACCESS_DENIED');
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('план с impact (участники получат отмену) → approve → удаление → сверка отсутствия; повторяющееся без scope и scope=this — отказ', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const rec = await call('calendar_delete_event', { eventId: 200, type: 'user', ownerId: 7, dryRun: true });
    expect(rec.error?.details['reason']).toBe('RECURRENCE_SCOPE_REQUIRED');
    const recThis = await call('calendar_delete_event', {
      eventId: 200,
      type: 'user',
      ownerId: 7,
      recurrenceScope: 'this',
      dryRun: true,
    });
    expect(recThis.error?.details['reason']).toBe('RECURRENCE_SCOPE_UNSUPPORTED');
    const recAll = await call('calendar_delete_event', {
      eventId: 200,
      type: 'user',
      ownerId: 7,
      recurrenceScope: 'all',
      dryRun: true,
    });
    expect(((recAll.data?.['plan'] as Record<string, unknown>)['risks'] as string[])[0]).toContain(
      'ВСЯ серия',
    );
    const missing = await call('calendar_delete_event', {
      eventId: 999,
      type: 'user',
      ownerId: 7,
      dryRun: true,
    });
    expect(missing.error?.code).toBe('NOT_FOUND');

    const args = { eventId: 100, type: 'user', ownerId: 7, idempotencyKey: randomUUID() };
    const prep = await call('calendar_delete_event', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const plan = prep.error?.details['plan'] as Record<string, unknown>;
    expect((plan['risks'] as string[]).join(' ')).toContain('уведомление об отмене');
    expect(
      ((plan['details'] as Record<string, unknown>)['impact'] as Record<string, unknown>)['attendees'],
    ).toHaveLength(3);
    expect(t.bitrix.callsTo('calendar.event.delete')).toHaveLength(0);
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('calendar_delete_event', { ...args, approvalId: opId(prep) });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ eventId: 100, deleted: true, verified: true });
    expect(events[100]).toBeUndefined();
    const again = await call('calendar_delete_event', { ...args, approvalId: opId(prep) });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('calendar.event.delete')).toHaveLength(1);
  });

  it('CONFLICT по expectedStateHash', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const dry = await call('calendar_delete_event', { eventId: 100, type: 'user', ownerId: 7, dryRun: true });
    const hash = dry.data?.['stateHash'] as string;
    Object.assign(events[100] ?? {}, { DATE_FROM_TS_UTC: ts('2030-10-01T12:00:00+03:00') });
    const stale = await call('calendar_delete_event', {
      eventId: 100,
      type: 'user',
      ownerId: 7,
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
  });
});

describe('calendar_respond_invitation', () => {
  it('принять приглашение за себя: план → approve → Y → сверка через status.get', async () => {
    const args = { eventId: 300, status: 'accepted', idempotencyKey: randomUUID() };
    const prep = await call('calendar_respond_invitation', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const details = (prep.error?.details['plan'] as Record<string, unknown>)['details'] as Record<
      string,
      unknown
    >;
    expect(details).toMatchObject({
      userId: 7,
      statusBefore: 'pending',
      statusAfter: 'accepted',
      bitrixStatus: 'Y',
    });
    t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('calendar_respond_invitation', { ...args, approvalId: opId(prep) });
    expect(done.data).toMatchObject({ eventId: 300, status: 'accepted', verified: true });
    expect(t.bitrix.callsTo('calendar.meeting.status.set')[0]?.body).toEqual({ eventId: 300, status: 'Y' });
  });

  it('чужое участие, организатор, tentative → отказ до плана и без записи', async () => {
    const foreign = await call('calendar_respond_invitation', {
      eventId: 400,
      status: 'declined',
      dryRun: true,
    });
    expect(foreign.error?.code).toBe('ACCESS_DENIED');
    expect(foreign.error?.details['reason']).toBe('NOT_AN_ATTENDEE');
    const host = await call('calendar_respond_invitation', {
      eventId: 100,
      status: 'accepted',
      dryRun: true,
    });
    expect(host.error?.details['reason']).toBe('ORGANIZER_CANNOT_RESPOND');
    const tentative = await call('calendar_respond_invitation', {
      eventId: 300,
      status: 'tentative',
      dryRun: true,
    });
    expect(tentative.error?.details['reason']).toBe('INVALID_STATUS');
    expect(
      await rejected('calendar_respond_invitation', { eventId: 300, status: 'maybe', dryRun: true }),
    ).toBe(true);
    expect(t.bitrix.callsTo('calendar.meeting.status.set')).toHaveLength(0);
  });
});

describe('employee_availability', () => {
  it('busy/absent без названий событий, free-события не занимают время; нет данных → unknown без free', async () => {
    const env = await call('employee_availability', {
      userIds: [7, 8, 9, 10],
      from: '2030-10-01',
      to: '2030-10-01',
      timezone: 'Europe/Moscow',
    });
    expect(env.success).toBe(true);
    expect(t.bitrix.callsTo('calendar.accessibility.get')[0]?.body).toMatchObject({
      users: [7, 8, 9, 10],
      from: '2030-09-29',
      to: '2030-10-02',
    });
    const users = env.data?.['users'] as Record<string, unknown>[];
    expect(users[0]).toMatchObject({
      userId: 7,
      completeness: 'complete',
      busy: [
        { from: '2030-10-01T10:00:00+03:00', to: '2030-10-01T11:00:00+03:00', allDay: false, kind: 'busy' },
      ],
      free: [
        { from: '2030-10-01T00:00:00+03:00', to: '2030-10-01T10:00:00+03:00' },
        { from: '2030-10-01T11:00:00+03:00', to: '2030-10-02T00:00:00+03:00' },
      ],
    });
    expect(users[1]).toMatchObject({
      userId: 8,
      completeness: 'complete',
      busy: [
        { from: '2030-10-01T00:00:00+03:00', to: '2030-10-02T00:00:00+03:00', allDay: true, kind: 'absent' },
      ],
      free: [],
    });
    expect(users[2]).toMatchObject({ userId: 9, completeness: 'unknown', busy: [] });
    expect(users[2]).not.toHaveProperty('free');
    expect(users[3]).toMatchObject({ userId: 10, completeness: 'complete', free: [expect.any(Object)] });
    expect(env.meta.completeness).toBe('partial');
    expect(JSON.stringify(env.data)).not.toContain('Секретная');
    expect((env.meta.warnings ?? []).join(' ')).toContain('не присутствие на работе');
  });

  it('интервал и лимит пользователей проверяются до Bitrix', async () => {
    const rev = await call('employee_availability', { userIds: [7], from: '2030-10-02', to: '2030-10-01' });
    expect(rev.error?.details['reason']).toBe('INVALID_DATE_RANGE');
    expect(
      await rejected('employee_availability', {
        userIds: Array.from({ length: 51 }, (_, i) => i + 1),
        from: '2030-10-01',
        to: '2030-10-01',
      }),
    ).toBe(true);
    expect(t.bitrix.callsTo('calendar.accessibility.get')).toHaveLength(0);
  });

  it('пустой ответ портала — unknown по всем, «свободен» не утверждается', async () => {
    t.bitrix.on('calendar.accessibility.get', legacyOk([]));
    const env = await call('employee_availability', {
      userIds: [7, 8],
      from: '2030-10-01',
      to: '2030-10-01',
    });
    const users = env.data?.['users'] as Record<string, unknown>[];
    expect(users.every((u) => u['completeness'] === 'unknown' && !('free' in u))).toBe(true);
  });
});

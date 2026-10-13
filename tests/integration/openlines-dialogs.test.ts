/**
 * Заявка 2026-10-13, п. 4: диалоги открытых линий за период одним вызовом («кому не ответили в WhatsApp за неделю»),
 * фильтр истории по дате и без системных строк, выгрузка переписки в файл. Сессии — из дел CRM открытых линий,
 * переписка — imopenlines.session.history.get по каждой сессии. Ссылки на файлы наружу не выходят.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk, type RecordedCall } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[] };
}

const msg = (id: number, sender: number, date: string, text: string) => ({
  id: String(id),
  senderid: String(sender),
  date,
  text,
});

/** Три сессии: 401 — WhatsApp, клиент ждёт ответа; 402 — WhatsApp, оператор ответил; 403 — Telegram, ждёт. */
const HISTORIES: Record<number, unknown> = {
  401: {
    chatId: 11,
    sessionId: 401,
    message: {
      '1': msg(1, 0, '2026-10-06T09:00:00+03:00', 'Создан новый лид'),
      '2': msg(2, 501, '2026-10-06T09:01:00+03:00', 'Здравствуйте, сколько стоит услуга?'),
      '3': msg(3, 103, '2026-10-06T09:31:00+03:00', 'Добрый день! Пришлите количество рабочих мест'),
      '4': msg(4, 501, '2026-10-07T10:00:00+03:00', 'Двенадцать мест'),
    },
    users: {
      '103': { id: 103, name: 'Оператор Ольга', connector: false },
      '501': { id: 501, name: 'Клиент А', connector: true },
    },
    files: {},
    chat: {
      '11': {
        id: 11,
        name: 'Клиент А — WhatsApp',
        entityId: 'wz_whatsapp_abc|5|11|501',
        entityData2: 'LEAD|71|COMPANY|0|CONTACT|0|DEAL|0',
      },
    },
  },
  402: {
    chatId: 12,
    sessionId: 402,
    message: {
      '5': msg(5, 502, '2026-10-06T11:00:00+03:00', 'Нужен договор'),
      '6': msg(6, 103, '2026-10-06T11:05:00+03:00', 'Отправила на почту'),
      '7': msg(7, 0, '2026-10-06T12:00:00+03:00', 'Диалог завершён'),
    },
    users: {
      '103': { id: 103, name: 'Оператор Ольга', connector: false },
      '502': { id: 502, name: 'Клиент Б', connector: true },
    },
    files: {},
    chat: {
      '12': { id: 12, name: 'Клиент Б — WhatsApp', entityId: 'wz_whatsapp_abc|5|12|502', entityData2: '' },
    },
  },
  403: {
    chatId: 13,
    sessionId: 403,
    message: { '8': msg(8, 503, '2026-10-08T15:00:00+03:00', 'Есть кто?') },
    users: { '503': { id: 503, name: 'Клиент В', connector: true } },
    files: {},
    chat: {
      '13': { id: 13, name: 'Клиент В — Telegram', entityId: 'telegrambot|6|13|503', entityData2: '' },
    },
  },
};

let root: string;
let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-ol-'));
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', DOWNLOAD_DIR: root });
  t.bitrix
    .on(
      'crm.activity.list',
      legacyOk([
        {
          ID: '91',
          ASSOCIATED_ENTITY_ID: '401',
          RESPONSIBLE_ID: '103',
          OWNER_TYPE_ID: '1',
          OWNER_ID: '71',
          COMPLETED: 'N',
        },
        {
          ID: '92',
          ASSOCIATED_ENTITY_ID: '402',
          RESPONSIBLE_ID: '103',
          OWNER_TYPE_ID: '3',
          OWNER_ID: '15',
          COMPLETED: 'Y',
        },
        {
          ID: '93',
          ASSOCIATED_ENTITY_ID: '403',
          RESPONSIBLE_ID: '104',
          OWNER_TYPE_ID: '1',
          OWNER_ID: '72',
          COMPLETED: 'N',
        },
      ]),
    )
    .on('imopenlines.session.history.get', (c: RecordedCall) => {
      const h = HISTORIES[Number(c.body['SESSION_ID'])];
      return h
        ? legacyOk(h)
        : { status: 400, body: { error: 'SESSION_NOT_FOUND', error_description: 'not found' } };
    })
    .on(
      'imopenlines.config.list.get',
      legacyOk([
        { ID: '5', LINE_NAME: 'Wazzup', ACTIVE: 'Y' },
        { ID: '6', LINE_NAME: 'Телеграм-бот', ACTIVE: 'Y' },
      ]),
    )
    .on(
      'user.get',
      legacyOk([
        { ID: '103', NAME: 'Ольга', LAST_NAME: 'Операторова', ACTIVE: true },
        { ID: '104', NAME: 'Пётр', LAST_NAME: 'Уволенный', ACTIVE: false },
      ]),
    );
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('openlines_dialogs_list', () => {
  it('все диалоги периода одной таблицей: канал, линия, оператор, кто последний, время первого ответа', async () => {
    const env = await call('openlines_dialogs_list', {
      from: '2026-10-06T00:00:00+03:00',
      to: '2026-10-12T23:59:59+03:00',
    });
    expect(env.success).toBe(true);
    const f = t.bitrix.callsTo('crm.activity.list')[0]?.body['filter'] as Record<string, unknown>;
    expect(f).toMatchObject({
      PROVIDER_ID: 'IMOPENLINES_SESSION',
      '>=LAST_UPDATED': '2026-10-06T00:00:00+03:00',
    });
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((i) => i['sessionId'])).toEqual([403, 401, 402]);
    expect(items[1]).toMatchObject({
      channel: 'WhatsApp',
      lineName: 'Wazzup',
      operatorName: 'Операторова Ольга',
      clientName: 'Клиент А — WhatsApp',
      crm: { lead: 71 },
      messages: 3,
      clientMessages: 2,
      operatorMessages: 1,
      lastFrom: 'client',
      waitingReply: true,
      firstReplyMinutes: 30,
      closed: false,
    });
    expect(items[2]).toMatchObject({
      waitingReply: false,
      operatorReplied: true,
      crm: { contact: 15 },
      closed: true,
    });
    expect(items[0]).toMatchObject({
      channel: 'Telegram',
      operatorName: 'Уволенный Пётр',
      operatorReplied: false,
    });
    expect(env.data?.['waitingReply']).toBe(2);
  });

  it('«кому не ответили в WhatsApp» — один вызов', async () => {
    const env = await call('openlines_dialogs_list', {
      from: '2026-10-06',
      to: '2026-10-12',
      channel: 'WhatsApp',
      waitingOnly: true,
    });
    expect((env.data?.['items'] as Record<string, unknown>[]).map((i) => i['sessionId'])).toEqual([401]);
  });
});

describe('openlines_chat_history: период и только текст', () => {
  it('textOnly убирает системные строки, from — ранние сообщения', async () => {
    const env = await call('openlines_chat_history', {
      sessionId: 401,
      textOnly: true,
      from: '2026-10-06T09:30:00+03:00',
    });
    const messages = env.data?.['messages'] as { id: number; authorKind: string }[];
    expect(messages.map((m) => m.id)).toEqual([3, 4]);
    expect(env.data?.['totalInSession']).toBe(4);
  });
});

describe('openlines_chat_export', () => {
  it('переписка в txt: дата, автор, текст; без системных строк', async () => {
    const env = await call('openlines_chat_export', { sessionId: 402 });
    expect(env.success).toBe(true);
    const file = env.data?.['path'] as string;
    expect(file.startsWith(root)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Канал: WhatsApp');
    expect(text).toContain('2026-10-06 11:00 — Клиент (Клиент Б): Нужен договор');
    expect(text).toContain('Оператор (Оператор Ольга): Отправила на почту');
    expect(text).not.toContain('Диалог завершён');
    const again = await call('openlines_chat_export', { sessionId: 402 });
    expect(again.data?.['path']).not.toBe(file);
  });
});

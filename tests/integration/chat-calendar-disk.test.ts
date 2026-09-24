/**
 * MVP чат/календарь/Диск (ТЗ §10.1, §9.3, §9.9, §9.12, §15.3) через MCP-клиент и мок Bitrix.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk } from '../helpers/mock-bitrix.js';

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

function opId(env: Env): string {
  const id = env.error?.details['operationId'];
  return typeof id === 'string' ? id : '';
}

/** Один полный путь подтверждения: план → approve → выполнение. */
async function approved(
  name: string,
  args: Record<string, unknown>,
): Promise<{ prep: Env; done: Env; operationId: string }> {
  const prep = await call(name, args);
  const operationId = opId(prep);
  if (operationId) t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = operationId ? await call(name, { ...args, approvalId: operationId }) : prep;
  return { prep, done, operationId };
}

const FROM = '2030-10-01T10:00:00+03:00';
const TO = '2030-10-01T11:00:00+03:00';

let sentMessages: Record<string, unknown>[];
let uploaded: Record<string, unknown> | undefined;
let folderChildren: Record<string, unknown>[];

function setup(overrides: Record<string, string> = {}) {
  t = createTestApp({ READ_ONLY_MODE: 'false', ...overrides });
  sentMessages = [];
  uploaded = undefined;
  folderChildren = [{ ID: '900', NAME: 'существующий.txt', TYPE: 'file' }];
  t.bitrix
    // чат
    .on('im.dialog.get', (c) => {
      const id = String(c.body['DIALOG_ID']);
      if (id === 'chat42')
        return legacyOk({ id: '42', type: 'chat', title: '[MCP TEST] Тестовый чат', user_counter: 3 });
      if (id === '7') return legacyOk({ id: '7', type: 'user', title: 'Иван Тестов', user_counter: 2 });
      return legacyError('ERROR_ARGUMENT', 400, 'Dialog not found');
    })
    .on('im.message.add', (c) => {
      const id = 1000 + sentMessages.length + 1;
      sentMessages.push({ id, text: c.body['MESSAGE'], dialogId: c.body['DIALOG_ID'] });
      return legacyOk(id);
    })
    .on('im.dialog.messages.get', () =>
      legacyOk({ messages: sentMessages.map((m) => ({ id: m['id'], text: m['text'] })) }),
    )
    // календарь
    .on('calendar.section.get', (c) =>
      c.body['type'] === 'user' && Number(c.body['ownerId']) === 7
        ? legacyOk([
            { ID: '5', NAME: 'Мой календарь' },
            { ID: '6', NAME: 'Рабочий' },
          ])
        : legacyOk([]),
    )
    .on('calendar.event.add', legacyOk(777))
    .on('calendar.event.getbyid', (c) =>
      Number(c.body['id']) === 777
        ? legacyOk({
            ID: '777',
            NAME: '[MCP TEST] Встреча',
            DATE_FROM: '01.10.2030 10:00:00',
            DATE_TO: '01.10.2030 11:00:00',
            TZ_FROM: 'Europe/Moscow',
            TZ_TO: 'Europe/Moscow',
            ATTENDEE_LIST: [{ id: 7 }, { id: 8 }],
          })
        : legacyError('ERROR_NOT_FOUND', 400),
    )
    // диск
    .on('disk.folder.get', (c) =>
      Number(c.body['id']) === 12
        ? legacyOk({ ID: '12', NAME: 'MCP TEST', STORAGE_ID: '3' })
        : legacyError('ERROR_NOT_FOUND', 400),
    )
    .on('disk.folder.getchildren', (c) => {
      const filter = c.body['filter'] as Record<string, unknown> | undefined;
      const name = typeof filter?.['NAME'] === 'string' ? filter['NAME'] : '';
      return legacyOk(folderChildren.filter((f) => f['NAME'] === name));
    })
    .on('disk.folder.uploadfile', (c) => {
      const [name, b64] = c.body['fileContent'] as [string, string];
      const size = Buffer.from(b64, 'base64').length;
      const finalName =
        c.body['generateUniqueName'] === true && folderChildren.some((f) => f['NAME'] === name)
          ? name.replace(/(\.[^.]+)?$/, ' (1)$1')
          : name;
      uploaded = {
        ID: '555',
        NAME: finalName,
        SIZE: String(size),
        DETAIL_URL: 'https://mock.bitrix24.invalid/disk/file/555/',
        DOWNLOAD_URL: 'https://mock.bitrix24.invalid/secret-download',
      };
      return legacyOk(uploaded);
    })
    .on('disk.file.get', (c) =>
      Number(c.body['id']) === 555 && uploaded ? legacyOk(uploaded) : legacyError('ERROR_NOT_FOUND', 400),
    );
}

beforeEach(async () => {
  setup();
  mkdirSync(t.config.storage.uploadRoot, { recursive: true });
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('chat_send_message', () => {
  it('dialogId из ФИО не принимается; несуществующий диалог → ошибка до плана', async () => {
    for (const dialogId of ['Иван Тестов', 'chat', 'user7', '7; drop']) {
      const r = await client.callTool({
        name: 'chat_send_message',
        arguments: { dialogId, message: 'x', idempotencyKey: randomUUID() },
      });
      expect(r.isError, dialogId).toBe(true);
    }
    const env = await call('chat_send_message', {
      dialogId: '999',
      message: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(t.bitrix.callsTo('im.message.add')).toHaveLength(0);
    expect(t.app.operations.countByStatus()).toEqual({});
  });

  it('план содержит точный dialogId, название чата, участников и ПОЛНЫЙ текст; сообщение уходит один раз и читается обратно', async () => {
    const text = 'Привет! Это [MCP TEST] сообщение с полным текстом.';
    const key = randomUUID();
    const { prep, done, operationId } = await approved('chat_send_message', {
      dialogId: 'chat42',
      message: text,
      idempotencyKey: key,
    });
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'chat:chat42',
      details: { dialogId: 'chat42', dialogTitle: '[MCP TEST] Тестовый чат', participants: 3, message: text },
    });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({
      messageId: 1001,
      dialogId: 'chat42',
      operationId,
      verified: true,
      replayed: false,
    });
    expect(t.bitrix.callsTo('im.message.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('im.message.add')[0]?.body).toEqual({ DIALOG_ID: 'chat42', MESSAGE: text });
    const again = await call('chat_send_message', {
      dialogId: 'chat42',
      message: text,
      idempotencyKey: key,
      approvalId: operationId,
    });
    expect(again.data).toMatchObject({ replayed: true });
    expect(t.bitrix.callsTo('im.message.add')).toHaveLength(1);
  });

  it('чтение обратно недоступно → отправлено, verified=false', async () => {
    t.bitrix.on('im.dialog.messages.get', legacyError('ACCESS_DENIED', 200));
    const { done } = await approved('chat_send_message', {
      dialogId: '7',
      message: 'личное',
      idempotencyKey: randomUUID(),
    });
    expect(done.success).toBe(true);
    expect(done.data?.['verified']).toBe(false);
    expect((done.meta.warnings ?? []).join(' ')).toContain('проверка не завершена');
    expect(t.bitrix.callsTo('im.message.add')).toHaveLength(1);
  });
});

describe('calendar_create_event', () => {
  it('to<=from, дата без зоны, неизвестная зона, чужой sectionId — отказ до плана', async () => {
    const base = { type: 'user', ownerId: 7, sectionId: 5, name: 'x', idempotencyKey: randomUUID() };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, from: TO, to: FROM }, 'INVALID_DATE_RANGE'],
      [{ ...base, from: '2030-10-01T10:00:00', to: TO }, 'TIMEZONE_REQUIRED'],
      [{ ...base, from: FROM, to: TO, timezone: 'Moscow' }, 'INVALID_TIMEZONE'],
    ];
    for (const [args, reason] of cases) {
      const env = await call('calendar_create_event', args);
      expect(env.error?.code, reason).toBe('VALIDATION_ERROR');
      expect(env.error?.details['reason']).toBe(reason);
    }
    const missing = await call('calendar_create_event', { ...base, sectionId: 99, from: FROM, to: TO });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(t.bitrix.callsTo('calendar.event.add')).toHaveLength(0);
    expect(t.app.operations.countByStatus()).toEqual({});
  });

  it('встреча с участниками: план с календарём, датами в зоне и участниками; from_ts/to_ts в запросе; сверка дат из формата Bitrix', async () => {
    const args = {
      type: 'user',
      ownerId: 7,
      sectionId: 5,
      name: '[MCP TEST] Встреча',
      from: FROM,
      to: TO,
      attendeeIds: [8, 7],
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approved('calendar_create_event', args);
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'calendar:user/7/5',
      details: {
        calendar: 'Мой календарь (sectionId 5, user 7)',
        from: '01.10.2030 10:00:00 (Europe/Moscow)',
        timezone: 'Europe/Moscow',
        attendees: [8, 7],
      },
    });
    expect((prep.error?.details['plan'] as { risks: string[] }).risks.join(' ')).toContain('Участники (2)');
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ eventId: 777, verified: true, replayed: false });
    const sent = t.bitrix.callsTo('calendar.event.add')[0]?.body;
    expect(sent).toMatchObject({
      type: 'user',
      ownerId: 7,
      section: 5,
      name: '[MCP TEST] Встреча',
      from_ts: Date.parse(FROM) / 1000,
      to_ts: Date.parse(TO) / 1000,
      timezone_from: 'Europe/Moscow',
      skip_time: 'N',
      is_meeting: 'Y',
      attendees: [8, 7],
      host: 7,
    });
    expect(sent?.['from']).toBeUndefined();
  });

  it('портал сдвинул время → success с warning, verified=false; allDay передаёт skip_time=Y', async () => {
    t.bitrix.on(
      'calendar.event.getbyid',
      legacyOk({
        ID: '777',
        NAME: 'x',
        DATE_FROM: '01.10.2030 12:00:00',
        DATE_TO: '01.10.2030 13:00:00',
        TZ_FROM: 'Europe/Moscow',
        TZ_TO: 'Europe/Moscow',
      }),
    );
    const { done } = await approved('calendar_create_event', {
      type: 'user',
      ownerId: 7,
      sectionId: 5,
      name: 'x',
      from: FROM,
      to: TO,
      idempotencyKey: randomUUID(),
    });
    expect(done.success).toBe(true);
    expect(done.data?.['verified']).toBe(false);
    expect((done.meta.warnings ?? []).join(' ')).toContain('Даты в портале');
    const allDay = await call('calendar_create_event', {
      type: 'user',
      ownerId: 7,
      sectionId: 6,
      name: 'день',
      from: '2030-10-01',
      to: '2030-10-01',
      allDay: true,
      dryRun: true,
    });
    expect(allDay.success).toBe(true);
    expect(
      (allDay.data?.['plan'] as { details: { fields: Record<string, unknown> } }).details.fields,
    ).toMatchObject({ skip_time: 'Y', section: 6 });
  });
});

describe('disk_upload_file', () => {
  const inline = {
    fileName: 'mcp-test.txt',
    contentBase64: Buffer.from('тестовый файл для Диска\n').toString('base64'),
  };

  it('нужен ровно один источник; неизвестный токен, чужая папка, конфликт имени — до плана', async () => {
    const both = await client.callTool({
      name: 'disk_upload_file',
      arguments: { folderId: 12, inline, fileToken: 'x'.repeat(20), idempotencyKey: randomUUID() },
    });
    expect(both.isError).toBe(true);
    const badToken = await call('disk_upload_file', {
      folderId: 12,
      fileToken: 'nope-nope-nope-nope-nope',
      idempotencyKey: randomUUID(),
    });
    expect(badToken.error?.code).toBe('NOT_FOUND');
    const badFolder = await call('disk_upload_file', { folderId: 99, inline, idempotencyKey: randomUUID() });
    expect(badFolder.error?.code).toBe('NOT_FOUND');
    const conflict = await call('disk_upload_file', {
      folderId: 12,
      inline: { ...inline, fileName: 'существующий.txt' },
      idempotencyKey: randomUUID(),
    });
    expect(conflict.error?.code).toBe('CONFLICT');
    expect(conflict.error?.details['reason']).toBe('NAME_CONFLICT');
    const unsafe = await call('disk_upload_file', {
      folderId: 12,
      inline: { fileName: 'virus.exe', contentBase64: inline.contentBase64 },
      idempotencyKey: randomUUID(),
    });
    expect(unsafe.error?.code).toBe('UNSAFE_FILE');
    expect(t.bitrix.callsTo('disk.folder.uploadfile')).toHaveLength(0);
    expect(t.app.operations.countByStatus()).toEqual({});
  });

  it('inline: план с папкой, именем, размером и sha256; загрузка один раз; размер сверен; DOWNLOAD_URL не выдаётся', async () => {
    const key = randomUUID();
    const { prep, done } = await approved('disk_upload_file', { folderId: 12, inline, idempotencyKey: key });
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const size = Buffer.from(inline.contentBase64, 'base64').length;
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'disk.folder:12',
      details: { folderName: 'MCP TEST', name: 'mcp-test.txt', size, mime: 'text/plain' },
    });
    expect((prep.error?.details['plan'] as { details: { sha256: string } }).details.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({
      fileId: 555,
      name: 'mcp-test.txt',
      size,
      verified: true,
      detailUrl: 'https://mock.bitrix24.invalid/disk/file/555/',
    });
    expect(JSON.stringify(done)).not.toContain('secret-download');
    expect(t.bitrix.callsTo('disk.folder.uploadfile')).toHaveLength(1);
    expect(t.bitrix.callsTo('disk.folder.uploadfile')[0]?.body).toMatchObject({
      id: 12,
      data: { NAME: 'mcp-test.txt' },
    });
    // повтор того же содержимого с тем же ключом = replay, второй загрузки нет
    const again = await call('disk_upload_file', { folderId: 12, inline, idempotencyKey: key });
    expect(again.data).toMatchObject({ replayed: true });
    expect(t.bitrix.callsTo('disk.folder.uploadfile')).toHaveLength(1);
  });

  it('fileToken из staging + conflictPolicy=rename: портал переименовал → success с warning', async () => {
    const path = `${t.config.storage.uploadRoot}/существующий.txt`;
    writeFileSync(path, 'новое содержимое\n');
    const manifest = await t.app.files.stageFromPath(path, 'owner');
    const { done } = await approved('disk_upload_file', {
      folderId: 12,
      fileToken: manifest.token,
      conflictPolicy: 'rename',
      idempotencyKey: randomUUID(),
    });
    expect(done.success).toBe(true);
    expect(done.data?.['name']).toBe('существующий (1).txt');
    expect(done.data?.['verified']).toBe(true);
    expect((done.meta.warnings ?? []).join(' ')).toContain('переименовано');
    expect(t.bitrix.callsTo('disk.folder.uploadfile')[0]?.body['generateUniqueName']).toBe(true);
  });

  it('T26: staged-файл подменён после подтверждения → UNSAFE_FILE, загрузки нет, операция failed', async () => {
    const path = `${t.config.storage.uploadRoot}/mcp-tamper.txt`;
    writeFileSync(path, 'исходное\n');
    const manifest = await t.app.files.stageFromPath(path, 'owner');
    const args = { folderId: 12, fileToken: manifest.token, idempotencyKey: randomUUID() };
    const prep = await call('disk_upload_file', args);
    const operationId = opId(prep);
    writeFileSync(manifest.stagingPath, 'подменённое\n');
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('disk_upload_file', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('UNSAFE_FILE');
    expect(t.bitrix.callsTo('disk.folder.uploadfile')).toHaveLength(0);
    expect(t.app.operations.view(operationId, 'owner', t.app.auth.portalKey)?.status).toBe('failed');
  });

  it('файл появился в папке между планом и подтверждением → CONFLICT (precheck)', async () => {
    const args = { folderId: 12, inline: { ...inline, fileName: 'новый.txt' }, idempotencyKey: randomUUID() };
    const prep = await call('disk_upload_file', args);
    const operationId = opId(prep);
    folderChildren.push({ ID: '901', NAME: 'новый.txt', TYPE: 'file' });
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('disk_upload_file', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('disk.folder.uploadfile')).toHaveLength(0);
  });
});

describe('tools/list', () => {
  it('в read-only все три инструмента записи скрыты', async () => {
    await close();
    t.app.close();
    setup({ READ_ONLY_MODE: 'true' });
    const c = await connectInMemory(t.app);
    client = c.client;
    close = () => c.close();
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of ['chat_send_message', 'calendar_create_event', 'disk_upload_file'])
      expect(names).not.toContain(n);
  });
});

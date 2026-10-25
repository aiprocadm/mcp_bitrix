/**
 * Заявка 2026-10-13 «записи звонков» (п. 3 итогового задания): фильтры и сводка telephony_calls_list, ID файла записи
 * прямо в списке (RECORD_FILE_ID или файл дела CRM), имя сотрудника, compact; calls_recordings_download; call_transcribe.
 * Распознавание подменено скриптом на node (TRANSCRIBE_PYTHON=node): проверяется запуск без оболочки, подсказка слов,
 * сохранение текста рядом с записью и повтор без нового распознавания. Ссылки на записи и номера наружу не выходят.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk, methodFromUrl, type RecordedCall } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

const SECRET = 'mocksecret0123456789';
// 12 звонков: чётные — входящие, нечётные — исходящие; каждый третий не состоялся; у звонка 2 запись в статистике,
// у остальных состоявшихся — файл в деле CRM (внешняя АТС).
const CALLS = Array.from({ length: 12 }, (_, i) => ({
  ID: String(i + 1),
  PORTAL_USER_ID: i < 8 ? '7' : '9',
  PORTAL_NUMBER: i < 6 ? 'line1' : 'line2',
  PHONE_NUMBER: `+7900000${String(1000 + i)}`,
  CALL_ID: `externalCall.${'x'.repeat(40)}.${String(i)}`,
  CALL_CATEGORY: 'external',
  CALL_DURATION: String(i % 3 === 0 ? 0 : 20 + i * 10),
  CALL_START_DATE: `2026-10-0${String(1 + Math.floor(i / 3))}T1${String(i % 10)}:05:00+03:00`,
  CALL_RECORD_URL: '',
  CALL_FAILED_CODE: i % 3 === 0 ? '304' : '200',
  CALL_FAILED_REASON: i % 3 === 0 ? 'Missed call' : 'Success call',
  CRM_ENTITY_TYPE: i === 5 ? '' : 'CONTACT',
  CRM_ENTITY_ID: i === 5 ? '' : '275',
  CRM_ACTIVITY_ID: String(500 + i),
  RECORD_FILE_ID: i === 1 ? 9001 : null,
  CALL_TYPE: i % 2 ? '1' : '2',
}));
const ACTIVITY_FILE = (activityId: number) => 9100 + activityId - 500;

let root: string;
let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

function fakeTranscriber(): string {
  const script = path.join(root, '..', `fake-whisper-${path.basename(root)}.mjs`);
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
const hot = args.includes('--hotwords') ? args[args.indexOf('--hotwords') + 1] : '';
process.stdout.write(JSON.stringify({ duration: 42.5, channels: 2, segments: [
  { start: 0.4, end: 3, speaker: 1, text: 'Добрый день, ' + hot },
  { start: 4, end: 6, speaker: 2, text: 'Здравствуйте, нужен договор' },
] }));`,
  );
  return script;
}

async function start(overrides: Record<string, string> = {}) {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', DOWNLOAD_DIR: root, ...overrides });
  t.bitrix
    .on('voximplant.statistic.get', (c: RecordedCall) => {
      const f = (c.body['FILTER'] ?? {}) as Record<string, unknown>;
      const rows = CALLS.filter(
        (r) =>
          f['PORTAL_USER_ID'] === undefined || r.PORTAL_USER_ID === String(f['PORTAL_USER_ID'] as number),
      );
      const sorted = c.body['ORDER'] === 'ASC' ? rows : [...rows].reverse();
      const startAt = Number(c.body['start'] ?? 0);
      const size = 5; // маленькие страницы — проверка обхода
      const next = startAt + size < sorted.length ? startAt + size : undefined;
      return legacyOk(sorted.slice(startAt, startAt + size), {
        total: sorted.length,
        ...(next !== undefined ? { next } : {}),
      });
    })
    .on('crm.activity.list', (c: RecordedCall) => {
      const ids = (((c.body['filter'] as Record<string, unknown>)['@ID'] ?? []) as number[]).map(Number);
      return legacyOk(
        ids.map((id) => ({ ID: String(id), FILES: [{ id: ACTIVITY_FILE(id), url: 'https://p.invalid/x' }] })),
      );
    })
    .on('crm.activity.get', (c: RecordedCall) => {
      const id = Number(c.body['id']);
      return legacyOk({
        ID: String(id),
        OWNER_TYPE_ID: '2',
        OWNER_ID: '33',
        FILES: [{ id: ACTIVITY_FILE(id) }],
      });
    })
    .on(
      'user.get',
      legacyOk([
        { ID: '7', NAME: 'Иван', LAST_NAME: 'Тестов', ACTIVE: true },
        { ID: '9', NAME: 'Олег', LAST_NAME: 'Уволенный', ACTIVE: false },
      ]),
    )
    .on('disk.file.get', (c: RecordedCall) => {
      const id = Number(c.body['id']);
      return legacyOk({
        ID: String(id),
        NAME: `rec-${String(id)}.mp3`,
        SIZE: '4',
        DOWNLOAD_URL: `https://mock.bitrix24.invalid/rest/7/${SECRET}/download/?token=disk%7C${String(id)}`,
      });
    })
    .on('download', () => ({ status: 200, bytes: new Uint8Array([0x49, 0x44, 0x33, 0x04]) }));
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-calls-'));
});
afterEach(async () => {
  await close();
  t.app.close();
  rmSync(root, { recursive: true, force: true });
});

const noLeaks = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain('p.invalid');
  expect(s).not.toContain('+7900');
};

describe('telephony_calls_list: фильтры, ID записи, имена, компактный ответ', () => {
  it('пропущенные входящие за период; без callId; recordFileId и userName в каждом звонке', async () => {
    await start();
    const missed = await call('telephony_calls_list', {
      from: '2026-10-01',
      to: '2026-10-31',
      direction: 'incoming',
      status: 'missed',
    });
    expect(missed.success).toBe(true);
    const ids = (missed.data?.['items'] as { id: number }[]).map((x) => x.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 7]);

    const all = await call('telephony_calls_list', {
      from: '2026-10-01',
      to: '2026-10-31',
      status: 'answered',
      pageSize: 50,
    });
    const items = all.data?.['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(8);
    const two = items.find((x) => x['id'] === 2);
    const three = items.find((x) => x['id'] === 3);
    expect(two).toMatchObject({
      recordFileId: 9001,
      userName: 'Тестов Иван',
      hasRecording: true,
      answered: true,
    });
    expect(three).toMatchObject({ recordFileId: ACTIVITY_FILE(502), hasRecording: true });
    expect(three).not.toHaveProperty('callId');
    expect(three).not.toHaveProperty('category');
    // Файлы дел — одним запросом, а не по запросу на звонок.
    expect(t.bitrix.callsTo('crm.activity.list').length).toBeLessThanOrEqual(2);
    expect(t.bitrix.callsTo('crm.activity.get')).toHaveLength(0);
    noLeaks(all);
  });

  it('длительность, линия, привязка к CRM, последние 4 цифры (номер остаётся скрытым)', async () => {
    await start();
    const env = await call('telephony_calls_list', {
      from: '2026-10-01',
      to: '2026-10-31',
      minDurationSec: 100,
      lineNumber: 'line2',
      crmBound: true,
      pageSize: 50,
    });
    expect((env.data?.['items'] as { id: number }[]).map((x) => x.id).sort((a, b) => a - b)).toEqual([
      9, 11, 12,
    ]);
    const byPhone = await call('telephony_calls_list', {
      from: '2026-10-01',
      to: '2026-10-31',
      phoneLast4: '1004',
    });
    const found = byPhone.data?.['items'] as { id: number; phoneNumber: string }[];
    expect(found.map((x) => x.id)).toEqual([5]);
    expect(found[0]?.phoneNumber).toBe('***1004');
  });

  it('mode=summary: сводка по сотрудникам и линиям одним вызовом', async () => {
    await start();
    const env = await call('telephony_calls_list', { from: '2026-10-01', to: '2026-10-31', mode: 'summary' });
    const s = env.data?.['summary'] as Record<string, unknown>;
    expect(s['all']).toMatchObject({ total: 12, incoming: 6, outgoing: 6, answered: 8, missed: 4 });
    const byUser = s['byUser'] as Record<string, unknown>[];
    expect(byUser).toEqual([
      expect.objectContaining({ userId: 7, userName: 'Тестов Иван', total: 8, answered: 5, missed: 3 }),
      expect.objectContaining({ userId: 9, userName: 'Уволенный Олег', total: 4, answered: 3, missed: 1 }),
    ]);
    expect((s['byLine'] as unknown[]).length).toBe(2);
    expect(s['complete']).toBe(true);
    expect(env.data).not.toHaveProperty('items');
  });
});

describe('calls_recordings_download', () => {
  it('записи сотрудника за период с понятными именами и описью; повтор ничего не скачивает', async () => {
    await start();
    const env = await call('calls_recordings_download', {
      from: '2026-10-01',
      to: '2026-10-31',
      userId: 7,
      minDurationSec: 30,
    });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({ saved: 5, complete: true });
    const dir = env.data?.['path'] as string;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.mp3'))
      .sort();
    expect(files).toHaveLength(5);
    expect(files[0]).toBe('2026-10-01_1105_Тестов Иван_исх_30с_call2.mp3');
    expect(files.some((f) => f.includes('_вх_'))).toBe(true);
    const manifest = readFileSync(path.join(dir, '_список-файлов.csv'), 'utf8');
    expect(manifest).toContain('***1001');
    expect(manifest).not.toContain('+7900');
    noLeaks(env);

    const downloadsBefore = t.bitrix.calls.filter((c) => methodFromUrl(c.url) === 'download').length;
    const again = await call('calls_recordings_download', {
      from: '2026-10-01',
      to: '2026-10-31',
      userId: 7,
      minDurationSec: 30,
    });
    expect(again.data).toMatchObject({ saved: 0, existed: 5, complete: true });
    expect(t.bitrix.calls.filter((c) => methodFromUrl(c.url) === 'download').length).toBe(downloadsBefore);
  });

  it('предел maxFiles — complete=false, продолжение тем же вызовом', async () => {
    await start();
    const first = await call('calls_recordings_download', {
      from: '2026-10-01',
      to: '2026-10-31',
      maxFiles: 3,
    });
    expect(first.data).toMatchObject({ saved: 3, complete: false });
    const second = await call('calls_recordings_download', {
      from: '2026-10-01',
      to: '2026-10-31',
      maxFiles: 50,
    });
    expect(second.data).toMatchObject({ saved: 5, existed: 3, complete: true });
  });
});

describe('call_transcribe', () => {
  it('выключено без TRANSCRIBE_PYTHON', async () => {
    await start();
    const env = await call('call_transcribe', { activityId: 502 });
    expect(env.error?.code).toBe('FEATURE_UNAVAILABLE');
    expect(env.error?.details['reason']).toBe('TRANSCRIBE_NOT_CONFIGURED');
  });

  it('по делу-звонку: скачивает запись, распознаёт с подсказкой слов, сохраняет текст; повтор — из файла', async () => {
    await start({
      TRANSCRIBE_PYTHON: process.execPath,
      TRANSCRIBE_SCRIPT: fakeTranscriber(),
      TRANSCRIBE_HOTWORDS: 'Тестовая фирма, MCP TEST',
    });
    const env = await call('call_transcribe', { activityId: 502, hotwords: 'Ромашка' });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      durationSec: 42.5,
      speakers: 2,
      cached: false,
      crmTarget: { entityType: 'deal', recordId: 33 },
    });
    expect(env.data?.['text']).toBe(
      '[00:00] Собеседник 1: Добрый день, Тестовая фирма, MCP TEST, Ромашка\n[00:04] Собеседник 2: Здравствуйте, нужен договор',
    );
    expect(existsSync(env.data?.['transcriptFile'] as string)).toBe(true);
    noLeaks(env);

    const again = await call('call_transcribe', { file: env.data?.['file'] });
    expect(again.data).toMatchObject({ cached: true, text: env.data?.['text'] });
    const windowsPath = String(env.data?.['file']).replaceAll('/', '\\');
    const legacy = await call('call_transcribe', { file: windowsPath });
    expect(legacy.data).toMatchObject({ cached: true, text: env.data?.['text'] });
  });

  it('file вне папки скачиваний — отказ; ровно один источник', async () => {
    await start({ TRANSCRIBE_PYTHON: process.execPath, TRANSCRIBE_SCRIPT: fakeTranscriber() });
    const env = await call('call_transcribe', { file: '../etc/passwd' });
    expect(env.success).toBe(false);
    const both = await client.callTool({
      name: 'call_transcribe',
      arguments: { activityId: 1, recordFileId: 2 },
    });
    expect(both.isError).toBe(true);
  });
});

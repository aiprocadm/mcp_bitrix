/**
 * disk_file_download и chat_files_download: сохранение файлов портала в DOWNLOAD_DIR (только single).
 * Проверяется: выключено без DOWNLOAD_DIR; байты файла сохраняются как есть; подпапка не выходит за корень
 * («..», символическая ссылка); повтор не перезаписывает и не ходит в портал; предел размера; ошибка одного файла
 * не прерывает пакет; опись CSV; продолжение по nextBeforeMessageId; ссылка скачивания с кодом вебхука не выходит.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
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
  meta: Record<string, unknown> & { warnings?: string[] };
}

const SECRET = 'mocksecret0123456789';
const DL = (id: number) =>
  `https://mock.bitrix24.invalid/rest/7/${SECRET}/download/?token=disk%7C${String(id)}`;
const bytesOf = (s: string) => new TextEncoder().encode(s);
const FILES: Record<number, { NAME: string; SIZE: string; bytes: Uint8Array }> = {
  801: { NAME: 'Договор.docx', SIZE: '11', bytes: bytesOf('docx-bytes!') },
  802: { NAME: 'Таблица.xlsx', SIZE: '4', bytes: bytesOf('xlsx') },
  803: { NAME: 'фото.jpg', SIZE: '3', bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
  804: { NAME: 'запись звонка.mp3', SIZE: '5000', bytes: new Uint8Array(5000) },
};
// 120 сообщений; файлы: 5 → 801+802, 60 → 803, 110 → 804 (больше предела), 115 → 805 (удалён на портале)
const FILE_MSGS: Record<number, number[]> = { 5: [801, 802], 60: [803], 110: [804], 115: [805] };
const MESSAGES = Array.from({ length: 120 }, (_, i) => {
  const id = i + 1;
  return {
    id,
    chat_id: 77,
    author_id: id % 2 ? 7 : 1,
    date: `2026-09-${String(10 + Math.floor(id / 10)).padStart(2, '0')}T10:00:00+03:00`,
    text: `Сообщение ${String(id)}`,
    params: FILE_MSGS[id] ? { FILE_ID: FILE_MSGS[id] } : {},
  };
});

function messagesHandler(c: RecordedCall) {
  const limit = Number(c.body['LIMIT'] ?? 20);
  let msgs = MESSAGES;
  if (c.body['LAST_ID'] !== undefined) msgs = msgs.filter((m) => m.id < Number(c.body['LAST_ID']));
  msgs = msgs.slice(-limit);
  return legacyOk({
    chat_id: 77,
    messages: [...msgs].reverse(),
    users: [
      { id: 7, name: 'Сотрудник Тестовый' },
      { id: 1, name: 'Владелец Тестовый' },
    ],
    files: [801, 802, 803, 804, 805]
      .filter((f) => msgs.some((m) => FILE_MSGS[m.id]?.includes(f)))
      .map((f) => ({
        id: f,
        name: FILES[f]?.NAME ?? 'удалённый.pdf',
        type: 'file',
        size: Number(FILES[f]?.SIZE ?? 10),
        urlDownload: `https://p.invalid/download/${String(f)}`,
      })),
  });
}

let root: string;
let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

async function start(overrides: Record<string, string>) {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  t.bitrix
    .on('disk.file.get', (c) => {
      const id = Number(c.body['id']);
      const f = FILES[id];
      return f
        ? legacyOk({ ID: String(id), NAME: f.NAME, SIZE: f.SIZE, DOWNLOAD_URL: DL(id) })
        : { status: 400, body: { error: 'ERROR_NOT_FOUND', error_description: 'Not found' } };
    })
    .on('download', (c) => {
      const id = Number(new URL(c.url).searchParams.get('token')?.split('|')[1]);
      const f = FILES[id];
      return f ? { status: 200, bytes: f.bytes } : { status: 404 };
    })
    .on('im.dialog.messages.get', messagesHandler);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-dl-'));
});
afterEach(async () => {
  expect(t.bitrix.callsTo('im.dialog.read')).toHaveLength(0);
  await close();
  t.app.close();
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(SECRET);
  expect(s).not.toMatch(/https?:\/\//);
};
const downloads = () => t.bitrix.calls.filter((c) => methodFromUrl(c.url) === 'download').length;

describe('скачивание выключено без DOWNLOAD_DIR', () => {
  it('оба инструмента → FEATURE_UNAVAILABLE до обращения к порталу', async () => {
    await start({});
    for (const [name, args] of [
      ['disk_file_download', { fileId: 801 }],
      ['chat_files_download', { dialogId: '7' }],
    ] as const) {
      const r = await call(name, args);
      expect(r.error?.code).toBe('FEATURE_UNAVAILABLE');
      expect(r.error?.details['reason']).toBe('DOWNLOAD_DIR_NOT_SET');
    }
    expect(t.bitrix.calls).toHaveLength(0);
  });
});

describe('disk_file_download', () => {
  it('байты файла сохраняются как есть; повтор — exists без перезаписи; ссылки и код вебхука не выходят', async () => {
    await start({ DOWNLOAD_DIR: root });
    const r = await call('disk_file_download', { fileId: 803, folder: 'фото/сентябрь' });
    expect(r.data).toMatchObject({ status: 'saved', name: 'фото.jpg', savedAs: '803_фото.jpg', size: 3 });
    const file = String(r.data?.['path']);
    expect(file.startsWith(path.join(root, 'фото', 'сентябрь'))).toBe(true);
    expect([...readFileSync(file)]).toEqual([0xff, 0xd8, 0xff]);
    noSecrets(r);
    const again = await call('disk_file_download', { fileId: 803, folder: 'фото/сентябрь' });
    expect(again.data?.['status']).toBe('exists');
    expect(downloads()).toBe(1);
    expect(readdirSync(path.dirname(file))).toEqual(['803_фото.jpg']);
  });

  it('больше MAX_DOWNLOAD_BYTES → FILE_TOO_LARGE до скачивания; папка «..» и ссылка наружу — отказ', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'mcp-out-'));
    symlinkSync(outside, path.join(root, 'наружу'));
    await start({ DOWNLOAD_DIR: root, MAX_DOWNLOAD_BYTES: '1000' });
    expect((await call('disk_file_download', { fileId: 804 })).error?.code).toBe('FILE_TOO_LARGE');
    for (const folder of ['../x', 'a/../../x', '/etc', '.hidden', 'a/b/c/d', 'наружу']) {
      expect((await call('disk_file_download', { fileId: 801, folder })).error?.code).toBe(
        'VALIDATION_ERROR',
      );
    }
    expect(downloads()).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('несуществующий файл → NOT_FOUND', async () => {
    await start({ DOWNLOAD_DIR: root });
    expect((await call('disk_file_download', { fileId: 805 })).error?.code).toBe('NOT_FOUND');
  });
});

describe('chat_files_download', () => {
  it('все файлы диалога: сохранены, большой и удалённый пропущены с причиной, опись CSV, повтор без скачиваний', async () => {
    await start({ DOWNLOAD_DIR: root, MAX_DOWNLOAD_BYTES: '1000' });
    const r = await call('chat_files_download', { dialogId: '7' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ folder: 'chat-7', saved: 3, skipped: 2, complete: true });
    expect(r.data?.['nextBeforeMessageId']).toBeNull();
    const items = r.data?.['items'] as { fileId: number; status: string; savedAs: string | null }[];
    expect(Object.fromEntries(items.map((i) => [i.fileId, i.status]))).toEqual({
      801: 'saved',
      802: 'saved',
      803: 'saved',
      804: 'too_large',
      805: 'failed',
    });
    const dir = path.join(root, 'chat-7');
    expect(readFileSync(path.join(dir, '2026-09-10_801_Договор.docx'), 'utf8')).toBe('docx-bytes!');
    expect(existsSync(path.join(dir, '2026-09-16_803_фото.jpg'))).toBe(true);
    const csv = readFileSync(path.join(dir, '_список-файлов.csv'), 'utf8');
    expect(csv.startsWith('﻿дата;кто прислал;имя файла')).toBe(true);
    expect(csv).toContain('Сотрудник Тестовый;Договор.docx;2026-09-10_801_Договор.docx');
    expect(csv.trim().split('\r\n')).toHaveLength(4);
    noSecrets(r);
    expect(downloads()).toBe(3);

    const diskCalls = t.bitrix.callsTo('disk.file.get').length;
    const again = await call('chat_files_download', { dialogId: '7' });
    expect(again.data).toMatchObject({ saved: 0, existed: 3, complete: true });
    expect(downloads()).toBe(3);
    // уже скачанные пропущены без disk.file.get: снова спрошены только пропущенные 804 и 805
    expect(t.bitrix.callsTo('disk.file.get').length - diskCalls).toBe(2);
    expect(readFileSync(path.join(dir, '_список-файлов.csv'), 'utf8').trim().split('\r\n')).toHaveLength(4);
  });

  it('maxFiles: частичный ответ и продолжение по nextBeforeMessageId дают все файлы ровно по разу', async () => {
    await start({ DOWNLOAD_DIR: root });
    const first = await call('chat_files_download', { dialogId: '7', maxFiles: 1, folder: 'архив' });
    expect(first.data).toMatchObject({ saved: 1, complete: false });
    expect(first.meta['completeness']).toBe('partial');
    let next = first.data?.['nextBeforeMessageId'] as number | null;
    let total = 1;
    for (let i = 0; i < 10 && next !== null; i++) {
      const r = await call('chat_files_download', {
        dialogId: '7',
        maxFiles: 1,
        folder: 'архив',
        beforeMessageId: next,
      });
      total += Number(r.data?.['saved']);
      next = r.data?.['nextBeforeMessageId'] as number | null;
    }
    expect(next).toBeNull();
    expect(total).toBe(4);
    expect(downloads()).toBe(4);
    expect(readdirSync(path.join(root, 'архив')).filter((f) => !f.startsWith('_'))).toHaveLength(4);
  });
});

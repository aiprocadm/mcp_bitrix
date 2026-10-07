/**
 * disk_file_read и crm_activity_files: скачивание на сервере по DOWNLOAD_URL (в нём код вебхука, как на живом портале),
 * извлечение текста, части по offset; запреты — чужой host, перенаправление, размер; ссылка никогда не выходит наружу.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk, methodFromUrl } from '../helpers/mock-bitrix.js';
import { makeDocx, makePdf } from '../helpers/office-fixtures.js';

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

const SECRET = 'mocksecret0123456789';
const DL = (id: number) =>
  `https://mock.bitrix24.invalid/rest/7/${SECRET}/download/?token=disk%7C${String(id)}`;
const LONG = Array.from({ length: 300 }, (_, i) => `Строка выписки ${String(i)}: оплата 1000 ₽`);
const FILES: Record<number, { NAME: string; SIZE: string; bytes: Uint8Array; url?: string }> = {
  601411: { NAME: 'Акт сверки.docx', SIZE: '0', bytes: makeDocx(['Акт сверки', 'Долг: 0 ₽']) },
  601413: { NAME: 'Счёт.pdf', SIZE: '0', bytes: makePdf('Invoice 15 paid 16320') },
  601420: { NAME: 'Выписка.txt', SIZE: '0', bytes: new TextEncoder().encode(LONG.join('\n')) },
  601430: { NAME: 'фото.jpg', SIZE: '100', bytes: new Uint8Array(100) },
  601440: { NAME: 'big.txt', SIZE: '999999999', bytes: new Uint8Array(1) },
  601450: {
    NAME: 'чужой.txt',
    SIZE: '10',
    bytes: new Uint8Array(10),
    url: 'https://evil.invalid/rest/download/',
  },
};

beforeEach(async () => {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10' });
  t.bitrix
    .on('disk.file.get', (c) => {
      const id = Number(c.body['id']);
      const f = FILES[id];
      return f
        ? legacyOk({ ID: String(id), NAME: f.NAME, SIZE: f.SIZE, DOWNLOAD_URL: f.url ?? DL(id) })
        : { status: 400, body: { error: 'ERROR_NOT_FOUND', error_description: 'Not found' } };
    })
    .on('download', (c) => {
      const id = Number(new URL(c.url).searchParams.get('token')?.split('|')[1]);
      const f = FILES[id];
      return f
        ? { status: 200, bytes: f.bytes, headers: { 'content-type': 'application/octet-stream' } }
        : { status: 404 };
    })
    .on(
      'crm.activity.get',
      legacyOk({
        ID: '321537',
        SUBJECT: 'Прайс и счёт',
        COMMUNICATIONS: [{ VALUE: 'client@example.invalid' }],
        FILES: [
          { id: 601411, url: '/bitrix/tools/crm_show_file.php?fileId=1' },
          { id: 601430, url: '/bitrix/tools/crm_show_file.php?fileId=2' },
        ],
      }),
    );
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

const noSecrets = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(SECRET);
  expect(s).not.toMatch(/https?:\/\//);
  expect(s).not.toContain('crm_show_file');
};

describe('disk_file_read', () => {
  it('docx и pdf: текст, формат, страницы; скачивание — GET без перенаправлений; ссылки и код вебхука не выходят', async () => {
    const d = await call('disk_file_read', { fileId: 601411 });
    expect(d.data).toMatchObject({
      name: 'Акт сверки.docx',
      format: 'docx',
      text: 'Акт сверки\nДолг: 0 ₽',
      truncated: false,
    });
    noSecrets(d);
    const dl = t.bitrix.calls.find((c) => methodFromUrl(c.url) === 'download');
    expect(dl?.method).toBe('GET');
    const p = await call('disk_file_read', { fileId: 601413 });
    expect(p.data).toMatchObject({ format: 'pdf', pages: 1 });
    expect(String(p.data?.['text'])).toContain('Invoice 15 paid 16320');
    noSecrets(p);
  });

  it('длинный текст — частями: nextOffset и продолжение', async () => {
    const first = await call('disk_file_read', { fileId: 601420, maxChars: 500 });
    expect(first.data).toMatchObject({ truncated: true, offset: 0, nextOffset: 500 });
    expect(first.meta['completeness']).toBe('partial');
    const next = await call('disk_file_read', { fileId: 601420, offset: 500, maxChars: 500 });
    expect(String(next.data?.['text'])).toBe(LONG.join('\n').slice(500, 1000));
  });

  it('до скачивания: неподдерживаемый формат и слишком большой файл отклоняются, файл не тянется', async () => {
    expect((await call('disk_file_read', { fileId: 601430 })).error?.details['reason']).toBe(
      'UNSUPPORTED_FILE_TYPE',
    );
    expect((await call('disk_file_read', { fileId: 601440 })).error?.code).toBe('FILE_TOO_LARGE');
    expect(t.bitrix.calls.filter((c) => methodFromUrl(c.url) === 'download')).toHaveLength(0);
  });

  it('адрес скачивания на чужом host — отказ без обращения к нему', async () => {
    const r = await call('disk_file_read', { fileId: 601450 });
    expect(r.error?.code).toBe('CONFIG_INVALID');
    expect(t.bitrix.calls.some((c) => c.url.includes('evil.invalid'))).toBe(false);
  });

  it('перенаправление при скачивании запрещено; фактический размер сверх предела — FILE_TOO_LARGE', async () => {
    t.bitrix.on('download', { status: 302, headers: { location: 'https://evil.invalid/' } });
    const redir = await call('disk_file_read', { fileId: 601420 });
    expect(redir.error?.code).toBe('BITRIX_UPSTREAM_ERROR');
    expect(redir.error?.message).toContain('перенаправ');
    noSecrets(redir);
    t.bitrix.on('download', { status: 200, bytes: new Uint8Array(11 * 1024 * 1024) });
    expect((await call('disk_file_read', { fileId: 601420 })).error?.code).toBe('FILE_TOO_LARGE');
  });
});

describe('crm_activity_files', () => {
  it('вложения дела: ID файла Диска, имя, читается ли; контакты участников и адреса не выдаются', async () => {
    const r = await call('crm_activity_files', { activityId: 321537 });
    expect(r.data).toMatchObject({
      subject: 'Прайс и счёт',
      items: [
        { fileId: 601411, name: 'Акт сверки.docx', readable: true },
        { fileId: 601430, name: 'фото.jpg', readable: false },
      ],
    });
    noSecrets(r);
    expect(JSON.stringify(r)).not.toContain('client@example');
  });
});

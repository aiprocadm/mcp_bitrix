/** Файлы (ТЗ §8.5): T25 (traversal/symlink/.env), T26 (подмена после staging), T27 (base64/размер/сканер). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileScanner, ScanVerdict } from '../../src/files/scanner.js';
import { FileStaging } from '../../src/files/staging.js';
import { detectMime, sanitizeFileName } from '../../src/files/validation.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { Database } from '../../src/storage/database.js';
import { SqliteSqlDb } from '../../src/storage/sqlite-db.js';

let root: string;
let staging: FileStaging;
let db: Database;

function fakeScanner(verdict: ScanVerdict | Error): FileScanner {
  return {
    name: 'fake',
    scan: () => (verdict instanceof Error ? Promise.reject(verdict) : Promise.resolve(verdict)),
    ping: () => Promise.resolve(),
  };
}

function make(
  opts: Partial<{
    scanRequired: boolean;
    scanner: FileScanner;
    maxUploadBytes: number;
    maxInlineFileBytes: number;
    ttlSeconds: number;
  }> = {},
) {
  db = Database.open(':memory:');
  staging = new FileStaging(
    new SqliteSqlDb(db),
    {
      uploadRoot: path.join(root, 'inbox'),
      stagingDir: path.join(root, 'staging'),
      maxUploadBytes: opts.maxUploadBytes ?? 10 * 1024 * 1024,
      maxInlineFileBytes: opts.maxInlineFileBytes ?? 256 * 1024,
      ttlSeconds: opts.ttlSeconds ?? 3600,
      scanRequired: opts.scanRequired ?? false,
      scanner: opts.scanner,
    },
    createSilentLogger(),
    'local',
  );
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const manifests = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_manifests')?.n;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-files-'));
  mkdirSync(path.join(root, 'inbox'), { recursive: true });
  mkdirSync(path.join(root, 'outside'), { recursive: true });
  writeFileSync(path.join(root, 'inbox', 'mcp-test.txt'), 'привет, Bitrix\n');
  writeFileSync(
    path.join(root, 'outside', '.env'),
    'BITRIX_WEBHOOK_BASE_URL=https://x.invalid/rest/1/secret/\n',
  );
  writeFileSync(path.join(root, 'outside', 'secret.txt'), 'secret');
  make();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('staging файлов', () => {
  it('файл из UPLOAD_ROOT → манифест с sha256, копия в staging, путь модели не отдаётся', async () => {
    const m = await staging.stageFromPath(path.join(root, 'inbox', 'mcp-test.txt'), 'owner');
    expect(m.originalName).toBe('mcp-test.txt');
    expect(m.mime).toBe('text/plain');
    expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.scanStatus).toBe('skipped');
    expect(m.stagingPath.startsWith(path.join(root, 'staging'))).toBe(true);
    const resolved = await staging.resolve(m.token, 'owner');
    expect(resolved.sha256).toBe(m.sha256);
    expect(staging.readVerified(resolved).toString()).toBe('привет, Bitrix\n');
    expect(await staging.listOwn('owner')).toHaveLength(1);
    expect((await staging.listOwn('owner'))[0]).not.toHaveProperty('stagingPath');
  });

  it('T25: traversal, файл вне root, симлинк, .env, относительный путь — отказ без чтения секрета', async () => {
    const inbox = path.join(root, 'inbox');
    await expect(
      staging.stageFromPath(path.join(inbox, '..', 'outside', 'secret.txt'), 'owner'),
    ).rejects.toThrow(/UPLOAD_ROOT/);
    await expect(staging.stageFromPath(path.join(root, 'outside', '.env'), 'owner')).rejects.toThrow(
      /UPLOAD_ROOT/,
    );
    symlinkSync(path.join(root, 'outside', 'secret.txt'), path.join(inbox, 'link.txt'));
    await expect(staging.stageFromPath(path.join(inbox, 'link.txt'), 'owner')).rejects.toThrow(
      /UPLOAD_ROOT|ссылки/,
    );
    symlinkSync(path.join(inbox, 'mcp-test.txt'), path.join(inbox, 'inner-link.txt'));
    await expect(staging.stageFromPath(path.join(inbox, 'inner-link.txt'), 'owner')).rejects.toThrow(
      /ссылки/,
    );
    writeFileSync(path.join(inbox, '.env'), 'X=1');
    await expect(staging.stageFromPath(path.join(inbox, '.env'), 'owner')).rejects.toThrow(
      /запрещены|allowlist/,
    );
    await expect(staging.stageFromPath('inbox/mcp-test.txt', 'owner')).rejects.toThrow(/абсолютный/);
    expect(manifests()).toBe(0);
  });

  it('T26: подмена staged-файла после подготовки → хеш не совпал, загрузка отменена', async () => {
    const m = await staging.stageFromPath(path.join(root, 'inbox', 'mcp-test.txt'), 'owner');
    writeFileSync(m.stagingPath, 'подменённый текст\n');
    const resolved = await staging.resolve(m.token, 'owner');
    expect(() => staging.readVerified(resolved)).toThrow(/изменилось/);
  });

  it('T27: невалидный base64, превышение размера — понятные ошибки, без мусора в staging', async () => {
    await expect(staging.stageInline('%%%not-base64%%%', 'a.txt', 'owner')).rejects.toThrow(/base64/);
    make({ maxInlineFileBytes: 10 });
    await expect(
      staging.stageInline(b64('очень длинный текст, больше десяти байт'), 'a.txt', 'owner'),
    ).rejects.toThrow(/превышает/);
    expect(manifests()).toBe(0);
  });

  it('T27: сканер обязателен — не настроен / недоступен → блокировка без сохранения; infected → отказ; clean → сохранён', async () => {
    make({ scanRequired: true });
    await expect(staging.stageInline(b64('ok'), 'a.txt', 'owner')).rejects.toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
    });
    make({ scanRequired: true, scanner: fakeScanner(new Error('ECONNREFUSED')) });
    await expect(staging.stageInline(b64('ok'), 'a.txt', 'owner')).rejects.toThrow(/недоступен/);
    make({
      scanRequired: true,
      scanner: fakeScanner({ status: 'infected', signature: 'Eicar-Test-Signature' }),
    });
    await expect(staging.stageUpload(Buffer.from('X5O!'), 'eicar.txt', 'owner')).rejects.toThrow(
      /Eicar-Test-Signature/,
    );
    expect(manifests()).toBe(0);
    expect(await staging.listOwn('owner')).toEqual([]);
    make({ scanRequired: true, scanner: fakeScanner({ status: 'clean' }) });
    const m = await staging.stageUpload(Buffer.from('чистый файл'), 'clean.txt', 'owner');
    expect(m.scanStatus).toBe('clean');
    expect(staging.readVerified(await staging.resolve(m.token, 'owner')).toString()).toBe('чистый файл');
    // Манифест «skipped» при обязательном сканере не отправляется (защита от смены конфигурации после staging)
    expect(() => staging.readVerified({ ...m, scanStatus: 'skipped' })).toThrow(/антивирусную/);
  });

  it('web-upload: пустой файл и чужое расширение — отказ', async () => {
    await expect(staging.stageUpload(Buffer.alloc(0), 'a.txt', 'owner')).rejects.toThrow(/Пустой/);
    await expect(staging.stageUpload(Buffer.from('MZ'), 'a.exe', 'owner')).rejects.toThrow(/allowlist/);
  });

  it('чужой principal и истёкший TTL не видят токен', async () => {
    const m = await staging.stageInline(b64('ok'), 'note.md', 'owner');
    await expect(staging.resolve(m.token, 'intruder')).rejects.toThrow(/не найден/);
    expect(await staging.listOwn('intruder')).toEqual([]);
    make({ ttlSeconds: -1 });
    const m2 = await staging.stageInline(b64('ok'), 'note.md', 'owner');
    await expect(staging.resolve(m2.token, 'owner')).rejects.toThrow(/не найден/);
    expect(await staging.cleanupExpired()).toBe(0);
  });
});

describe('валидация содержимого', () => {
  it('сигнатура должна соответствовать расширению; текст без NUL и валидный UTF-8', () => {
    expect(detectMime(Buffer.from('%PDF-1.7 ...'), 'pdf')).toBe('application/pdf');
    expect(() => detectMime(Buffer.from('not a pdf'), 'pdf')).toThrow(/не соответствует/);
    expect(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'png')).toBe(
      'image/png',
    );
    expect(() => detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'png')).toThrow(/не соответствует/);
    expect(detectMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'docx')).toContain('wordprocessingml');
    expect(() => detectMime(Buffer.from([0x4d, 0x5a, 0x90]), 'xlsx')).toThrow(/не соответствует/);
    expect(() => detectMime(Buffer.from([0x41, 0x00, 0x42]), 'txt')).toThrow(/не соответствует/);
    expect(() => detectMime(Buffer.from([0xff, 0xfe, 0xfd]), 'csv')).toThrow(/не соответствует/);
  });

  it('имена: запрещены ключи/конфиги/хранилища, управляющие символы вычищаются', () => {
    expect(sanitizeFileName('/tmp/x/отчёт.pdf')).toBe('отчёт.pdf');
    expect(sanitizeFileName('a\u0000b.txt')).toBe('ab.txt');
    for (const bad of ['.env', '.env.local', 'master.key', 'id.pem', 'mcp.sqlite', 'token.txt', '..']) {
      expect(() => sanitizeFileName(bad)).toThrow();
    }
  });
});

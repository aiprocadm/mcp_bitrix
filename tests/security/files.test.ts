/** Файлы (ТЗ §8.5): T25 (traversal/symlink/.env), T26 (подмена после staging), T27 (base64/размер/сканер). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStaging } from '../../src/files/staging.js';
import { detectMime, sanitizeFileName } from '../../src/files/validation.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { Database } from '../../src/storage/database.js';

let root: string;
let staging: FileStaging;
let db: Database;

function make(
  opts: Partial<{
    scanRequired: boolean;
    maxUploadBytes: number;
    maxInlineFileBytes: number;
    ttlSeconds: number;
  }> = {},
) {
  db = Database.open(':memory:');
  staging = new FileStaging(
    db,
    {
      uploadRoot: path.join(root, 'inbox'),
      stagingDir: path.join(root, 'staging'),
      maxUploadBytes: opts.maxUploadBytes ?? 10 * 1024 * 1024,
      maxInlineFileBytes: opts.maxInlineFileBytes ?? 256 * 1024,
      ttlSeconds: opts.ttlSeconds ?? 3600,
      scanRequired: opts.scanRequired ?? false,
    },
    createSilentLogger(),
  );
}

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
  it('файл из UPLOAD_ROOT → манифест с sha256, копия в staging, путь модели не отдаётся', () => {
    const m = staging.stageFromPath(path.join(root, 'inbox', 'mcp-test.txt'), 'owner');
    expect(m.originalName).toBe('mcp-test.txt');
    expect(m.mime).toBe('text/plain');
    expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.stagingPath.startsWith(path.join(root, 'staging'))).toBe(true);
    const resolved = staging.resolve(m.token, 'owner');
    expect(resolved.sha256).toBe(m.sha256);
    expect(staging.readVerified(resolved).toString()).toBe('привет, Bitrix\n');
  });

  it('T25: traversal, файл вне root, симлинк, .env, относительный путь — отказ без чтения секрета', () => {
    const inbox = path.join(root, 'inbox');
    expect(() => staging.stageFromPath(path.join(inbox, '..', 'outside', 'secret.txt'), 'owner')).toThrow(
      /UPLOAD_ROOT/,
    );
    expect(() => staging.stageFromPath(path.join(root, 'outside', '.env'), 'owner')).toThrow(/UPLOAD_ROOT/);
    symlinkSync(path.join(root, 'outside', 'secret.txt'), path.join(inbox, 'link.txt'));
    expect(() => staging.stageFromPath(path.join(inbox, 'link.txt'), 'owner')).toThrow(/UPLOAD_ROOT|ссылки/);
    symlinkSync(path.join(inbox, 'mcp-test.txt'), path.join(inbox, 'inner-link.txt'));
    expect(() => staging.stageFromPath(path.join(inbox, 'inner-link.txt'), 'owner')).toThrow(/ссылки/);
    writeFileSync(path.join(inbox, '.env'), 'X=1');
    expect(() => staging.stageFromPath(path.join(inbox, '.env'), 'owner')).toThrow(/запрещены|allowlist/);
    expect(() => staging.stageFromPath('inbox/mcp-test.txt', 'owner')).toThrow(/абсолютный/);
    expect(db.get('SELECT COUNT(*) AS n FROM file_manifests')).toEqual({ n: 0 });
  });

  it('T26: подмена staged-файла после подготовки → хеш не совпал, загрузка отменена', () => {
    const m = staging.stageFromPath(path.join(root, 'inbox', 'mcp-test.txt'), 'owner');
    writeFileSync(m.stagingPath, 'подменённый текст\n');
    expect(() => staging.readVerified(staging.resolve(m.token, 'owner'))).toThrow(/изменилось/);
  });

  it('T27: невалидный base64, превышение размера, сканер недоступен — понятные ошибки, без мусора в staging', () => {
    expect(() => staging.stageInline('%%%not-base64%%%', 'a.txt', 'owner')).toThrow(/base64/);
    make({ maxInlineFileBytes: 10 });
    expect(() =>
      staging.stageInline(
        Buffer.from('очень длинный текст, больше десяти байт').toString('base64'),
        'a.txt',
        'owner',
      ),
    ).toThrow(/превышает/);
    make({ scanRequired: true });
    expect(() => staging.stageInline(Buffer.from('ok').toString('base64'), 'a.txt', 'owner')).toThrow(
      /сканер/,
    );
    expect(db.get('SELECT COUNT(*) AS n FROM file_manifests')).toEqual({ n: 0 });
  });

  it('чужой principal и истёкший TTL не видят токен', () => {
    const m = staging.stageInline(Buffer.from('ok').toString('base64'), 'note.md', 'owner');
    expect(() => staging.resolve(m.token, 'intruder')).toThrow(/не найден/);
    make({ ttlSeconds: -1 });
    const m2 = staging.stageInline(Buffer.from('ok').toString('base64'), 'note.md', 'owner');
    expect(() => staging.resolve(m2.token, 'owner')).toThrow(/не найден/);
    expect(staging.cleanupExpired()).toBe(0);
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

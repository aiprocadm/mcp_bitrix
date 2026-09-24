/** T45: восстановление зашифрованной копии — читаемое состояние с ключом, pending approvals не исполняются. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { createBackup, restoreBackup } from '../../src/ops/backup.js';
import { Database } from '../../src/storage/database.js';
import { OperationsStore } from '../../src/storage/operations.js';
import { testConfig } from '../helpers/app.js';

let root: string;
const KEY = Buffer.alloc(32, 9);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-backup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function configIn(dir: string) {
  mkdirSync(path.join(dir, 'policies'), { recursive: true });
  writeFileSync(path.join(dir, 'policies', 'methods.json'), '{"version":"t","rawAllowlist":[]}');
  return testConfig({
    DATA_DIR: dir,
    DATABASE_URL: `file:${path.join(dir, 'mcp.sqlite')}`,
    METHOD_POLICY_FILE: path.join(dir, 'policies', 'methods.json'),
    ACCESS_POLICY_FILE: path.join(dir, 'policies', 'nope.json'),
    OUTPUT_POLICY_FILE: path.join(dir, 'policies', 'nope2.json'),
  });
}

describe('backup / restore (§17.7, T45)', () => {
  it('снимок SQLite + политики шифруются; восстановление в новую папку читаемо, pending операции посчитаны и не исполнены', () => {
    const config = configIn(root);
    const db = Database.open(config.storage.databasePath);
    const ops = new OperationsStore(db);
    ops.createPrepared({
      id: '11111111-1111-4111-8111-111111111111',
      principalId: 'owner',
      portalKey: 'k',
      tool: 'crm_create_record',
      operationKind: 'create',
      argsHash: 'h',
      target: 'crm.deal',
      expectedStateHash: null,
      fileHash: null,
      policyVersion: 'v',
      planEncrypted: 'v1:x:y:z',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    db.close();

    const out = path.join(root, 'backups', 'b.enc');
    const s = createBackup(config, KEY, out);
    expect(s.policies).toEqual(['methods.json']);
    expect(s.sqliteBytes).toBeGreaterThan(0);
    const raw = readFileSync(out, 'utf8');
    expect(raw.startsWith('bitrix24-mcp-backup/1\n')).toBe(true);
    expect(raw).not.toContain('crm_create_record');
    expect(raw).not.toContain('rawAllowlist');

    const r = restoreBackup(KEY, out, path.join(root, 'restored'));
    expect(r.policies).toEqual(['methods.json']);
    expect(r.pendingOperations).toEqual({ prepared: 1 });
    expect(readFileSync(path.join(r.dir, 'policies', 'methods.json'), 'utf8')).toContain('rawAllowlist');
    const restored = Database.open(r.sqliteFile);
    expect(new OperationsStore(restored).countByStatus()).toEqual({ prepared: 1 });
    restored.close();
  });

  it('чужой ключ, повреждённый файл и существующая папка — отказ', () => {
    const config = configIn(root);
    Database.open(config.storage.databasePath).close();
    const out = path.join(root, 'b.enc');
    createBackup(config, KEY, out);
    expect(() => restoreBackup(Buffer.alloc(32, 1), out, path.join(root, 'r1'))).toThrow(AppError);
    writeFileSync(path.join(root, 'junk.enc'), 'nope\nnope\n');
    expect(() => restoreBackup(KEY, path.join(root, 'junk.enc'), path.join(root, 'r2'))).toThrow(
      /не файл резервной копии/,
    );
    mkdirSync(path.join(root, 'exists'));
    expect(() => restoreBackup(KEY, out, path.join(root, 'exists'))).toThrow(/уже существует/);
    expect(() => createBackup(config, KEY, out)).toThrow(); // wx: поверх существующей копии не пишем
  });

  it('без базы копия не создаётся', () => {
    const config = configIn(root);
    expect(() => createBackup(config, KEY, path.join(root, 'b.enc'))).toThrow(AppError);
  });
});

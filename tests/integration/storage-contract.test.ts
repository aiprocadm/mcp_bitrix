/**
 * SaaS-ТЗ S2: контракт хранилищ одинаков для SQLite (single) и PostgreSQL (saas) + S02 (RLS).
 * PostgreSQL — настоящий (временный кластер или TEST_POSTGRES_ADMIN_URL); без него PG-часть помечается skip.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindingHash, CursorStore } from '../../src/bitrix/pagination.js';
import { AppError } from '../../src/errors/app-error.js';
import { FileStaging } from '../../src/files/staging.js';
import { AuditLog } from '../../src/logging/audit.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { SecretBox } from '../../src/security/crypto.js';
import { Database } from '../../src/storage/database.js';
import { OperationsStore } from '../../src/storage/operations.js';
import { PostgresSqlDb } from '../../src/storage/postgres-db.js';
import type { SqlDb } from '../../src/storage/sql.js';
import { SqliteSqlDb } from '../../src/storage/sqlite-db.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

let pgServer: TestPostgres | undefined;
let pgDb: PostgresSqlDb | undefined;
let sqliteDb: SqliteSqlDb;
const root = mkdtempSync(path.join(tmpdir(), 'mcp-contract-'));

beforeAll(async () => {
  sqliteDb = new SqliteSqlDb(Database.open(':memory:'));
  pgServer = await startTestPostgres();
  if (pgServer) pgDb = await PostgresSqlDb.open({ connectionString: pgServer.url });
}, 60_000);
afterAll(async () => {
  await sqliteDb.close();
  await pgDb?.close();
  await pgServer?.stop();
  rmSync(root, { recursive: true, force: true });
});

const box = new SecretBox(Buffer.alloc(32, 5));
const newOp = (id: string) => ({
  id,
  principalId: 'user-1',
  portalKey: 'pk',
  tool: 'crm_create_record',
  operationKind: 'create',
  argsHash: 'h'.repeat(64),
  target: 'crm.deal',
  expectedStateHash: null,
  fileHash: null,
  policyVersion: 'v1',
  planEncrypted: 'enc',
  idempotencyKey: randomUUID(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});

function contract(name: string, getDb: () => SqlDb) {
  describe(`контракт хранилищ: ${name}`, () => {
    it('операции: жизненный цикл, атомарное расходование подтверждения, изоляция арендатора', async () => {
      const t = `t-${randomUUID().slice(0, 8)}`;
      const ops = new OperationsStore(getDb(), t);
      const other = new OperationsStore(getDb(), `${t}-b`);
      const id = randomUUID();
      await ops.createPrepared(newOp(id));
      expect((await ops.get(id))?.attempts).toBe(0);
      expect(await other.get(id)).toBeUndefined();
      expect(await ops.getOwn(id, 'someone-else', 'pk')).toBeUndefined();
      expect(await other.approve(id)).toBe('not-prepared');
      expect(await ops.approve(id)).toBe('approved');
      const [first, second] = await Promise.all([ops.tryStartExecuting(id), ops.tryStartExecuting(id)]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      await ops.finish(id, 'succeeded', { resultEncrypted: 'r' });
      expect(await ops.countByStatus()).toEqual({ succeeded: 1 });
      expect(await other.countByStatus()).toEqual({});
      expect((await ops.get(id))?.attempts).toBe(1);
    });

    it('idempotency: upsert по ключу арендатора, чужой арендатор не видит', async () => {
      const t = `t-${randomUUID().slice(0, 8)}`;
      const ops = new OperationsStore(getDb(), t);
      const row = {
        principal_id: 'u',
        portal_key: 'pk',
        tool: 'x',
        idempotency_key: 'k1',
        args_hash: 'a1',
        operation_id: 'o1',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      await ops.upsertIdempotency(row);
      await ops.upsertIdempotency({ ...row, args_hash: 'a2', operation_id: 'o2' });
      expect(await ops.findIdempotency('u', 'pk', 'x', 'k1')).toMatchObject({
        args_hash: 'a2',
        operation_id: 'o2',
      });
      expect(
        await new OperationsStore(getDb(), `${t}-b`).findIdempotency('u', 'pk', 'x', 'k1'),
      ).toBeUndefined();
      // Тот же ключ у другого арендатора — своя строка
      await new OperationsStore(getDb(), `${t}-b`).upsertIdempotency({ ...row, operation_id: 'ob' });
      expect((await ops.findIdempotency('u', 'pk', 'x', 'k1'))?.operation_id).toBe('o2');
    });

    it('курсоры: peek/discard, одноразовость, чужой арендатор и истёкший — недействителен', async () => {
      const t = `t-${randomUUID().slice(0, 8)}`;
      const binding = { principalId: 'u', portalKey: 'pk', tool: 'x', bindingHash: bindingHash({ a: 1 }) };
      const store = new CursorStore(getDb(), box, 600, t);
      const id = await store.create(binding, { start: 50, buffer: [1, 2] });
      await expect(new CursorStore(getDb(), box, 600, `${t}-b`).peek(id, binding)).rejects.toThrow(AppError);
      expect(await store.peek(id, binding)).toEqual({ start: 50, buffer: [1, 2] });
      expect(await store.consume(id, binding)).toEqual({ start: 50, buffer: [1, 2] });
      await expect(store.peek(id, binding)).rejects.toThrow(/недействителен/);
      const expired = new CursorStore(getDb(), box, -1, t);
      const old = await expired.create(binding, {});
      await expect(expired.peek(old, binding)).rejects.toThrow(/недействителен/);
    });

    it('аудит с арендатором и манифесты файлов по арендатору', async () => {
      const t = `t-${randomUUID().slice(0, 8)}`;
      const audit = new AuditLog(getDb(), Buffer.alloc(32, 1), createSilentLogger(), true, 90);
      await audit.assertAvailableForWrite();
      await audit.record({
        tenantId: t,
        requestId: 'r',
        principalId: 'u',
        portalKey: 'pk',
        operationKind: 'read',
        outcome: 'success',
      });
      const rows = await getDb().withTenant(t, (x) =>
        x.all<{ tenant_id: string }>('SELECT tenant_id FROM audit WHERE tenant_id = ?', t),
      );
      expect(rows).toHaveLength(1);

      const staging = new FileStaging(
        getDb(),
        {
          uploadRoot: path.join(root, `${name}-inbox`),
          stagingDir: path.join(root, `${name}-staging`),
          maxUploadBytes: 1024 * 1024,
          maxInlineFileBytes: 64 * 1024,
          ttlSeconds: 3600,
          scanRequired: false,
          scanner: undefined,
        },
        createSilentLogger(),
        t,
      );
      const m = await staging.stageInline(Buffer.from('data').toString('base64'), 'a.txt', 'u');
      expect((await staging.resolve(m.token, 'u')).size).toBe(4);
      await expect(staging.forTenant(`${t}-b`).resolve(m.token, 'u')).rejects.toThrow(/не найден/);
    });
  });
}

contract('SQLite', () => sqliteDb);

describe.skipIf(!process.env['TEST_POSTGRES_ADMIN_URL'] && !existsPgBinaries())('PostgreSQL', () => {
  contract('PostgreSQL', () => {
    if (!pgDb) throw new Error('PostgreSQL не запущен');
    return pgDb;
  });

  it('S02: RLS — без app.tenant_id и с чужим арендатором строк нет, даже если код забыл фильтр; запись в чужой tenant_id отклоняется', async () => {
    if (!pgDb || !pgServer) throw new Error('PostgreSQL не запущен');
    const t = `t-${randomUUID().slice(0, 8)}`;
    await new OperationsStore(pgDb, t).createPrepared(newOp(randomUUID()));
    // Прямой запрос ролью сервиса без контекста арендатора: RLS скрывает всё
    expect(Number((await pgDb.get<{ n: string }>('SELECT COUNT(*) AS n FROM operations'))?.n)).toBe(0);
    // Контекст другого арендатора, запрос без фильтра tenant_id
    const foreign = await pgDb.withTenant(`${t}-b`, (x) => x.all('SELECT id FROM operations'));
    expect(foreign).toHaveLength(0);
    const own = await pgDb.withTenant(t, (x) => x.all('SELECT id FROM operations'));
    expect(own).toHaveLength(1);
    // WITH CHECK: вставка строки с чужим tenant_id в своём контексте
    await expect(
      pgDb.withTenant(t, (x) =>
        x.run(
          "INSERT INTO cursors (id, tenant_id, principal_id, portal_key, tool, binding_hash, state_json, created_at, expires_at) VALUES ('c1', 'intruder', 'u', 'pk', 'x', 'h', '{}', 'now', 'later')",
        ),
      ),
    ).rejects.toThrow(AppError);
    // Суперпользователь (обходит RLS) — сервис отказывается стартовать
    await expect(PostgresSqlDb.open({ connectionString: pgServer.adminUrl })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    // Контроль: под суперпользователем строка действительно есть (RLS, а не пустая таблица)
    const admin = new pg.Client({ connectionString: pgServer.adminUrl });
    await admin.connect();
    const n = await admin.query<{ n: string }>('SELECT COUNT(*) AS n FROM operations WHERE tenant_id = $1', [
      t,
    ]);
    await admin.end();
    expect(Number(n.rows[0]?.n)).toBe(1);
  });
});

function existsPgBinaries(): boolean {
  return existsSync('/usr/lib/postgresql');
}

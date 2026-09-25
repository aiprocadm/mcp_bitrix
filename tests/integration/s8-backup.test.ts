/**
 * S8 (§13, Б-T45 для кластера): скрипты deploy/saas на НАСТОЯЩЕМ PostgreSQL — инициализация ролей (без SUPERUSER/
 * BYPASSRLS у сервиса), шифрованный pg_dump ролью бэкапа, проверка восстановления во временную базу со сверкой строк.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantKeyRing } from '../../src/saas/keyring.js';
import { TenantsRepo, TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import { PostgresSqlDb } from '../../src/storage/postgres-db.js';
import { MOCK_ENV } from '../helpers/app.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';
import { PG_AVAILABLE } from '../helpers/saas.js';

const ROOT = path.resolve(MOCK_ENV, '..', '..', '..');
const DEPLOY = path.join(ROOT, 'deploy', 'saas');
const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const TOOLS = PG_AVAILABLE && has('pg_dump') && has('pg_restore') && has('psql') && has('openssl');
const AGE = has('age') && has('age-keygen');

describe.skipIf(!TOOLS)('S8: бэкап и проверка восстановления PostgreSQL (скрипты deploy/saas)', () => {
  let server: TestPostgres;
  let dir: string;
  let base: Record<string, string>;
  let appUrl: string;
  const suffix = randomBytes(3).toString('hex');
  const appRole = `mcp_app_${suffix}`;
  const backupRole = `mcp_backup_${suffix}`;
  const dbName = `mcp_${suffix}`;
  const domain = `secret-portal-${suffix}.bitrix24.ru`;
  let tenantCount = 0;

  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync('bash', [path.join(DEPLOY, script), ...args], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...base, ...env },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    const s = await startTestPostgres();
    if (!s) throw new Error('PostgreSQL недоступен');
    server = s;
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-s8-backup-'));
    const admin = new URL(server.adminUrl);
    base = {
      PGHOST: admin.hostname,
      PGPORT: admin.port || '5432',
      ...(admin.password ? { PGPASSWORD: decodeURIComponent(admin.password) } : {}),
    };
    const appPw = randomBytes(12).toString('hex');
    writeFileSync(path.join(dir, 'app_pw'), `${appPw}\n`, { mode: 0o600 });
    writeFileSync(path.join(dir, 'backup_pw'), randomBytes(12).toString('hex'), { mode: 0o600 });
    const init = spawnSync('sh', [path.join(DEPLOY, 'postgres-init', '10-roles.sh')], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        ...base,
        POSTGRES_USER: decodeURIComponent(admin.username),
        MCP_APP_ROLE: appRole,
        MCP_BACKUP_ROLE: backupRole,
        MCP_DB_NAME: dbName,
        PG_APP_PASSWORD_FILE: path.join(dir, 'app_pw'),
        PG_BACKUP_PASSWORD_FILE: path.join(dir, 'backup_pw'),
      },
      encoding: 'utf8',
    });
    expect(init.status, init.stderr).toBe(0);
    // Пароли не должны попадать в аргументы процессов — и в вывод скрипта
    expect(init.stdout + init.stderr).not.toContain(appPw);

    const u = new URL(admin.toString());
    u.username = appRole;
    u.password = appPw;
    u.pathname = `/${dbName}`;
    appUrl = u.toString();
    // Сервис стартует под ролью из init-скрипта: assertRlsEnforced пропускает её (нет SUPERUSER/BYPASSRLS)
    const db = await PostgresSqlDb.open({ connectionString: appUrl });
    const keys = new TenantKeyRing(Buffer.alloc(32, 7));
    const tenants = new TenantsRepo(db, keys);
    const users = new TenantUsersRepo(db);
    for (let i = 0; i < 3; i++) {
      const t = (
        await tenants.upsertInstalled({
          memberId: `m-${randomUUID()}`,
          domain: `${String(i)}${domain}`,
          appTokenHash: 'h',
        })
      ).tenant;
      tenantCount += 1;
      await users.upsertFromBitrix({
        tenantId: t.id,
        bitrixUserId: 1,
        displayName: `Сотрудник ${suffix}`,
        email: null,
        defaultRole: 'operator',
      });
    }
    await db.close();
  }, 60_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await server.stop();
  });

  const backupEnv = (extra: Record<string, string>) => ({
    PGUSER: backupRole,
    PGDATABASE: dbName,
    BACKUP_DIR: path.join(dir, 'backups'),
    ...extra,
  });

  it('роль сервиса не может выгрузить таблицы под FORCE RLS — поэтому отдельная роль бэкапа', () => {
    const r = spawnSync(
      'pg_dump',
      ['--format=custom', '-t', 'tenant_users', '-f', path.join(dir, 'x.dump')],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          ...base,
          PGUSER: appRole,
          PGDATABASE: dbName,
          PGPASSWORD: readFileSync(path.join(dir, 'app_pw'), 'utf8').trim(),
        },
        encoding: 'utf8',
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/row-level security/i);
  });

  it.skipIf(!AGE)(
    'age: копия зашифрована публичным ключом, восстанавливается и сверяется во временной базе',
    () => {
      const keygen = spawnSync('age-keygen', ['-o', path.join(dir, 'identity.txt')], { encoding: 'utf8' });
      expect(keygen.status).toBe(0);
      const pub = spawnSync('age-keygen', ['-y', path.join(dir, 'identity.txt')], {
        encoding: 'utf8',
      }).stdout.trim();
      expect(pub).toMatch(/^age1[0-9a-z]+$/);
      writeFileSync(path.join(dir, 'recipients.txt'), `${pub}\n`);
      const kekDir = path.join(dir, 'kek');
      mkdirSync(kekDir);
      writeFileSync(path.join(kekDir, 'kek'), randomBytes(32), { mode: 0o600 });

      const b = run(
        'pg-backup.sh',
        [],
        backupEnv({
          BACKUP_ENCRYPTION: 'age',
          BACKUP_AGE_RECIPIENTS_FILE: path.join(dir, 'recipients.txt'),
          KEK_FILE: path.join(kekDir, 'kek'),
        }),
      );
      expect(b.status, b.stderr).toBe(0);
      const files = readdirSync(path.join(dir, 'backups'));
      const dump = files.find((f) => f.endsWith('.dump.age'));
      expect(dump).toBeTruthy();
      expect(files).toContain(`${dump ?? ''}.sha256`);
      const dumpPath = path.join(dir, 'backups', dump ?? '');
      const raw = readFileSync(dumpPath);
      expect(raw.includes(Buffer.from(domain))).toBe(false); // данные не в открытом виде
      expect(raw.includes(readFileSync(path.join(kekDir, 'kek')))).toBe(false);
      const counts = readFileSync(dumpPath.replace(/\.dump\.age$/, '.counts'), 'utf8');
      expect(counts).toMatch(new RegExp(`^tenants ${String(tenantCount)}$`, 'm'));
      expect(counts).toMatch(/^tenant_users 3$/m);

      const r = run('pg-restore-check.sh', [dumpPath], {
        PGUSER: decodeURIComponent(new URL(server.adminUrl).username),
        BACKUP_AGE_IDENTITY_FILE: path.join(dir, 'identity.txt'),
        RESTORE_CHECK_STRICT: '1',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/tenant_users: 3/);
      expect(r.stdout).toMatch(/восстановление проверено/);
      expect(r.stdout + r.stderr).not.toContain(domain);

      // порча файла обнаруживается до восстановления
      const broken = path.join(dir, 'backups', `broken-${dump ?? ''}`);
      const bytes = Buffer.from(raw);
      bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
      writeFileSync(broken, bytes);
      writeFileSync(
        `${broken}.sha256`,
        readFileSync(`${dumpPath}.sha256`, 'utf8').replace(dump ?? '', `broken-${dump ?? ''}`),
      );
      const bad = run('pg-restore-check.sh', [broken], {
        PGUSER: decodeURIComponent(new URL(server.adminUrl).username),
        BACKUP_AGE_IDENTITY_FILE: path.join(dir, 'identity.txt'),
      });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toMatch(/контрольная сумма/);
    },
  );

  it('openssl: копия с паролем из файла восстанавливается; KEK внутри каталога копий — отказ', () => {
    writeFileSync(path.join(dir, 'passphrase'), randomBytes(24).toString('hex'), { mode: 0o600 });
    const outDir = path.join(dir, 'backups-openssl');
    const b = run('pg-backup.sh', [], {
      ...backupEnv({ BACKUP_ENCRYPTION: 'openssl', BACKUP_PASSPHRASE_FILE: path.join(dir, 'passphrase') }),
      BACKUP_DIR: outDir,
    });
    expect(b.status, b.stderr).toBe(0);
    const dump = readdirSync(outDir).find((f) => f.endsWith('.dump.enc'));
    expect(dump).toBeTruthy();
    const r = run('pg-restore-check.sh', [path.join(outDir, dump ?? '')], {
      PGUSER: decodeURIComponent(new URL(server.adminUrl).username),
      BACKUP_PASSPHRASE_FILE: path.join(dir, 'passphrase'),
      RESTORE_CHECK_STRICT: '1',
    });
    expect(r.status, r.stderr).toBe(0);

    writeFileSync(path.join(outDir, 'kek'), randomBytes(32));
    const refused = run('pg-backup.sh', [], {
      ...backupEnv({ BACKUP_ENCRYPTION: 'openssl', BACKUP_PASSPHRASE_FILE: path.join(dir, 'passphrase') }),
      BACKUP_DIR: outDir,
      KEK_FILE: path.join(outDir, 'kek'),
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/KEK/);
  });
});

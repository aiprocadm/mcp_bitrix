/**
 * Настоящий PostgreSQL для тестов SaaS (без имитаций, SaaS-ТЗ S2):
 *  - TEST_POSTGRES_ADMIN_URL (CI-сервис): создаётся отдельная база и непривилегированная роль;
 *  - иначе, если есть бинарники PostgreSQL и системный пользователь postgres, — временный кластер (initdb);
 *  - иначе undefined: тесты помечаются skip явно (describe.skipIf), а не «проходят» на подделке.
 * Сервис всегда подключается ролью без SUPERUSER/BYPASSRLS — как в production (RLS действует).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestPostgres {
  /** Роль сервиса (без SUPERUSER/BYPASSRLS), владелец базы. */
  readonly url: string;
  /** Суперпользователь той же базы — только для проверок теста (в сервис не передавать). */
  readonly adminUrl: string;
  stop(): Promise<void>;
}

function findPgBin(): string | undefined {
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) {
    const bin = path.join(root, v, 'bin');
    if (existsSync(path.join(bin, 'initdb'))) return bin;
  }
  return undefined;
}

async function createAppRole(adminUrl: string, baseUrl: URL): Promise<{ url: string; dbAdminUrl: string }> {
  const suffix = randomBytes(4).toString('hex');
  const role = `mcp_app_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const dbName = `mcp_test_${suffix}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`);
  await admin.end();
  const url = new URL(baseUrl.toString());
  url.username = role;
  url.password = password;
  url.pathname = `/${dbName}`;
  const dbAdminUrl = new URL(adminUrl);
  dbAdminUrl.pathname = `/${dbName}`;
  return { url: url.toString(), dbAdminUrl: dbAdminUrl.toString() };
}

export async function startTestPostgres(): Promise<TestPostgres | undefined> {
  const external = process.env['TEST_POSTGRES_ADMIN_URL'];
  if (external) {
    const { url, dbAdminUrl } = await createAppRole(external, new URL(external));
    return { url, adminUrl: dbAdminUrl, stop: () => Promise.resolve() };
  }
  const bin = findPgBin();
  if (!bin) return undefined;
  const asPostgres = process.getuid?.() === 0;
  if (asPostgres && spawnSync('id', ['postgres']).status !== 0) return undefined;
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-pg-'));
  const run = (cmd: string, args: string[]) =>
    asPostgres
      ? execFileSync('runuser', ['-u', 'postgres', '--', path.join(bin, cmd), ...args], { stdio: 'ignore' })
      : execFileSync(path.join(bin, cmd), args, { stdio: 'ignore' });
  if (asPostgres) {
    const uid = Number(execFileSync('id', ['-u', 'postgres']).toString().trim());
    const gid = Number(execFileSync('id', ['-g', 'postgres']).toString().trim());
    chownSync(dir, uid, gid);
  }
  const port = 40000 + Math.floor(Math.random() * 20000);
  try {
    run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', [
      '-D',
      path.join(dir, 'data'),
      '-o',
      `-p ${String(port)} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`,
      '-l',
      path.join(dir, 'log'),
      '-w',
      'start',
    ]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  const adminUrl = `postgresql://postgres@127.0.0.1:${String(port)}/postgres`;
  const { url, dbAdminUrl } = await createAppRole(adminUrl, new URL(adminUrl));
  return {
    url,
    adminUrl: dbAdminUrl,
    stop: () => {
      try {
        run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
      } catch {
        // уже остановлен
      }
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

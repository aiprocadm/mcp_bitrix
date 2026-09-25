/** Общий стенд SaaS-тестов: настоящий PostgreSQL (tests/helpers/postgres.ts), связка ключей, репозитории. */
import { existsSync } from 'node:fs';
import { PostgresSqlDb } from '../../src/storage/postgres-db.js';
import { TenantKeyRing } from '../../src/saas/keyring.js';
import { startTestPostgres, type TestPostgres } from './postgres.js';

/** Есть ли где запустить PostgreSQL: без него SaaS-тесты помечаются skip (а не проходят на подделке). */
export const PG_AVAILABLE =
  Boolean(process.env['TEST_POSTGRES_ADMIN_URL']) || existsSync('/usr/lib/postgresql');

export interface SaasTestDb {
  server: TestPostgres;
  db: PostgresSqlDb;
  keys: TenantKeyRing;
  close(): Promise<void>;
}

export const TEST_KEK = Buffer.alloc(32, 9);

export async function openSaasTestDb(): Promise<SaasTestDb> {
  const server = await startTestPostgres();
  if (!server) throw new Error('PostgreSQL для тестов недоступен');
  const db = await PostgresSqlDb.open({ connectionString: server.url });
  return {
    server,
    db,
    keys: new TenantKeyRing(TEST_KEK),
    async close() {
      await db.close();
      await server.stop();
    },
  };
}

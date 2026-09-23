/**
 * npm run bitrix:profile: один вызов `profile` через общий API client, вывод очищенных данных.
 * Безопасный первый запрос без изменения портала (ТЗ §7.4 п.3).
 */
import { createApp } from '../app/container.js';
import { createSilentLogger } from '../logging/logger.js';
import { pickProfile } from '../tools/system/connection-info.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2));
  const config = cliConfig(args);
  const app = createApp(config, { logger: createSilentLogger() });
  try {
    const r = await app.bitrix.call('legacy', 'profile', {}, { requestId: 'cli-profile', budgetMs: 15_000 });
    const p = pickProfile(r.result);
    out(
      JSON.stringify(
        {
          portalOrigin: app.auth.portalOrigin,
          user: p,
          durationMs: r.meta.durationMs,
          attempts: r.meta.attempts,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    fail(e, 1);
  } finally {
    app.close();
  }
}

void main();

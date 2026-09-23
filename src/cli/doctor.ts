/**
 * npm run doctor (ТЗ §7.4, §17.3): конфигурация, политики, ключ, БД, версия, read-only связь
 * с порталом и доступность MVP-методов. Портал не изменяет. `--offline` — без сетевых проверок.
 * Код выхода 1 при любом FAIL.
 */
import { existsSync, statSync } from 'node:fs';
import { createApp } from '../app/container.js';
import { listMethods } from '../bitrix/method-registry.js';
import { describeConfig } from '../config/env.js';
import { loadPolicies } from '../config/policy.js';
import { AppError } from '../errors/app-error.js';
import { createSilentLogger } from '../logging/logger.js';
import { Database } from '../storage/database.js';
import { pickProfile } from '../tools/system/connection-info.js';
import { methodBelongsToModule } from '../tools/system/capabilities.js';
import { MCP_SDK_VERSION, NODE_VERSION, SERVER_VERSION } from '../version.js';
import { cliArgs, cliConfig, out, printChecks, type Check } from './common.js';

const MVP_METHODS = [
  'profile',
  'crm.deal.list',
  'crm.deal.get',
  'crm.deal.add',
  'tasks.task.add',
  'tasks.task.get',
  'tasks.task.list',
  'im.message.add',
  'disk.folder.uploadfile',
  'calendar.event.add',
];

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), { offline: { kind: 'boolean' } });
  const config = cliConfig(args);
  const checks: Check[] = [];
  let ready = true;

  checks.push({
    name: 'versions',
    status: 'ok',
    detail: `server ${SERVER_VERSION}, node ${NODE_VERSION}, mcp-sdk ${MCP_SDK_VERSION}`,
  });
  checks.push({
    name: 'config',
    status: 'ok',
    detail: config.configPath ?? 'файл .env не найден, действуют значения по умолчанию',
  });

  try {
    loadPolicies({
      methods: config.policy.methodPolicyFile,
      access: config.policy.accessPolicyFile,
      output: config.policy.outputPolicyFile,
    });
    checks.push({ name: 'policies', status: 'ok', detail: 'methods/access/output загружены' });
  } catch (e) {
    ready = false;
    checks.push({ name: 'policies', status: 'fail', detail: AppError.from(e).message });
  }

  if (existsSync(config.storage.secretsKeyFile)) {
    const mode = statSync(config.storage.secretsKeyFile).mode & 0o777;
    const loose = process.platform !== 'win32' && mode !== 0o600;
    checks.push({
      name: 'encryption key',
      status: loose ? 'warn' : 'ok',
      detail: loose ? `права ${mode.toString(8)}, ожидается 600` : 'найден',
    });
  } else {
    ready = false;
    checks.push({ name: 'encryption key', status: 'fail', detail: 'не найден — выполните npm run setup' });
  }

  try {
    const db = Database.open(config.storage.databasePath);
    const ops = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM operations WHERE status IN ('prepared','approved','executing','unknown')",
    );
    checks.push({
      name: 'database',
      status: 'ok',
      detail: `schema v${db.schemaVersion()}, незавершённых операций: ${ops?.n ?? 0}`,
    });
    db.close();
  } catch (e) {
    ready = false;
    checks.push({ name: 'database', status: 'fail', detail: AppError.from(e).message });
  }

  checks.push({
    name: 'write mode',
    status: 'ok',
    detail: config.policy.readOnlyMode
      ? 'READ_ONLY_MODE=true (запись выключена)'
      : 'запись ВКЛЮЧЕНА, подтверждения обязательны',
  });
  checks.push({ name: 'modules', status: 'ok', detail: [...config.policy.enabledModules].join(', ') });

  if (!config.bitrix.webhook) {
    ready = false;
    checks.push({
      name: 'bitrix webhook',
      status: 'fail',
      detail: 'BITRIX_WEBHOOK_BASE_URL не задан (см. docs/bitrix-webhook.md)',
    });
  } else {
    checks.push({
      name: 'bitrix webhook',
      status: 'ok',
      detail: `портал ${config.bitrix.portalOrigin ?? '?'}, userId ${config.bitrix.webhook.userId}`,
    });
  }

  if (args.flags['offline'] || !ready) {
    checks.push({
      name: 'live checks',
      status: 'skip',
      detail: args.flags['offline'] ? '--offline' : 'пропущены из-за ошибок выше',
    });
  } else {
    const app = createApp(config, { logger: createSilentLogger() });
    try {
      const requestId = 'doctor';
      try {
        const r = await app.bitrix.call('legacy', 'profile', {}, { requestId, budgetMs: 15_000 });
        const p = pickProfile(r.result);
        checks.push({
          name: 'profile',
          status: 'ok',
          detail: `пользователь #${p.id} ${p.name} ${p.lastName}${p.isAdmin ? ' (admin)' : ''}, ${r.meta.durationMs} мс`,
        });
      } catch (e) {
        ready = false;
        const err = AppError.from(e);
        checks.push({ name: 'profile', status: 'fail', detail: `${err.code}: ${err.message}` });
      }
      if (ready) {
        try {
          const scopes = await app.capabilities.scopes(requestId, true);
          checks.push({ name: 'scopes', status: 'ok', detail: scopes.join(', ') || '(пусто)' });
        } catch (e) {
          checks.push({ name: 'scopes', status: 'warn', detail: AppError.from(e).code });
        }
        for (const d of listMethods().filter((m) => MVP_METHODS.includes(m.method))) {
          const enabled = [...config.policy.enabledModules].some((m) => methodBelongsToModule(d, m));
          if (!enabled) {
            checks.push({ name: d.method, status: 'skip', detail: 'модуль выключен' });
            continue;
          }
          const c = await app.capabilities.probe(d, requestId, true);
          checks.push({
            name: d.method,
            status: c.status === 'supported' ? 'ok' : 'warn',
            detail: c.status + (c.reason ? `: ${c.reason}` : ''),
          });
        }
      }
    } finally {
      app.close();
    }
  }

  printChecks(checks);
  out('');
  out('Конфигурация (без секретов): ' + JSON.stringify(describeConfig(config)));
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}

main().catch((e: unknown) => {
  const err = AppError.from(e);
  process.stderr.write(`[${err.code}] ${err.message}\n`);
  process.exit(2);
});

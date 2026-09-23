/**
 * npm run test:live -- --read-only | --write --prepare | --write --execute  [--report <файл>]
 * Живая проверка портала (ТЗ §10.3, §17.3). Запускается только вручную при LIVE_TESTS_ENABLED=true.
 * Отчёт (IDs, статусы, без секретов) — в JSON; тестовые объекты НЕ удаляются автоматически.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../app/container.js';
import { createSilentLogger } from '../logging/logger.js';
import {
  assertLiveAllowed,
  buildWritePlans,
  executeWrites,
  newReport,
  prepareWrites,
  runReadOnly,
  type LiveMode,
  type LiveReport,
} from '../live/scenario.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

function printSteps(report: LiveReport): void {
  const icon = { passed: 'OK   ', failed: 'FAIL ', blocked: 'BLOCK', skipped: 'SKIP ' } as const;
  for (const s of report.steps) out(`${icon[s.status]} ${s.step.padEnd(40)} ${s.detail}`);
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), {
    'read-only': { kind: 'boolean' },
    write: { kind: 'boolean' },
    prepare: { kind: 'boolean' },
    execute: { kind: 'boolean' },
    report: { kind: 'string' },
  });
  const mode: LiveMode = args.flags['write'] ? (args.flags['execute'] ? 'execute' : 'prepare') : 'read-only';
  if (args.flags['write'] && !args.flags['prepare'] && !args.flags['execute']) {
    fail(new Error('С --write укажите фазу: --prepare (планы) или --execute (после approval:review)'));
  }
  const config = cliConfig(args);
  assertLiveAllowed(config, mode);
  const app = createApp(config, { logger: createSilentLogger() });
  const reportPath = path.resolve(
    config.baseDir,
    args.values['report'] ?? path.join(config.storage.dataDir, 'live-smoke-report.json'),
  );
  try {
    let report: LiveReport;
    if (mode === 'execute') {
      if (!existsSync(reportPath)) fail(new Error(`Нет отчёта фазы prepare: ${reportPath}`));
      report = JSON.parse(readFileSync(reportPath, 'utf8')) as LiveReport;
      report.mode = 'execute';
    } else {
      report = newReport(config, mode, app.auth.portalOrigin);
    }
    out(`Живая проверка: режим ${mode}, портал ${app.auth.portalOrigin}, префикс «${config.live.prefix}»`);
    if (mode === 'read-only') {
      report.steps = await runReadOnly(app);
    } else if (mode === 'prepare') {
      report.writes = buildWritePlans(config);
      report.steps = await prepareWrites(app, report.writes);
      out('');
      out('Дальше: подтвердите каждый план в терминале (npm run approval:review -- --id <operationId>),');
      out('затем выполните: npm run test:live -- --write --execute');
    } else {
      const r = await executeWrites(app, report.writes);
      report.steps = r.steps;
      report.createdIds = r.createdIds;
      out('');
      out('Проверьте объекты в Bitrix24 и удалите тестовые записи вручную (§10.3 п.8).');
    }
    report.finishedAt = new Date().toISOString();
    printSteps(report);
    mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    out(`Отчёт: ${reportPath}`);
    process.exitCode = report.steps.some((s) => s.status === 'failed') ? 1 : 0;
  } finally {
    app.close();
  }
}

main().catch((e: unknown) => fail(e, 1));

/**
 * npm run setup (ТЗ §13 п.1): рабочие policies/*.json из examples, каталоги данных с 0700,
 * ключ шифрования (существующий не перегенерируется), проверка конфигурации.
 * Ключ и секреты в терминал не печатаются.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describeConfig } from '../config/env.js';
import { loadPolicies } from '../config/policy.js';
import { ensureMasterKey } from '../security/crypto.js';
import { cliArgs, cliConfig, fail, out, printChecks, type Check } from './common.js';

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows
  }
}

function main(): void {
  const args = cliArgs(process.argv.slice(2));
  const config = cliConfig(args);
  const checks: Check[] = [];

  const policyPairs: [string, string][] = [
    [config.policy.methodPolicyFile, 'methods.example.json'],
    [config.policy.accessPolicyFile, 'access.example.json'],
    [config.policy.outputPolicyFile, 'output.example.json'],
  ];
  const examplesDir = path.resolve(config.baseDir, 'policies');
  for (const [target, example] of policyPairs) {
    const src = path.join(examplesDir, example);
    if (existsSync(target)) {
      checks.push({ name: path.basename(target), status: 'ok', detail: 'уже существует, не тронут' });
      continue;
    }
    if (!existsSync(src)) {
      checks.push({ name: path.basename(target), status: 'fail', detail: `нет примера ${src}` });
      continue;
    }
    ensureDir(path.dirname(target));
    copyFileSync(src, target);
    checks.push({ name: path.basename(target), status: 'ok', detail: 'создан из примера' });
  }

  for (const dir of [
    config.storage.dataDir,
    config.storage.uploadRoot,
    config.storage.stagingDir,
    path.dirname(config.storage.secretsKeyFile),
  ]) {
    ensureDir(dir);
  }
  checks.push({ name: 'data dirs', status: 'ok', detail: `${config.storage.dataDir} (0700)` });

  try {
    const key = ensureMasterKey(config.storage.secretsKeyFile, { create: true });
    checks.push({
      name: 'encryption key',
      status: 'ok',
      detail: key.createdNow ? 'создан (0600)' : 'существует, не перегенерирован',
    });
  } catch (e) {
    fail(e);
  }

  try {
    loadPolicies({
      methods: config.policy.methodPolicyFile,
      access: config.policy.accessPolicyFile,
      output: config.policy.outputPolicyFile,
    });
    checks.push({ name: 'policies', status: 'ok', detail: 'схема проверена' });
  } catch (e) {
    fail(e);
  }

  checks.push({
    name: 'bitrix webhook',
    status: config.bitrix.webhook ? 'ok' : 'warn',
    detail: config.bitrix.webhook
      ? `настроен (портал ${config.bitrix.portalOrigin ?? '?'})`
      : 'BITRIX_WEBHOOK_BASE_URL пуст — заполните .env, затем npm run doctor',
  });

  printChecks(checks);
  out('');
  out('Конфигурация (без секретов): ' + JSON.stringify(describeConfig(config)));
  out('Дальше: npm run doctor');
}

main();

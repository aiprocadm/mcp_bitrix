/** Общее для CLI-команд: разбор --config, вывод, коды выхода. CLI пишет в stdout (это не MCP-процесс). */
import { loadConfig, type AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { redactString } from '../security/redaction.js';
import { parseCliArgs, type ArgSpec, type ParsedArgs } from './args.js';

export interface CliRun {
  args: ParsedArgs;
  config: AppConfig;
}

export function cliArgs(argv: readonly string[], extra: Record<string, ArgSpec> = {}): ParsedArgs {
  try {
    return parseCliArgs(argv, { config: { kind: 'string' }, ...extra });
  } catch (e) {
    fail(e);
  }
}

export function cliConfig(args: ParsedArgs): AppConfig {
  try {
    return loadConfig({ configPath: args.values['config'] });
  } catch (e) {
    fail(e);
  }
}

export function out(line: string): void {
  process.stdout.write(redactString(line) + '\n');
}

export function fail(e: unknown, exitCode = 2): never {
  const err = AppError.from(e);
  const extra = err.details.nextAction ? ` → ${err.details.nextAction}` : '';
  process.stderr.write(redactString(`[${err.code}] ${err.message}${extra}\n`));
  // CLI читает человек, а не модель: исходная причина полезна для диагностики (после редактирования секретов).
  if (!AppError.is(e) && e instanceof Error)
    process.stderr.write(redactString(`  причина: ${e.name}: ${e.message}\n`));
  process.exit(exitCode);
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export function printChecks(checks: readonly Check[]): void {
  const icon: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  for (const c of checks) out(`${icon[c.status]}  ${c.name.padEnd(28)} ${c.detail}`);
}

#!/usr/bin/env node
/**
 * Точка входа (ТЗ §12 index.ts): разбор CLI, загрузка конфигурации, запуск транспорта,
 * graceful shutdown. Любой вывод сервера — в stderr; stdout принадлежит MCP при stdio.
 */
import { createApp } from './app/container.js';
import { loadConfig } from './config/env.js';
import { AppError } from './errors/app-error.js';
import { startHttp } from './mcp/http.js';
import { startStdio } from './mcp/stdio.js';
import { parseCliArgs } from './cli/args.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    transport: { kind: 'string' },
    config: { kind: 'string' },
  });
  const transportArg = args.values['transport'];
  if (transportArg !== undefined && transportArg !== 'stdio' && transportArg !== 'http') {
    throw new AppError('CONFIG_INVALID', '--transport принимает stdio или http', { field: '--transport' });
  }
  const config = loadConfig({ configPath: args.values['config'] });
  const transport = transportArg ?? config.server.transport;
  const app = createApp({ ...config, server: { ...config.server, transport } });

  const handle = transport === 'http' ? await startHttp(app) : await startStdio(app);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.logger.info({ signal }, 'shutting down');
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => {
        app.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  if (transport === 'stdio') process.stdin.on('close', () => shutdown('stdin-closed'));
}

main().catch((e: unknown) => {
  const err = AppError.from(e);
  process.stderr.write(`[${err.code}] ${err.message}\n`);
  process.exit(2);
});

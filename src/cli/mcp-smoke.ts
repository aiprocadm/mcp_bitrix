/**
 * npm run mcp:smoke -- --transport stdio|http [--config path]
 * npm run mcp:smoke -- --transport http --url https://mcp.example.com/mcp [--token-env MCP_SMOKE_TOKEN]
 * Официальный MCP client: initialize → tools/list → безопасный вызов bitrix_server_version
 * (без обращения к Bitrix24). Для stdio запускается дочерний процесс сервера; для http без --url
 * сервер поднимается в этом же процессе на loopback; с --url проверяется УДАЛЁННЫЙ сервер
 * (ТЗ §17.6 п.7, §20.2 «remote MCP smoke»): bearer-токен берётся из переменной окружения,
 * не из аргумента командной строки (аргументы видны в списке процессов).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from '../app/container.js';
import { isLoopbackHost } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { startHttp } from '../mcp/http.js';
import { createSilentLogger } from '../logging/logger.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

async function runChecks(client: Client): Promise<void> {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  out(`tools/list: ${String(names.length)} инструментов: ${names.join(', ')}`);
  if (!names.includes('bitrix_server_version'))
    throw new Error('bitrix_server_version отсутствует в tools/list');
  const r = await client.callTool({ name: 'bitrix_server_version', arguments: {} });
  const structured = r.structuredContent as { success?: boolean; data?: { version?: string } } | undefined;
  if (r.isError || !structured?.success) throw new Error('bitrix_server_version вернул ошибку');
  out(`tools/call bitrix_server_version: success, version ${structured.data?.version ?? '?'}`);
  const bad = await client.callTool({ name: 'bitrix_server_version', arguments: { unexpected: 1 } });
  if (!bad.isError) throw new Error('Лишний параметр не был отклонён (additionalProperties:false)');
  out('tools/call с лишним параметром: isError=true (ожидаемо)');
}

async function remoteSmoke(rawUrl: string, tokenEnv: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('VALIDATION_ERROR', '--url должен быть абсолютным адресом MCP endpoint', {
      field: 'url',
    });
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new AppError('VALIDATION_ERROR', 'Удалённый smoke только по https (http — лишь для loopback)', {
      field: 'url',
    });
  }
  const token = process.env[tokenEnv];
  if (!token) {
    throw new AppError('CONFIG_INVALID', `Переменная окружения ${tokenEnv} с bearer-токеном не задана`, {
      field: tokenEnv,
      nextAction: `Получите access token у authorization server и выполните: ${tokenEnv}=... npm run mcp:smoke -- --transport http --url ${url.origin}${url.pathname}`,
    });
  }
  out(`http: удалённый сервер ${url.origin}${url.pathname}`);
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, { authProvider: { token: () => Promise.resolve(token) } }),
  );
  try {
    await runChecks(client);
  } finally {
    await client.close();
  }
  out('remote http smoke: OK');
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), {
    transport: { kind: 'string' },
    url: { kind: 'string' },
    'token-env': { kind: 'string' },
  });
  const transport = args.values['transport'] ?? 'stdio';
  const remoteUrl = args.values['url'];

  if (transport === 'http' && remoteUrl) {
    await remoteSmoke(remoteUrl, args.values['token-env'] ?? 'MCP_SMOKE_TOKEN');
    return;
  }
  if (remoteUrl) throw new Error('--url применим только с --transport http');

  const config = cliConfig(args);
  const configPath = config.configPath ?? path.resolve(process.cwd(), '.env');

  if (transport === 'stdio') {
    const dist = path.resolve(process.cwd(), 'dist/index.js');
    const useDist = existsSync(dist);
    const serverArgs = useDist
      ? [dist, '--transport', 'stdio', '--config', configPath]
      : [
          '--import',
          'tsx',
          path.resolve(process.cwd(), 'src/index.ts'),
          '--transport',
          'stdio',
          '--config',
          configPath,
        ];
    out(`stdio: запускаю ${useDist ? 'dist/index.js' : 'src/index.ts через tsx'}`);
    const t = new StdioClientTransport({ command: process.execPath, args: serverArgs, stderr: 'pipe' });
    const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
    await client.connect(t);
    try {
      await runChecks(client);
    } finally {
      await client.close();
    }
    out('stdio smoke: OK');
    return;
  }
  if (transport === 'http') {
    const app = createApp(config, { logger: createSilentLogger() });
    await app.ready;
    const handle = await startHttp(app, { host: '127.0.0.1', port: 0 });
    try {
      out(`http: сервер на ${handle.url}`);
      const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
      try {
        await runChecks(client);
      } finally {
        await client.close();
      }
      out('http smoke: OK');
    } finally {
      await handle.close();
      app.close();
    }
    return;
  }
  throw new Error('--transport принимает stdio или http');
}

main().catch((e: unknown) => fail(e, 1));

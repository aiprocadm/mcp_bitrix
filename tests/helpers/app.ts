/** Сборка тестового приложения: mock.env + переопределения, БД в памяти, фиксированный ключ, мок Bitrix. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createApp, type AppContainer } from '../../src/app/container.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { MockBitrix } from './mock-bitrix.js';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/helpers$/, 'fixtures');
export const MOCK_ENV = path.join(FIXTURES_DIR, 'mock.env');
export const TEST_KEY = Buffer.alloc(32, 7);

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  // processEnv передаётся явно, чтобы окружение машины не влияло на тесты
  return loadConfig({ configPath: MOCK_ENV, processEnv: { ...overrides } });
}

export interface TestApp {
  app: AppContainer;
  bitrix: MockBitrix;
  config: AppConfig;
}

export function createTestApp(
  overrides: Record<string, string> = {},
  extraTools: ToolDefinition[] = [],
): TestApp {
  const config = testConfig(overrides);
  const bitrix = new MockBitrix();
  const base = createApp(config, {
    fetch: bitrix.fetch,
    logger: createSilentLogger(),
    inMemoryDatabase: true,
    masterKey: TEST_KEY,
  });
  const app: AppContainer = extraTools.length ? { ...base, tools: [...base.tools, ...extraTools] } : base;
  return { app, bitrix, config };
}

export interface ConnectedClient {
  client: Client;
  close(): Promise<void>;
}

export async function connectInMemory(app: AppContainer): Promise<ConnectedClient> {
  const { server } = createMcpServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function structured<T = Record<string, unknown>>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

/**
 * Проверка ТЗ §8.2 п.3: подготовленный план нельзя подтвердить через pipe (без TTY).
 * Готовим план через приложение, затем запускаем настоящий CLI с echo ПОДТВЕРЖДАЮ.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/container.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { ensureMasterKey } from '../../src/security/crypto.js';
import { MOCK_ENV, testConfig } from '../helpers/app.js';
import { makeFakeCreateTool } from '../helpers/fake-write-tool.js';
import { dispatch } from '../../src/mcp/register-tools.js';

const ROOT = path.resolve(MOCK_ENV, '..', '..', '..');

describe('approval:review без терминала', () => {
  it('план остаётся prepared, CLI отказывает с ACCESS_DENIED', async () => {
    const config = testConfig({ READ_ONLY_MODE: 'false' });
    ensureMasterKey(config.storage.secretsKeyFile, { create: true });
    const hooks = { performCalls: 0, verifyCalls: 0, precheckCalls: 0 };
    const base = createApp(config, { logger: createSilentLogger() });
    const app = { ...base, tools: [...base.tools, makeFakeCreateTool(hooks)] };
    const def = app.tools.find((x) => x.name === 'test_create');
    if (!def) throw new Error('tool');
    const env = await dispatch(def, { title: 'pipe', idempotencyKey: randomUUID() }, app);
    const operationId = env.success ? '' : (env.error.details.operationId ?? '');
    base.close();
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(ROOT, 'src/cli/approval-review.ts'),
        '--config',
        MOCK_ENV,
        '--id',
        operationId,
      ],
      {
        cwd: ROOT,
        input: 'ПОДТВЕРЖДАЮ\n',
        encoding: 'utf8',
        env: { ...process.env, READ_ONLY_MODE: 'false' },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ACCESS_DENIED');
    expect(r.stdout).toContain('ПЛАН ОПЕРАЦИИ');

    const check = createApp(config, { logger: createSilentLogger() });
    expect((await check.operations.view(operationId, 'owner', check.auth.portalKey))?.status).toBe(
      'prepared',
    );
    check.close();
  }, 40_000);
});

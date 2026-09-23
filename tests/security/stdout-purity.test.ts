/**
 * T42: в stdio-режиме stdout содержит только JSON-RPC. Запускается настоящий процесс сервера
 * (src/index.ts через tsx) с LOG_LEVEL=debug, чтобы логи точно писались — и только в stderr.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMasterKey } from '../../src/security/crypto.js';
import { MOCK_ENV, testConfig } from '../helpers/app.js';

const ROOT = path.resolve(MOCK_ENV, '..', '..', '..');

describe('stdio: чистота stdout (T42)', () => {
  it('каждая строка stdout — JSON-RPC сообщение; логи уходят в stderr', async () => {
    // Настоящий процесс читает ключ из data/test (не в git) — создаём его, как делает npm run setup.
    ensureMasterKey(testConfig().storage.secretsKeyFile, { create: true });
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'src/index.ts'), '--transport', 'stdio', '--config', MOCK_ENV],
      {
        cwd: ROOT,
        env: { ...process.env, LOG_LEVEL: 'debug' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    await waitFor(
      () => stdout.includes('"id":1'),
      15_000,
      () => stderr,
    );
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(() => stdout.includes('"id":2'), 15_000);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'bitrix_server_version', arguments: {} },
    });
    await waitFor(() => stdout.includes('"id":3'), 15_000);
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));

    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const msg = JSON.parse(line) as { jsonrpc?: string };
      expect(msg.jsonrpc).toBe('2.0');
    }
    expect(stderr).toContain('mcp server started');
    expect(stdout).not.toContain('mcp server started');
    expect(stdout).not.toContain('mocksecret');
    expect(stderr).not.toContain('mocksecret');
  }, 40_000);
});

async function waitFor(cond: () => boolean, timeoutMs: number, diag?: () => string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for stdout; stderr: ${diag ? diag().slice(0, 500) : '(нет)'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

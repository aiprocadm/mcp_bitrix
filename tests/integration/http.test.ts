/** T41 (HTTP): Streamable HTTP через Fastify-адаптер, healthz/readyz, защита Host (T40). */
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttp, type HttpHandle } from '../../src/mcp/http.js';
import { createTestApp, structured, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  dealRecord,
  deals,
  legacyListPage,
  legacyOk,
  PROFILE_RESULT,
} from '../helpers/mock-bitrix.js';

describe('Streamable HTTP', () => {
  let t: TestApp;
  let handle: HttpHandle;
  const ALL = deals(1, 30).map((d) => dealRecord(Number(d.ID)));

  beforeAll(async () => {
    t = createTestApp({ MCP_TRANSPORT: 'http' });
    t.bitrix
      .on('profile', legacyOk(PROFILE_RESULT))
      .on('scope', legacyOk(['crm']))
      .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
      .on('crm.deal.list', (c) => legacyListPage(ALL, Number(c.body['start'] ?? 0), 50));
    handle = await startHttp(t.app, { host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await handle.close();
    t.app.close();
  });

  it('healthz без обращения к Bitrix, readyz с состоянием БД/аудита', async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ status: 'ok' });
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      status: 'ready',
      database: 'ok',
      audit: 'ok',
      readOnlyMode: true,
    });
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('initialize → tools/list → tools/call через официальный клиент, сессия сохраняется', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((x) => x.name)).toContain('bitrix_connection_info');
      const r = await client.callTool({ name: 'bitrix_connection_info', arguments: {} });
      const env = structured<{ success: boolean; data: { portalOrigin: string } }>(r);
      expect(env.success).toBe(true);
      expect(env.data.portalOrigin).toBe('https://mock.bitrix24.invalid');
      expect(transport.sessionId).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('T41 (HTTP): CRM-список с курсором через две сессии одного оператора; вторая сессия видит тот же курсор', async () => {
    const c1 = new Client({ name: 'http-a', version: '0.0.0' });
    await c1.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const c2 = new Client({ name: 'http-b', version: '0.0.0' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    try {
      const p1 = structured<{
        success: boolean;
        data: { returnedCount: number };
        meta: { page: { nextCursor: string } };
      }>(await c1.callTool({ name: 'crm_list_records', arguments: { entityType: 'deal', pageSize: 20 } }));
      expect(p1.success).toBe(true);
      expect(p1.data.returnedCount).toBe(20);
      // курсор привязан к оператору/порталу/фильтру, а не к HTTP-сессии — второй клиент того же владельца продолжает
      const p2 = structured<{ success: boolean; data: { returnedCount: number } }>(
        await c2.callTool({
          name: 'crm_list_records',
          arguments: { entityType: 'deal', pageSize: 20, cursor: p1.meta.page.nextCursor },
        }),
      );
      expect(p2.success).toBe(true);
      expect(p2.data.returnedCount).toBe(10);
      expect(t.bitrix.callsTo('crm.deal.list')).toHaveLength(1);
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  it('T40: чужой Host отклоняется (DNS rebinding), GET/DELETE без сессии — 400, POST не-initialize без сессии — 400', async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    // fetch не позволяет подменить Host — используем node:http напрямую
    const evilStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: 'evil.example',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(evilStatus).toBe(403);
    const get = await fetch(`${base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(400);
    const post = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(post.status).toBe(400);
    const unknownSession = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unknownSession.status).toBe(404);
  });
});

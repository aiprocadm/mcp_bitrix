/**
 * Streamable HTTP через официальный адаптер Fastify (ТЗ §4.5, §5).
 * Сессии stateful: транспорт и McpServer на сессию. В режиме MCP_AUTH_MODE=local
 * конфигурация уже гарантирует loopback; адаптер добавляет защиту Host/Origin.
 * /healthz — только процесс; /readyz — конфигурация/БД/аудит, без запросов к Bitrix.
 */
import { randomUUID } from 'node:crypto';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContainer } from '../app/container.js';
import { isLoopbackHost } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { SERVER_VERSION } from '../version.js';
import { createMcpServer } from './server.js';

export interface HttpHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

export function buildHttpApp(app: AppContainer): FastifyInstance {
  const cfg = app.config.server;
  if (cfg.authMode === 'local' && !isLoopbackHost(cfg.host)) {
    throw new AppError('CONFIG_INVALID', 'HTTP на внешнем интерфейсе без авторизации запрещён', {
      field: 'MCP_HOST',
    });
  }
  const fastify = createMcpFastifyApp({
    host: cfg.host,
    ...(cfg.allowedHosts.length ? { allowedHosts: [...cfg.allowedHosts] } : {}),
  });
  const sessions = new Map<string, Session>();

  fastify.get('/healthz', () => ({ status: 'ok' }));
  fastify.get('/readyz', async (_req, reply) => {
    const audit = app.audit.status();
    let dbOk = true;
    try {
      app.db.get('SELECT 1 AS one');
    } catch {
      dbOk = false;
    }
    const ready = dbOk && (audit.available || !audit.enabled);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      version: SERVER_VERSION,
      database: dbOk ? 'ok' : 'error',
      audit: audit.enabled ? (audit.available ? 'ok' : 'unavailable') : 'disabled',
      readOnlyMode: app.config.policy.readOnlyMode,
      sessions: sessions.size,
    });
  });

  const jsonRpcError = (reply: FastifyReply, status: number, message: string) =>
    reply.code(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(request.raw, reply.raw, request.body);
      return reply;
    }
    if (sessionId) return jsonRpcError(reply, 404, 'Сессия не найдена');
    if (!isInitializeRequest(request.body))
      return jsonRpcError(reply, 400, 'Ожидается initialize без Mcp-Session-Id');
    const { server } = createMcpServer(app);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        app.logger.info({ sessionId: id }, 'mcp http session opened');
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        app.logger.info({ sessionId: id }, 'mcp http session closed');
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  const bySession = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.headers['mcp-session-id'];
    const s = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!s) return jsonRpcError(reply, 400, 'Неверный или отсутствующий Mcp-Session-Id');
    await s.transport.handleRequest(request.raw, reply.raw);
    return reply;
  };
  fastify.get('/mcp', bySession);
  fastify.delete('/mcp', bySession);

  fastify.addHook('onClose', async () => {
    for (const s of sessions.values()) {
      await s.server.close().catch(() => undefined);
    }
    sessions.clear();
  });
  return fastify;
}

export async function startHttp(
  app: AppContainer,
  override?: { host?: string; port?: number },
): Promise<HttpHandle> {
  const fastify = buildHttpApp(app);
  const host = override?.host ?? app.config.server.host;
  const port = override?.port ?? app.config.server.port;
  await fastify.listen({ host, port });
  const addr = fastify.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}/mcp`;
  app.logger.info({ transport: 'http', host, port: actualPort }, 'mcp server started');
  return {
    host,
    port: actualPort,
    url,
    async close() {
      // Открытые SSE/keep-alive соединения клиентов не должны блокировать остановку.
      fastify.server.closeAllConnections();
      await fastify.close();
    },
  };
}

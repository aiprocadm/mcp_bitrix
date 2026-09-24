/**
 * Streamable HTTP через официальный адаптер Fastify (ТЗ §4.5, §5).
 * Сессии stateful: транспорт и McpServer на сессию. В режиме MCP_AUTH_MODE=local
 * конфигурация уже гарантирует loopback; адаптер добавляет защиту Host/Origin.
 * В режиме oauth (этап 12): на КАЖДОМ запросе к /mcp и /readyz проверяется bearer-токен
 * (src/auth/mcp-auth.ts), сессия привязана к субъекту токена, принципал сессии — субъект,
 * Origin браузеров — по allowlist, а документ RFC 9728 отдаётся на /.well-known/oauth-protected-resource.
 * /healthz — только процесс; /readyz — конфигурация/БД/аудит, без запросов к Bitrix.
 */
import { randomUUID } from 'node:crypto';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContainer } from '../app/container.js';
import {
  McpAuthError,
  McpTokenVerifier,
  originAllowed,
  protectedResourceMetadata,
  wwwAuthenticate,
  type VerifiedToken,
} from '../auth/mcp-auth.js';
import { isLoopbackHost, type McpAuthSettings } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { SERVER_VERSION } from '../version.js';
import { createMcpServer } from './server.js';

export interface HttpHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface BuildHttpOptions {
  /** Для тестов: проверяющий токены с локальным набором ключей вместо удалённого JWKS. */
  verifier?: McpTokenVerifier;
}

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  /** Субъект, открывший сессию; чужой токен к сессии не допускается. */
  principalId: string;
}

function hostnameOf(entry: string): string {
  const e = entry.trim();
  if (!e.includes('://')) return e.toLowerCase();
  try {
    return new URL(e).hostname;
  } catch {
    return e.toLowerCase();
  }
}

export function buildHttpApp(app: AppContainer, opts: BuildHttpOptions = {}): FastifyInstance {
  const cfg = app.config.server;
  if (cfg.authMode === 'local' && !isLoopbackHost(cfg.host)) {
    throw new AppError('CONFIG_INVALID', 'HTTP на внешнем интерфейсе без авторизации запрещён', {
      field: 'MCP_HOST',
    });
  }
  const auth: McpAuthSettings | undefined = cfg.authMode === 'oauth' ? cfg.auth : undefined;
  if (cfg.authMode === 'oauth' && !auth) {
    throw new AppError('CONFIG_INVALID', 'MCP_AUTH_MODE=oauth без настроек авторизации', {
      field: 'MCP_AUTH_MODE',
    });
  }
  const verifier = auth ? (opts.verifier ?? new McpTokenVerifier(auth, app.policies.access)) : undefined;

  // Адаптер проверяет Origin по hostname; точное сравнение origin — в originAllowed().
  const adapterOrigins = auth
    ? [new URL(auth.publicOrigin).hostname, ...cfg.allowedOrigins.map(hostnameOf)]
    : undefined;
  const fastify = createMcpFastifyApp({
    host: cfg.host,
    ...(cfg.allowedHosts.length ? { allowedHosts: [...cfg.allowedHosts] } : {}),
    ...(adapterOrigins ? { allowedOrigins: adapterOrigins } : {}),
  });
  const sessions = new Map<string, Session>();

  const sendAuthError = (reply: FastifyReply, err: McpAuthError) => {
    if (auth && err.status !== 503) reply.header('WWW-Authenticate', wwwAuthenticate(auth, err));
    if (err.status === 403 || err.status === 401) reply.header('Cache-Control', 'no-store');
    return reply.code(err.status).send({ error: err.code, error_description: err.message });
  };

  /**
   * Проверка токена на каждом запросе (спецификация: authorization в каждом HTTP-запросе).
   * Возвращает undefined, если ответ уже отправлен.
   */
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<VerifiedToken | undefined> => {
    if (!auth || !verifier) return undefined;
    const query = request.query as Record<string, unknown> | undefined;
    if (query && ('access_token' in query || 'token' in query)) {
      await sendAuthError(
        reply,
        new McpAuthError(
          400,
          'invalid_request',
          'Токен в строке запроса запрещён; используйте заголовок Authorization',
        ),
      );
      return undefined;
    }
    if (!originAllowed(request.headers.origin, auth, cfg.allowedOrigins)) {
      app.logger.warn({ reason: 'origin' }, 'mcp http request rejected');
      await reply
        .code(403)
        .send({ error: 'access_denied', error_description: 'Origin не входит в allowlist' });
      return undefined;
    }
    try {
      return await verifier.verify(request.headers.authorization);
    } catch (e) {
      const err =
        e instanceof McpAuthError ? e : new McpAuthError(503, 'server_error', 'Проверка токена недоступна');
      app.logger.warn({ reason: err.code, status: err.status }, 'mcp http auth failed');
      await sendAuthError(reply, err);
      return undefined;
    }
  };

  fastify.get('/healthz', () => ({ status: 'ok' }));
  fastify.get('/readyz', async (request, reply) => {
    // ТЗ §4.5: readyz — на внутреннем интерфейсе или под авторизацией.
    if (auth) {
      const token = await authenticate(request, reply);
      if (!token) return reply;
    }
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
      authMode: cfg.authMode,
      sessions: sessions.size,
    });
  });

  if (auth) {
    // RFC 9728: документ метаданных защищённого ресурса — публичный, без токенов.
    const metadataPath = new URL(auth.metadataUrl).pathname;
    const document = protectedResourceMetadata(auth, cfg.name);
    const serveMetadata = (_req: FastifyRequest, reply: FastifyReply) =>
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Cache-Control', 'public, max-age=300')
        .send(document);
    fastify.get(metadataPath, serveMetadata);
    if (metadataPath !== '/.well-known/oauth-protected-resource') {
      fastify.get('/.well-known/oauth-protected-resource', serveMetadata);
    }
  }

  const jsonRpcError = (reply: FastifyReply, status: number, message: string) =>
    reply.code(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

  /** Сессия по заголовку; при oauth — только если открыта тем же субъектом. */
  const findSession = (request: FastifyRequest, reply: FastifyReply, token: VerifiedToken | undefined) => {
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing && token && existing.principalId !== token.principal.id) {
      app.logger.warn({ reason: 'session_principal_mismatch' }, 'mcp http request rejected');
      void reply
        .code(403)
        .send({ error: 'access_denied', error_description: 'Сессия открыта другим субъектом' });
      return { rejected: true as const };
    }
    return { rejected: false as const, sessionId, existing };
  };

  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = await authenticate(request, reply);
    if (auth && !token) return reply;
    const found = findSession(request, reply, token);
    if (found.rejected) return reply;
    if (found.existing) {
      await found.existing.transport.handleRequest(request.raw, reply.raw, request.body);
      return reply;
    }
    if (found.sessionId) return jsonRpcError(reply, 404, 'Сессия не найдена');
    if (!isInitializeRequest(request.body))
      return jsonRpcError(reply, 400, 'Ожидается initialize без Mcp-Session-Id');
    const principal = token?.principal ?? app.principal;
    const { server } = createMcpServer(app, { principal });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, principalId: principal.id });
        app.logger.info(
          { sessionId: id, principalSource: principal.source, role: principal.role },
          'mcp http session opened',
        );
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
    const token = await authenticate(request, reply);
    if (auth && !token) return reply;
    const found = findSession(request, reply, token);
    if (found.rejected) return reply;
    if (!found.existing) return jsonRpcError(reply, 400, 'Неверный или отсутствующий Mcp-Session-Id');
    await found.existing.transport.handleRequest(request.raw, reply.raw);
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
  override?: { host?: string; port?: number; verifier?: McpTokenVerifier },
): Promise<HttpHandle> {
  const fastify = buildHttpApp(app, override?.verifier ? { verifier: override.verifier } : {});
  const host = override?.host ?? app.config.server.host;
  const port = override?.port ?? app.config.server.port;
  await fastify.listen({ host, port });
  const addr = fastify.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}/mcp`;
  app.logger.info(
    { transport: 'http', host, port: actualPort, authMode: app.config.server.authMode },
    'mcp server started',
  );
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

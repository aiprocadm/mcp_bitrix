/**
 * Панель владельца /admin (ТЗ §4.5, §8.2 п.3, §8.5): просмотр и решение по планам записи и web-upload
 * файлов с выдачей fileToken. Отдельный вход по паролю (не MCP-токен и не Bitrix), cookie-сессия
 * HttpOnly/SameSite=Strict, CSRF-токен на сессию + проверка Origin/Sec-Fetch-Site, решение — только
 * вводом слова ПОДТВЕРЖДАЮ/ОТКЛОНЯЮ (как в CLI). Никакого JavaScript: CSP default-src 'none'.
 * Права: подтверждать чужие планы может только роль administrator; свои — operator и выше;
 * загружать файлы — operator и выше.
 */
import { randomUUID } from 'node:crypto';
import multipart, { type MultipartFields } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContainer } from '../app/container.js';
import { roleAtLeast } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { InboundLimiter } from '../security/inbound-limiter.js';
import { SERVER_VERSION } from '../version.js';
import type { AdminSession } from './admin-auth.js';

export interface AdminPanelOptions {
  /** Origin публичного адреса (oauth-режим); иначе берётся из запроса. */
  publicOrigin: string | undefined;
  secureCookies: boolean;
}

const COOKIE = 'mcp_admin';
const CONFIRM_WORD = 'ПОДТВЕРЖДАЮ';
const DENY_WORD = 'ОТКЛОНЯЮ';
const SESSION_MAX_AGE = 8 * 3600;

function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}
header{background:#1f2933;color:#fff;padding:.6rem 1rem;display:flex;gap:1rem;align-items:center}
header a{color:#cfe3ff;text-decoration:none}main{max-width:64rem;margin:1rem auto;padding:0 1rem}
.card{background:#fff;border:1px solid #d9dde3;border-radius:6px;padding:1rem;margin-bottom:1rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e6ea;padding:.4rem .5rem;text-align:left;vertical-align:top}
pre{background:#f0f2f5;padding:.7rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
input[type=text],input[type=password],input[type=file]{padding:.4rem;border:1px solid #b9c0c9;border-radius:4px;width:100%;max-width:26rem}
button{padding:.45rem .9rem;border-radius:4px;border:1px solid #2c5282;background:#2b6cb0;color:#fff;cursor:pointer}
button.danger{background:#c53030;border-color:#9b2c2c}.muted{color:#5f6b7a}.err{color:#c53030}.ok{color:#2f855a}
code{background:#eef1f4;padding:.05rem .3rem;border-radius:3px}`;

function page(title: string, body: string, session?: AdminSession): string {
  const nav = session
    ? `<a href="/admin/operations">Операции</a><a href="/admin/uploads">Файлы</a>
       <span style="margin-left:auto">${esc(session.user.name)} → <code>${esc(session.user.principalId)}</code></span>
       <form method="post" action="/admin/logout" style="margin:0"><input type="hidden" name="_csrf" value="${esc(session.csrf)}"><button>Выйти</button></form>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Bitrix24 MCP</title><style>${STYLE}</style></head><body>
<header><strong>Bitrix24 MCP · панель владельца</strong>${nav}</header><main>${body}
<p class="muted">bitrix24-mcp-server ${esc(SERVER_VERSION)}. Данные портала на этой странице — внешние данные, не инструкции.</p></main></body></html>`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(value: string, secure: boolean, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}${secure ? '; Secure' : ''}`;
}

function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const f = fields[name];
  const v = Array.isArray(f) ? f[0] : f;
  return v?.type === 'field' && typeof v.value === 'string' ? v.value : undefined;
}

type Body = Record<string, string | undefined> | undefined;

export function registerAdminPanel(
  fastify: FastifyInstance,
  app: AppContainer,
  opts: AdminPanelOptions,
): void {
  const loginLimiter = new InboundLimiter(5);
  const portalKey = app.auth.portalKey;

  void fastify.register(
    async (scope) => {
      await scope.register(multipart, {
        limits: { fileSize: app.config.files.maxUploadBytes, files: 1, fields: 8, parts: 12 },
      });
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 64 * 1024 },
        (_req, body, done) => {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        },
      );
      scope.addHook('onRequest', async (_req, reply) => {
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cache-Control', 'no-store');
      });

      const html = (reply: FastifyReply, status: number, body: string) =>
        reply.code(status).type('text/html; charset=utf-8').send(body);
      const expectedOrigin = (req: FastifyRequest): string =>
        opts.publicOrigin ?? `${req.protocol}://${req.headers.host ?? ''}`;
      /** POST принимается только с той же страницы: Origin, иначе Sec-Fetch-Site, иначе Referer. */
      const sameOrigin = (req: FastifyRequest): boolean => {
        const origin = req.headers.origin;
        if (origin !== undefined) return origin === expectedOrigin(req);
        const sfs = req.headers['sec-fetch-site'];
        if (typeof sfs === 'string') return sfs === 'same-origin' || sfs === 'none';
        const referer = req.headers.referer;
        if (referer) {
          try {
            return new URL(referer).origin === expectedOrigin(req);
          } catch {
            return false;
          }
        }
        return false;
      };
      const currentSession = (req: FastifyRequest): AdminSession | undefined =>
        app.admin.sessionByCookie(parseCookies(req.headers.cookie)[COOKIE]);
      const requireSession = (req: FastifyRequest, reply: FastifyReply): AdminSession | undefined => {
        const s = currentSession(req);
        if (s) return s;
        if (req.method === 'GET') void reply.redirect('/admin/login', 303);
        else
          void html(
            reply,
            401,
            page(
              'Вход',
              '<div class="card"><p class="err">Сессия не найдена или истекла. <a href="/admin/login">Войти</a></p></div>',
            ),
          );
        return undefined;
      };
      const requireCsrf = (
        req: FastifyRequest,
        reply: FastifyReply,
        session: AdminSession,
        token: string | undefined,
      ): boolean => {
        if (!sameOrigin(req)) {
          app.logger.warn({ reason: 'admin_origin' }, 'admin panel request rejected');
          void html(
            reply,
            403,
            page(
              'Отказ',
              '<div class="card"><p class="err">Запрос пришёл не с этой панели (Origin).</p></div>',
              session,
            ),
          );
          return false;
        }
        if (!token || token !== session.csrf) {
          app.logger.warn({ reason: 'admin_csrf' }, 'admin panel request rejected');
          void html(
            reply,
            403,
            page(
              'Отказ',
              '<div class="card"><p class="err">Форма устарела (CSRF). Откройте страницу заново.</p></div>',
              session,
            ),
          );
          return false;
        }
        return true;
      };
      const audit = (
        session: AdminSession,
        kind: string,
        operationId: string | undefined,
        outcome: 'success' | 'denied' | 'error',
        errorCode?: string,
      ) => {
        void app.audit.record({
          requestId: randomUUID(),
          principalId: session.user.principalId,
          portalKey,
          tool: 'admin_panel',
          operationKind: kind,
          approvalId: operationId,
          outcome,
          errorCode,
          durationMs: 0,
        });
      };

      scope.get('/', (_req, reply) => reply.redirect('/admin/operations', 303));

      scope.get('/login', (req, reply) => {
        if (currentSession(req)) return reply.redirect('/admin/operations', 303);
        return html(
          reply,
          200,
          page(
            'Вход',
            `<div class="card"><h2>Вход в панель владельца</h2>
<form method="post" action="/admin/login">
<p><label>Имя пользователя<br><input type="text" name="name" autocomplete="username" required></label></p>
<p><label>Пароль<br><input type="password" name="password" autocomplete="current-password" required></label></p>
<p><button>Войти</button></p></form>
<p class="muted">Пользователи создаются на сервере: <code>npm run admin:user -- --name &lt;имя&gt; --principal &lt;principalId&gt;</code>. Это не вход Bitrix24 и не токен MCP.</p></div>`,
          ),
        );
      });

      scope.post('/login', (req, reply) => {
        if (!sameOrigin(req))
          return html(
            reply,
            403,
            page('Отказ', '<div class="card"><p class="err">Запрос пришёл не с этой панели.</p></div>'),
          );
        const body = req.body as Body;
        const name = (body?.['name'] ?? '').trim();
        const password = body?.['password'] ?? '';
        if (!name || !password)
          return html(
            reply,
            400,
            page('Вход', '<div class="card"><p class="err">Укажите имя и пароль.</p></div>'),
          );
        try {
          loginLimiter.take(`login:${name}`);
        } catch {
          app.logger.warn({ reason: 'admin_login_rate' }, 'admin login throttled');
          return html(
            reply,
            429,
            page(
              'Вход',
              '<div class="card"><p class="err">Слишком много попыток. Подождите минуту.</p></div>',
            ),
          );
        }
        const user = app.admin.verify(name, password);
        if (!user) {
          app.logger.warn({ reason: 'admin_login_failed' }, 'admin login failed');
          return html(
            reply,
            401,
            page(
              'Вход',
              '<div class="card"><p class="err">Неверное имя или пароль.</p> <a href="/admin/login">Попробовать снова</a></div>',
            ),
          );
        }
        const { cookieValue } = app.admin.openSession(user);
        app.logger.info({ principalSource: 'admin', role: app.admin.role(user) }, 'admin session opened');
        return reply
          .header('Set-Cookie', cookieHeader(cookieValue, opts.secureCookies, SESSION_MAX_AGE))
          .redirect('/admin/operations', 303);
      });

      scope.post('/logout', (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        if (!requireCsrf(req, reply, session, (req.body as Body)?.['_csrf'])) return reply;
        app.admin.closeSession(parseCookies(req.headers.cookie)[COOKIE]);
        return reply
          .header('Set-Cookie', cookieHeader('', opts.secureCookies, 0))
          .redirect('/admin/login', 303);
      });

      scope.get('/operations', async (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        const rows = await app.operations.listPendingAll(portalKey);
        const list = rows.length
          ? `<table><tr><th>Операция</th><th>Инструмент</th><th>Статус</th><th>Оператор</th><th>Цель</th><th>Действует до</th></tr>${rows
              .map(
                (r) =>
                  `<tr><td><a href="/admin/operations/${esc(r.operationId)}">${esc(r.operationId.slice(0, 8))}…</a></td><td>${esc(r.tool)}</td><td>${esc(r.status)}</td><td><code>${esc(r.principalId)}</code></td><td>${esc(r.target ?? '')}</td><td>${esc(r.expiresAt)}</td></tr>`,
              )
              .join('')}</table>`
          : '<p class="muted">Ожидающих решения операций нет.</p>';
        return html(
          reply,
          200,
          page(
            'Операции',
            `<div class="card"><h2>Планы записи, ожидающие решения</h2>${list}</div>`,
            session,
          ),
        );
      });

      scope.get<{ Params: { id: string } }>('/operations/:id', async (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        const id = req.params.id;
        const row = /^[0-9a-f-]{36}$/.test(id) ? await app.operations.getForPortal(id, portalKey) : undefined;
        if (!row)
          return html(
            reply,
            404,
            page('Операция', '<div class="card"><p class="err">Операция не найдена.</p></div>', session),
          );
        const { view, plan } = await app.approvals.readPlan(id, row.principal_id, portalKey);
        const role = app.admin.role(session.user);
        const own = row.principal_id === session.user.principalId;
        const canDecide = roleAtLeast(role, 'administrator') || (own && roleAtLeast(role, 'operator'));
        const decided =
          typeof (req.query as Record<string, unknown>)['done'] === 'string'
            ? String((req.query as Record<string, unknown>)['done'])
            : '';
        const notice =
          decided === 'approved'
            ? '<p class="ok">Подтверждено. Теперь повторите вызов инструмента с теми же параметрами и approvalId.</p>'
            : decided === 'denied'
              ? '<p class="ok">Отклонено.</p>'
              : '';
        const form =
          view.status === 'prepared' && Date.parse(view.expiresAt) >= Date.now()
            ? canDecide
              ? `<form method="post" action="/admin/operations/${esc(id)}"><input type="hidden" name="_csrf" value="${esc(session.csrf)}">
<p><label>Введите <code>${CONFIRM_WORD}</code>, чтобы разрешить, или <code>${DENY_WORD}</code>, чтобы отклонить<br><input type="text" name="word" autocomplete="off" required></label></p>
<p><button name="decision" value="approve">Разрешить</button> <button class="danger" name="decision" value="deny">Отклонить</button></p></form>`
              : `<p class="err">Решение недоступно: план оператора <code>${esc(row.principal_id)}</code> может подтвердить только administrator (ваша роль: ${esc(role)}).</p>`
            : `<p class="muted">Решение не требуется: операция в состоянии ${esc(view.status)}${Date.parse(view.expiresAt) < Date.now() ? ' (срок истёк)' : ''}.</p>`;
        const body = `<div class="card"><h2>План операции</h2>${notice}
<table><tr><th>operationId</th><td><code>${esc(view.operationId)}</code></td></tr>
<tr><th>Статус</th><td>${esc(view.status)}</td></tr>
<tr><th>Инструмент</th><td>${esc(view.tool)} (${esc(view.operationKind)})</td></tr>
<tr><th>Оператор</th><td><code>${esc(row.principal_id)}</code>${own ? ' (вы)' : ''}</td></tr>
<tr><th>Портал</th><td>${esc(plan.summary.portalOrigin)}</td></tr>
<tr><th>Действие</th><td>${esc(plan.summary.action)}</td></tr>
<tr><th>Цель</th><td>${esc(plan.summary.target)}</td></tr>
<tr><th>Создан</th><td>${esc(view.createdAt)}, действует до ${esc(view.expiresAt)}</td></tr></table>
<h3>Что уйдёт в Bitrix24 (полностью)</h3><pre>${esc(JSON.stringify(plan.summary.details, null, 2))}</pre>
${plan.summary.risks.length ? `<h3>Возможные последствия</h3><ul>${plan.summary.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
${form}</div>`;
        return html(reply, 200, page('Операция', body, session));
      });

      scope.post<{ Params: { id: string } }>('/operations/:id', async (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        const body = req.body as Body;
        if (!requireCsrf(req, reply, session, body?.['_csrf'])) return reply;
        const id = req.params.id;
        const row = /^[0-9a-f-]{36}$/.test(id) ? await app.operations.getForPortal(id, portalKey) : undefined;
        if (!row)
          return html(
            reply,
            404,
            page('Операция', '<div class="card"><p class="err">Операция не найдена.</p></div>', session),
          );
        const role = app.admin.role(session.user);
        const own = row.principal_id === session.user.principalId;
        if (!(roleAtLeast(role, 'administrator') || (own && roleAtLeast(role, 'operator')))) {
          audit(session, 'approve', id, 'denied', 'ACCESS_DENIED');
          return html(
            reply,
            403,
            page(
              'Отказ',
              '<div class="card"><p class="err">Ваша роль не позволяет решать по этому плану.</p></div>',
              session,
            ),
          );
        }
        const decision = body?.['decision'];
        const kind: 'approve' | 'deny' = decision === 'approve' ? 'approve' : 'deny';
        const word = (body?.['word'] ?? '').trim();
        const wanted = decision === 'approve' ? CONFIRM_WORD : decision === 'deny' ? DENY_WORD : undefined;
        if (!wanted || word !== wanted) {
          return html(
            reply,
            400,
            page(
              'Операция',
              `<div class="card"><p class="err">Решение не принято: введите ровно <code>${wanted ?? CONFIRM_WORD}</code>.</p> <a href="/admin/operations/${esc(id)}">Назад к плану</a></div>`,
              session,
            ),
          );
        }
        try {
          if (decision === 'approve') await app.approvals.approve(id, row.principal_id, portalKey);
          else await app.approvals.deny(id, row.principal_id, portalKey);
        } catch (e) {
          const err = AppError.from(e);
          audit(session, kind, id, 'error', err.code);
          return html(
            reply,
            409,
            page(
              'Операция',
              `<div class="card"><p class="err">${esc(err.message)}</p> <a href="/admin/operations/${esc(id)}">Назад к плану</a></div>`,
              session,
            ),
          );
        }
        audit(session, kind, id, 'success');
        app.logger.info({ operationId: id, decision, principalSource: 'admin' }, 'admin decision recorded');
        return reply.redirect(
          `/admin/operations/${id}?done=${decision === 'approve' ? 'approved' : 'denied'}`,
          303,
        );
      });

      const uploadsPage = async (session: AdminSession, notice: string): Promise<string> => {
        const role = app.admin.role(session.user);
        const files = await app.files.listOwn(session.user.principalId);
        const list = files.length
          ? `<table><tr><th>fileToken</th><th>Файл</th><th>Размер</th><th>Сканер</th><th>Действует до</th></tr>${files
              .map(
                (f) =>
                  `<tr><td><code>${esc(f.token)}</code></td><td>${esc(f.originalName)}</td><td>${String(f.size)}</td><td>${esc(f.scanStatus)}</td><td>${esc(f.expiresAt)}</td></tr>`,
              )
              .join('')}</table>`
          : '<p class="muted">Подготовленных файлов нет.</p>';
        const form = roleAtLeast(role, 'operator')
          ? `<form method="post" action="/admin/uploads" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${esc(session.csrf)}">
<p><label>Файл (до ${String(Math.floor(app.config.files.maxUploadBytes / 1024 / 1024))} MiB; txt, md, csv, pdf, docx, xlsx, png, jpg)<br><input type="file" name="file" required></label></p>
<p><button>Подготовить и получить fileToken</button></p></form>
<p class="muted">Файл проверяется${app.config.files.scanRequired ? ' антивирусом' : ''} и кладётся в закрытое хранилище сервера на ${String(Math.round(app.config.files.uploadTtlSeconds / 3600))} ч. Модели передайте только fileToken.</p>`
          : `<p class="err">Загрузка недоступна роли ${esc(role)}.</p>`;
        return page(
          'Файлы',
          `<div class="card"><h2>Web-upload для disk_upload_file</h2>${notice}${form}</div><div class="card"><h3>Ваши подготовленные файлы (оператор <code>${esc(session.user.principalId)}</code>)</h3>${list}</div>`,
          session,
        );
      };

      scope.get('/uploads', async (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        return html(reply, 200, await uploadsPage(session, ''));
      });

      scope.post('/uploads', async (req, reply) => {
        const session = requireSession(req, reply);
        if (!session) return reply;
        if (!roleAtLeast(app.admin.role(session.user), 'operator')) {
          return html(
            reply,
            403,
            page(
              'Отказ',
              '<div class="card"><p class="err">Загрузка недоступна вашей роли.</p></div>',
              session,
            ),
          );
        }
        let part;
        try {
          part = await req.file();
        } catch (e) {
          return html(
            reply,
            400,
            page(
              'Файлы',
              `<div class="card"><p class="err">Не удалось прочитать форму: ${esc((e as Error).message)}</p></div>`,
              session,
            ),
          );
        }
        if (!part) return html(reply, 400, await uploadsPage(session, '<p class="err">Файл не выбран.</p>'));
        if (!requireCsrf(req, reply, session, fieldValue(part.fields, '_csrf'))) return reply;
        let buf: Buffer;
        try {
          buf = await part.toBuffer();
        } catch {
          return html(
            reply,
            413,
            await uploadsPage(session, '<p class="err">Файл больше допустимого размера.</p>'),
          );
        }
        try {
          const m = await app.files.stageUpload(buf, part.filename, session.user.principalId);
          audit(session, 'upload', undefined, 'success');
          return await html(
            reply,
            200,
            await uploadsPage(
              session,
              `<p class="ok">Файл «${esc(m.originalName)}» подготовлен (${String(m.size)} байт, ${esc(m.mime)}, сканер: ${esc(m.scanStatus)}).</p>
<p>fileToken: <code>${esc(m.token)}</code></p><p>sha256: <code>${esc(m.sha256)}</code></p><p>Действует до ${esc(m.expiresAt)}. Передайте fileToken инструменту <code>disk_upload_file</code>.</p>`,
            ),
          );
        } catch (e) {
          const err = AppError.from(e);
          audit(session, 'upload', undefined, 'error', err.code);
          const status = err.code === 'FEATURE_UNAVAILABLE' ? 503 : 400;
          return html(
            reply,
            status,
            await uploadsPage(
              session,
              `<p class="err">${esc(err.message)}${err.details.nextAction ? ` → ${esc(err.details.nextAction)}` : ''}</p>`,
            ),
          );
        }
      });
    },
    { prefix: '/admin' },
  );
}

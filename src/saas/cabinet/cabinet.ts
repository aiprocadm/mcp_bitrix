/**
 * Кабинет клиента `/app` (SaaS-ТЗ §11.1, §11.2, §4 сценарии 1–3, §12 п.2 и п.5).
 *
 * Серверный рендер без JavaScript, CSP `default-src 'self'`, cookie сессии `HttpOnly; Secure; SameSite=Lax`
 * (префикс `__Host-`), CSRF-токен сессии + проверка Origin на каждом POST, лимиты входа и решений.
 *
 * Вход (D4): форма «адрес портала» → одноразовый `state` (префикс `cab.`), привязанный к браузеру cookie bind →
 * авторизация на портале Bitrix24 (BitrixLoginService.authorizeUrl, только установленные порталы — SSRF §12 п.4) →
 * обратный вызов GET /b24/oauth/callback (маршрут сборки режима saas передаёт сюда, если `isCabinetState(state)`) →
 * обмен кода (BitrixLoginService.completeLogin) → сессия кабинета.
 *
 * Подтверждения (D12): тот же ApprovalService, что исполняет вызовы MCP (контекст `scopeFor`) — проверки статуса,
 * срока и хеша плана не обходятся. Чужая или несуществующая операция → одинаковый ответ 404 (§12 п.2, S12).
 */
import multipart, { type MultipartFields } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.js';
import { InboundLimiter } from '../../security/inbound-limiter.js';
import type { OperationRow } from '../../storage/operations.js';
import { portalKeyForMember } from '../bitrix/user-provider.js';
import { normalizePortalDomain } from '../repos/tenants.js';
import { TenantDataDeletion } from '../tenant-deletion.js';
import { registerTenantAdminRoutes, type DeleteTenantData } from './admin-routes.js';
import { approvalShortCode, CONFIRM_WORD, isHighRiskOperation } from './approval-link.js';
import { CABINET_CSS, card, esc, fmtTime, hiddenCsrf, layout } from './html.js';
import {
  CABINET_AUDIT_TOOL,
  CSP_DEFAULT,
  CSP_EXTERNAL_FORM,
  errorText,
  field,
  Kit,
  parseCookies,
  parseForm,
  safeReturnTo,
  type Ctx,
} from './kit.js';
import {
  CABINET_STATE_PREFIX,
  CabinetLoginStates,
  CabinetSessionStore,
  randomToken,
  SESSION_TTL_MS,
} from './sessions.js';
import type { CabinetCallbackRequest, CabinetDeps, CabinetResponse, CabinetScope } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIND_RE = /^[A-Za-z0-9_-]{43}$/;

/** Обратный вызов Bitrix24 с таким state принадлежит кабинету (иначе — серверу авторизации MCP). */
export const isCabinetState = (state: unknown): boolean =>
  typeof state === 'string' && state.startsWith(CABINET_STATE_PREFIX);

export interface Cabinet {
  /** Регистрирует маршруты `/app/*` (плагин Fastify с собственными парсерами форм и заголовками безопасности). */
  register(app: FastifyInstance): void;
  /** GET /b24/oauth/callback при `isCabinetState(query.state)`: завершение входа, выдача сессии. */
  handleBitrixCallback(req: CabinetCallbackRequest): Promise<CabinetResponse>;
  /** То же для маршрута Fastify: разбирает запрос и отправляет ответ. */
  replyBitrixCallback(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  isCabinetState(state: unknown): boolean;
  readonly sessions: CabinetSessionStore;
}

interface OpAccess {
  readonly row: OperationRow;
  readonly own: boolean;
  readonly highRisk: boolean;
  /** Решение принимает администратор (политика admin_for_high_risk). */
  readonly adminReview: boolean;
  readonly canDecide: boolean;
}

const SUB_STATUS: Record<string, string> = {
  trialing: 'пробный период',
  active: 'активна',
  past_due: 'платёж не прошёл — льготный период',
  suspended: 'приостановлена',
  canceled: 'отменена',
};

const OP_STATUS: Record<string, string> = {
  prepared: 'ждёт подтверждения',
  approved: 'подтверждена, ждёт повтора вызова',
  executing: 'выполняется',
  succeeded: 'выполнена',
  failed: 'ошибка',
  unknown: 'результат неизвестен',
  denied: 'отклонена',
  expired: 'истекла',
};

/** Значение cookie-подсказки: битая кодировка — пустая строка (а не 500). */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return '';
  }
}

function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const f = fields[name];
  const v = Array.isArray(f) ? f[0] : f;
  return v?.type === 'field' && typeof v.value === 'string' ? v.value : undefined;
}

export function createCabinet(deps: CabinetDeps): Cabinet {
  const now = deps.now ?? Date.now;
  const sessions = new CabinetSessionStore(deps.db, now);
  const states = new CabinetLoginStates(deps.db, now);
  const kit = new Kit(deps, sessions, now);
  const loginLimiter = new InboundLimiter(deps.loginPerMinute ?? 10, now);
  const decisionLimiter = new InboundLimiter(deps.decisionsPerMinute ?? 30, now);
  const deleteData: DeleteTenantData =
    deps.deleteTenantData ??
    (() => {
      if (!deps.fileStaging)
        throw new AppError('CONFIG_INVALID', 'Кабинет: нужен fileStaging или deleteTenantData', {
          field: 'fileStaging',
        });
      const deletion = new TenantDataDeletion({
        db: deps.db,
        keys: deps.keys,
        fileStaging: deps.fileStaging,
        revokeTenant: deps.revokeTenant,
        coordination: deps.coordination,
        logger: deps.logger,
        now,
      });
      return (tenantId, req) => deletion.deleteAll(tenantId, req);
    })();

  const response = (status: number, body: string, extra: Partial<CabinetResponse> = {}): CabinetResponse => ({
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP_DEFAULT,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...extra.headers,
    },
    setCookies: extra.setCookies ?? [],
    body,
  });
  const messagePage = (title: string, text: string) =>
    layout(title, card(`<h2>${esc(title)}</h2><p>${text}</p><p><a href="/app/login">Войти снова</a></p>`));

  async function handleBitrixCallback(req: CabinetCallbackRequest): Promise<CabinetResponse> {
    const q = req.query ?? {};
    const str = (k: string): string | undefined => (typeof q[k] === 'string' ? q[k] : undefined);
    try {
      loginLimiter.take(`cb:${req.ip ?? 'unknown'}`);
    } catch {
      return response(429, messagePage('Слишком много попыток', 'Подождите минуту и войдите снова.'));
    }
    const state = str('state');
    const bind = parseCookies(req.cookie).get(kit.bindCookie);
    // Состояние сгорает при любой попытке (в том числе из чужого браузера): повтор невозможен.
    const login = state
      ? await states.consume(state, bind && BIND_RE.test(bind) ? bind : undefined)
      : undefined;
    const clearBind = kit.cookie(kit.bindCookie, '', 0);
    if (!login) {
      return response(
        400,
        messagePage(
          'Ссылка входа устарела',
          'Вход начат в другом браузере или истёк срок. Начните вход заново.',
        ),
        { setCookies: [clearBind] },
      );
    }
    if (str('error')) {
      return response(200, messagePage('Вход отменён', 'Вход через Bitrix24 не выполнен.'), {
        setCookies: [clearBind],
      });
    }
    const code = str('code');
    if (!code || code.length > 512) {
      return response(400, messagePage('Вход не выполнен', 'Bitrix24 не передал код авторизации.'), {
        setCookies: [clearBind],
      });
    }
    let result;
    try {
      result = await deps.login.completeLogin(code);
    } catch (e) {
      const err = AppError.from(e);
      deps.logger.warn(
        { event: 'cabinet.login_failed', code: err.code, reason: err.details.reason },
        'cabinet login failed',
      );
      const status = err.code === 'ACCESS_DENIED' ? 403 : err.code === 'NOT_FOUND' ? 404 : 502;
      const text =
        err.code === 'ACCESS_DENIED' || err.code === 'NOT_FOUND' || err.code === 'CONFLICT'
          ? esc(errorText(err))
          : 'Не удалось войти через Bitrix24, попробуйте ещё раз.';
      return response(status, messagePage('Вход не выполнен', text), { setCookies: [clearBind] });
    }
    if (result.tenant.domain !== login.portal) {
      return response(
        400,
        messagePage(
          'Вход не выполнен',
          'Вход выполнен в другой портал, чем был указан. Начните вход заново.',
        ),
        { setCookies: [clearBind] },
      );
    }
    const opened = await sessions.open(result.tenant.id, result.user.id);
    const oldCookie = parseCookies(req.cookie).get(kit.sessionCookie);
    if (oldCookie) await sessions.close(oldCookie);
    await deps.audit.record({
      tenantId: result.tenant.id,
      requestId: randomToken(12),
      principalId: result.user.id,
      portalKey: portalKeyForMember(result.tenant.memberId),
      tool: CABINET_AUDIT_TOOL,
      operationKind: 'login',
      outcome: 'success',
      durationMs: 0,
    });
    deps.logger.info({ tenantId: result.tenant.id }, 'cabinet session opened');
    return response(303, '', {
      headers: { Location: safeReturnTo(login.returnTo) },
      setCookies: [
        clearBind,
        kit.cookie(kit.sessionCookie, opened.cookieValue, Math.floor(SESSION_TTL_MS / 1000)),
      ],
    });
  }

  async function replyBitrixCallback(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const res = await handleBitrixCallback({
      query: req.query as Record<string, unknown>,
      cookie: req.headers.cookie,
      ip: req.ip,
    });
    reply.code(res.status);
    for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
    if (res.setCookies.length) reply.header('Set-Cookie', res.setCookies);
    return reply.send(res.body);
  }

  /** Доступ к операции: своя, либо (администратор при политике admin_for_high_risk) операция повышенного риска. */
  async function opAccess(ctx: Ctx, scope: CabinetScope, id: string): Promise<OpAccess | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const row = await scope.operations.get(id);
    if (row?.portal_key !== scope.auth.portalKey) return undefined;
    const own = row.principal_id === scope.principal.id;
    const highRisk = isHighRiskOperation(row.tool, row.operation_kind);
    const policy = (await deps.settings.get(ctx.tenant.id)).approvalPolicy;
    const adminReview = highRisk && policy === 'admin_for_high_risk';
    if (!own && !(adminReview && ctx.isAdmin)) return undefined;
    const canDecide = adminReview ? ctx.isAdmin : own && kit.canOperate(ctx);
    return { row, own, highRisk, adminReview, canDecide };
  }

  const notFound = (reply: FastifyReply, ctx: Ctx) =>
    kit.html(
      reply,
      404,
      kit.page('Операция', card('<h2>Операция не найдена</h2><p class="err">Операция не найдена.</p>'), ctx),
    );

  function register(app: FastifyInstance): void {
    void app.register(
      async (scope) => {
        await scope.register(multipart, {
          limits: { fileSize: deps.files.maxUploadBytes, files: 1, fields: 8, parts: 12 },
        });
        if (scope.hasContentTypeParser('application/x-www-form-urlencoded'))
          scope.removeContentTypeParser('application/x-www-form-urlencoded');
        scope.addContentTypeParser(
          'application/x-www-form-urlencoded',
          { parseAs: 'string', bodyLimit: 64 * 1024 },
          (_req, body, done) => {
            done(null, parseForm(String(body)));
          },
        );
        scope.addHook('onRequest', async (_req, reply) => {
          reply.header('Content-Security-Policy', CSP_DEFAULT);
          reply.header('X-Content-Type-Options', 'nosniff');
          reply.header('X-Frame-Options', 'DENY');
          reply.header('Referrer-Policy', 'no-referrer');
          reply.header('Cache-Control', 'no-store');
        });

        scope.get('/static/cabinet.css', (_req, reply) =>
          reply
            .header('Cache-Control', 'public, max-age=3600')
            .type('text/css; charset=utf-8')
            .send(CABINET_CSS),
        );

        // ───────────────────────────── вход и выход ─────────────────────────────

        const loginForm = (portal: string, next: string, error = '', reauth = false) =>
          layout(
            'Вход',
            card(`<h2>Вход в кабинет через Bitrix24</h2>${reauth ? '<p class="banner">Для этого действия нужен свежий вход (не старше 15 минут). Войдите ещё раз.</p>' : ''}
${error ? `<p class="err">${error}</p>` : ''}
<form method="post" action="/app/login">
<input type="hidden" name="next" value="${esc(next)}">
<p><label>Адрес вашего портала Bitrix24<br><input type="text" name="portal" required maxlength="253" placeholder="company.bitrix24.ru" value="${esc(portal)}" autocomplete="url"></label></p>
<p><button>Войти через Bitrix24</button></p></form>
<p class="muted">Пароль Bitrix24 вводится только на странице вашего портала; сервис его не получает и не хранит.</p>`),
          );

        scope.get('/login', async (req, reply) => {
          const q = req.query as Record<string, unknown>;
          const next = safeReturnTo(typeof q['next'] === 'string' ? q['next'] : undefined);
          const reauth = q['reauth'] === '1';
          if (!reauth && (await kit.context(req))) return reply.redirect(next, 303);
          const hint =
            (typeof q['portal'] === 'string' && q['portal']) ||
            (typeof q['DOMAIN'] === 'string' && q['DOMAIN']) ||
            safeDecode(parseCookies(req.headers.cookie).get(kit.asPortalCookie) ?? '');
          return kit.html(reply, 200, loginForm(hint.slice(0, 253), next, '', reauth), CSP_EXTERNAL_FORM);
        });

        scope.post('/login', async (req, reply) => {
          if (!kit.sameOrigin(req))
            return kit.message(reply, 403, 'Отказ', 'Запрос пришёл не со страницы кабинета.');
          const next = safeReturnTo(field(req.body, 'next'));
          const portalRaw = field(req.body, 'portal') ?? '';
          try {
            loginLimiter.take(`login:${req.ip}`);
          } catch {
            deps.logger.warn({ reason: 'cabinet_login_rate' }, 'cabinet login throttled');
            return kit.html(
              reply,
              429,
              loginForm(portalRaw, next, 'Слишком много попыток. Подождите минуту.'),
            );
          }
          let portal: string;
          try {
            portal = normalizePortalDomain(portalRaw);
          } catch {
            return kit.html(
              reply,
              400,
              loginForm(portalRaw, next, 'Укажите адрес портала, например company.bitrix24.ru'),
              CSP_EXTERNAL_FORM,
            );
          }
          const existing = parseCookies(req.headers.cookie).get(kit.bindCookie);
          const bind = existing && BIND_RE.test(existing) ? existing : randomToken(32);
          const state = await states.create(bind, portal, next);
          let url: string;
          try {
            url = await deps.login.authorizeUrl(portal, state);
          } catch (e) {
            const err = AppError.from(e);
            if (err.code === 'NOT_FOUND')
              return kit.html(
                reply,
                200,
                layout(
                  'Установите приложение',
                  card(`<h2>Приложение не установлено на портале ${esc(portal)}</h2>
<p>Администратору портала: установите приложение «MCP для Bitrix24» из Маркета Bitrix24 (или по ссылке от сервиса), затем войдите снова.</p>
<p><a href="/app/login">Назад</a></p>`),
                ),
              );
            return kit.html(reply, 400, loginForm(portalRaw, next, esc(errorText(err))), CSP_EXTERNAL_FORM);
          }
          if (!url.startsWith('https://') && !url.startsWith('http://'))
            throw new AppError('INTERNAL_ERROR', 'Некорректный адрес входа Bitrix24');
          return reply
            .header('Set-Cookie', kit.cookie(kit.bindCookie, bind, Math.floor((10 * 60_000) / 1000)))
            .redirect(url, 303);
        });

        scope.post('/logout', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          if (!kit.requireCsrf(req, reply, ctx, field(req.body, '_csrf'))) return reply;
          await sessions.close(parseCookies(req.headers.cookie).get(kit.sessionCookie));
          return reply.header('Set-Cookie', kit.cookie(kit.sessionCookie, '', 0)).redirect('/app/login', 303);
        });

        // ───────────────────────────── начало ─────────────────────────────

        scope.get('/', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          const sub = await deps.subscriptions.get(ctx.tenant.id);
          const plan = sub ? await deps.plans.get(sub.planCode) : undefined;
          const banner =
            sub?.status === 'past_due'
              ? `<p class="banner">Платёж не прошёл. Инструменты работают в льготный период; ${ctx.isAdmin ? '<a href="/app/admin/billing">оплатите подписку</a>' : 'сообщите администратору портала'}.</p>`
              : sub?.status === 'suspended' || sub?.status === 'canceled' || !sub
                ? `<p class="banner">Подписка неактивна: инструменты MCP недоступны (кроме диагностики). ${ctx.isAdmin ? '<a href="/app/admin/billing">Оплатить</a>' : 'Обратитесь к администратору портала.'}</p>`
                : ctx.tenant.status === 'suspended'
                  ? '<p class="banner">Доступ портала к сервису приостановлен владельцем сервиса.</p>'
                  : '';
          const subText = sub
            ? `<p>Тариф: <strong>${esc(plan?.name ?? sub.planCode)}</strong>; статус: ${esc(SUB_STATUS[sub.status] ?? sub.status)}${sub.cancelAtPeriodEnd ? ' (отменена, действует до конца периода)' : ''}; период до ${esc(fmtTime(sub.periodEnd))}.</p>`
            : '<p>Подписка не оформлена.</p>';
          let usage = '';
          if (deps.usage && plan) {
            const all = await deps.usage.monthUsage(ctx.tenant.id);
            const mine = await deps.usage.monthUsage(ctx.tenant.id, ctx.user.id);
            usage = `<h3>Использование за месяц</h3><table>
<tr><th></th><th>Портал</th><th>Вы</th><th>Лимит тарифа</th></tr>
<tr><td>Вызовы</td><td>${String(all.calls)}</td><td>${String(mine.calls)}</td><td>${String(plan.limits.callsPerMonth)}</td></tr>
<tr><td>Записи</td><td>${String(all.writes)}</td><td>${String(mine.writes)}</td><td>${String(plan.limits.writesPerMonth)}</td></tr></table>
<p class="muted">Данные с задержкой до 1 минуты.</p>`;
          }
          const scopeCtx = await kit.scope(ctx);
          const pending = await scopeCtx.approvals.listPending(
            scopeCtx.principal.id,
            scopeCtx.auth.portalKey,
          );
          const body = `${banner}${card(`<h2>Здравствуйте, ${esc(ctx.nav.userName)}</h2>${subText}
<p><a href="/app/connect"><strong>Подключить к Claude / ChatGPT →</strong></a></p>
${pending.length ? `<p>Ожидают вашего подтверждения: <a href="/app/approvals">${String(pending.length)}</a>.</p>` : ''}`)}
${usage ? card(usage) : ''}`;
          return kit.html(reply, 200, kit.page('Начало', body, ctx));
        });

        // ───────────────────────────── подключение ─────────────────────────────

        scope.get('/connect', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          const mcpUrl = `${kit.base}/mcp`;
          const q = req.query as Record<string, unknown>;
          let check = '';
          if (q['check'] === '1') {
            const last = await deps.audit.lastSuccessAt(ctx.tenant.id, ctx.user.id, [CABINET_AUDIT_TOOL]);
            check = last
              ? `<p class="ok">Подключение работает: последний успешный вызов — ${esc(fmtTime(last.ts))} (инструмент <code>${esc(last.tool)}</code>).</p>`
              : '<p class="err">Успешных вызовов от вашего имени пока нет. Подключите клиент по инструкции ниже и попросите модель, например, «покажи информацию о подключении к Bitrix24», затем проверьте снова.</p>';
          }
          const body =
            card(`<h2>Подключение к Claude или ChatGPT</h2>
<p>Адрес MCP-сервера: <code>${esc(mcpUrl)}</code></p>
<p>Вход при подключении — через ваш Bitrix24 (OAuth). Модель работает с правами вашей учётной записи Bitrix24; каждую запись вы подтверждаете в этом кабинете.</p>
<form method="get" action="/app/connect"><input type="hidden" name="check" value="1"><button>Проверить подключение</button></form>${check}`) +
            card(`<h3>Claude Desktop</h3><ol class="steps">
<li>Откройте «Настройки» → «Коннекторы» (Settings → Connectors).</li>
<li>Нажмите «Добавить пользовательский коннектор» (Add custom connector).</li>
<li>Название — «Bitrix24», адрес — <code>${esc(mcpUrl)}</code>. Сохраните.</li>
<li>Нажмите «Подключить» (Connect): откроется браузер — укажите адрес портала и войдите через Bitrix24, разрешите доступ.</li>
<li>В новом чате включите коннектор «Bitrix24» в меню инструментов.</li></ol>`) +
            card(`<h3>Claude Code</h3><ol class="steps">
<li>В терминале выполните: <code>claude mcp add --transport http bitrix24 ${esc(mcpUrl)}</code></li>
<li>Запустите <code>claude</code>, введите команду <code>/mcp</code>, выберите «bitrix24» → «Authenticate».</li>
<li>В браузере укажите адрес портала и войдите через Bitrix24.</li></ol>`) +
            card(`<h3>claude.ai (веб)</h3><ol class="steps">
<li>Откройте «Settings» → «Connectors» → «Add custom connector» (в командных тарифах коннектор добавляет владелец организации).</li>
<li>Адрес — <code>${esc(mcpUrl)}</code>, затем «Connect» и вход через Bitrix24.</li>
<li>В чате включите коннектор в меню инструментов.</li></ol>`) +
            card(`<h3>ChatGPT</h3><ol class="steps">
<li>Откройте «Настройки» → «Приложения и коннекторы» (Apps &amp; Connectors) → «Дополнительно» и включите режим разработчика (Developer mode), если он нужен вашему тарифу.</li>
<li>«Создать» (Create) коннектор: адрес MCP — <code>${esc(mcpUrl)}</code>, аутентификация — OAuth.</li>
<li>Войдите через Bitrix24 и включите коннектор в чате.</li></ol>
<p class="muted">Названия пунктов меню клиентов меняются; если пункт называется иначе — ищите «коннектор» / «MCP-сервер».</p>`);
          return kit.html(reply, 200, kit.page('Подключение', body, ctx));
        });

        // ───────────────────────────── подтверждения ─────────────────────────────

        scope.get('/approvals', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          const sc = await kit.scope(ctx);
          const own = await sc.approvals.listPending(sc.principal.id, sc.auth.portalKey);
          const rows: { view: (typeof own)[number]; who: string }[] = own.map((view) => ({
            view,
            who: 'вы',
          }));
          const settings = await deps.settings.get(ctx.tenant.id);
          if (ctx.isAdmin && settings.approvalPolicy === 'admin_for_high_risk') {
            const names = new Map((await deps.users.list(ctx.tenant.id)).map((u) => [u.id, u.displayName]));
            for (const v of await sc.operations.listPendingAll(sc.auth.portalKey)) {
              if (v.principalId === sc.principal.id || !isHighRiskOperation(v.tool, v.operationKind))
                continue;
              rows.push({ view: v, who: names.get(v.principalId) ?? 'сотрудник' });
            }
          }
          const list = rows.length
            ? `<table><tr><th>Операция</th><th>Инструмент</th><th>Статус</th><th>Кто</th><th>Цель</th><th>Действует до</th></tr>${rows
                .map(
                  ({ view: r, who }) =>
                    `<tr><td><a href="/app/approvals/${esc(r.operationId)}">${esc(approvalShortCode(r.operationId))}</a></td><td>${esc(r.tool)}${isHighRiskOperation(r.tool, r.operationKind) ? ' <strong class="err">повышенный риск</strong>' : ''}</td><td>${esc(OP_STATUS[r.status] ?? r.status)}</td><td>${esc(who)}</td><td>${esc(r.target ?? '')}</td><td>${esc(fmtTime(r.expiresAt))}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">Ожидающих решения операций нет.</p>';
          return kit.html(
            reply,
            200,
            kit.page('Подтверждения', card(`<h2>Записи, ожидающие решения</h2>${list}`), ctx),
          );
        });

        scope.get<{ Params: { operationId: string } }>('/approvals/:operationId', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          const id = req.params.operationId;
          const sc = await kit.scope(ctx);
          const access = await opAccess(ctx, sc, id);
          if (!access) return notFound(reply, ctx);
          const { row } = access;
          let plan;
          let view;
          try {
            ({ view, plan } = await sc.approvals.readPlan(id, row.principal_id, sc.auth.portalKey));
          } catch {
            return notFound(reply, ctx);
          }
          const done = (req.query as Record<string, unknown>)['done'];
          const notice =
            done === 'approved'
              ? '<p class="ok">Подтверждено. Вернитесь в чат и напишите «готово» — модель повторит вызов с approvalId.</p>'
              : done === 'denied'
                ? '<p class="ok">Отклонено. Запись не будет выполнена.</p>'
                : '';
          const open = view.status === 'prepared' && Date.parse(view.expiresAt) >= now();
          let form: string;
          if (!open) {
            form = `<p class="muted">Решение не требуется: операция в состоянии «${esc(OP_STATUS[view.status] ?? view.status)}»${Date.parse(view.expiresAt) < now() ? ' (срок истёк)' : ''}.</p>`;
          } else if (!access.canDecide) {
            form = access.adminReview
              ? '<p class="err">Операции повышенного риска на этом портале подтверждает администратор арендатора.</p>'
              : '<p class="err">Ваша роль в сервисе не позволяет подтверждать записи.</p>';
          } else if (access.highRisk && !kit.fresh(ctx)) {
            form = `<p class="banner">Удаление или массовая замена: нужен свежий вход (не старше 15 минут). <a href="${esc(kit.reloginLink(`/app/approvals/${id}`))}">Войти заново через Bitrix24</a></p>
<form method="post" action="/app/approvals/${esc(id)}">${hiddenCsrf(ctx.session.csrf)}<button class="danger" name="decision" value="deny">Отклоняю</button></form>`;
          } else {
            form = `<form method="post" action="/app/approvals/${esc(id)}">${hiddenCsrf(ctx.session.csrf)}
${access.highRisk ? `<p><label>Это удаление или массовая замена. Для подтверждения введите слово <code>${CONFIRM_WORD}</code><br><input type="text" name="word" autocomplete="off"></label></p>` : ''}
<p><button name="decision" value="approve">Подтверждаю</button> <button class="danger" name="decision" value="deny">Отклоняю</button></p></form>`;
          }
          const owner = access.own
            ? 'вы'
            : ((await deps.users.get(ctx.tenant.id, row.principal_id))?.displayName ?? 'сотрудник');
          const body = card(`<h2>План записи</h2>${notice}
<table><tr><th>Код для сверки</th><td><strong>${esc(approvalShortCode(view.operationId))}</strong> (сравните с кодом в чате)</td></tr>
<tr><th>operationId</th><td><code>${esc(view.operationId)}</code></td></tr>
<tr><th>Статус</th><td>${esc(OP_STATUS[view.status] ?? view.status)}</td></tr>
<tr><th>Инструмент</th><td>${esc(view.tool)} (${esc(view.operationKind)})${access.highRisk ? ' — <strong class="err">повышенный риск</strong>' : ''}</td></tr>
<tr><th>Автор</th><td>${esc(owner)}</td></tr>
<tr><th>Портал</th><td>${esc(plan.summary.portalOrigin)}</td></tr>
<tr><th>Действие</th><td>${esc(plan.summary.action)}</td></tr>
<tr><th>Цель</th><td>${esc(plan.summary.target)}</td></tr>
<tr><th>Создан</th><td>${esc(fmtTime(view.createdAt))}, действует до ${esc(fmtTime(view.expiresAt))}</td></tr></table>
<h3>Что уйдёт в Bitrix24 (полностью)</h3><pre>${esc(JSON.stringify(plan.summary.details, null, 2))}</pre>
${plan.summary.risks.length ? `<h3>Возможные последствия</h3><ul>${plan.summary.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
${form}`);
          return kit.html(reply, 200, kit.page('Подтверждение', body, ctx));
        });

        scope.post<{ Params: { operationId: string } }>('/approvals/:operationId', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          if (!kit.requireCsrf(req, reply, ctx, field(req.body, '_csrf'))) return reply;
          try {
            decisionLimiter.take(`decide:${ctx.tenant.id}:${ctx.user.id}`);
          } catch {
            return kit.message(reply, 429, 'Слишком много решений', 'Подождите минуту.', ctx);
          }
          const id = req.params.operationId;
          const sc = await kit.scope(ctx);
          const access = await opAccess(ctx, sc, id);
          if (!access) return notFound(reply, ctx);
          const decision = field(req.body, 'decision');
          if (decision !== 'approve' && decision !== 'deny')
            return kit.message(
              reply,
              400,
              'Решение не принято',
              'Выберите «Подтверждаю» или «Отклоняю».',
              ctx,
            );
          const back = `<a href="/app/approvals/${esc(id)}">Назад к плану</a>`;
          if (!access.canDecide) {
            await kit.audit(ctx, decision, 'denied', {
              approvalId: id,
              errorCode: 'ACCESS_DENIED',
              portalKey: sc.auth.portalKey,
            });
            return kit.message(reply, 403, 'Отказ', `Вы не можете решать по этой операции. ${back}`, ctx);
          }
          if (decision === 'approve' && access.highRisk) {
            if (!kit.fresh(ctx))
              return kit.message(
                reply,
                403,
                'Нужен свежий вход',
                `Удаление или массовая замена подтверждается только после входа не старше 15 минут. <a href="${esc(kit.reloginLink(`/app/approvals/${id}`))}">Войти заново</a>`,
                ctx,
              );
            if ((field(req.body, 'word') ?? '').trim() !== CONFIRM_WORD)
              return kit.message(
                reply,
                400,
                'Решение не принято',
                `Введите ровно <code>${CONFIRM_WORD}</code>. ${back}`,
                ctx,
              );
          }
          try {
            if (decision === 'approve')
              await sc.approvals.approve(id, access.row.principal_id, sc.auth.portalKey);
            else await sc.approvals.deny(id, access.row.principal_id, sc.auth.portalKey);
          } catch (e) {
            const err = AppError.from(e);
            await kit.audit(ctx, decision, 'error', {
              approvalId: id,
              errorCode: err.code,
              portalKey: sc.auth.portalKey,
            });
            if (err.code === 'NOT_FOUND') return notFound(reply, ctx);
            return kit.message(reply, 409, 'Решение не принято', `${esc(errorText(err))} ${back}`, ctx);
          }
          await kit.audit(ctx, decision, 'success', { approvalId: id, portalKey: sc.auth.portalKey });
          deps.logger.info(
            { tenantId: ctx.tenant.id, operationId: id, decision },
            'cabinet decision recorded',
          );
          return reply.redirect(
            `/app/approvals/${id}?done=${decision === 'approve' ? 'approved' : 'denied'}`,
            303,
          );
        });

        // ───────────────────────────── история ─────────────────────────────

        scope.get('/history', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          const sc = await kit.scope(ctx);
          const ops = await sc.operations.listRecent(sc.principal.id, sc.auth.portalKey, 100);
          const list = ops.length
            ? `<table><tr><th>Время</th><th>Инструмент</th><th>Объект</th><th>Статус</th><th>Код ошибки</th></tr>${ops
                .map(
                  (o) =>
                    `<tr><td>${esc(fmtTime(o.finishedAt ?? o.approvedAt ?? o.createdAt))}</td><td>${esc(o.tool)}</td><td>${esc(o.target ?? '')}</td><td>${o.status === 'prepared' ? `<a href="/app/approvals/${esc(o.operationId)}">${esc(OP_STATUS[o.status])}</a>` : esc(OP_STATUS[o.status] ?? o.status)}</td><td>${esc(o.errorCode ?? '')}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">Записей пока не было.</p>';
          return kit.html(
            reply,
            200,
            kit.page(
              'История',
              card(
                `<h2>Ваши операции записи</h2><p class="muted">Последние 100. Тела ответов Bitrix24 здесь не хранятся и не показываются.</p>${list}`,
              ),
              ctx,
            ),
          );
        });

        // ───────────────────────────── файлы ─────────────────────────────

        const filesPage = async (ctx: Ctx, sc: CabinetScope, notice: string): Promise<string> => {
          const files = await sc.files.listOwn(sc.principal.id);
          const list = files.length
            ? `<table><tr><th>fileToken</th><th>Файл</th><th>Размер</th><th>Сканер</th><th>Действует до</th></tr>${files
                .map(
                  (f) =>
                    `<tr><td><code>${esc(f.token)}</code></td><td>${esc(f.originalName)}</td><td>${String(f.size)}</td><td>${esc(f.scanStatus)}</td><td>${esc(fmtTime(f.expiresAt))}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">Подготовленных файлов нет.</p>';
          const form = kit.canOperate(ctx)
            ? `<form method="post" action="/app/files" enctype="multipart/form-data">${hiddenCsrf(ctx.session.csrf)}
<p><label>Файл (до ${String(Math.floor(deps.files.maxUploadBytes / 1024 / 1024))} МиБ; txt, md, csv, pdf, docx, xlsx, png, jpg)<br><input type="file" name="file" required></label></p>
<p><button>Подготовить и получить fileToken</button></p></form>
<p class="muted">Файл ${deps.files.scanRequired ? 'проверяется антивирусом и ' : ''}хранится в закрытом хранилище сервиса ${String(Math.round(deps.files.uploadTtlSeconds / 3600))} ч. Модели передайте только fileToken — для инструмента <code>disk_upload_file</code>.</p>`
            : '<p class="err">Загрузка недоступна вашей роли.</p>';
          return kit.page(
            'Файлы',
            card(`<h2>Загрузка файла для disk_upload_file</h2>${notice}${form}`) +
              card(`<h3>Ваши подготовленные файлы</h3>${list}`),
            ctx,
          );
        };

        scope.get('/files', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          return kit.html(reply, 200, await filesPage(ctx, await kit.scope(ctx), ''));
        });

        scope.post('/files', async (req, reply) => {
          const ctx = await kit.requireCtx(req, reply);
          if (!ctx) return reply;
          if (!kit.canOperate(ctx))
            return kit.message(reply, 403, 'Отказ', 'Загрузка недоступна вашей роли.', ctx);
          const sc = await kit.scope(ctx);
          let part;
          try {
            part = await req.file();
          } catch {
            return kit.message(reply, 400, 'Файлы', 'Не удалось прочитать форму.', ctx);
          }
          if (!part)
            return kit.html(reply, 400, await filesPage(ctx, sc, '<p class="err">Файл не выбран.</p>'));
          if (!kit.requireCsrf(req, reply, ctx, fieldValue(part.fields, '_csrf'))) return reply;
          let buf: Buffer;
          try {
            buf = await part.toBuffer();
          } catch {
            return kit.html(
              reply,
              413,
              await filesPage(ctx, sc, '<p class="err">Файл больше допустимого размера.</p>'),
            );
          }
          try {
            const m = await sc.files.stageUpload(buf, part.filename, sc.principal.id);
            await kit.audit(ctx, 'upload', 'success', { portalKey: sc.auth.portalKey });
            return await kit.html(
              reply,
              200,
              await filesPage(
                ctx,
                sc,
                `<p class="ok">Файл «${esc(m.originalName)}» подготовлен (${String(m.size)} байт, ${esc(m.mime)}, сканер: ${esc(m.scanStatus)}).</p>
<p>fileToken: <code>${esc(m.token)}</code></p><p>Действует до ${esc(fmtTime(m.expiresAt))}. Передайте fileToken инструменту <code>disk_upload_file</code>.</p>`,
              ),
            );
          } catch (e) {
            const err = AppError.from(e);
            await kit.audit(ctx, 'upload', 'error', { errorCode: err.code, portalKey: sc.auth.portalKey });
            return kit.html(
              reply,
              err.code === 'FEATURE_UNAVAILABLE' ? 503 : 400,
              await filesPage(ctx, sc, `<p class="err">${esc(errorText(err))}</p>`),
            );
          }
        });

        registerTenantAdminRoutes(scope, kit, deleteData);
      },
      { prefix: '/app' },
    );
  }

  return {
    register,
    handleBitrixCallback,
    replyBitrixCallback,
    isCabinetState,
    sessions,
  };
}

/** Кабинет на экземпляре Fastify: `/app/*`. Обратный вызов входа вешает сборка режима saas (см. Cabinet). */
export function registerCabinet(app: FastifyInstance, deps: CabinetDeps): Cabinet {
  const cabinet = createCabinet(deps);
  cabinet.register(app);
  return cabinet;
}

/**
 * Панель владельца `/owner` (SaaS-ТЗ §11.3, §12 п.5, D15) — HTTP-маршруты Fastify.
 *
 * Безопасность (по образцу `/admin`, src/http/admin.ts, но строже):
 *  - вход — отдельная учётная запись: email + пароль + TOTP (не Bitrix24, не токен MCP); лимит попыток по IP и по
 *    учётной записи (Coordination — общий для экземпляров) + блокировка учётной записи в БД;
 *  - cookie сессии `HttpOnly; Secure; SameSite=Strict; Path=/owner`, в БД — только SHA-256;
 *  - каждый POST: проверка Origin (или Sec-Fetch-Site/Referer) + CSRF-токен сессии;
 *  - CSP `default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`
 *    (стили — внешним файлом, JavaScript нет), X-Frame-Options DENY, no-store, no-referrer;
 *  - действия — только через OwnerService (журнал `support_actions`); данных порталов и токенов в панели нет.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import type { SqlDb } from '../../storage/sql.js';
import type { SecretBox } from '../../security/crypto.js';
import type { EntitlementService } from '../billing/entitlements.js';
import type { SubscriptionService } from '../billing/subscription-service.js';
import type { Coordination } from '../coordination.js';
import type { MetricsRegistry } from '../ops/metrics.js';
import type { Plan, PlansRepo, SubscriptionsRepo } from '../repos/plans.js';
import type { TenantStatus, TenantsRepo } from '../repos/tenants.js';
import { OWNER_SESSION_TTL_MS, OwnerAccounts, type OwnerSession } from './accounts.js';
import type { AnnouncementLevel } from './announcements.js';
import {
  OWNER_CSS,
  announcementsPage,
  esc,
  journalPage,
  layout,
  loginPage,
  messagePage,
  metricsPage,
  paymentsPage,
  plansPage,
  tenantDetailPage,
  tenantsPage,
} from './pages.js';
import { OwnerService } from './service.js';

/** Зависимости панели владельца: подключает сборка режима saas (`src/saas/runtime.ts`). */
export interface OwnerPanelDeps {
  /** PostgreSQL сервиса (роль без BYPASSRLS; таблицы арендатора читаются через withTenant). */
  readonly db: SqlDb;
  /** Ключ секретов TOTP владельцев: `ownerSecretsBox(kek)` (HKDF из KEK, отдельно от DEK арендаторов). */
  readonly ownerSecrets: SecretBox;
  readonly tenants: TenantsRepo;
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
  /** markInvoicePaid / refund (журнал support_actions — внутри). */
  readonly billing: SubscriptionService;
  /** Лимиты входа (общие для экземпляров) и события `billing:entitlements` / `tenant-invalidate`. */
  readonly coordination: Coordination;
  /** Отзыв доступа арендатора при блокировке (§7.4) — `OAuthServer.revokeTenant`. */
  readonly revokeTenant: (tenantId: string) => Promise<{ refreshRevoked: number; operationsDenied: number }>;
  /** Кэш прав этого экземпляра (сброс сразу, остальные — по событию). */
  readonly entitlements?: EntitlementService;
  /** Реестр метрик процесса (S8) — для страницы «Метрики». */
  readonly metrics?: MetricsRegistry;
  readonly logger: AppLogger;
  /** Публичный origin сервиса (PUBLIC_BASE_URL) — для проверки Origin у POST. */
  readonly publicOrigin: string;
  /** Часы (тесты TOTP и блокировок). */
  readonly now?: () => number;
  /** Лимиты попыток входа: по IP и по учётной записи за окно (по умолчанию 20 и 10 за 15 минут). */
  readonly loginLimits?: { perIp: number; perAccount: number; windowMs: number };
}

const COOKIE = 'mcp_owner';
const CSP =
  "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

type Body = Record<string, string | undefined> | undefined;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(value: string, maxAgeSec: number): string {
  return `${COOKIE}=${value}; Path=/owner; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(maxAgeSec)}`;
}

const NOTICES: Record<string, string> = {
  trial: 'Пробный период продлён.',
  blocked: 'Арендатор заблокирован, доступ отозван.',
  unblocked: 'Арендатор разблокирован.',
  paid: 'Оплата счёта отмечена, подписка активирована.',
  already: 'Счёт уже был отмечен оплаченным — ничего не изменилось.',
  refund: 'Возврат отправлен провайдеру.',
  plan: 'Тариф сохранён.',
  ann: 'Объявление опубликовано.',
  annoff: 'Объявление снято.',
};

const notice = (req: FastifyRequest): string => {
  const k = (req.query as Record<string, unknown> | undefined)?.['ok'];
  const text = typeof k === 'string' ? NOTICES[k] : undefined;
  return text ? `<p class="ok">${esc(text)}</p>` : '';
};

/** «990», «990.5», «990,50» → копейки (целые, без float). */
function parseRubles(v: string | undefined, field: string): number {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec((v ?? '').trim());
  if (!m?.[1]) throw new AppError('VALIDATION_ERROR', 'Сумма в рублях, например 990.00', { field });
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function parseIntField(v: string | undefined, field: string, min: number, max: number): number {
  const s = (v ?? '').trim();
  if (!/^-?\d{1,12}$/.test(s)) throw new AppError('VALIDATION_ERROR', 'Ожидается целое число', { field });
  const n = Number(s);
  if (n < min || n > max)
    throw new AppError('VALIDATION_ERROR', `Число от ${String(min)} до ${String(max)}`, { field });
  return n;
}

/** Дата из `<input type="datetime-local">` трактуется как UTC. */
function parseLocalUtc(v: string | undefined, field: string): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s))
    throw new AppError('VALIDATION_ERROR', 'Некорректная дата', { field });
  const ms = Date.parse(`${s}Z`);
  if (Number.isNaN(ms)) throw new AppError('VALIDATION_ERROR', 'Некорректная дата', { field });
  return new Date(ms).toISOString();
}

function planFromForm(b: Body): Plan {
  const modules = (b?.['modules'] ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (modules.length === 0)
    throw new AppError('VALIDATION_ERROR', 'Укажите модули (* — все)', { field: 'modules' });
  const name = (b?.['name'] ?? '').trim();
  if (!name || name.length > 100)
    throw new AppError('VALIDATION_ERROR', 'Название тарифа — 1–100 символов', { field: 'name' });
  return {
    code: (b?.['code'] ?? '').trim(),
    name,
    priceKopecks: parseRubles(b?.['price'], 'price'),
    periodMonths: b?.['periodMonths'] === '12' ? 12 : 1,
    trialDays: parseIntField(b?.['trialDays'] ?? '0', 'trialDays', 0, 365),
    limits: {
      users: parseIntField(b?.['users'], 'users', 0, 1_000_000),
      callsPerMonth: parseIntField(b?.['calls'], 'calls', 0, 1_000_000_000),
      writesPerMonth: parseIntField(b?.['writes'], 'writes', 0, 1_000_000_000),
    },
    modules,
    destructiveAllowed: b?.['destructive'] === '1',
    public: b?.['public'] === '1',
    active: b?.['active'] === '1',
    sort: parseIntField(b?.['sort'] ?? '0', 'sort', -100_000, 100_000),
  };
}

const errStatus = (e: AppError): number =>
  e.code === 'NOT_FOUND'
    ? 404
    : e.code === 'ACCESS_DENIED'
      ? 403
      : e.code === 'CONFLICT'
        ? 409
        : e.code === 'VALIDATION_ERROR'
          ? 400
          : e.code === 'FEATURE_UNAVAILABLE'
            ? 503
            : 500;

export function registerOwnerPanel(app: FastifyInstance, deps: OwnerPanelDeps): void {
  const nowMs = deps.now ?? (() => Date.now());
  const accounts = new OwnerAccounts({ db: deps.db, secrets: deps.ownerSecrets, now: nowMs });
  const service = new OwnerService({
    db: deps.db,
    tenants: deps.tenants,
    plans: deps.plans,
    subscriptions: deps.subscriptions,
    billing: deps.billing,
    coordination: deps.coordination,
    revokeTenant: deps.revokeTenant,
    ...(deps.entitlements ? { entitlements: deps.entitlements } : {}),
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    logger: deps.logger,
    now: () => new Date(nowMs()),
  });
  const limits = deps.loginLimits ?? { perIp: 20, perAccount: 10, windowMs: 15 * 60_000 };
  const log = deps.logger;

  void app.register(
    (scope, _opts, done) => {
      // Разбор форм в своей области видимости: заменяем разборщик родителя (если он был), чтобы не конфликтовать.
      if (scope.hasContentTypeParser('application/x-www-form-urlencoded'))
        scope.removeContentTypeParser('application/x-www-form-urlencoded');
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 32 * 1024 },
        (_req, body, done) => {
          const out: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(String(body))) if (!(k in out)) out[k] = v;
          done(null, out);
        },
      );
      scope.addHook('onRequest', async (_req, reply) => {
        reply.header('Content-Security-Policy', CSP);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cache-Control', 'no-store');
        reply.header('Cross-Origin-Opener-Policy', 'same-origin');
        reply.header('Cross-Origin-Resource-Policy', 'same-origin');
        reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      });

      const html = (reply: FastifyReply, status: number, body: string) =>
        reply.code(status).type('text/html; charset=utf-8').send(body);

      /** POST — только со страниц панели: Origin, иначе Sec-Fetch-Site, иначе Referer. */
      const sameOrigin = (req: FastifyRequest): boolean => {
        const origin = req.headers.origin;
        if (origin !== undefined) return origin === deps.publicOrigin;
        const sfs = req.headers['sec-fetch-site'];
        if (typeof sfs === 'string') return sfs === 'same-origin';
        const referer = req.headers.referer;
        if (referer) {
          try {
            return new URL(referer).origin === deps.publicOrigin;
          } catch {
            return false;
          }
        }
        return false;
      };
      const cookieOf = (req: FastifyRequest) => parseCookies(req.headers.cookie)[COOKIE];
      const requireSession = async (
        req: FastifyRequest,
        reply: FastifyReply,
      ): Promise<OwnerSession | undefined> => {
        const s = await accounts.sessionByCookie(cookieOf(req));
        if (s) return s;
        if (req.method === 'GET') await reply.redirect('/owner/login', 303);
        else
          await html(
            reply,
            401,
            layout(
              'Вход',
              '<div class="card"><p class="err">Сессия не найдена или истекла. <a href="/owner/login">Войти</a></p></div>',
            ),
          );
        return undefined;
      };
      /** Сессия + Origin + CSRF для изменяющих запросов. */
      const guardPost = async (
        req: FastifyRequest,
        reply: FastifyReply,
      ): Promise<{ session: OwnerSession; body: Body } | undefined> => {
        const session = await requireSession(req, reply);
        if (!session) return undefined;
        const body = req.body as Body;
        if (!sameOrigin(req)) {
          log.warn({ reason: 'owner_origin' }, 'owner panel request rejected');
          await html(
            reply,
            403,
            messagePage('Отказ', 'Запрос пришёл не со страницы панели (Origin).', session),
          );
          return undefined;
        }
        if (!body?.['_csrf'] || body['_csrf'] !== session.csrf) {
          log.warn({ reason: 'owner_csrf' }, 'owner panel request rejected');
          await html(
            reply,
            403,
            messagePage('Отказ', 'Форма устарела (CSRF). Откройте страницу заново.', session),
          );
          return undefined;
        }
        return { session, body };
      };
      const fail = (reply: FastifyReply, session: OwnerSession, e: unknown, back: string) => {
        const err = AppError.from(e);
        if (errStatus(err) >= 500)
          log.error({ code: err.code, reason: err.details.reason }, 'owner action failed');
        return html(reply, errStatus(err), messagePage('Ошибка', err.message, session, back));
      };
      const idParam = (req: FastifyRequest): string => (req.params as { id?: string }).id ?? '';

      scope.get('/static/owner.css', (_req, reply) =>
        reply.type('text/css; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(OWNER_CSS),
      );

      scope.get('/', (_req, reply) => reply.redirect('/owner/tenants', 303));

      scope.get('/login', async (req, reply) => {
        if (await accounts.sessionByCookie(cookieOf(req))) return reply.redirect('/owner/tenants', 303);
        return html(reply, 200, loginPage());
      });

      scope.post('/login', async (req, reply) => {
        if (!sameOrigin(req))
          return html(reply, 403, messagePage('Отказ', 'Запрос пришёл не со страницы панели.'));
        const body = req.body as Body;
        const email = (body?.['email'] ?? '').trim().toLowerCase();
        const password = body?.['password'] ?? '';
        const code = body?.['code'] ?? '';
        if (!email || !password || !code)
          return html(reply, 400, loginPage('<p class="err">Укажите email, пароль и код.</p>'));
        const acctKey = createHash('sha256').update(email).digest('hex').slice(0, 32);
        const ipOk = await deps.coordination.allow(`owner:login:ip:${req.ip}`, limits.perIp, limits.windowMs);
        const acctOk =
          ipOk &&
          (await deps.coordination.allow(`owner:login:acct:${acctKey}`, limits.perAccount, limits.windowMs));
        const tooMany = () => {
          log.warn({ reason: 'owner_login_rate' }, 'owner login throttled');
          return html(
            reply,
            429,
            loginPage('<p class="err">Слишком много попыток входа. Попробуйте позже.</p>'),
          );
        };
        if (!ipOk || !acctOk) return tooMany();
        const r = await accounts.authenticate(email, password, code);
        if (!r.ok) {
          if (r.reason === 'locked') return tooMany();
          log.warn({ reason: 'owner_login_failed' }, 'owner login failed');
          return html(reply, 401, loginPage('<p class="err">Неверный email, пароль или код.</p>'));
        }
        const { cookieValue } = await accounts.openSession(r.owner);
        await service.recordAccountEvent(r.owner, 'owner.login');
        log.info({ role: r.owner.role }, 'owner session opened');
        return reply
          .header('Set-Cookie', cookieHeader(cookieValue, Math.floor(OWNER_SESSION_TTL_MS / 1000)))
          .redirect('/owner/tenants', 303);
      });

      scope.post('/logout', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        await accounts.closeSession(cookieOf(req));
        await service.recordAccountEvent(g.session.owner, 'owner.logout');
        return reply.header('Set-Cookie', cookieHeader('', 0)).redirect('/owner/login', 303);
      });

      scope.get('/tenants', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        const q = req.query as Record<string, string | undefined>;
        const status = ['active', 'suspended', 'uninstalled', 'deleted'].includes(q['status'] ?? '')
          ? (q['status'] as TenantStatus)
          : undefined;
        const text = (q['q'] ?? '').slice(0, 100) || undefined;
        const offset = /^\d{1,6}$/.test(q['offset'] ?? '') ? Number(q['offset']) : 0;
        const limit = 50;
        const rows = await service.listTenants({ status, q: text, limit, offset });
        return html(reply, 200, tenantsPage(session, rows, { status, q: text }, offset, limit));
      });

      scope.get('/tenants/:id', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        try {
          const d = await service.tenantDetail(idParam(req));
          return await html(reply, 200, tenantDetailPage(session, d, notice(req)));
        } catch (e) {
          return fail(reply, session, e, '/owner/tenants');
        }
      });

      scope.post('/tenants/:id/extend-trial', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        const id = idParam(req);
        try {
          const days = parseIntField(g.body?.['days'], 'days', 1, 90);
          await service.extendTrial(g.session.owner, id, days, g.body?.['reason'] ?? '');
          return await reply.redirect(`/owner/tenants/${encodeURIComponent(id)}?ok=trial`, 303);
        } catch (e) {
          return fail(reply, g.session, e, `/owner/tenants/${encodeURIComponent(id)}`);
        }
      });

      scope.post('/tenants/:id/block', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        const id = idParam(req);
        try {
          const t = await deps.tenants.get(/^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '');
          if (!t) throw new AppError('NOT_FOUND', 'Арендатор не найден');
          if ((g.body?.['confirm'] ?? '').trim().toLowerCase() !== t.domain)
            throw new AppError('VALIDATION_ERROR', 'Для блокировки введите домен портала точно', {
              field: 'confirm',
            });
          await service.blockTenant(g.session.owner, id, g.body?.['reason'] ?? '');
          return await reply.redirect(`/owner/tenants/${encodeURIComponent(id)}?ok=blocked`, 303);
        } catch (e) {
          return fail(reply, g.session, e, `/owner/tenants/${encodeURIComponent(id)}`);
        }
      });

      scope.post('/tenants/:id/unblock', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        const id = idParam(req);
        try {
          await service.unblockTenant(g.session.owner, id, g.body?.['reason'] ?? '');
          return await reply.redirect(`/owner/tenants/${encodeURIComponent(id)}?ok=unblocked`, 303);
        } catch (e) {
          return fail(reply, g.session, e, `/owner/tenants/${encodeURIComponent(id)}`);
        }
      });

      scope.get('/payments', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        return html(
          reply,
          200,
          paymentsPage(
            session,
            await service.recentPayments(100),
            await service.recentInvoices(100),
            notice(req),
          ),
        );
      });

      scope.post('/payments/:id/refund', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        try {
          const amount = parseRubles(g.body?.['amount'], 'amount');
          await service.refund(g.session.owner, idParam(req), amount, g.body?.['reason'] ?? '');
          return await reply.redirect('/owner/payments?ok=refund', 303);
        } catch (e) {
          return fail(reply, g.session, e, '/owner/payments');
        }
      });

      scope.post('/invoices/:id/mark-paid', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        try {
          const r = await service.markInvoicePaid(g.session.owner, idParam(req), g.body?.['reason'] ?? '');
          return await reply.redirect(`/owner/payments?ok=${r.alreadyPaid ? 'already' : 'paid'}`, 303);
        } catch (e) {
          return fail(reply, g.session, e, '/owner/payments');
        }
      });

      scope.get('/plans', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        return html(reply, 200, plansPage(session, await service.listPlans(), notice(req)));
      });

      scope.post('/plans', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        try {
          await service.savePlan(g.session.owner, planFromForm(g.body), g.body?.['reason'] ?? '');
          return await reply.redirect('/owner/plans?ok=plan', 303);
        } catch (e) {
          return fail(reply, g.session, e, '/owner/plans');
        }
      });

      scope.get('/announcements', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        return html(reply, 200, announcementsPage(session, await service.announcements(), notice(req)));
      });

      scope.post('/announcements', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        try {
          const b = g.body;
          const level = b?.['level'] ?? '';
          if (!['info', 'warning', 'critical'].includes(level))
            throw new AppError('VALIDATION_ERROR', 'Уровень: info, warning или critical', { field: 'level' });
          const tenantId = (b?.['tenantId'] ?? '').trim();
          await service.createAnnouncement(g.session.owner, {
            tenantId: tenantId || null,
            level: level as AnnouncementLevel,
            title: b?.['title'] ?? '',
            body: b?.['body'] ?? '',
            startsAt: parseLocalUtc(b?.['startsAt'], 'startsAt') ?? new Date(nowMs()).toISOString(),
            endsAt: parseLocalUtc(b?.['endsAt'], 'endsAt'),
          });
          return await reply.redirect('/owner/announcements?ok=ann', 303);
        } catch (e) {
          return fail(reply, g.session, e, '/owner/announcements');
        }
      });

      scope.post('/announcements/:id/deactivate', async (req, reply) => {
        const g = await guardPost(req, reply);
        if (!g) return reply;
        try {
          const raw = idParam(req);
          await service.deactivateAnnouncement(g.session.owner, /^\d{1,15}$/.test(raw) ? Number(raw) : -1);
          return await reply.redirect('/owner/announcements?ok=annoff', 303);
        } catch (e) {
          return fail(reply, g.session, e, '/owner/announcements');
        }
      });

      scope.get('/metrics', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        return html(reply, 200, metricsPage(session, await service.metricsSummary()));
      });

      scope.get('/journal', async (req, reply) => {
        const session = await requireSession(req, reply);
        if (!session) return reply;
        return html(reply, 200, journalPage(session, await service.supportLog({ limit: 200 })));
      });
      done();
    },
    { prefix: '/owner' },
  );
}

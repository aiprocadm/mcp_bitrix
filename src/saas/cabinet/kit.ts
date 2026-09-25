/**
 * Общие части маршрутов кабинета: контекст запроса (сессия → арендатор → пользователь), ответы HTML с заголовками
 * безопасности, CSRF/Origin, свежесть входа, аудит действий кабинета.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleAtLeast } from '../../auth/principal.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditOutcome } from '../../logging/audit.js';
import { portalKeyForMember } from '../bitrix/user-provider.js';
import type { Tenant, TenantUser } from '../repos/tenants.js';
import { FRESH_LOGIN_MS } from './approval-link.js';
import { card, esc, layout, type NavInfo } from './html.js';
import type { CabinetSession, CabinetSessionStore } from './sessions.js';
import type { CabinetDeps, CabinetScope } from './types.js';

/** Инструмент в аудите для действий кабинета (не считается «вызовом MCP» при проверке подключения). */
export const CABINET_AUDIT_TOOL = 'cabinet';

export const CSP_DEFAULT =
  "default-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
/** Страницы, форма которых уводит на внешний https (вход Bitrix24, страница оплаты). */
export const CSP_EXTERNAL_FORM = CSP_DEFAULT.replace("form-action 'self'", "form-action 'self' https:");

export interface Ctx {
  readonly session: CabinetSession;
  readonly tenant: Tenant;
  readonly user: TenantUser;
  readonly isAdmin: boolean;
  readonly nav: NavInfo;
}

export type FormBody = Record<string, string | string[] | undefined>;

export function parseForm(raw: string): FormBody {
  const out: FormBody = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const v = (body as FormBody)[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

export function fields(body: unknown, name: string): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const v = (body as FormBody)[name];
  if (Array.isArray(v)) return v;
  return typeof v === 'string' ? [v] : [];
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

/** Безопасный адрес возврата после входа: только страницы кабинета. */
export function safeReturnTo(value: string | undefined): string {
  if (!value) return '/app';
  if (!/^\/app(\/[A-Za-z0-9._~\-/]*)?(\?[A-Za-z0-9._~\-=&]*)?$/.test(value)) return '/app';
  if (value.includes('//') || value.includes('/..')) return '/app';
  return value;
}

export const errorText = (e: unknown): string => {
  const err = AppError.from(e);
  return `${err.message}${err.details.nextAction ? ` → ${err.details.nextAction}` : ''}`;
};

export class Kit {
  readonly secure: boolean;
  readonly origin: string;
  readonly sessionCookie: string;
  readonly bindCookie: string;
  /** Cookie сервера авторизации с доменом портала (подсказка для формы входа). */
  readonly asPortalCookie: string;

  constructor(
    readonly deps: CabinetDeps,
    readonly sessions: CabinetSessionStore,
    readonly now: () => number,
  ) {
    const base = new URL(deps.publicBaseUrl);
    this.secure = base.protocol === 'https:';
    this.origin = base.origin;
    const p = this.secure ? '__Host-' : '';
    this.sessionCookie = `${p}mcp_cab`;
    this.bindCookie = `${p}mcp_cab_bind`;
    this.asPortalCookie = `${p}mcp_as_portal`;
  }

  get base(): string {
    return this.origin;
  }

  cookie(name: string, value: string, maxAgeSec: number): string {
    return `${name}=${value}; Path=/; Max-Age=${String(maxAgeSec)}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
  }

  html(reply: FastifyReply, status: number, body: string, csp = CSP_DEFAULT): FastifyReply {
    return reply
      .code(status)
      .header('Content-Security-Policy', csp)
      .type('text/html; charset=utf-8')
      .send(body);
  }

  page(title: string, body: string, ctx?: Ctx): string {
    return layout(title, body, ctx?.nav);
  }

  /** Сообщение-страница (ошибка/отказ) с навигацией, если есть сессия. */
  message(reply: FastifyReply, status: number, title: string, text: string, ctx?: Ctx): FastifyReply {
    return this.html(
      reply,
      status,
      this.page(title, card(`<h2>${esc(title)}</h2><p class="err">${text}</p>`), ctx),
    );
  }

  /** POST принимается только с этого сервиса: Origin, иначе Sec-Fetch-Site, иначе Referer. */
  sameOrigin(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) return origin === this.origin;
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string') return sfs === 'same-origin';
    const referer = req.headers.referer;
    if (referer) {
      try {
        return new URL(referer).origin === this.origin;
      } catch {
        return false;
      }
    }
    return false;
  }

  async context(req: FastifyRequest): Promise<Ctx | undefined> {
    const session = await this.sessions.byCookie(parseCookies(req.headers.cookie).get(this.sessionCookie));
    if (!session) return undefined;
    const tenant = await this.deps.tenants.get(session.tenantId);
    if (!tenant || tenant.status === 'uninstalled' || tenant.status === 'deleted') return undefined;
    const user = await this.deps.users.get(session.tenantId, session.userId);
    if (user?.status !== 'active') return undefined;
    const isAdmin = user.role === 'administrator';
    return {
      session,
      tenant,
      user,
      isAdmin,
      nav: {
        userName: user.displayName || `#${String(user.bitrixUserId)}`,
        role: user.role,
        isAdmin,
        csrf: session.csrf,
        portal: tenant.domain,
      },
    };
  }

  /** Без сессии: GET → на вход (одинаково для любых адресов), POST → 401 без подробностей. */
  async requireCtx(req: FastifyRequest, reply: FastifyReply): Promise<Ctx | undefined> {
    const ctx = await this.context(req);
    if (ctx) return ctx;
    if (req.method === 'GET') {
      const next = safeReturnTo(req.url.split('#')[0]);
      void reply.redirect(`/app/login?next=${encodeURIComponent(next)}`, 303);
    } else {
      void this.message(
        reply,
        401,
        'Нужен вход',
        'Сессия не найдена или истекла. <a href="/app/login">Войти через Bitrix24</a>',
      );
    }
    return undefined;
  }

  requireCsrf(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, token: string | undefined): boolean {
    if (!this.sameOrigin(req)) {
      this.deps.logger.warn({ reason: 'cabinet_origin' }, 'cabinet request rejected');
      void this.message(reply, 403, 'Отказ', 'Запрос пришёл не со страницы кабинета (Origin).', ctx);
      return false;
    }
    if (!token || token !== ctx.session.csrf) {
      this.deps.logger.warn({ reason: 'cabinet_csrf' }, 'cabinet request rejected');
      void this.message(reply, 403, 'Отказ', 'Форма устарела (CSRF). Откройте страницу заново.', ctx);
      return false;
    }
    return true;
  }

  requireAdmin(reply: FastifyReply, ctx: Ctx): boolean {
    if (ctx.isAdmin) return true;
    void this.message(
      reply,
      403,
      'Раздел администратора',
      'Раздел доступен администратору арендатора. Роль назначает администратор портала в кабинете.',
      ctx,
    );
    return false;
  }

  /** Вход через Bitrix24 не старше 15 минут (удаления, массовые замены, удаление данных). */
  fresh(ctx: Ctx): boolean {
    return this.now() - Date.parse(ctx.session.authenticatedAt) <= FRESH_LOGIN_MS;
  }

  reloginLink(next: string): string {
    return `/app/login?reauth=1&next=${encodeURIComponent(safeReturnTo(next))}`;
  }

  canOperate(ctx: Ctx): boolean {
    return roleAtLeast(ctx.user.role, 'operator');
  }

  scope(ctx: Ctx): Promise<CabinetScope> {
    return this.deps.scopeFor(ctx.tenant.id, ctx.user.id);
  }

  async audit(
    ctx: Ctx,
    kind: string,
    outcome: AuditOutcome,
    extra: { approvalId?: string; errorCode?: string; portalKey?: string } = {},
  ): Promise<void> {
    await this.deps.audit.record({
      tenantId: ctx.tenant.id,
      requestId: randomUUID(),
      principalId: ctx.user.id,
      portalKey: extra.portalKey ?? portalKeyForMember(ctx.tenant.memberId),
      tool: CABINET_AUDIT_TOOL,
      operationKind: kind,
      approvalId: extra.approvalId,
      outcome,
      errorCode: extra.errorCode,
      durationMs: 0,
    });
  }
}

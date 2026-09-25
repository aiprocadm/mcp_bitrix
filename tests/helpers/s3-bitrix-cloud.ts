/**
 * Имитация облака Bitrix24 для тестов S3 (без сети): сервер авторизации `oauth.bitrix.info/oauth/token/` и REST
 * порталов. Формы ответов — строго по официальной документации:
 *  - settings/oauth/index.md, auto-renewal.md: пара токенов {access_token, client_endpoint, domain, expires, expires_in,
 *    member_id, refresh_token, scope, server_endpoint, status, user_id}; refresh_token одноразовый (ротация);
 *  - settings/oauth/error-codes.md: {"error": "invalid_grant" | "PAYMENT_REQUIRED" | …, "error_description": …};
 *  - REST: {result, time}; истёкший токен — 401 {"error": "expired_token"} (auto-renewal.md, п.3 логики);
 *  - profile.md, event-get.md, event-bind.md, app-info.md — тела result.
 */
import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../../src/bitrix/client.js';

export const OAUTH_ORIGIN = 'https://oauth.bitrix.info';

interface Grant {
  memberId: string;
  userId: number;
}

export interface PortalUser {
  id: number;
  admin: boolean;
  name: string;
  lastName: string;
}

export interface Portal {
  memberId: string;
  domain: string;
  users: Map<number, PortalUser>;
  handlers: { event: string; handler: string; auth_type: string; offline: number }[];
  appInfo: Record<string, unknown>;
}

export interface OAuthCall {
  grantType: string;
  clientId: string | null;
  clientSecret: string | null;
}

export interface RestCall {
  host: string;
  method: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

const tok = () => randomBytes(16).toString('hex');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const TIME = {
  start: 1721296536.908506,
  finish: 1721296537.007365,
  duration: 0.098,
  processing: 0.032,
  date_start: '2024-07-18T11:55:36+02:00',
  date_finish: '2024-07-18T11:55:37+02:00',
  operating: 0,
};

export class FakeBitrixCloud {
  readonly clientId = 'app.66f1a2b3c4d5e6.12345678';
  readonly clientSecret = 'S3cr3tClientValue0123456789abcdef';
  readonly portals = new Map<string, Portal>();
  readonly oauthCalls: OAuthCall[] = [];
  readonly restCalls: RestCall[] = [];
  /** Все URL запросов (для проверки, что секрет не утёк куда не надо). */
  readonly urls: string[] = [];
  private readonly refreshTokens = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, Grant & { expiresAt: number }>();
  private readonly codes = new Map<string, Grant>();
  /** Срок access_token в ответах (с). */
  expiresIn = 3600;
  /** Задержка ответа сервера авторизации (мс) — чтобы одновременные обновления пересеклись. */
  oauthDelayMs = 0;
  /** Принудительная ошибка сервера авторизации для refresh (код error). */
  refreshError: string | undefined;
  /** HTTP-статус «недоступности» сервера авторизации. */
  oauthHttpFailure: number | undefined;
  now = () => Date.now();
  /**
   * Дополнительные методы REST (сборка режима saas: инструменты поверх портала). Возвращают `result` (и доп. поля
   * ответа legacy, например `total`), вызываются только с действующим токеном пользователя портала.
   */
  readonly extraMethods = new Map<
    string,
    (body: Record<string, unknown>, user: PortalUser | undefined) => { result: unknown; [k: string]: unknown }
  >();

  addPortal(memberId: string, domain: string, users: PortalUser[]): Portal {
    const p: Portal = {
      memberId,
      domain,
      users: new Map(users.map((u) => [u.id, u])),
      handlers: [],
      appInfo: {
        ID: 5,
        CODE: 'mcp.bitrix24',
        VERSION: 1,
        STATUS: 'F',
        INSTALLED: true,
        PAYMENT_EXPIRED: 'N',
        DAYS: null,
        LANGUAGE_ID: 'ru',
        LICENSE: 'ru_ent250',
        LICENSE_TYPE: 'ent250',
        LICENSE_FAMILY: 'ent',
      },
    };
    this.portals.set(memberId, p);
    return p;
  }

  /** Пара, которую Bitrix24 выдал бы приложению для пользователя (установка/событие). */
  issue(memberId: string, userId: number): { accessToken: string; refreshToken: string } {
    const accessToken = tok();
    const refreshToken = tok();
    this.accessTokens.set(accessToken, { memberId, userId, expiresAt: this.now() + this.expiresIn * 1000 });
    this.refreshTokens.set(refreshToken, { memberId, userId });
    return { accessToken, refreshToken };
  }

  /** Одноразовый код авторизации (полный протокол, шаг 1). */
  issueCode(memberId: string, userId: number): string {
    const code = tok();
    this.codes.set(code, { memberId, userId });
    return code;
  }

  expireAccess(accessToken: string): void {
    const g = this.accessTokens.get(accessToken);
    if (g) g.expiresAt = 0;
  }

  expireAllAccess(): void {
    for (const g of this.accessTokens.values()) g.expiresAt = 0;
  }

  revokeRefresh(refreshToken: string): void {
    this.refreshTokens.delete(refreshToken);
  }

  hasPlaintext(text: string): string | undefined {
    for (const t of [...this.accessTokens.keys(), ...this.refreshTokens.keys()])
      if (text.includes(t)) return t;
    return undefined;
  }

  get refreshCount(): number {
    return this.oauthCalls.filter((c) => c.grantType === 'refresh_token').length;
  }

  private tokenResponse(g: Grant, withUserId: boolean): Record<string, unknown> {
    const portal = this.portals.get(g.memberId);
    const pair = this.issue(g.memberId, g.userId);
    return {
      access_token: pair.accessToken,
      client_endpoint: `https://${portal?.domain ?? 'unknown.invalid'}/rest/`,
      domain: 'oauth.bitrix.info',
      expires: Math.floor(this.now() / 1000) + this.expiresIn,
      expires_in: this.expiresIn,
      member_id: g.memberId,
      refresh_token: pair.refreshToken,
      scope: 'crm,task,user_brief,im,disk,calendar',
      server_endpoint: 'https://oauth.bitrix.info/rest/',
      status: 'F',
      ...(withUserId ? { user_id: g.userId } : {}),
    };
  }

  private async oauth(url: URL): Promise<Response> {
    const q = url.searchParams;
    this.oauthCalls.push({
      grantType: q.get('grant_type') ?? '',
      clientId: q.get('client_id'),
      clientSecret: q.get('client_secret'),
    });
    if (this.oauthDelayMs) await new Promise((r) => setTimeout(r, this.oauthDelayMs));
    if (this.oauthHttpFailure) return new Response('Service Unavailable', { status: this.oauthHttpFailure });
    if (q.get('client_id') !== this.clientId || q.get('client_secret') !== this.clientSecret) {
      return json(401, { error: 'invalid_client', error_description: 'Invalid client' });
    }
    if (q.get('grant_type') === 'authorization_code') {
      const g = this.codes.get(q.get('code') ?? '');
      if (!g) return json(400, { error: 'invalid_grant', error_description: 'Invalid code' });
      this.codes.delete(q.get('code') ?? '');
      // Ответ обмена кода в документации — без user_id.
      return json(200, this.tokenResponse(g, false));
    }
    if (q.get('grant_type') === 'refresh_token') {
      if (this.refreshError) {
        return json(400, { error: this.refreshError, error_description: 'Refused' });
      }
      const rt = q.get('refresh_token') ?? '';
      const g = this.refreshTokens.get(rt);
      if (!g) return json(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
      this.refreshTokens.delete(rt); // ротация: старый refresh больше не действует
      return json(200, this.tokenResponse(g, true));
    }
    return json(400, { error: 'invalid_request', error_description: 'Bad grant_type' });
  }

  private rest(url: URL, body: Record<string, unknown>): Response {
    const portal = [...this.portals.values()].find((p) => p.domain === url.host);
    const m = /^\/rest\/(.+)\.json$/.exec(url.pathname);
    const method = m?.[1] ?? '';
    const auth = typeof body['auth'] === 'string' ? body['auth'] : undefined;
    this.restCalls.push({ host: url.host, method, auth, body });
    if (!portal) return json(404, { error: 'NOT_FOUND', error_description: 'Portal not found' });
    const g = auth ? this.accessTokens.get(auth) : undefined;
    if (g?.memberId !== portal.memberId) {
      return json(401, {
        error: 'invalid_token',
        error_description: 'The access token provided is invalid.',
      });
    }
    if (g.expiresAt <= this.now()) {
      return json(401, {
        error: 'expired_token',
        error_description: 'The access token provided has expired.',
      });
    }
    const user = portal.users.get(g.userId);
    switch (method) {
      case 'profile':
        return json(200, {
          result: user
            ? {
                ID: String(user.id),
                ADMIN: user.admin,
                NAME: user.name,
                LAST_NAME: user.lastName,
                PERSONAL_GENDER: '',
                TIME_ZONE: '',
              }
            : {},
          time: TIME,
        });
      case 'event.get':
        return json(200, { result: portal.handlers, time: TIME });
      case 'event.bind': {
        const event = typeof body['event'] === 'string' ? body['event'].toUpperCase() : '';
        if (!event.startsWith('ONAPP')) {
          return json(400, { error: 'ERROR_EVENT_NOT_FOUND', error_description: 'Event not found' });
        }
        portal.handlers.push({
          event,
          handler: typeof body['handler'] === 'string' ? body['handler'] : '',
          auth_type: '0',
          offline: 0,
        });
        return json(200, { result: true, time: TIME });
      }
      case 'app.info':
        return json(200, { result: portal.appInfo, time: TIME });
      default: {
        const extra = this.extraMethods.get(method);
        if (extra) return json(200, { ...extra(body, user), time: TIME });
        return json(400, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' });
      }
    }
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    this.urls.push(url.toString());
    if (url.origin === OAUTH_ORIGIN && url.pathname === '/oauth/token/') return this.oauth(url);
    const raw = typeof init.body === 'string' ? init.body : '{}';
    return this.rest(url, JSON.parse(raw) as Record<string, unknown>);
  };
}

/** Тело события так, как его шлёт Bitrix24: поля формы PHP (`auth[access_token]=…`). */
export function eventForm(fields: {
  event: string;
  data?: Record<string, string | number>;
  auth: Record<string, string | number | undefined>;
}): string {
  const f = new URLSearchParams();
  f.set('event', fields.event);
  f.set('event_handler_id', '17');
  f.set('ts', '1696527000');
  for (const [k, v] of Object.entries(fields.data ?? {})) f.set(`data[${k}]`, String(v));
  for (const [k, v] of Object.entries(fields.auth)) if (v !== undefined) f.set(`auth[${k}]`, String(v));
  return f.toString();
}

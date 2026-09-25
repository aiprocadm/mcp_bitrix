/**
 * Сервер авторизации MCP (SaaS-ТЗ D5, §7.1, §7.2, §7.4) по спецификации MCP 2026-07-28
 * (docs/specification/2026-07-28/basic/authorization/*): OAuth 2.1 (draft-ietf-oauth-v2-1-13), метаданные
 * RFC 8414 и RFC 9728, регистрация клиентов — Client ID Metadata Documents и DCR RFC 7591, PKCE S256 (RFC 7636),
 * Resource Indicators RFC 8707, `iss` в ответе авторизации (RFC 9207), отзыв RFC 7009.
 *
 * Здесь только чистые обработчики «запрос → ответ» без привязки к HTTP-фреймворку: маршруты (`OAUTH_ROUTES`)
 * подключает сборка режима saas. Вход пользователя делегируется Bitrix24 (`BitrixLoginGateway`, этап S3).
 *
 * Поток authorize: GET /oauth/authorize (проверка клиента, redirect_uri, PKCE, resource, scope) → страница
 * «адрес портала» → POST /oauth/login → Bitrix24 → обратный вызов (bitrixCallback) → экран согласия (если для
 * пары пользователь–клиент нет сохранённого) → POST /oauth/consent → redirect с code, state, iss.
 * Состояние между шагами — запечатанное (AES-GCM, срок, назначение) и привязанное к браузеру cookie `bind`
 * (HttpOnly, Secure, SameSite=Lax, префикс __Host-); формы защищены CSRF-токеном от (bind, состояние).
 */
import { jwtVerify } from 'jose';
import { AppError } from '../../errors/app-error.js';
import type { FetchLike } from '../../bitrix/client.js';
import type { AppLogger } from '../../logging/logger.js';
import { OperationsStore } from '../../storage/operations.js';
import type { SqlDb } from '../../storage/sql.js';
import type { Coordination } from '../coordination.js';
import {
  normalizePortalDomain,
  type TenantSettingsRepo,
  type TenantsRepo,
  type TenantUser,
  type TenantUsersRepo,
} from '../repos/tenants.js';
import { defaultFetch, defaultResolver, type HostResolver } from './cimd-fetch.js';
import { ClientLookupError, ClientMetadataError, ClientResolver, validateClientMetadata } from './clients.js';
import {
  CODE_CHALLENGE_S256_RE,
  pkceMatches,
  randomToken,
  safeEqual,
  sha256Hex,
  StateSealer,
} from './crypto.js';
import { PORTAL_NOT_INSTALLED, type BitrixLoginGateway } from './gateway.js';
import { consentPage, errorPage, installPage, portalPage } from './pages.js';
import { isLoopbackRedirect, redirectHost, redirectUriMatches } from './redirect-uri.js';
import {
  mcpResource,
  OAUTH_SCOPES,
  protectedResourceMetadataUrl,
  type OAuthScope,
  type OAuthServerSettings,
} from './settings.js';
import type { SigningKeyStore } from './signing-keys.js';
import {
  AuthCodesRepo,
  ConsentsRepo,
  OAuthClientsRepo,
  RefreshTokensRepo,
  type OAuthClient,
  type RefreshRecord,
} from './stores.js';
import { revokedJtiKey } from './verifier.js';

/** Пути, которые сборка режима saas регистрирует на обработчики AuthorizationServer. */
export const OAUTH_ROUTES = {
  asMetadata: 'GET /.well-known/oauth-authorization-server',
  resourceMetadata:
    'GET /.well-known/oauth-protected-resource/mcp (и GET /.well-known/oauth-protected-resource)',
  jwks: 'GET /oauth/jwks',
  register: 'POST /oauth/register (application/json)',
  authorize: 'GET /oauth/authorize',
  login: 'POST /oauth/login (application/x-www-form-urlencoded)',
  bitrixCallback: 'GET <redirect_uri приложения Bitrix24> при state с префиксом mcpas. (isAuthServerState)',
  consent: 'POST /oauth/consent (application/x-www-form-urlencoded)',
  token: 'POST /oauth/token (application/x-www-form-urlencoded)',
  revoke: 'POST /oauth/revoke (application/x-www-form-urlencoded)',
} as const;

/** Канал Coordination: отзыв доступа (сборка сбрасывает TenantScopeRegistry.invalidate). JSON {tenantId, userId?}. */
export const REVOCATION_CHANNEL = 'saas:access-revoked';

/** Префикс state, передаваемого в Bitrix24: обратный вызов с таким state принадлежит серверу авторизации. */
const STATE_PREFIX = 'mcpas.';
export const isAuthServerState = (state: unknown): boolean =>
  typeof state === 'string' && state.startsWith(STATE_PREFIX);

export interface OAuthRequest {
  /** Разобранная query-строка (повтор параметра — массив). */
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  /** Разобранное тело: поля формы (x-www-form-urlencoded) или JSON (/oauth/register). */
  readonly body?: unknown;
  readonly headers?: {
    readonly authorization?: string | undefined;
    readonly cookie?: string | undefined;
  };
  /** Адрес клиента (за прокси — из доверенного X-Forwarded-For): ключ лимита регистраций. */
  readonly ip?: string | undefined;
}

export interface OAuthResponse {
  status: number;
  headers: Record<string, string>;
  /** Значения заголовков Set-Cookie. */
  setCookies: string[];
  body: string;
}

export interface AuthorizationServerDeps {
  readonly settings: OAuthServerSettings;
  readonly db: SqlDb;
  readonly keys: SigningKeyStore;
  readonly coordination: Coordination;
  readonly gateway: BitrixLoginGateway;
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly tenantSettings: TenantSettingsRepo;
  /** Сетевые зависимости загрузки документов CIMD (тесты — без сети). */
  readonly fetch?: FetchLike | undefined;
  readonly resolveHost?: HostResolver | undefined;
  readonly now?: (() => number) | undefined;
  readonly logger?: AppLogger | undefined;
}

type TokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target';

class TokenError extends Error {
  constructor(
    readonly error: TokenErrorCode,
    readonly description: string,
    readonly status = 400,
    readonly basicChallenge = false,
  ) {
    super(description);
  }
}

class DuplicateParam extends Error {
  constructor(readonly param: string) {
    super(param);
  }
}

/** Значение параметра; повтор (RFC 6749 §3.1: «MUST NOT be included more than once») — DuplicateParam. */
function one(p: unknown, name: string): string | undefined {
  if (typeof p !== 'object' || p === null) return undefined;
  const v = (p as Record<string, unknown>)[name];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 1 && typeof v[0] === 'string') return v[0] === '' ? undefined : v[0];
    throw new DuplicateParam(name);
  }
  if (typeof v !== 'string') throw new DuplicateParam(name);
  return v === '' ? undefined : v;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** Сравнение resource: регистр схемы и хоста не важен (спецификация: «SHOULD accept uppercase»), без `/` в конце. */
function canonicalResource(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

/** Состояние запроса авторизации (компактные ключи — оно передаётся через Bitrix24 в `state`). */
interface AuthReq {
  /** client_id */ c: string;
  /** redirect_uri, как в запросе */ r: string;
  /** code_challenge (S256) */ cc: string;
  /** scope */ s: OAuthScope[];
  /** resource */ res: string;
  /** state клиента */ st?: string;
  /** sha256(bind cookie) */ b: string;
}
interface LoginState extends AuthReq {
  /** tenant id */ t: string;
  /** домен портала */ p: string;
}
interface ConsentState extends LoginState {
  /** user id */ u: string;
  /** имя пользователя */ n: string;
}

const MAX_STATE_LENGTH = 1024;

export class AuthorizationServer {
  readonly clients: OAuthClientsRepo;
  readonly codes: AuthCodesRepo;
  readonly refreshTokens: RefreshTokensRepo;
  readonly consents: ConsentsRepo;
  private readonly resolver: ClientResolver;
  private readonly sealer: StateSealer;
  private readonly now: () => number;
  private readonly secure: boolean;

  constructor(private readonly deps: AuthorizationServerDeps) {
    this.now = deps.now ?? Date.now;
    this.clients = new OAuthClientsRepo(deps.db, this.now);
    this.codes = new AuthCodesRepo(deps.db, this.now);
    this.refreshTokens = new RefreshTokensRepo(deps.db, this.now);
    this.consents = new ConsentsRepo(deps.db, this.now);
    this.resolver = new ClientResolver(
      deps.settings,
      this.clients,
      { fetch: deps.fetch ?? defaultFetch, resolve: deps.resolveHost ?? defaultResolver },
      this.now,
    );
    this.sealer = new StateSealer(deps.keys.stateSecret());
    this.secure = deps.settings.publicBaseUrl.startsWith('https://');
  }

  private get issuer(): string {
    return this.deps.settings.publicBaseUrl;
  }

  // ───────────────────────────── метаданные ─────────────────────────────

  /** RFC 8414 §2 + RFC 9207 §3 + CIMD (спецификация MCP client-registration «Advertising CIMD Support»). */
  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.issuer;
    const authMethods = ['none', 'client_secret_post', 'client_secret_basic'];
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/oauth/jwks`,
      scopes_supported: [...OAUTH_SCOPES, 'offline_access'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: authMethods,
      revocation_endpoint_auth_methods_supported: authMethods,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: this.deps.settings.cimd.enabled,
    };
  }

  /** RFC 9728 §2 для ресурса `${PUBLIC_BASE_URL}/mcp`. offline_access сюда не входит (спецификация MCP «Refresh Tokens»). */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: mcpResource(this.deps.settings),
      authorization_servers: [this.issuer],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: this.deps.settings.resourceName,
    };
  }

  /** Адрес документа RFC 9728 для WWW-Authenticate. */
  resourceMetadataUrl(): string {
    return protectedResourceMetadataUrl(this.deps.settings);
  }

  asMetadataResponse(): OAuthResponse {
    return this.json(200, this.authorizationServerMetadata(), 'public, max-age=3600');
  }

  resourceMetadataResponse(): OAuthResponse {
    return this.json(200, this.protectedResourceMetadata(), 'public, max-age=3600');
  }

  jwksResponse(): OAuthResponse {
    return this.json(200, this.deps.keys.jwks(), 'public, max-age=300');
  }

  // ───────────────────────────── DCR (RFC 7591) ─────────────────────────────

  async register(req: OAuthRequest): Promise<OAuthResponse> {
    const { limit, windowSec } = this.deps.settings.registrationRateLimit;
    const ip = req.ip ?? 'unknown';
    if (!(await this.deps.coordination.allow(`oauth:dcr:${ip}`, limit, windowSec * 1000))) {
      const res = this.json(429, {
        error: 'invalid_request',
        error_description: 'Слишком много регистраций клиентов, повторите позже',
      });
      res.headers['Retry-After'] = String(windowSec);
      return res;
    }
    let valid;
    try {
      valid = validateClientMetadata(req.body, 'dcr');
    } catch (e) {
      if (e instanceof ClientMetadataError)
        return this.json(400, { error: e.error, error_description: e.description });
      throw e;
    }
    const { client, clientSecret } = await this.clients.registerDynamic(valid);
    this.deps.logger?.info(
      { event: 'oauth.client_registered', clientId: client.clientId, kind: 'dcr' },
      'Зарегистрирован клиент MCP',
    );
    return this.json(201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      ...client.metadata,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    });
  }

  // ───────────────────────────── authorize ─────────────────────────────

  async authorize(req: OAuthRequest): Promise<OAuthResponse> {
    const q = req.query;
    let clientId: string | undefined;
    let redirectParam: string | undefined;
    try {
      clientId = one(q, 'client_id');
      redirectParam = one(q, 'redirect_uri');
    } catch {
      return this.page(
        400,
        errorPage('Ошибка подключения', 'Параметр client_id или redirect_uri повторяется'),
      );
    }
    if (!clientId) return this.page(400, errorPage('Ошибка подключения', 'Не указан client_id'));
    let client: OAuthClient | undefined;
    try {
      client = await this.resolver.resolve(clientId);
    } catch (e) {
      if (e instanceof ClientLookupError)
        return this.page(400, errorPage('Неизвестный клиент', e.description));
      throw e;
    }
    if (!client) return this.page(400, errorPage('Неизвестный клиент', 'Клиент не зарегистрирован'));
    // redirect_uri проверяется до любого перенаправления: при ошибке пользователь видит страницу, а не редирект
    // на непроверенный адрес (OAuth 2.1 §4.1.2.1, спецификация MCP «Open Redirection»).
    let redirectUri: string;
    if (redirectParam) {
      if (!redirectUriMatches(redirectParam, client.redirectUris))
        return this.page(
          400,
          errorPage('Ошибка подключения', 'redirect_uri не совпадает с зарегистрированным для клиента'),
        );
      redirectUri = redirectParam;
    } else if (client.redirectUris.length === 1 && client.redirectUris[0]) {
      redirectUri = client.redirectUris[0];
    } else {
      return this.page(400, errorPage('Ошибка подключения', 'Не указан redirect_uri'));
    }

    let clientState: string | undefined;
    try {
      clientState = one(q, 'state');
    } catch {
      return this.page(400, errorPage('Ошибка подключения', 'Параметр state повторяется'));
    }
    const fail = (error: string, description: string) =>
      this.redirect(redirectUri, clientState, { error, error_description: description }, 302);
    if (clientState !== undefined && clientState.length > MAX_STATE_LENGTH)
      return fail('invalid_request', 'state слишком длинный');

    let responseType, challenge, method, resource, scopeParam;
    try {
      responseType = one(q, 'response_type');
      challenge = one(q, 'code_challenge');
      method = one(q, 'code_challenge_method');
      scopeParam = one(q, 'scope');
    } catch (e) {
      return fail('invalid_request', `Параметр ${(e as DuplicateParam).param} повторяется`);
    }
    try {
      resource = one(q, 'resource');
    } catch {
      return fail('invalid_target', 'Поддерживается один resource');
    }
    if (responseType !== 'code')
      return fail('unsupported_response_type', 'Поддерживается только response_type=code');
    if (!client.metadata.grant_types.includes('authorization_code'))
      return fail('unauthorized_client', 'Клиенту не разрешён authorization_code');
    if (!challenge) return fail('invalid_request', 'Требуется PKCE: code_challenge');
    if (method !== 'S256') return fail('invalid_request', 'Поддерживается только code_challenge_method=S256');
    if (!CODE_CHALLENGE_S256_RE.test(challenge))
      return fail('invalid_request', 'Неверный формат code_challenge');
    if (!resource) return fail('invalid_request', 'Требуется параметр resource (RFC 8707)');
    if (canonicalResource(resource) !== mcpResource(this.deps.settings))
      return fail('invalid_target', 'resource не является адресом этого MCP-сервера');
    const scopes = this.parseScopes(scopeParam);
    if (!scopes) return fail('invalid_scope', 'Запрошены неизвестные права');

    const cookies = parseCookies(req.headers?.cookie);
    const existing = cookies.get(this.cookieName('bind'));
    const bind = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken(32);
    const authReq: AuthReq = {
      c: client.clientId,
      r: redirectUri,
      cc: challenge,
      s: scopes,
      res: mcpResource(this.deps.settings),
      b: sha256Hex(bind),
      ...(clientState !== undefined ? { st: clientState } : {}),
    };
    const sealed = this.sealer.seal('authreq', authReq, this.expiry());
    const res = this.page(
      200,
      portalPage({
        clientName: client.clientName,
        sealed,
        csrf: this.sealer.csrf(bind, sealed),
        portal: this.rememberedPortal(cookies),
      }),
      "form-action 'self' https:",
    );
    res.setCookies.push(this.cookie('bind', bind, this.deps.settings.authRequestTtlSec));
    return res;
  }

  /** POST /oauth/login: адрес портала → перенаправление на авторизацию Bitrix24. */
  async login(req: OAuthRequest): Promise<OAuthResponse> {
    let sealed, csrf, portalRaw;
    try {
      sealed = one(req.body, 'request');
      csrf = one(req.body, 'csrf');
      portalRaw = one(req.body, 'portal');
    } catch {
      return this.stale();
    }
    const bind = this.bindFrom(req);
    if (!sealed || !csrf || !bind || !safeEqual(csrf, this.sealer.csrf(bind, sealed))) return this.stale();
    const authReq = this.sealer.open<AuthReq>('authreq', sealed, this.now());
    if (authReq?.b !== sha256Hex(bind)) return this.stale();
    const client = await this.resolveSafe(authReq.c);
    if (!client) return this.stale();

    const again = (error: string) =>
      this.page(
        200,
        portalPage({ clientName: client.clientName, sealed, csrf, portal: portalRaw ?? '', error }),
        "form-action 'self' https:",
      );
    let portal: string;
    try {
      portal = normalizePortalDomain(portalRaw ?? '');
    } catch {
      return again('Укажите адрес портала, например company.bitrix24.ru');
    }
    const tenant = await this.deps.tenants.getByDomain(portal);
    if (!tenant || tenant.status === 'uninstalled' || tenant.status === 'deleted')
      return this.page(200, installPage(portal));
    if (tenant.status !== 'active')
      return this.page(403, errorPage('Доступ приостановлен', 'Доступ портала к сервису приостановлен'));

    const loginState: LoginState = { ...authReq, t: tenant.id, p: portal };
    const state = STATE_PREFIX + this.sealer.seal('login', loginState, this.expiry());
    const url = await this.deps.gateway.startLogin(portal, state);
    if (!url.startsWith('https://') && !url.startsWith('http://'))
      throw new AppError('INTERNAL_ERROR', 'Некорректный адрес входа Bitrix24');
    return this.location(303, url);
  }

  /** Обратный вызов Bitrix24 после входа (маршрут приложения S3 передаёт сюда, если isAuthServerState(state)). */
  async bitrixCallback(req: OAuthRequest): Promise<OAuthResponse> {
    let stateRaw: string | undefined;
    try {
      stateRaw = one(req.query, 'state');
    } catch {
      return this.stale();
    }
    if (!stateRaw?.startsWith(STATE_PREFIX)) return this.stale();
    const st = this.sealer.open<LoginState>('login', stateRaw.slice(STATE_PREFIX.length), this.now());
    const bind = this.bindFrom(req);
    if (!st || !bind || st.b !== sha256Hex(bind)) return this.stale();

    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (typeof v === 'string') query[k] = v;
    }
    if (query['error']) return this.redirect(st.r, st.st, { error: 'access_denied' }, 302);

    let identity;
    try {
      identity = await this.deps.gateway.completeLogin(query);
    } catch (e) {
      if (AppError.is(e) && e.details.reason === PORTAL_NOT_INSTALLED)
        return this.page(200, installPage(st.p));
      this.deps.logger?.warn(
        { event: 'oauth.bitrix_login_failed', code: AppError.is(e) ? e.code : 'INTERNAL_ERROR' },
        'Вход через Bitrix24 не удался',
      );
      return this.page(
        502,
        errorPage('Вход не выполнен', 'Не удалось войти через Bitrix24, попробуйте ещё раз'),
      );
    }
    if (identity.tenantId !== st.t)
      return this.page(400, errorPage('Вход не выполнен', 'Вход выполнен в другой портал, чем был указан'));
    const tenant = await this.deps.tenants.get(identity.tenantId);
    if (tenant?.status !== 'active')
      return this.page(403, errorPage('Доступ приостановлен', 'Доступ портала к сервису приостановлен'));

    const defaults = await this.deps.tenantSettings.get(tenant.id);
    let user = await this.deps.users.upsertFromBitrix({
      tenantId: tenant.id,
      bitrixUserId: identity.bitrixUserId,
      displayName: identity.displayName,
      email: identity.email ?? null,
      defaultRole: defaults.defaultRole,
    });
    if (user.status === 'disabled')
      return this.redirect(
        st.r,
        st.st,
        { error: 'access_denied', error_description: 'Пользователь отключён администратором портала' },
        302,
      );
    if (user.status === 'reauth_required') {
      // Свежий вход через Bitrix24 состоялся (S3 сохранил новые токены) — повторный вход больше не нужен.
      await this.deps.users.setStatus(tenant.id, user.id, 'active');
      user = { ...user, status: 'active' };
    }
    const client = await this.resolveSafe(st.c);
    if (!client || !redirectUriMatches(st.r, client.redirectUris)) return this.stale();

    const granted = await this.consents.get(tenant.id, user.id, client.clientId);
    if (granted && st.s.every((s) => granted.includes(s))) {
      const res = await this.issueCode(st, user);
      res.setCookies.push(this.cookie('portal', st.p, 180 * 86_400));
      return res;
    }
    const consentState: ConsentState = {
      ...st,
      u: user.id,
      n: user.displayName || `#${String(user.bitrixUserId)}`,
    };
    const sealed = this.sealer.seal('consent', consentState, this.expiry());
    const res = this.page(
      200,
      consentPage({
        clientName: client.clientName,
        clientId: client.clientId,
        redirectHost: redirectHost(st.r),
        loopbackOnly: client.redirectUris.every(isLoopbackRedirect),
        scopes: st.s,
        portal: st.p,
        userName: consentState.n,
        sealed,
        csrf: this.sealer.csrf(bind, sealed),
      }),
      `form-action 'self' ${this.formTarget(st.r)}`,
    );
    res.setCookies.push(this.cookie('portal', st.p, 180 * 86_400));
    return res;
  }

  /** POST /oauth/consent: решение пользователя на экране согласия. */
  async consent(req: OAuthRequest): Promise<OAuthResponse> {
    let sealed, csrf, decision;
    try {
      sealed = one(req.body, 'consent');
      csrf = one(req.body, 'csrf');
      decision = one(req.body, 'decision');
    } catch {
      return this.stale();
    }
    const bind = this.bindFrom(req);
    if (!sealed || !csrf || !bind || !safeEqual(csrf, this.sealer.csrf(bind, sealed))) return this.stale();
    const st = this.sealer.open<ConsentState>('consent', sealed, this.now());
    if (st?.b !== sha256Hex(bind)) return this.stale();
    if (decision !== 'approve')
      return this.redirect(
        st.r,
        st.st,
        { error: 'access_denied', error_description: 'Доступ отклонён' },
        303,
      );

    const client = await this.resolveSafe(st.c);
    if (!client || !redirectUriMatches(st.r, client.redirectUris)) return this.stale();
    const user = await this.deps.users.get(st.t, st.u);
    const tenant = await this.deps.tenants.get(st.t);
    if (user?.status !== 'active' || tenant?.status !== 'active')
      return this.redirect(st.r, st.st, { error: 'access_denied' }, 303);
    const previous = (await this.consents.get(st.t, st.u, client.clientId)) ?? [];
    await this.consents.save(st.t, st.u, client.clientId, [...new Set([...previous, ...st.s])]);
    return this.issueCode(st, user, 303);
  }

  private async issueCode(st: LoginState, user: TenantUser, status: 302 | 303 = 302): Promise<OAuthResponse> {
    const code = await this.codes.create(
      {
        clientId: st.c,
        tenantId: st.t,
        userId: user.id,
        redirectUri: st.r,
        codeChallenge: st.cc,
        scope: st.s.join(' '),
        resource: st.res,
        tokenGeneration: user.tokenGeneration,
      },
      this.deps.settings.authCodeTtlSec,
    );
    return this.redirect(st.r, st.st, { code }, status);
  }

  // ───────────────────────────── token ─────────────────────────────

  async token(req: OAuthRequest): Promise<OAuthResponse> {
    try {
      const client = await this.authenticateClient(req);
      const grantType = one(req.body, 'grant_type');
      if (grantType === 'authorization_code') return await this.exchangeCode(req, client);
      if (grantType === 'refresh_token') return await this.refresh(req, client);
      throw new TokenError('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
    } catch (e) {
      return this.tokenError(e);
    }
  }

  private async exchangeCode(req: OAuthRequest, client: OAuthClient): Promise<OAuthResponse> {
    const code = one(req.body, 'code');
    const redirectUri = one(req.body, 'redirect_uri');
    const verifier = one(req.body, 'code_verifier');
    let resource: string | undefined;
    try {
      resource = one(req.body, 'resource');
    } catch {
      throw new TokenError('invalid_target', 'Поддерживается один resource');
    }
    if (!code) throw new TokenError('invalid_request', 'Не указан code');
    if (!redirectUri) throw new TokenError('invalid_request', 'Не указан redirect_uri');
    if (!verifier) throw new TokenError('invalid_request', 'Требуется PKCE: code_verifier');
    if (!resource) throw new TokenError('invalid_request', 'Требуется параметр resource (RFC 8707)');

    const consumed = await this.codes.consume(code);
    if (consumed.status === 'reused') {
      // OAuth 2.1 §4.1.3: повтор кода — отзыв всего выданного по нему.
      const n = await this.refreshTokens.revokeFamily(consumed.code.familyId);
      this.deps.logger?.warn(
        {
          event: 'oauth.code_reuse',
          clientId: consumed.code.clientId,
          tenantId: consumed.code.tenantId,
          revoked: n,
        },
        'Повторное использование кода авторизации',
      );
      throw new TokenError('invalid_grant', 'Код авторизации уже использован');
    }
    if (consumed.status !== 'ok')
      throw new TokenError('invalid_grant', 'Код авторизации недействителен или истёк');
    const rec = consumed.code;
    if (rec.clientId !== client.clientId) throw new TokenError('invalid_grant', 'Код выдан другому клиенту');
    if (rec.redirectUri !== redirectUri) throw new TokenError('invalid_grant', 'redirect_uri не совпадает');
    if (!pkceMatches(verifier, rec.codeChallenge))
      throw new TokenError('invalid_grant', 'Проверка PKCE не пройдена');
    if (canonicalResource(resource) !== rec.resource)
      throw new TokenError('invalid_target', 'resource не совпадает с запрошенным при авторизации');
    const user = await this.activeUser(rec.tenantId, rec.userId);
    if (user?.tokenGeneration !== rec.tokenGeneration)
      throw new TokenError('invalid_grant', 'Доступ отозван');

    const scopes = rec.scope.split(' ') as OAuthScope[];
    const access = await this.accessToken(rec.tenantId, user, scopes, client.clientId);
    let refreshToken: string | undefined;
    if (client.metadata.grant_types.includes('refresh_token')) {
      refreshToken = await this.refreshTokens.issue(
        {
          familyId: rec.familyId,
          clientId: client.clientId,
          tenantId: rec.tenantId,
          userId: rec.userId,
          scope: rec.scope,
          resource: rec.resource,
          tokenGeneration: user.tokenGeneration,
        },
        this.deps.settings.refreshTokenTtlSec,
      );
    }
    await this.clients.touch(client.clientId);
    return this.tokenResponse(access, scopes, refreshToken);
  }

  private async refresh(req: OAuthRequest, client: OAuthClient): Promise<OAuthResponse> {
    const token = one(req.body, 'refresh_token');
    const scopeParam = one(req.body, 'scope');
    let resource: string | undefined;
    try {
      resource = one(req.body, 'resource');
    } catch {
      throw new TokenError('invalid_target', 'Поддерживается один resource');
    }
    if (!token) throw new TokenError('invalid_request', 'Не указан refresh_token');
    if (!client.metadata.grant_types.includes('refresh_token'))
      throw new TokenError('unauthorized_client', 'Клиенту не разрешён refresh_token');
    const found = await this.refreshTokens.find(token);
    if (found?.clientId !== client.clientId)
      throw new TokenError('invalid_grant', 'refresh_token недействителен');
    const original = found.scope.split(' ');
    let scopes = original as OAuthScope[];
    if (scopeParam !== undefined) {
      const requested = this.parseScopes(scopeParam);
      if (!requested?.every((s) => original.includes(s)))
        throw new TokenError('invalid_scope', 'Можно запросить только ранее выданные права');
      scopes = requested;
    }
    if (resource !== undefined && canonicalResource(resource) !== found.resource)
      throw new TokenError('invalid_target', 'resource не совпадает с выданным');

    let user: TenantUser | undefined;
    const result = await this.refreshTokens.rotate(
      token,
      client.clientId,
      this.deps.settings.refreshTokenTtlSec,
      async (rec: RefreshRecord) => {
        user = await this.activeUser(rec.tenantId, rec.userId);
        if (user?.tokenGeneration !== rec.tokenGeneration) return undefined;
        return { scope: scopes.join(' ') };
      },
    );
    if (result.status === 'reuse_detected') {
      this.deps.logger?.warn(
        { event: 'oauth.refresh_reuse', clientId: client.clientId, tenantId: result.record.tenantId },
        'Повторное использование refresh-токена: семья отозвана',
      );
      throw new TokenError('invalid_grant', 'refresh_token уже использован; доступ отозван');
    }
    if (result.status !== 'ok' || !result.token || !user)
      throw new TokenError('invalid_grant', 'refresh_token недействителен');
    const access = await this.accessToken(result.record.tenantId, user, scopes, client.clientId);
    await this.clients.touch(client.clientId);
    return this.tokenResponse(access, scopes, result.token);
  }

  private async accessToken(
    tenantId: string,
    user: TenantUser,
    scopes: readonly OAuthScope[],
    clientId: string,
  ): Promise<string> {
    return this.deps.keys.sign(
      {
        iss: this.issuer,
        aud: mcpResource(this.deps.settings),
        sub: user.id,
        tid: tenantId,
        scope: scopes.join(' '),
        gen: user.tokenGeneration,
        client_id: clientId,
        jti: randomToken(16),
      },
      this.deps.settings.accessTokenTtlSec,
    );
  }

  private tokenResponse(
    access: string,
    scopes: readonly OAuthScope[],
    refresh: string | undefined,
  ): OAuthResponse {
    return this.json(200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.deps.settings.accessTokenTtlSec,
      scope: scopes.join(' '),
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  }

  /** Пользователь и арендатор активны (иначе undefined). */
  private async activeUser(tenantId: string, userId: string): Promise<TenantUser | undefined> {
    const tenant = await this.deps.tenants.get(tenantId);
    if (tenant?.status !== 'active') return undefined;
    const user = await this.deps.users.get(tenantId, userId);
    return user?.status === 'active' ? user : undefined;
  }

  /**
   * Аутентификация клиента на token/revoke (RFC 6749 §2.3.1, OAuth 2.1 §2.4): способ должен совпадать с
   * зарегистрированным; публичный клиент передаёт только client_id.
   */
  private async authenticateClient(req: OAuthRequest): Promise<OAuthClient> {
    const header = req.headers?.authorization;
    let clientId = one(req.body, 'client_id');
    let secret: string | undefined;
    let method: 'none' | 'client_secret_post' | 'client_secret_basic' = 'none';
    if (header && /^Basic\s+/i.test(header)) {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) throw new TokenError('invalid_client', 'Неверная аутентификация клиента', 401, true);
      let basicId: string;
      try {
        basicId = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' '));
        secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' '));
      } catch {
        throw new TokenError('invalid_client', 'Неверная аутентификация клиента', 401, true);
      }
      if (clientId && clientId !== basicId)
        throw new TokenError('invalid_request', 'client_id в теле и в заголовке различаются');
      clientId = basicId;
      method = 'client_secret_basic';
    } else if (one(req.body, 'client_secret') !== undefined) {
      secret = one(req.body, 'client_secret');
      method = 'client_secret_post';
    }
    if (!clientId) throw new TokenError('invalid_client', 'Не указан client_id', 401);
    let client: OAuthClient | undefined;
    try {
      client = await this.resolver.resolve(clientId);
    } catch {
      client = undefined;
    }
    if (!client)
      throw new TokenError('invalid_client', 'Неизвестный клиент', 401, method === 'client_secret_basic');
    if (client.metadata.token_endpoint_auth_method !== method)
      throw new TokenError(
        'invalid_client',
        'Способ аутентификации клиента не совпадает',
        401,
        method === 'client_secret_basic',
      );
    if (
      method !== 'none' &&
      (!secret || !client.secretHash || !safeEqual(sha256Hex(secret), client.secretHash))
    )
      throw new TokenError(
        'invalid_client',
        'Неверный секрет клиента',
        401,
        method === 'client_secret_basic',
      );
    return client;
  }

  // ───────────────────────────── revoke (RFC 7009) ─────────────────────────────

  async revoke(req: OAuthRequest): Promise<OAuthResponse> {
    let client: OAuthClient;
    let token: string | undefined;
    try {
      client = await this.authenticateClient(req);
      token = one(req.body, 'token');
    } catch (e) {
      return this.tokenError(e);
    }
    if (!token) return this.tokenError(new TokenError('invalid_request', 'Не указан token'));
    // RFC 7009 §2.2: неизвестный или чужой токен — тоже 200 (не раскрываем существование).
    if (token.startsWith('mcpr_')) {
      const rec = await this.refreshTokens.find(token);
      if (rec?.clientId === client.clientId) await this.refreshTokens.revokeFamily(rec.familyId);
    } else {
      await this.revokeAccessToken(token, client.clientId);
    }
    return {
      status: 200,
      headers: this.noStore({ 'Content-Type': 'application/json' }),
      setCookies: [],
      body: '{}',
    };
  }

  private async revokeAccessToken(token: string, clientId: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, this.deps.keys.getKey, {
        issuer: this.issuer,
        audience: mcpResource(this.deps.settings),
        algorithms: ['ES256', 'EdDSA'],
        currentDate: new Date(this.now()),
      });
      if (payload['client_id'] !== clientId || typeof payload.jti !== 'string' || !payload.exp) return;
      const ttlMs = payload.exp * 1000 - this.now() + 60_000;
      if (ttlMs > 0) await this.deps.coordination.incr(revokedJtiKey(payload.jti), 1, ttlMs);
    } catch {
      // Невалидный/просроченный токен: отзывать нечего.
    }
  }

  // ───────────────────────────── отзыв доступа (§7.4) ─────────────────────────────

  /**
   * Отключение пользователя (§7.4, S07): все refresh-токены пользователя отозваны, поколение +1 (выданные access
   * отклоняются SaasTokenVerifier), неисполненные подготовленные/подтверждённые операции → denied
   * (principal_id операций в saas = tenant_users.id), оповещение экземпляров для сброса кэша контекстов.
   */
  async revokeUser(
    tenantId: string,
    userId: string,
  ): Promise<{ refreshRevoked: number; operationsDenied: number }> {
    const refreshRevoked = await this.refreshTokens.revokeUser(tenantId, userId);
    await this.deps.users.bumpGeneration(tenantId, userId);
    const operationsDenied = await new OperationsStore(this.deps.db, tenantId).denyAllPending(userId);
    await this.deps.coordination.publish(REVOCATION_CHANNEL, JSON.stringify({ tenantId, userId }));
    return { refreshRevoked, operationsDenied };
  }

  /** Блокировка/удаление арендатора (§7.4): то же для всех пользователей портала. */
  async revokeTenant(tenantId: string): Promise<{ refreshRevoked: number; operationsDenied: number }> {
    const refreshRevoked = await this.refreshTokens.revokeTenant(tenantId);
    const operationsDenied = await this.deps.db.withTenant(tenantId, async (x) => {
      await x.run(
        'UPDATE tenant_users SET token_generation = token_generation + 1, updated_at = ? WHERE tenant_id = ?',
        new Date(this.now()).toISOString(),
        tenantId,
      );
      return x.run(
        "UPDATE operations SET status = 'denied', finished_at = ? WHERE tenant_id = ? AND status IN ('prepared','approved')",
        new Date(this.now()).toISOString(),
        tenantId,
      );
    });
    await this.deps.coordination.publish(REVOCATION_CHANNEL, JSON.stringify({ tenantId }));
    return { refreshRevoked, operationsDenied };
  }

  /** Задачи worker: удаление неиспользуемых клиентов, истёкших кодов и refresh, ротация ключа по возрасту. */
  async runMaintenance(): Promise<{ clients: number; codes: number; refresh: number; rotated: boolean }> {
    const clients = await this.clients.purgeUnused(this.deps.settings.unusedClientRetentionDays);
    const codes = await this.codes.purgeExpired();
    const refresh = await this.refreshTokens.purgeExpired();
    const rotated = await this.deps.keys.rotateIfDue();
    return { clients, codes, refresh, rotated };
  }

  // ───────────────────────────── вспомогательное ─────────────────────────────

  /** scope из запроса → набор прав сервиса; пусто — все права; offline_access допускается и не хранится. */
  private parseScopes(raw: string | undefined): OAuthScope[] | undefined {
    if (raw === undefined || raw.trim() === '') return [...OAUTH_SCOPES];
    const out = new Set<OAuthScope>();
    for (const s of raw.split(' ').filter(Boolean)) {
      if (s === 'offline_access') continue;
      if (!(OAUTH_SCOPES as readonly string[]).includes(s)) return undefined;
      out.add(s as OAuthScope);
    }
    return out.size > 0 ? OAUTH_SCOPES.filter((s) => out.has(s)) : [...OAUTH_SCOPES];
  }

  private async resolveSafe(clientId: string): Promise<OAuthClient | undefined> {
    try {
      return await this.resolver.resolve(clientId);
    } catch {
      return undefined;
    }
  }

  private expiry(): number {
    return this.now() + this.deps.settings.authRequestTtlSec * 1000;
  }

  private cookieName(kind: 'bind' | 'portal'): string {
    return `${this.secure ? '__Host-' : ''}mcp_as_${kind}`;
  }

  private cookie(kind: 'bind' | 'portal', value: string, maxAgeSec: number): string {
    return `${this.cookieName(kind)}=${encodeURIComponent(value)}; Path=/; Max-Age=${String(maxAgeSec)}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
  }

  private bindFrom(req: OAuthRequest): string | undefined {
    const v = parseCookies(req.headers?.cookie).get(this.cookieName('bind'));
    return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
  }

  private rememberedPortal(cookies: Map<string, string>): string {
    const raw = cookies.get(this.cookieName('portal'));
    if (!raw) return '';
    try {
      return normalizePortalDomain(decodeURIComponent(raw));
    } catch {
      return '';
    }
  }

  /** Источник для CSP form-action: redirect после POST /oauth/consent идёт на адрес клиента. */
  private formTarget(redirectUri: string): string {
    const url = new URL(redirectUri);
    return url.protocol === 'http:' ? `http://${url.hostname}:*` : url.origin;
  }

  private redirect(
    redirectUri: string,
    state: string | undefined,
    params: Record<string, string>,
    status: 302 | 303,
  ): OAuthResponse {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
    if (state !== undefined) url.searchParams.append('state', state);
    url.searchParams.append('iss', this.issuer);
    return this.location(status, url.toString());
  }

  private location(status: number, url: string): OAuthResponse {
    return {
      status,
      headers: this.noStore({ Location: url, 'Referrer-Policy': 'no-referrer' }),
      setCookies: [],
      body: '',
    };
  }

  private stale(): OAuthResponse {
    return this.page(
      400,
      errorPage(
        'Сеанс подключения устарел',
        'Запрос устарел или открыт в другом браузере. Начните подключение заново.',
      ),
    );
  }

  private noStore(headers: Record<string, string>): Record<string, string> {
    return { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers };
  }

  private json(status: number, body: unknown, cache?: string): OAuthResponse {
    const headers: Record<string, string> = cache
      ? { 'Cache-Control': cache, 'Content-Type': 'application/json' }
      : this.noStore({ 'Content-Type': 'application/json' });
    return { status, headers, setCookies: [], body: JSON.stringify(body) };
  }

  private page(status: number, html: string, formAction = "form-action 'self'"): OAuthResponse {
    return {
      status,
      headers: this.noStore({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      }),
      setCookies: [],
      body: html,
    };
  }

  private tokenError(e: unknown): OAuthResponse {
    if (e instanceof DuplicateParam)
      return this.json(400, {
        error: 'invalid_request',
        error_description: `Параметр ${e.param} повторяется`,
      });
    if (!(e instanceof TokenError)) throw e;
    const res = this.json(e.status, { error: e.error, error_description: e.description });
    if (e.basicChallenge) res.headers['WWW-Authenticate'] = 'Basic realm="oauth"';
    return res;
  }
}

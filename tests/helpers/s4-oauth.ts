/**
 * Стенд тестов сервера авторизации MCP (S4): тестовый BitrixLoginGateway (без сети Bitrix24), каталог ключей
 * во временной папке, InMemoryCoordination, управляемые часы и помощники прохождения потока authorize.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../src/errors/app-error.js';
import { InMemoryCoordination } from '../../src/saas/coordination.js';
import { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import {
  AuthorizationServer,
  PORTAL_NOT_INSTALLED,
  resolveOAuthSettings,
  SaasTokenVerifier,
  SigningKeyStore,
  type BitrixLoginGateway,
  type BitrixLoginIdentity,
  type OAuthRequest,
  type OAuthResponse,
  type OAuthServerSettings,
} from '../../src/saas/oauth/index.js';
import { pkceS256 } from '../../src/saas/oauth/crypto.js';
import type { FetchLike } from '../../src/bitrix/client.js';
import type { SaasTestDb } from './saas.js';

export const BASE = 'https://mcp.example.ru';
export const RESOURCE = `${BASE}/mcp`;

/** Тестовый вход через Bitrix24: code обратного вызова → заранее заданная личность. */
export class FakeBitrixLoginGateway implements BitrixLoginGateway {
  readonly identities = new Map<string, BitrixLoginIdentity>();
  readonly started: { portal: string; state: string }[] = [];

  startLogin(portalDomain: string, state: string): Promise<string> {
    this.started.push({ portal: portalDomain, state });
    const url = new URL(`https://${portalDomain}/oauth/authorize/`);
    url.searchParams.set('client_id', 'app.test');
    url.searchParams.set('state', state);
    return Promise.resolve(url.toString());
  }

  completeLogin(q: Readonly<Record<string, string | undefined>>): Promise<BitrixLoginIdentity> {
    const id = q['code'] ? this.identities.get(q['code']) : undefined;
    if (q['code'] === 'not-installed')
      return Promise.reject(
        new AppError('NOT_FOUND', 'Приложение не установлено', { reason: PORTAL_NOT_INSTALLED }),
      );
    if (!id) return Promise.reject(new AppError('BITRIX_AUTH_FAILED', 'Неверный код'));
    return Promise.resolve(id);
  }
}

export class Clock {
  constructor(public t = Date.parse('2026-09-25T10:00:00Z')) {}
  now = (): number => this.t;
  advance(sec: number): void {
    this.t += sec * 1000;
  }
}

export interface OAuthStand {
  as: AuthorizationServer;
  verifier: SaasTokenVerifier;
  keys: SigningKeyStore;
  settings: OAuthServerSettings;
  gateway: FakeBitrixLoginGateway;
  coordination: InMemoryCoordination;
  tenants: TenantsRepo;
  users: TenantUsersRepo;
  clock: Clock;
}

export async function makeStand(
  s: SaasTestDb,
  opts: { settings?: Partial<OAuthServerSettings>; fetch?: FetchLike } = {},
): Promise<OAuthStand> {
  const clock = new Clock();
  const settings = resolveOAuthSettings({
    publicBaseUrl: BASE,
    signingKeysDir: mkdtempSync(path.join(tmpdir(), 's4-keys-')),
    ...opts.settings,
  });
  const keys = await SigningKeyStore.open(settings, clock.now);
  const coordination = new InMemoryCoordination(clock.now);
  const gateway = new FakeBitrixLoginGateway();
  const tenants = new TenantsRepo(s.db, s.keys);
  const users = new TenantUsersRepo(s.db);
  const as = new AuthorizationServer({
    settings,
    db: s.db,
    keys,
    coordination,
    gateway,
    tenants,
    users,
    tenantSettings: new TenantSettingsRepo(s.db),
    now: clock.now,
    fetch: opts.fetch,
    resolveHost: () => Promise.resolve(['93.184.216.34']),
  });
  const verifier = new SaasTokenVerifier({ settings, keys, tenants, users, coordination, now: clock.now });
  return { as, verifier, keys, settings, gateway, coordination, tenants, users, clock };
}

/** Новый портал-арендатор и личность пользователя для тестового входа. */
export async function newPortal(
  st: OAuthStand,
  bitrixUserId = 1,
): Promise<{ tenantId: string; domain: string; loginCode: string }> {
  const suffix = randomUUID().slice(0, 8);
  const domain = `p${suffix}.bitrix24.ru`;
  const { tenant } = await st.tenants.upsertInstalled({ memberId: `m-${suffix}`, domain, appTokenHash: 'h' });
  const loginCode = `login-${suffix}-${String(bitrixUserId)}`;
  st.gateway.identities.set(loginCode, {
    tenantId: tenant.id,
    bitrixUserId,
    displayName: `Пользователь ${String(bitrixUserId)}`,
  });
  return { tenantId: tenant.id, domain, loginCode };
}

export function cookiesOf(res: OAuthResponse, jar = new Map<string, string>()): Map<string, string> {
  for (const c of res.setCookies) {
    const [pair] = c.split(';');
    const i = pair?.indexOf('=') ?? -1;
    if (pair && i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return jar;
}

export const cookieHeader = (jar: Map<string, string>): string =>
  [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

export function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m?.[1]) throw new Error(`В форме нет поля ${name}`);
  return m[1].replace(/&amp;/g, '&');
}

export const verifierFor = (seed: string): string => (seed + 'x'.repeat(64)).slice(0, 64);

export async function registerClient(
  st: OAuthStand,
  body: Record<string, unknown> = {},
  ip = '203.0.113.5',
): Promise<string> {
  const res = await st.as.register({
    ip,
    body: {
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      ...body,
    },
  });
  if (res.status !== 201) throw new Error(`Регистрация не удалась: ${res.body}`);
  return (JSON.parse(res.body) as { client_id: string }).client_id;
}

export interface FlowInput {
  clientId: string;
  redirectUri?: string;
  verifier?: string;
  portal: string;
  loginCode: string;
  scope?: string;
  state?: string;
  jar?: Map<string, string>;
  extraQuery?: Record<string, string>;
}

/** Полный поток до получения кода (с согласием, если оно нужно). Возвращает URL возврата клиенту. */
export async function authorizeToRedirect(st: OAuthStand, f: FlowInput): Promise<URL> {
  const jar = f.jar ?? new Map<string, string>();
  const verifier = f.verifier ?? verifierFor('v');
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: f.clientId,
    redirect_uri: f.redirectUri ?? 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    resource: RESOURCE,
    state: f.state ?? 'st-1',
    ...(f.scope ? { scope: f.scope } : {}),
    ...f.extraQuery,
  };
  const page = await st.as.authorize({ query, headers: { cookie: cookieHeader(jar) } });
  if (page.status !== 200)
    throw new Error(`authorize: ${String(page.status)} ${page.headers['Location'] ?? ''}`);
  cookiesOf(page, jar);
  const login = await st.as.login({
    body: { request: hidden(page.body, 'request'), csrf: hidden(page.body, 'csrf'), portal: f.portal },
    headers: { cookie: cookieHeader(jar) },
  });
  if (login.status !== 303) throw new Error(`login: ${String(login.status)}`);
  const bitrixUrl = new URL(login.headers['Location'] ?? '');
  const cb = await st.as.bitrixCallback({
    query: { code: f.loginCode, state: bitrixUrl.searchParams.get('state') ?? '', domain: f.portal },
    headers: { cookie: cookieHeader(jar) },
  });
  cookiesOf(cb, jar);
  if (cb.status === 302) return new URL(cb.headers['Location'] ?? '');
  if (cb.status !== 200) throw new Error(`callback: ${String(cb.status)}`);
  const consent = await st.as.consent({
    body: { consent: hidden(cb.body, 'consent'), csrf: hidden(cb.body, 'csrf'), decision: 'approve' },
    headers: { cookie: cookieHeader(jar) },
  });
  if (consent.status !== 303) throw new Error(`consent: ${String(consent.status)}`);
  return new URL(consent.headers['Location'] ?? '');
}

export function tokenRequest(
  body: Record<string, string>,
  headers: OAuthRequest['headers'] = {},
): OAuthRequest {
  return { body, headers };
}

export function parse(res: OAuthResponse): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

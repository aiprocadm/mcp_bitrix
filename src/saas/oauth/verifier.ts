/**
 * Проверка access token сервиса на MCP-запросе в режиме saas (SaaS-ТЗ §5.2 п.2–3, §7.4; спецификация MCP
 * 2026-07-28 basic/authorization/index.mdx «Token Handling»: неверный/просроченный токен — 401, недостаточный
 * scope — 403 с WWW-Authenticate). Порядок: формат Bearer → подпись (JWKS сервера) + typ/iss/aud/exp →
 * отзыв jti → пользователь и арендатор активны → `gen` равно текущему поколению пользователя.
 * Классы ошибки и форма 401/403 — общие с режимом oauth (src/auth/mcp-auth.ts, McpAuthError); сам mcp-auth.ts
 * не меняется: он проверяет внешний AS режима single/oauth.
 */
import { errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { McpAuthError } from '../../auth/mcp-auth.js';
import type { Role } from '../../config/policy.js';
import type { TenantsRepo, TenantUsersRepo } from '../repos/tenants.js';
import type { Coordination } from '../coordination.js';
import { mcpResource, OAUTH_SCOPES, protectedResourceMetadataUrl, type OAuthScope } from './settings.js';
import type { OAuthServerSettings } from './settings.js';
import type { SigningKeyStore } from './signing-keys.js';

export interface SaasPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly bitrixUserId: number;
  /** Роль сервиса, суженная scope токена: без mcp:write — reader (ТЗ §4: роль только сужает права). */
  readonly role: Role;
  readonly scopes: readonly OAuthScope[];
  readonly clientId: string | undefined;
  /** Секунды epoch. */
  readonly expiresAt: number;
  readonly jti: string;
}

/** Ключ отзыва access token по jti в Coordination (значение > 0 — отозван). */
export const revokedJtiKey = (jti: string): string => `oauth:revoked-jti:${jti}`;

const JWT_ALGS = ['ES256', 'EdDSA'];

function describe(e: unknown): { ru: string; ascii: string } {
  if (e instanceof joseErrors.JWTExpired) return { ru: 'Токен просрочен', ascii: 'token expired' };
  if (e instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = /^[a-z_]+$/i.test(e.claim) ? e.claim : 'claim';
    return { ru: `Токен не прошёл проверку утверждения ${claim}`, ascii: `claim ${claim} check failed` };
  }
  if (e instanceof joseErrors.JWKSNoMatchingKey || e instanceof joseErrors.JWSSignatureVerificationFailed)
    return { ru: 'Подпись токена не подтверждена', ascii: 'signature not verified' };
  return { ru: 'Токен неверного формата или не прошёл проверку', ascii: 'malformed token' };
}

const revoked = (ascii: string, ru = 'Доступ отозван, подключите приложение заново') =>
  new McpAuthError(401, 'invalid_token', ru, undefined, ascii);

export class SaasTokenVerifier {
  constructor(
    private readonly deps: {
      readonly settings: OAuthServerSettings;
      readonly keys: SigningKeyStore;
      readonly tenants: TenantsRepo;
      readonly users: TenantUsersRepo;
      readonly coordination?: Coordination | undefined;
      readonly now?: (() => number) | undefined;
    },
  ) {}

  /** Значение заголовка Authorization → субъект; ошибка — McpAuthError (статус и код RFC 6750). */
  async verify(authorization: string | undefined): Promise<SaasPrincipal> {
    if (!authorization?.trim())
      throw new McpAuthError(
        401,
        'invalid_token',
        'Требуется заголовок Authorization: Bearer <access token>',
      );
    const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization.trim());
    if (!m?.[1]) throw new McpAuthError(400, 'invalid_request', 'Поддерживается только схема Bearer');
    const { settings } = this.deps;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], this.deps.keys.getKey, {
        issuer: settings.publicBaseUrl,
        audience: mcpResource(settings),
        algorithms: JWT_ALGS,
        typ: 'at+jwt',
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat', 'sub', 'jti', 'tid', 'gen', 'scope'],
        ...(this.deps.now ? { currentDate: new Date(this.deps.now()) } : {}),
      }));
    } catch (e) {
      const d = describe(e);
      throw new McpAuthError(401, 'invalid_token', d.ru, undefined, d.ascii);
    }
    const sub = payload.sub;
    const tid = payload['tid'];
    const gen = payload['gen'];
    const jti = payload.jti;
    const scopeClaim = payload['scope'];
    if (
      typeof sub !== 'string' ||
      typeof tid !== 'string' ||
      typeof gen !== 'number' ||
      typeof jti !== 'string' ||
      typeof scopeClaim !== 'string'
    )
      throw new McpAuthError(401, 'invalid_token', 'Токен неверного формата', undefined, 'malformed token');
    const scopes = scopeClaim
      .split(' ')
      .filter((s): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0)
      throw new McpAuthError(403, 'insufficient_scope', 'Токен не содержит прав сервиса', undefined);

    if (this.deps.coordination && (await this.deps.coordination.get(revokedJtiKey(jti))) > 0)
      throw revoked('token revoked');
    const tenant = await this.deps.tenants.get(tid);
    if (tenant?.status !== 'active') throw revoked('tenant inactive', 'Портал отключён от сервиса');
    const user = await this.deps.users.get(tid, sub);
    if (user?.status !== 'active') throw revoked('user inactive', 'Пользователь отключён или требуется вход');
    if (user.tokenGeneration !== gen) throw revoked('token generation revoked');

    const clientId = payload['client_id'];
    return {
      tenantId: tid,
      userId: sub,
      bitrixUserId: user.bitrixUserId,
      role: scopes.includes('mcp:write') ? user.role : 'reader',
      scopes,
      clientId: typeof clientId === 'string' ? clientId : undefined,
      expiresAt: payload.exp ?? 0,
      jti,
    };
  }
}

/** Проверка прав операции: нет scope → 403 insufficient_scope (спецификация: «Runtime Insufficient Scope Errors»). */
export function requireScope(p: SaasPrincipal, scope: OAuthScope): void {
  if (!p.scopes.includes(scope))
    throw new McpAuthError(
      403,
      'insufficient_scope',
      `Недостаточно прав: нужен ${scope}`,
      undefined,
      `${scope} required`,
    );
}

function quote(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, ' ')
    .trim();
}

/**
 * WWW-Authenticate для ответов 401/403 MCP-эндпоинта (RFC 6750 §3, RFC 9728 §5.1, спецификация MCP
 * «Scope Selection Strategy»): resource_metadata всегда; scope — минимально нужные права.
 */
export function saasWwwAuthenticate(
  settings: OAuthServerSettings,
  err?: McpAuthError,
  requiredScopes: readonly OAuthScope[] = OAUTH_SCOPES,
): string {
  const parts: string[] = [];
  if (err?.code === 'insufficient_scope') {
    parts.push('error="insufficient_scope"', `scope="${requiredScopes.join(' ')}"`);
  } else if (err?.code === 'invalid_token') {
    parts.push('error="invalid_token"');
    if (err.asciiDescription) parts.push(`error_description="${quote(err.asciiDescription)}"`);
  } else if (err?.code === 'invalid_request') {
    parts.push('error="invalid_request"');
  } else {
    parts.push(`scope="${requiredScopes.join(' ')}"`);
  }
  parts.push(`resource_metadata="${protectedResourceMetadataUrl(settings)}"`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * OAuth-защита самого MCP-сервера (ТЗ §4.2, §8.1, §18.3; спецификация MCP Authorization — S25).
 * Сервер — resource server: проверяет на КАЖДОМ запросе подпись (JWKS издателя), `iss`, `aud`
 * (канонический адрес нашего сервера, RFC 8707), срок, `sub` в allowlist и scope; выдаёт 401/403
 * с `WWW-Authenticate: Bearer resource_metadata=...` (RFC 6750/9728). Токен Bitrix24 здесь не принимается:
 * это другой контур авторизации. Сетевой вызов к JWKS делает библиотека jose по явно настроенному адресу.
 */
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { McpAuthSettings } from '../config/env.js';
import type { AccessPolicy, Role } from '../config/policy.js';
import type { Principal } from './principal.js';

export const MCP_SCOPES = ['read', 'write', 'admin'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export type McpAuthFailure =
  'invalid_request' | 'invalid_token' | 'insufficient_scope' | 'access_denied' | 'server_error';

export class McpAuthError extends Error {
  /**
   * @param message — для тела ответа (может быть по-русски).
   * @param asciiDescription — для `error_description` в WWW-Authenticate: значения HTTP-заголовков только ASCII.
   */
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    readonly code: McpAuthFailure,
    message: string,
    readonly requiredScope?: McpScope,
    readonly asciiDescription?: string,
  ) {
    super(message);
    this.name = 'McpAuthError';
  }
}

export interface VerifiedToken {
  readonly principal: Principal;
  readonly scopes: readonly string[];
  /** Секунды epoch. */
  readonly expiresAt: number;
  readonly clientId: string | undefined;
}

const ROLE_RANK: Record<Role, number> = { reader: 1, operator: 2, administrator: 3 };

/** Иерархия scope: admin ⊇ write ⊇ read (спецификация требует учитывать иерархии). */
function roleFromScopes(scopes: readonly string[]): Role | undefined {
  if (scopes.includes('admin')) return 'administrator';
  if (scopes.includes('write')) return 'operator';
  if (scopes.includes('read')) return 'reader';
  return undefined;
}

/** `scope` (строка через пробел, RFC 8693/9068) или `scp` (массив либо строка — у части издателей). */
function extractScopes(payload: JWTPayload): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const s of value.split(/\s+/)) if (s) out.add(s);
    } else if (Array.isArray(value)) {
      for (const s of value) if (typeof s === 'string' && s) out.add(s);
    }
  };
  add(payload['scope']);
  add(payload['scp']);
  return [...out];
}

function describeJoseError(e: unknown): { ru: string; ascii: string } {
  if (e instanceof joseErrors.JWTExpired) return { ru: 'Токен просрочен', ascii: 'token expired' };
  if (e instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = /^[a-z_]+$/i.test(e.claim) ? e.claim : 'claim';
    return { ru: `Токен не прошёл проверку утверждения ${claim}`, ascii: `claim ${claim} check failed` };
  }
  if (e instanceof joseErrors.JWKSNoMatchingKey || e instanceof joseErrors.JWSSignatureVerificationFailed)
    return { ru: 'Подпись токена не подтверждена ключами издателя', ascii: 'signature not verified' };
  return { ru: 'Токен неверного формата или не прошёл проверку', ascii: 'malformed token' };
}

export class McpTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(
    private readonly settings: McpAuthSettings,
    private readonly access: AccessPolicy,
    getKey?: JWTVerifyGetKey,
  ) {
    this.getKey =
      getKey ??
      createRemoteJWKSet(new URL(settings.jwksUri), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
  }

  /** Проверяет значение заголовка Authorization. Ошибка — McpAuthError с HTTP-статусом и кодом RFC 6750. */
  async verify(authorization: string | undefined): Promise<VerifiedToken> {
    if (!authorization?.trim()) {
      throw new McpAuthError(
        401,
        'invalid_token',
        'Требуется заголовок Authorization: Bearer <access token>',
      );
    }
    const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization.trim());
    if (!m?.[1]) throw new McpAuthError(400, 'invalid_request', 'Поддерживается только схема Bearer');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], this.getKey, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        clockTolerance: 30,
        requiredClaims: ['exp', 'sub', 'iat'],
      }));
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) {
        const d = describeJoseError(e);
        throw new McpAuthError(401, 'invalid_token', d.ru, undefined, d.ascii);
      }
      // Сетевая недоступность JWKS — не вина клиента: 503 без раскрытия причины.
      throw new McpAuthError(503, 'server_error', 'Ключи издателя временно недоступны');
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub || !this.settings.allowedSubjects.includes(sub)) {
      throw new McpAuthError(403, 'access_denied', 'Субъект токена не входит в allowlist сервера');
    }
    const scopes = extractScopes(payload);
    const scopeRole = roleFromScopes(scopes);
    if (!scopeRole) {
      throw new McpAuthError(403, 'insufficient_scope', 'Токен не содержит ни одного scope сервера', 'read');
    }
    // Роль = минимум из роли в access policy (по умолчанию reader) и роли по scope токена.
    const policyRole: Role = this.access.principals[sub]?.role ?? 'reader';
    const role: Role = ROLE_RANK[scopeRole] < ROLE_RANK[policyRole] ? scopeRole : policyRole;
    const clientId = payload['client_id'] ?? payload['azp'];
    return {
      principal: { id: sub, role, source: 'oauth' },
      scopes,
      expiresAt: payload.exp ?? 0,
      clientId: typeof clientId === 'string' ? clientId : undefined,
    };
  }
}

/** Значение параметра заголовка: только печатный ASCII без кавычек (RFC 6750 §3 quoted-string). */
function quote(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, ' ')
    .trim();
}

/** Заголовок WWW-Authenticate (RFC 6750 §3, MCP Authorization «Scope Selection Strategy»). */
export function wwwAuthenticate(settings: McpAuthSettings, err?: McpAuthError): string {
  const parts: string[] = [];
  if (err?.code === 'insufficient_scope') {
    parts.push('error="insufficient_scope"', `scope="${err.requiredScope ?? 'read'}"`);
  } else if (err?.code === 'invalid_token' && err.asciiDescription) {
    parts.push('error="invalid_token"', `error_description="${quote(err.asciiDescription)}"`);
  } else {
    // Первичный вызов без токена: подсказка минимального scope (спецификация, Scope Selection Strategy).
    parts.push('scope="read"');
  }
  parts.push(`resource_metadata="${settings.metadataUrl}"`);
  return `Bearer ${parts.join(', ')}`;
}

/** Документ RFC 9728 (Protected Resource Metadata): только публичные сведения, без токенов. */
export function protectedResourceMetadata(
  settings: McpAuthSettings,
  resourceName: string,
): Record<string, unknown> {
  return {
    resource: settings.resource,
    authorization_servers: [settings.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: resourceName,
  };
}

/** Origin браузерного клиента: отсутствие допустимо (серверные клиенты), произвольный — нет (ТЗ §8.6). */
export function originAllowed(
  origin: string | undefined,
  settings: McpAuthSettings,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === '') return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // включая непрозрачный "null"
  }
  if (parsed.origin === 'null') return false;
  if (parsed.origin === settings.publicOrigin) return true;
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.includes('://')) {
      try {
        return new URL(e).origin === parsed.origin;
      } catch {
        return false;
      }
    }
    return e === parsed.hostname.toLowerCase();
  });
}

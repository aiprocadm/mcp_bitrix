/**
 * Настройки сервера авторизации MCP (SaaS-ТЗ §7.1, §15). Значения собирает сборка режима saas из окружения
 * (переменные перечислены в docs/saas/s4-oauth.md); модуль сам env не читает.
 */
import { AppError } from '../../errors/app-error.js';

export type SigningAlg = 'ES256' | 'EdDSA';

export interface OAuthServerSettings {
  /** PUBLIC_BASE_URL: origin сервиса без завершающего `/` — это `issuer` (RFC 8414) и основа всех адресов. */
  readonly publicBaseUrl: string;
  /** OAUTH_SIGNING_KEYS_DIR: каталог ключей подписи JWT и ключа состояния (общий для всех экземпляров web, 0700). */
  readonly signingKeysDir: string;
  /** Алгоритм подписи access token. По умолчанию ES256. */
  readonly signingAlg: SigningAlg;
  /** Срок жизни access token, с (ТЗ §7.1: 10 минут). */
  readonly accessTokenTtlSec: number;
  /** Срок жизни refresh token, с (ТЗ §7.1: 30 дней; скользящий — считается от последней ротации). */
  readonly refreshTokenTtlSec: number;
  /** Срок жизни кода авторизации, с (не больше 60). */
  readonly authCodeTtlSec: number;
  /** Срок жизни незавершённого запроса авторизации (вход в Bitrix24 + согласие), с. */
  readonly authRequestTtlSec: number;
  /** Возраст активного ключа подписи, после которого он автоматически заменяется новым, с. */
  readonly signingKeyRotationSec: number;
  /** DCR: не больше `limit` регистраций с одного IP за `windowSec` (ТЗ §7.1, §12 п.7). */
  readonly registrationRateLimit: { readonly limit: number; readonly windowSec: number };
  /** Клиенты, не использованные дольше этого срока, удаляет worker (ТЗ §7.1: 30 дней). */
  readonly unusedClientRetentionDays: number;
  /** Client ID Metadata Documents (спецификация MCP 2026-07-28, client-registration). */
  readonly cimd: {
    readonly enabled: boolean;
    /** Политика доверия: пусто — любой публичный https-хост; иначе только эти хосты и их поддомены. */
    readonly allowedHosts: readonly string[];
    readonly fetchTimeoutMs: number;
    readonly maxBytes: number;
    /** Границы срока кэша документа (учитывается Cache-Control max-age). */
    readonly minCacheSec: number;
    readonly maxCacheSec: number;
  };
  /** Имя ресурса в метаданных RFC 9728. */
  readonly resourceName: string;
}

export const OAUTH_SCOPES = ['mcp:read', 'mcp:write'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** Значения по умолчанию (ТЗ §7.1). */
export const OAUTH_DEFAULTS = {
  signingAlg: 'ES256',
  accessTokenTtlSec: 600,
  refreshTokenTtlSec: 30 * 24 * 3600,
  authCodeTtlSec: 60,
  authRequestTtlSec: 600,
  signingKeyRotationSec: 30 * 24 * 3600,
  registrationRateLimit: { limit: 10, windowSec: 3600 },
  unusedClientRetentionDays: 30,
  cimd: {
    enabled: true,
    allowedHosts: [],
    fetchTimeoutMs: 5000,
    maxBytes: 5 * 1024,
    minCacheSec: 300,
    maxCacheSec: 24 * 3600,
  },
  resourceName: 'MCP для Bitrix24',
} as const satisfies Omit<OAuthServerSettings, 'publicBaseUrl' | 'signingKeysDir'>;

const invalid = (field: string, why: string) =>
  new AppError('CONFIG_INVALID', `Настройка сервера авторизации ${field}: ${why}`, { field });

/** Полные настройки из обязательных и частичных; проверяет инварианты (TTL кода ≤ 60 с и т.п.). */
export function resolveOAuthSettings(
  input: Pick<OAuthServerSettings, 'publicBaseUrl' | 'signingKeysDir'> &
    Partial<Omit<OAuthServerSettings, 'publicBaseUrl' | 'signingKeysDir' | 'cimd'>> & {
      cimd?: Partial<OAuthServerSettings['cimd']>;
    },
): OAuthServerSettings {
  let base: URL;
  try {
    base = new URL(input.publicBaseUrl);
  } catch {
    throw invalid('PUBLIC_BASE_URL', 'не является абсолютным URL');
  }
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
    throw invalid('PUBLIC_BASE_URL', 'только origin без пути, query и учётных данных');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    throw invalid('PUBLIC_BASE_URL', 'требуется https (http только для loopback)');
  if (!input.signingKeysDir) throw invalid('OAUTH_SIGNING_KEYS_DIR', 'не задан');
  const s: OAuthServerSettings = {
    ...OAUTH_DEFAULTS,
    ...input,
    publicBaseUrl: base.origin,
    cimd: { ...OAUTH_DEFAULTS.cimd, ...input.cimd },
  };
  if (s.authCodeTtlSec <= 0 || s.authCodeTtlSec > 60) throw invalid('authCodeTtlSec', 'от 1 до 60 секунд');
  if (s.accessTokenTtlSec <= 0 || s.accessTokenTtlSec > 3600)
    throw invalid('accessTokenTtlSec', 'от 1 до 3600 секунд');
  if (s.refreshTokenTtlSec <= s.accessTokenTtlSec)
    throw invalid('refreshTokenTtlSec', 'должен быть больше срока access token');
  if (s.signingKeyRotationSec <= s.accessTokenTtlSec)
    throw invalid('signingKeyRotationSec', 'должен быть больше срока access token');
  if (s.registrationRateLimit.limit < 1 || s.registrationRateLimit.windowSec < 1)
    throw invalid('registrationRateLimit', 'лимит и окно должны быть положительными');
  return s;
}

/** Канонический URI ресурса MCP (RFC 8707 §2, спецификация MCP «Canonical Server URI»). */
export const mcpResource = (s: OAuthServerSettings): string => `${s.publicBaseUrl}/mcp`;

/** Адрес документа RFC 9728 для ресурса `/mcp` (§3: well-known + путь ресурса). */
export const protectedResourceMetadataUrl = (s: OAuthServerSettings): string =>
  `${s.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;

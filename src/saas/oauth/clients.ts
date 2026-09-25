/**
 * Регистрация клиентов MCP (спецификация MCP 2026-07-28, basic/authorization/client-registration.mdx):
 *  - Client ID Metadata Documents (SHOULD): client_id = https-URL документа с метаданными; AS загружает документ,
 *    сверяет `client_id` с URL, проверяет структуру и redirect_uris, кэширует с учётом Cache-Control;
 *  - Dynamic Client Registration RFC 7591 (MAY, для совместимости): POST /oauth/register.
 * Общие правила метаданных — RFC 7591 §2; redirect_uri — redirect-uri.ts.
 */
import type { FetchLike } from '../../bitrix/client.js';
import { CimdFetchError, fetchClientMetadataDocument, type HostResolver } from './cimd-fetch.js';
import { redirectUriProblem } from './redirect-uri.js';
import type { OAuthServerSettings } from './settings.js';
import type { ClientMetadata, OAuthClient, OAuthClientsRepo, TokenEndpointAuthMethod } from './stores.js';

export class ClientMetadataError extends Error {
  constructor(
    readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    readonly description: string,
  ) {
    super(description);
    this.name = 'ClientMetadataError';
  }
}

export interface ValidatedClient {
  clientName: string;
  redirectUris: string[];
  metadata: ClientMetadata;
}

const MAX_REDIRECT_URIS = 10;
const GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

/** Печатный текст для показа пользователю: без управляющих символов, с ограничением длины. */
function displayText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new ClientMetadataError('invalid_client_metadata', `${field} должен быть массивом строк`);
  return value;
}

/** Проверка метаданных клиента (RFC 7591 §2) для DCR и CIMD. */
export function validateClientMetadata(raw: unknown, kind: 'dcr' | 'cimd'): ValidatedClient {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ClientMetadataError('invalid_client_metadata', 'Ожидается JSON-объект метаданных клиента');
  const m = raw as Record<string, unknown>;

  const redirectUris = stringArray(m['redirect_uris'], 'redirect_uris');
  if (!redirectUris || redirectUris.length === 0)
    throw new ClientMetadataError('invalid_redirect_uri', 'redirect_uris обязателен');
  if (redirectUris.length > MAX_REDIRECT_URIS)
    throw new ClientMetadataError('invalid_redirect_uri', 'Слишком много redirect_uris');
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new ClientMetadataError('invalid_redirect_uri', problem);
  }

  // RFC 7591 §2: по умолчанию client_secret_basic. CIMD: секреты запрещены — только публичный клиент.
  const methodRaw = m['token_endpoint_auth_method'] ?? (kind === 'cimd' ? 'none' : 'client_secret_basic');
  const allowedMethods: readonly string[] =
    kind === 'cimd' ? ['none'] : ['none', 'client_secret_post', 'client_secret_basic'];
  if (typeof methodRaw !== 'string' || !allowedMethods.includes(methodRaw))
    throw new ClientMetadataError(
      'invalid_client_metadata',
      `token_endpoint_auth_method: поддерживается ${allowedMethods.join(', ')}`,
    );
  if (kind === 'cimd' && (m['client_secret'] !== undefined || m['client_secret_expires_at'] !== undefined))
    throw new ClientMetadataError('invalid_client_metadata', 'Документ клиента не должен содержать секрет');

  // grant_types не указан — AS подставляет значения по умолчанию (RFC 7591 §3.2.1), включая refresh_token.
  const grantTypes = stringArray(m['grant_types'], 'grant_types') ?? ['authorization_code', 'refresh_token'];
  if (!grantTypes.includes('authorization_code') || !grantTypes.every((g) => GRANT_TYPES.has(g)))
    throw new ClientMetadataError(
      'invalid_client_metadata',
      'grant_types: поддерживаются authorization_code и refresh_token',
    );
  const responseTypes = stringArray(m['response_types'], 'response_types') ?? ['code'];
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code')
    throw new ClientMetadataError('invalid_client_metadata', 'response_types: поддерживается только code');

  const appType = m['application_type'];
  if (appType !== undefined && appType !== 'native' && appType !== 'web')
    throw new ClientMetadataError('invalid_client_metadata', 'application_type: native или web');

  const clientName = displayText(m['client_name'], 120);
  if (kind === 'cimd' && !clientName)
    throw new ClientMetadataError('invalid_client_metadata', 'client_name обязателен в документе клиента');

  const metadata: ClientMetadata = {
    grant_types: [...new Set(grantTypes)],
    response_types: ['code'],
    token_endpoint_auth_method: methodRaw as TokenEndpointAuthMethod,
  };
  if (appType === 'native' || appType === 'web') metadata.application_type = appType;
  const clientUri = m['client_uri'];
  if (typeof clientUri === 'string' && clientUri.startsWith('https://') && clientUri.length <= 2000)
    metadata.client_uri = clientUri;
  const softwareId = displayText(m['software_id'], 200);
  if (softwareId) metadata.software_id = softwareId;
  const softwareVersion = displayText(m['software_version'], 100);
  if (softwareVersion) metadata.software_version = softwareVersion;

  return { clientName: clientName ?? 'Клиент без названия', redirectUris, metadata };
}

/**
 * client_id в форме URL документа (CIMD): https, есть путь, без fragment, учётных данных, query и точечных
 * сегментов; строка должна быть в нормальной форме (совпадать с URL.href), чтобы сравнение было точным.
 */
export function cimdClientIdUrl(clientId: string): URL | undefined {
  if (!clientId.startsWith('https://') || clientId.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.href !== clientId) return undefined;
  if (url.pathname === '/' || url.search || url.hash || url.username || url.password) return undefined;
  if (url.pathname.split('/').some((seg) => seg === '.' || seg === '..')) return undefined;
  return url;
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((a) => {
    const h = a.trim().toLowerCase();
    return h !== '' && (host === h || host.endsWith(`.${h}`));
  });
}

function cacheSeconds(cacheControl: string | null, min: number, max: number): number {
  const m = cacheControl ? /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl) : null;
  const value = m?.[1] ? Number(m[1]) : min;
  return Math.min(max, Math.max(min, value));
}

export class ClientLookupError extends Error {
  constructor(readonly description: string) {
    super(description);
    this.name = 'ClientLookupError';
  }
}

/** Поиск клиента по client_id: зарегистрированный (DCR) или документ CIMD (из кэша либо загрузкой). */
export class ClientResolver {
  constructor(
    private readonly settings: OAuthServerSettings,
    private readonly clients: OAuthClientsRepo,
    private readonly net: { fetch: FetchLike; resolve: HostResolver },
    private readonly now: () => number = Date.now,
  ) {}

  /** undefined — клиента нет; ClientLookupError — документ CIMD недоступен или некорректен. */
  async resolve(clientId: string): Promise<OAuthClient | undefined> {
    const url = cimdClientIdUrl(clientId);
    if (!url) {
      const c = await this.clients.get(clientId);
      return c?.kind === 'dcr' ? c : undefined;
    }
    if (!this.settings.cimd.enabled) return undefined;
    if (!hostAllowed(url.hostname, this.settings.cimd.allowedHosts))
      throw new ClientLookupError('Домен клиента не входит в список доверенных');
    const cached = await this.clients.get(clientId);
    if (
      cached?.kind === 'cimd' &&
      cached.metadataExpiresAt &&
      Date.parse(cached.metadataExpiresAt) > this.now()
    )
      return cached;
    let doc: { body: string; cacheControl: string | null };
    try {
      doc = await fetchClientMetadataDocument(url, {
        fetch: this.net.fetch,
        resolve: this.net.resolve,
        timeoutMs: this.settings.cimd.fetchTimeoutMs,
        maxBytes: this.settings.cimd.maxBytes,
      });
    } catch (e) {
      throw new ClientLookupError(
        `Документ метаданных клиента: ${e instanceof CimdFetchError ? e.reason : 'ошибка загрузки'}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc.body);
    } catch {
      throw new ClientLookupError('Документ метаданных клиента не является JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { client_id?: unknown }).client_id !== clientId
    )
      throw new ClientLookupError('client_id в документе не совпадает с его адресом');
    let valid: ValidatedClient;
    try {
      valid = validateClientMetadata(parsed, 'cimd');
    } catch (e) {
      throw new ClientLookupError(
        e instanceof ClientMetadataError ? e.description : 'Некорректный документ клиента',
      );
    }
    const ttl = cacheSeconds(
      doc.cacheControl,
      this.settings.cimd.minCacheSec,
      this.settings.cimd.maxCacheSec,
    );
    return this.clients.upsertCimd({ clientId, ...valid, expiresAtMs: this.now() + ttl * 1000 });
  }
}

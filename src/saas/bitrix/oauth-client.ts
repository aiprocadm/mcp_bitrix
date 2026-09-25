/**
 * Клиент сервера авторизации Bitrix24 (SaaS-ТЗ §7.2, §7.3, D2–D4). ЕДИНСТВЕННЫЙ сетевой файл модуля src/saas/bitrix:
 * вызовы REST порталов идут через BitrixClient (src/bitrix/client.ts), здесь — только `/oauth/token/`.
 *
 * Контракт — официальная документация Bitrix24 (apidocs.bitrix24.ru):
 *  - обмен кода: settings/oauth/index.md «Step 2. Application Authorization» —
 *    `GET https://oauth.bitrix.info/oauth/token/?grant_type=authorization_code&client_id&client_secret&code`,
 *    код живёт 30 секунд;
 *  - обновление: settings/oauth/auto-renewal.md — `grant_type=refresh_token&client_id&client_secret&refresh_token`;
 *    ответ 200 JSON: access_token, refresh_token, expires (unix), expires_in, client_endpoint, server_endpoint,
 *    domain (домен СЕРВЕРА авторизации, не портала), member_id, scope (через запятую), status, user_id;
 *  - ошибки: settings/oauth/error-codes.md — `{"error": "...", "error_description": "..."}`:
 *    invalid_request, invalid_client, insufficient_scope/invalid_scope, invalid_grant, PAYMENT_REQUIRED.
 *
 * Безопасность: запрос только на хост из настроек (allowlist), без перенаправлений, с таймаутом и лимитом ответа.
 * URL запроса содержит client_secret и код/refresh-токен (так требует документация — GET), поэтому URL, тело
 * ответа и сообщения чужих ошибок никогда не логируются и не попадают в AppError.
 */
import type { FetchLike } from '../../bitrix/client.js';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import { validateBitrixAppSettings, type BitrixAppSettings } from './settings.js';

/** Пара токенов и сведения о портале из ответа сервера авторизации. */
export interface BitrixOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Срок жизни access_token в секундах (документация: 3600). */
  readonly expiresIn: number;
  /** Адрес REST портала: `https://<портал>/rest/` (всегда со слешем в конце). */
  readonly clientEndpoint: string;
  readonly serverEndpoint: string | undefined;
  readonly memberId: string;
  /** Права через запятую. */
  readonly scope: string;
  /** Пользователь, для которого выдан токен (есть в ответе обновления; в ответе обмена кода — не всегда). */
  readonly userId: number | undefined;
  /** Статус приложения (F/D/T/P/L) — информационный. */
  readonly status: string | undefined;
}

/** Коды сервера авторизации, после которых обновлять тем же refresh-токеном бессмысленно (нужен новый вход). */
export const OAUTH_USER_FATAL = new Set(['invalid_grant', 'PAYMENT_REQUIRED']);

export interface BitrixOAuthClientOptions {
  readonly settings: BitrixAppSettings;
  readonly fetch: FetchLike;
  readonly logger: AppLogger;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export class BitrixOAuthClient {
  private readonly settings: BitrixAppSettings;
  private readonly allowedHost: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly o: BitrixOAuthClientOptions) {
    this.settings = validateBitrixAppSettings(o.settings);
    this.allowedHost = new URL(this.settings.oauthServerUrl).host;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxBytes = o.maxResponseBytes ?? 64 * 1024;
  }

  /** Хост сервера авторизации (для allowlist исходящих запросов сервиса). */
  get oauthHost(): string {
    return this.allowedHost;
  }

  get clientId(): string {
    return this.settings.clientId;
  }

  /** Обмен одноразового кода (живёт 30 с) на первую пару токенов. */
  exchangeCode(code: string): Promise<BitrixOAuthTokens> {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(code)) {
      return Promise.reject(
        new AppError('VALIDATION_ERROR', 'Некорректный код авторизации Bitrix24', { field: 'code' }),
      );
    }
    return this.token({ grant_type: 'authorization_code', code });
  }

  /** Новая пара токенов по refresh_token (старый refresh после этого сохранять нельзя — только новый). */
  refresh(refreshToken: string): Promise<BitrixOAuthTokens> {
    if (!/^[A-Za-z0-9._-]{1,512}$/.test(refreshToken)) {
      return Promise.reject(
        new AppError('BITRIX_AUTH_FAILED', 'Сохранённый refresh-токен Bitrix24 повреждён', {
          reason: 'OAUTH_invalid_grant',
          upstreamCode: 'invalid_grant',
        }),
      );
    }
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async token(grant: Record<string, string>): Promise<BitrixOAuthTokens> {
    const url = new URL('/oauth/token/', this.settings.oauthServerUrl);
    url.searchParams.set('grant_type', grant['grant_type'] ?? '');
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('client_secret', this.settings.clientSecret);
    for (const [k, v] of Object.entries(grant)) if (k !== 'grant_type') url.searchParams.set(k, v);
    if (url.host !== this.allowedHost || url.protocol !== new URL(this.settings.oauthServerUrl).protocol) {
      throw new AppError('CONFIG_INVALID', 'Адрес сервера авторизации вне allowlist', {
        field: 'B24_OAUTH_SERVER_URL',
      });
    }
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.o.fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      this.o.logger.warn(
        { grant: grant['grant_type'], reason: e instanceof Error ? e.name : 'unknown' },
        'bitrix oauth request failed',
      );
      throw new AppError(
        aborted ? 'BITRIX_TIMEOUT' : 'BITRIX_UPSTREAM_ERROR',
        aborted ? 'Таймаут сервера авторизации Bitrix24' : 'Сервер авторизации Bitrix24 недоступен',
        { retryable: true, reason: 'OAUTH_SERVER_UNAVAILABLE' },
      );
    }
    const body = await this.readJson(res);
    this.o.logger.info(
      { grant: grant['grant_type'], httpStatus: res.status, durationMs: Date.now() - startedAt },
      'bitrix oauth response',
    );
    const error = body ? str(body['error']) : undefined;
    if (error) {
      // Сообщение сервера (error_description) не копируется: в ответ клиенту идёт только код.
      throw new AppError('BITRIX_AUTH_FAILED', 'Сервер авторизации Bitrix24 отказал в выдаче токенов', {
        reason: `OAUTH_${error.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)}`,
        upstreamCode: error.slice(0, 40),
        httpStatus: res.status,
      });
    }
    if (res.status !== 200 || !body) {
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'Неожиданный ответ сервера авторизации Bitrix24', {
        retryable: res.status >= 500,
        httpStatus: res.status,
        reason: 'OAUTH_BAD_RESPONSE',
      });
    }
    return parseTokenResponse(body);
  }

  private async readJson(res: Response): Promise<Record<string, unknown> | undefined> {
    if (res.status >= 300 && res.status < 400) return undefined;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > this.maxBytes) return undefined;
    if (!res.body) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const value of res.body as AsyncIterable<Uint8Array>) {
      size += value.byteLength;
      if (size > this.maxBytes) return undefined;
      chunks.push(value);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Адрес REST портала из ответа: только https, без учётных данных/параметров, со слешем в конце. */
export function normalizeClientEndpoint(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  if (!/^\/rest\/?$/.test(url.pathname)) return undefined;
  return `${url.origin}/rest/`;
}

function parseTokenResponse(b: Record<string, unknown>): BitrixOAuthTokens {
  const accessToken = str(b['access_token']);
  const refreshToken = str(b['refresh_token']);
  const memberId = str(b['member_id']);
  const clientEndpoint = normalizeClientEndpoint(b['client_endpoint']);
  const expiresIn = Number(b['expires_in']);
  if (!accessToken || !refreshToken || !memberId || !clientEndpoint || !Number.isFinite(expiresIn)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Ответ сервера авторизации Bitrix24 неполон', {
      reason: 'OAUTH_BAD_RESPONSE',
    });
  }
  const userId = Number(b['user_id']);
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.max(0, Math.floor(expiresIn)),
    clientEndpoint,
    serverEndpoint: str(b['server_endpoint']),
    memberId,
    scope: (str(b['scope']) ?? '').replace(/\s+/g, ','),
    userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
    status: str(b['status']),
  };
}

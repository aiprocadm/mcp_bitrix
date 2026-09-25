/**
 * Провайдер авторизации Bitrix24 пользователя SaaS (SaaS-ТЗ §7.3, D3): каждый сотрудник работает своим OAuth-токеном.
 * Реализует BitrixAuthProvider (src/auth/bitrix-auth-provider.ts) для BitrixClient:
 *  - legacy: база `client_endpoint` (`https://<портал>/rest/`), токен в поле тела `auth`
 *    (settings/oauth/index.md: «Method calls go to the address from client_endpoint … access_token is passed in the
 *    auth parameter»);
 *  - REST 3.0: база `https://<портал>/rest/api/`, токен также в поле `auth` тела
 *    (api-reference/rest-v3.md: «For applications, pass the authorization token in the auth field in the request body»).
 *
 * Обновление пары (settings/oauth/auto-renewal.md): по ошибке авторизации (BitrixClient вызывает tryRefresh() один раз)
 * и проактивно, если access истекает меньше чем через 60 с. Single-flight на пару (арендатор, пользователь) между
 * экземплярами: блокировка Coordination + поколение в bitrix_tokens (кто вошёл вторым, видит новое поколение и берёт
 * готовую пару без запроса к серверу авторизации — refresh_token одноразовый).
 * Отказ сервера авторизации (invalid_grant, PAYMENT_REQUIRED) → токены удаляются, пользователь `reauth_required`,
 * BITRIX_AUTH_FAILED с nextAction и ссылкой на кабинет; дальше провайдер отвечает той же ошибкой без сетевых запросов.
 */
import { createHash } from 'node:crypto';
import type { BitrixAuthProvider, RequestAuth } from '../../auth/bitrix-auth-provider.js';
import type { ApiVersion } from '../../bitrix/method-registry.js';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import { LockTimeoutError, type Coordination } from '../coordination.js';
import type { TenantsRepo, TenantUsersRepo } from '../repos/tenants.js';
import { publishInvalidate } from './invalidation.js';
import { OAUTH_USER_FATAL, type BitrixOAuthClient } from './oauth-client.js';
import type { BitrixAppUrls } from './settings.js';
import type { BitrixTokenStore, StoredBitrixTokens } from './token-store.js';

/** Проактивное обновление: если access живёт меньше этого — обновить заранее. */
export const PROACTIVE_REFRESH_MS = 60_000;

export interface BitrixOAuthProviderDeps {
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly tokens: BitrixTokenStore;
  readonly oauth: Pick<BitrixOAuthClient, 'refresh'>;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
  readonly urls: Pick<BitrixAppUrls, 'cabinet'>;
  readonly now?: () => number;
  /** Блокировка обновления: ожидание и срок (по умолчанию 30 с — больше таймаута сервера авторизации). */
  readonly lockWaitMs?: number;
  readonly lockTtlMs?: number;
}

/** Стабильный ключ портала (одинаков для всех пользователей арендатора; без секретов). */
export function portalKeyForMember(memberId: string): string {
  return createHash('sha256').update(`bitrix24-member:${memberId}`).digest('hex').slice(0, 16);
}

export function reauthError(cabinetUrl: string, reason: string): AppError {
  const payment = reason === 'OAUTH_PAYMENT_REQUIRED';
  return new AppError(
    'BITRIX_AUTH_FAILED',
    payment
      ? 'Bitrix24 не выдаёт токены приложению: истёк оплаченный или пробный период приложения на портале'
      : 'Доступ к Bitrix24 истёк или отозван: нужен повторный вход через Bitrix24',
    {
      reason,
      retryable: false,
      nextAction: payment
        ? `Администратору портала: продлите приложение в Bitrix24, затем войдите заново в кабинете ${cabinetUrl}`
        : `Откройте кабинет ${cabinetUrl} и войдите заново через Bitrix24`,
    },
  );
}

interface LiveTokens {
  accessToken: string;
  accessExpiresAt: number;
  generation: number;
}

export class BitrixOAuthUserProvider implements BitrixAuthProvider {
  readonly mode = 'oauth' as const;
  readonly portalOrigin: string;
  readonly portalKey: string;
  readonly identityUserId: number;
  readonly tenantId: string;
  readonly userId: string;
  private readonly legacyBase: string;
  private readonly v3Base: string;
  private readonly now: () => number;
  private live: LiveTokens;
  private failed: AppError | undefined;
  private inflight: Promise<void> | undefined;

  private constructor(
    private readonly deps: BitrixOAuthProviderDeps,
    private readonly memberId: string,
    bitrixUserId: number,
    stored: StoredBitrixTokens,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.tenantId = stored.tenantId;
    this.userId = stored.userId;
    const endpoint = new URL(stored.clientEndpoint);
    this.portalOrigin = endpoint.origin;
    this.legacyBase = `${endpoint.origin}/rest/`;
    this.v3Base = `${endpoint.origin}/rest/api/`;
    this.portalKey = portalKeyForMember(memberId);
    this.identityUserId = bitrixUserId;
    this.live = {
      accessToken: stored.accessToken,
      accessExpiresAt: stored.accessExpiresAt,
      generation: stored.generation,
    };
  }

  /**
   * Провайдер пользователя арендатора. Арендатор должен быть установлен, пользователь — активен, токены — есть;
   * иначе BITRIX_AUTH_FAILED с понятной причиной (чужой пользователь неотличим от несуществующего).
   */
  static async open(
    deps: BitrixOAuthProviderDeps,
    tenantId: string,
    userId: string,
  ): Promise<BitrixOAuthUserProvider> {
    const cabinet = deps.urls.cabinet;
    const tenant = await deps.tenants.get(tenantId);
    if (!tenant || tenant.status === 'uninstalled' || tenant.status === 'deleted') {
      throw new AppError('BITRIX_AUTH_FAILED', 'Приложение не установлено на портале Bitrix24', {
        reason: 'APP_NOT_INSTALLED',
        nextAction: 'Администратору портала: установите приложение из Маркета Bitrix24',
      });
    }
    const user = await deps.users.get(tenantId, userId);
    if (!user) throw reauthError(cabinet, 'USER_NOT_FOUND');
    if (user.status === 'disabled') {
      throw new AppError('ACCESS_DENIED', 'Доступ пользователя к сервису отключён администратором портала', {
        reason: 'USER_DISABLED',
      });
    }
    if (user.status === 'reauth_required') throw reauthError(cabinet, 'REAUTH_REQUIRED');
    const stored = await deps.tokens.load(tenantId, userId);
    if (!stored) throw reauthError(cabinet, 'BITRIX_TOKENS_MISSING');
    return new BitrixOAuthUserProvider(deps, tenant.memberId, user.bitrixUserId, stored);
  }

  /** Хост портала — единственный разрешённый для BitrixClient этого пользователя (SSRF, SaaS-ТЗ §12 п.4). */
  get allowedHosts(): readonly string[] {
    return [new URL(this.portalOrigin).host];
  }

  getAuth(apiVersion: ApiVersion): RequestAuth {
    if (this.failed) throw this.failed;
    if (this.live.accessExpiresAt - this.now() < PROACTIVE_REFRESH_MS && !this.inflight) {
      // getAuth синхронный: обновление идёт в фоне; истёкший токен даст отказ, и tryRefresh дождётся этого же обновления.
      this.refreshOnce(true).catch(() => undefined);
    }
    return {
      baseUrl: apiVersion === 'v3' ? this.v3Base : this.legacyBase,
      bodyFields: { auth: this.live.accessToken },
    };
  }

  /** Дождаться свежего токена (перед серией вызовов; сборка контекста может вызвать после open). */
  async ensureFresh(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.live.accessExpiresAt - this.now() >= PROACTIVE_REFRESH_MS) return;
    await this.refreshOnce(false);
  }

  async tryRefresh(): Promise<boolean> {
    if (this.failed) throw this.failed;
    await this.refreshOnce(false);
    return true;
  }

  /** Одно обновление на провайдер за раз; параллельные вызовы ждут того же. */
  private refreshOnce(background: boolean): Promise<void> {
    if (!this.inflight) {
      const known = this.live.generation;
      this.inflight = this.refreshPair(known)
        .then((t) => {
          this.live = {
            accessToken: t.accessToken,
            accessExpiresAt: t.accessExpiresAt,
            generation: t.generation,
          };
        })
        .catch((e: unknown) => {
          const err = AppError.from(e);
          if (background) {
            this.deps.logger.warn(
              { tenantId: this.tenantId, code: err.code, reason: err.details.reason },
              'bitrix proactive token refresh failed',
            );
          }
          throw err;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /** Single-flight между экземплярами: блокировка на пару (арендатор, пользователь) + поколение в БД. */
  private async refreshPair(knownGeneration: number): Promise<StoredBitrixTokens> {
    const key = `bitrix-token-refresh:${this.tenantId}:${this.userId}`;
    try {
      return await this.deps.coordination.withLock(
        key,
        { ttlMs: this.deps.lockTtlMs ?? 30_000, waitMs: this.deps.lockWaitMs ?? 30_000 },
        async () => {
          const cur = await this.deps.tokens.load(this.tenantId, this.userId);
          if (!cur) throw this.fail(reauthError(this.deps.urls.cabinet, 'REAUTH_REQUIRED'));
          // Пару уже обновил другой экземпляр (или другой провайдер процесса) — берём её без запроса.
          if (
            cur.generation !== knownGeneration &&
            cur.accessExpiresAt - this.now() >= PROACTIVE_REFRESH_MS
          ) {
            return cur;
          }
          let fresh;
          try {
            fresh = await this.deps.oauth.refresh(cur.refreshToken);
          } catch (e) {
            const err = AppError.from(e);
            const upstream = err.details.upstreamCode ?? '';
            if (err.code === 'BITRIX_AUTH_FAILED' && OAUTH_USER_FATAL.has(upstream)) {
              await this.markReauth(`OAUTH_${upstream}`);
              throw this.fail(reauthError(this.deps.urls.cabinet, `OAUTH_${upstream}`));
            }
            if (err.code === 'BITRIX_AUTH_FAILED') {
              // invalid_client/invalid_request — ошибка конфигурации сервиса, а не пользователя: токены не трогаем.
              throw new AppError('BITRIX_AUTH_FAILED', 'Сервис не смог обновить доступ к Bitrix24', {
                reason: err.details.reason ?? 'OAUTH_ERROR',
                upstreamCode: upstream,
                nextAction: 'Повторите позже; если ошибка сохраняется — обратитесь в поддержку сервиса',
              });
            }
            throw err;
          }
          if (fresh.memberId !== this.memberId) {
            await this.markReauth('PORTAL_MISMATCH');
            throw this.fail(reauthError(this.deps.urls.cabinet, 'PORTAL_MISMATCH'));
          }
          const saved = await this.deps.tokens.saveRefreshed(
            this.tenantId,
            this.userId,
            fresh,
            cur.generation,
          );
          if (saved === undefined) {
            // Под блокировкой не должно случаться; при гонке с входом пользователя берём записанную пару.
            this.deps.logger.warn({ tenantId: this.tenantId }, 'bitrix token generation changed under lock');
          }
          const now = await this.deps.tokens.load(this.tenantId, this.userId);
          if (!now) throw this.fail(reauthError(this.deps.urls.cabinet, 'REAUTH_REQUIRED'));
          return now;
        },
      );
    } catch (e) {
      if (e instanceof LockTimeoutError) {
        throw new AppError('BITRIX_TIMEOUT', 'Обновление доступа к Bitrix24 не завершилось вовремя', {
          retryable: true,
          reason: 'TOKEN_REFRESH_LOCK_TIMEOUT',
        });
      }
      throw e;
    }
  }

  private fail(err: AppError): AppError {
    this.failed = err;
    return err;
  }

  /** Токены бесполезны: удалить, пользователь «нужен повторный вход» (поколение +1), сброс кэшей контекста. */
  private async markReauth(reason: string): Promise<void> {
    await this.deps.tokens.delete(this.tenantId, this.userId);
    await this.deps.users.setStatus(this.tenantId, this.userId, 'reauth_required');
    await publishInvalidate(this.deps.coordination, this.tenantId, this.userId);
    this.deps.logger.warn({ tenantId: this.tenantId, reason }, 'bitrix user requires re-authorization');
  }
}

/** Фабрика провайдеров для сборки контекста арендатора (TenantScope) в режиме saas. */
export class BitrixOAuthProviderFactory {
  constructor(private readonly deps: BitrixOAuthProviderDeps) {}

  open(tenantId: string, userId: string): Promise<BitrixOAuthUserProvider> {
    return BitrixOAuthUserProvider.open(this.deps, tenantId, userId);
  }
}

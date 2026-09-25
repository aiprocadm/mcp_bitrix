/**
 * Установка тиражного приложения Bitrix24 (SaaS-ТЗ §8, D1–D3, §9.1). Документированные пути:
 *
 * 1. Событие `ONAPPINSTALL` (api-reference/common/events/on-app-install.md) — единственная точка создания арендатора:
 *    в нём есть и токены установившего сотрудника, и `application_token` для проверки последующих событий
 *    (api-reference/events/safe-event-handlers.md). Оно приходит:
 *      - приложению без интерфейса — на «Event installation handler URL» (installation callback,
 *        settings/app-installation/mass-market-apps/installation-callback.md);
 *      - приложению с интерфейсом — на обработчик, который мастер установки подписал через event.bind
 *        («The handler for this event can be set in the installation script», on-app-install.md), после
 *        BX24.installFinish().
 * 2. Мастер установки (settings/app-installation/mass-market-apps/installation-master.md): Bitrix24 открывает
 *    «Installation application URL» с параметрами запуска (AUTH_ID, REFRESH_ID, member_id, DOMAIN — simple-way.md);
 *    `prepareInstall` подписывает ONAPPINSTALL/ONAPPUNINSTALL/ONAPPUPDATE, страница вызывает BX24.installFinish().
 *
 * Подлинность. Первая установка: «a working access token confirms the authenticity of the request: check it and only
 * then retain application_token» (installation-callback.md). Адресу `client_endpoint` из запроса доверять нельзя
 * (его пишет отправитель), поэтому пара проверяется на сервере авторизации Bitrix24 (из настроек): обновление по
 * refresh_token с нашим client_secret возвращает доверенные member_id, client_endpoint и user_id. Повторные события
 * работающего арендатора — сравнение sha256(application_token) с сохранённым (constant-time).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import type { Coordination } from '../coordination.js';
import type { PlansRepo, SubscriptionsRepo } from '../repos/plans.js';
import type { Tenant, TenantsRepo, TenantUsersRepo } from '../repos/tenants.js';
import type { BitrixEventPayload, BitrixLaunchParams } from './event-payload.js';
import { publishInvalidate } from './invalidation.js';
import type { BitrixOAuthClient, BitrixOAuthTokens } from './oauth-client.js';
import {
  ensureEventBindings,
  fetchProfile,
  TransientOAuthAuth,
  type BitrixProfile,
  type PortalClientFactory,
} from './portal.js';
import type { BitrixAppUrls } from './settings.js';
import type { BitrixTokenStore } from './token-store.js';

/** События, на которые подписывается приложение при установке. */
export const APP_LIFECYCLE_EVENTS = ['ONAPPUNINSTALL', 'ONAPPUPDATE'] as const;
export const TRIAL_PLAN_CODE = 'trial';

export function appTokenHash(applicationToken: string): string {
  return createHash('sha256').update(applicationToken, 'utf8').digest('hex');
}

/** Сравнение без утечки по времени: sha256 входящего токена против сохранённого хеша. */
export function appTokenMatches(storedHash: string | null, applicationToken: string): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(appTokenHash(applicationToken), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface BitrixAppServiceDeps {
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
  readonly tokens: BitrixTokenStore;
  readonly oauth: Pick<BitrixOAuthClient, 'refresh' | 'exchangeCode'>;
  readonly portal: PortalClientFactory;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
  readonly urls: BitrixAppUrls;
}

export interface InstallResult {
  readonly tenantId: string;
  /** Новый арендатор (первая установка портала). */
  readonly created: boolean;
  /** Начат пробный период (только один раз на портал). */
  readonly trialStarted: boolean;
  /** Внутренний id пользователя-установщика (tenant_users.id), роль administrator. */
  readonly userId: string;
  readonly bitrixUserId: number;
  /** Подписки, добавленные сейчас (уже существующие не дублируются). */
  readonly eventsBound: readonly string[];
  /** Несмертельные проблемы — показать в кабинете (не молчать). */
  readonly warnings: readonly string[];
  /** Куда отправить пользователя: кабинет. */
  readonly nextUrl: string;
}

export interface PrepareInstallResult {
  readonly memberId: string;
  readonly domain: string;
  readonly eventsBound: readonly string[];
  /** Приложение уже установлено и работает для этого портала. */
  readonly alreadyInstalled: boolean;
}

const denied = (reason: string, message = 'Запрос установки не подтверждён Bitrix24') =>
  new AppError('ACCESS_DENIED', message, { reason });

export class BitrixInstallService {
  constructor(private readonly d: BitrixAppServiceDeps) {}

  /**
   * Проверка пары токенов на сервере авторизации: доверенные member_id/client_endpoint/user_id.
   * Отказ сервера → ACCESS_DENIED (подделка или устаревшая пара); сбой сети — как есть (повторит Bitrix24).
   */
  async verifyPair(refreshToken: string | undefined, claimedMemberId: string): Promise<BitrixOAuthTokens> {
    if (!refreshToken) throw denied('INSTALL_TOKENS_MISSING');
    let trusted: BitrixOAuthTokens;
    try {
      trusted = await this.d.oauth.refresh(refreshToken);
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === 'BITRIX_AUTH_FAILED') throw denied(err.details.reason ?? 'OAUTH_REJECTED');
      throw err;
    }
    if (trusted.memberId !== claimedMemberId) throw denied('MEMBER_ID_MISMATCH');
    return trusted;
  }

  /** Профиль владельца пары через BitrixClient (адрес — доверенный client_endpoint от сервера авторизации). */
  async profileOf(t: BitrixOAuthTokens): Promise<BitrixProfile> {
    const auth = new TransientOAuthAuth(t);
    const profile = await fetchProfile(this.d.portal(auth, auth.allowedHosts));
    if (t.userId !== undefined && t.userId !== profile.id) throw denied('USER_ID_MISMATCH');
    return profile;
  }

  /** Обработчик ONAPPINSTALL (installation callback / событие после мастера установки). */
  async handleInstallEvent(p: BitrixEventPayload): Promise<InstallResult> {
    if (p.event !== 'ONAPPINSTALL') throw new AppError('VALIDATION_ERROR', 'Ожидалось событие ONAPPINSTALL');
    const existing = await this.d.tenants.getByMemberId(p.auth.memberId);
    if (existing && (existing.status === 'active' || existing.status === 'suspended')) {
      const stored = await this.d.tenants.appTokenHash(existing.id);
      // Работающий арендатор: «On subsequent calls, compare the received token with the retained one».
      if (stored && !appTokenMatches(stored, p.auth.applicationToken)) throw denied('APP_TOKEN_MISMATCH');
    }
    const trusted = await this.verifyPair(p.auth.refreshToken, p.auth.memberId);
    const profile = await this.profileOf(trusted);
    const domain = new URL(trusted.clientEndpoint).host;
    const { tenant, created } = await this.d.tenants.upsertInstalled({
      memberId: trusted.memberId,
      domain,
      appTokenHash: appTokenHash(p.auth.applicationToken),
    });
    const warnings: string[] = [];
    if (!profile.admin) warnings.push('INSTALLER_NOT_PORTAL_ADMIN');

    const userId = await this.upsertInstaller(tenant, profile);
    await this.d.tokens.save(tenant.id, userId, trusted);

    let eventsBound: string[] = [];
    try {
      const auth = new TransientOAuthAuth(trusted);
      eventsBound = await ensureEventBindings(
        this.d.portal(auth, auth.allowedHosts),
        APP_LIFECYCLE_EVENTS,
        this.d.urls.eventsHandler,
      );
    } catch (e) {
      // Установка состоялась; без подписки на удаление токены отзовутся при первом отказе обновления.
      const err = AppError.from(e);
      warnings.push(`EVENT_BIND_FAILED:${err.code}`);
      this.d.logger.warn({ tenantId: tenant.id, code: err.code }, 'bitrix event.bind failed on install');
    }

    const trialStarted = await this.startTrialOnce(tenant, warnings);
    if (!created) await publishInvalidate(this.d.coordination, tenant.id);
    this.d.logger.info(
      { tenantId: tenant.id, created, trialStarted, eventsBound: eventsBound.length },
      'bitrix app installed',
    );
    return {
      tenantId: tenant.id,
      created,
      trialStarted,
      userId,
      bitrixUserId: profile.id,
      eventsBound,
      warnings,
      nextUrl: this.d.urls.cabinet,
    };
  }

  /**
   * Мастер установки приложения с интерфейсом: подписка на события жизненного цикла (включая ONAPPINSTALL,
   * который создаст арендатора после BX24.installFinish()). Токены мастера не сохраняются.
   */
  async prepareInstall(p: BitrixLaunchParams): Promise<PrepareInstallResult> {
    const trusted = await this.verifyPair(p.refreshId, p.memberId);
    const profile = await this.profileOf(trusted);
    if (!profile.admin) {
      throw new AppError('ACCESS_DENIED', 'Установить приложение может только администратор портала', {
        reason: 'INSTALLER_NOT_PORTAL_ADMIN',
      });
    }
    const auth = new TransientOAuthAuth(trusted);
    const eventsBound = await ensureEventBindings(
      this.d.portal(auth, auth.allowedHosts),
      ['ONAPPINSTALL', ...APP_LIFECYCLE_EVENTS],
      this.d.urls.eventsHandler,
    );
    const tenant = await this.d.tenants.getByMemberId(trusted.memberId);
    return {
      memberId: trusted.memberId,
      domain: new URL(trusted.clientEndpoint).host,
      eventsBound,
      alreadyInstalled: tenant?.status === 'active',
    };
  }

  /** ONAPPUPDATE: новая версия приложения — новый application_token (safe-event-handlers.md) и переподписка. */
  async handleUpdateEvent(
    p: BitrixEventPayload,
  ): Promise<{ tenantId: string; eventsBound: readonly string[] }> {
    const tenant = await this.d.tenants.getByMemberId(p.auth.memberId);
    if (!tenant || tenant.status === 'uninstalled' || tenant.status === 'deleted')
      throw denied('TENANT_UNKNOWN');
    const stored = await this.d.tenants.appTokenHash(tenant.id);
    const trusted = await this.verifyPair(p.auth.refreshToken, p.auth.memberId);
    if (!appTokenMatches(stored, p.auth.applicationToken)) {
      // Смену токена принимаем только от администратора портала (пара проверена сервером авторизации).
      const profile = await this.profileOf(trusted);
      if (!profile.admin) throw denied('APP_TOKEN_MISMATCH');
      await this.d.tenants.upsertInstalled({
        memberId: tenant.memberId,
        domain: new URL(trusted.clientEndpoint).host,
        appTokenHash: appTokenHash(p.auth.applicationToken),
      });
    }
    const auth = new TransientOAuthAuth(trusted);
    const eventsBound = await ensureEventBindings(
      this.d.portal(auth, auth.allowedHosts),
      APP_LIFECYCLE_EVENTS,
      this.d.urls.eventsHandler,
    );
    return { tenantId: tenant.id, eventsBound };
  }

  private async upsertInstaller(tenant: Tenant, profile: BitrixProfile): Promise<string> {
    const user = await this.d.users.upsertFromBitrix({
      tenantId: tenant.id,
      bitrixUserId: profile.id,
      displayName: profile.displayName,
      email: null,
      defaultRole: 'administrator',
    });
    if (user.role !== 'administrator') await this.d.users.setRole(tenant.id, user.id, 'administrator');
    if (user.status !== 'active') await this.d.users.setStatus(tenant.id, user.id, 'active');
    return user.id;
  }

  /** Пробный период — один на портал (member_id), повторная установка его не обнуляет (§9.1). */
  private async startTrialOnce(tenant: Tenant, warnings: string[]): Promise<boolean> {
    if (tenant.trialUsed) return false;
    const plan = await this.d.plans.get(TRIAL_PLAN_CODE);
    if (!plan?.active) {
      warnings.push('TRIAL_PLAN_MISSING');
      this.d.logger.error({ tenantId: tenant.id }, 'trial plan is missing; trial not started');
      return false;
    }
    if (!(await this.d.tenants.claimTrial(tenant.id))) return false;
    await this.d.subscriptions.startTrial(tenant.id, plan);
    return true;
  }
}

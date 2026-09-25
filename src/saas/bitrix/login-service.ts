/**
 * Вход пользователя портала через Bitrix24 (SaaS-ТЗ §7.2, D4) — полный протокол OAuth 2.0
 * (settings/oauth/index.md): 1) пользователь уходит на `https://<портал>/oauth/authorize/?client_id=…&state=…`;
 * 2) Bitrix24 возвращает на redirect_uri из карточки приложения (`code`, `state`, `domain`, `member_id`, `scope`,
 * `server_domain`); 3) сервис обменивает `code` (живёт 30 с) на пару токенов на сервере авторизации.
 * Сервер авторизации MCP (S4) использует этот модуль и сам ведёт `state`, PKCE и согласие.
 *
 * SSRF (SaaS-ТЗ §12 п.4): адрес портала для перенаправления берётся только из установок (tenants), произвольный
 * адрес не принимается. Портал после обмена определяется по member_id из ответа сервера авторизации (доверенный).
 */
import { AppError } from '../../errors/app-error.js';
import type { Role } from '../../config/policy.js';
import type { AppLogger } from '../../logging/logger.js';
import type { Coordination } from '../coordination.js';
import type {
  Tenant,
  TenantSettingsRepo,
  TenantsRepo,
  TenantUser,
  TenantUsersRepo,
} from '../repos/tenants.js';
import { publishInvalidate } from './invalidation.js';
import type { BitrixOAuthClient } from './oauth-client.js';
import { fetchProfile, TransientOAuthAuth, type PortalClientFactory } from './portal.js';
import type { BitrixAppUrls } from './settings.js';
import type { BitrixTokenStore } from './token-store.js';

export interface BitrixLoginServiceDeps {
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly settings: TenantSettingsRepo;
  readonly tokens: BitrixTokenStore;
  readonly oauth: Pick<BitrixOAuthClient, 'exchangeCode' | 'clientId'>;
  readonly portal: PortalClientFactory;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
  readonly urls: Pick<BitrixAppUrls, 'cabinet'>;
}

export interface LoginResult {
  readonly tenant: Tenant;
  readonly user: TenantUser;
  /** Администратор портала Bitrix24 (profile.ADMIN) — подсказка кабинету, роль сервиса не меняет. */
  readonly portalAdmin: boolean;
}

const notInstalled = () =>
  new AppError('NOT_FOUND', 'Приложение не установлено на этом портале Bitrix24', {
    reason: 'APP_NOT_INSTALLED',
    nextAction: 'Администратору портала: установите приложение из Маркета Bitrix24, затем войдите снова',
  });

export class BitrixLoginService {
  constructor(private readonly d: BitrixLoginServiceDeps) {}

  /** Адрес авторизации на портале; портал должен быть установлен (иначе — «установите приложение»). */
  async authorizeUrl(portalDomain: string, state: string): Promise<string> {
    if (!/^[A-Za-z0-9._~-]{16,256}$/.test(state)) {
      throw new AppError('VALIDATION_ERROR', 'Некорректный state', { field: 'state' });
    }
    const tenant = await this.d.tenants.getByDomain(portalDomain);
    if (tenant?.status !== 'active') throw notInstalled();
    const url = new URL('/oauth/authorize/', `https://${tenant.domain}`);
    url.searchParams.set('client_id', this.d.oauth.clientId);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Обмен кода → пользователь арендатора (создаётся при первом входе с ролью по умолчанию) и его токены. */
  async completeLogin(code: string): Promise<LoginResult> {
    const t = await this.d.oauth.exchangeCode(code);
    const tenant = await this.d.tenants.getByMemberId(t.memberId);
    if (!tenant || tenant.status === 'uninstalled' || tenant.status === 'deleted') throw notInstalled();
    const endpointHost = new URL(t.clientEndpoint).host;
    if (endpointHost !== tenant.domain) {
      // Адрес портала сменился после установки: запросы разрешены только к установленному адресу.
      throw new AppError('CONFLICT', 'Адрес портала Bitrix24 не совпадает с адресом установки', {
        reason: 'PORTAL_DOMAIN_CHANGED',
        nextAction: 'Администратору портала: переустановите приложение, чтобы обновить адрес портала',
      });
    }
    const auth = new TransientOAuthAuth(t);
    const profile = await fetchProfile(this.d.portal(auth, auth.allowedHosts));
    if (t.userId !== undefined && t.userId !== profile.id) {
      throw new AppError('BITRIX_AUTH_FAILED', 'Ответ Bitrix24 противоречив', { reason: 'USER_ID_MISMATCH' });
    }
    const defaultRole: Role = (await this.d.settings.get(tenant.id)).defaultRole;
    let user = await this.d.users.upsertFromBitrix({
      tenantId: tenant.id,
      bitrixUserId: profile.id,
      displayName: profile.displayName,
      email: null,
      defaultRole,
    });
    if (user.status === 'disabled') {
      throw new AppError('ACCESS_DENIED', 'Доступ к сервису отключён администратором портала', {
        reason: 'USER_DISABLED',
      });
    }
    await this.d.tokens.save(tenant.id, user.id, t);
    if (user.status === 'reauth_required') {
      await this.d.users.setStatus(tenant.id, user.id, 'active');
      await publishInvalidate(this.d.coordination, tenant.id, user.id);
      user = (await this.d.users.get(tenant.id, user.id)) ?? user;
    }
    this.d.logger.info({ tenantId: tenant.id }, 'bitrix user logged in');
    return { tenant, user, portalAdmin: profile.admin };
  }
}

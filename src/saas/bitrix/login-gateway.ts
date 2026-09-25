/**
 * Мост S3 → S4: вход пользователя через Bitrix24 (`BitrixLoginService`) в интерфейсе, который знает сервер
 * авторизации MCP (`BitrixLoginGateway`, src/saas/oauth/gateway.ts). SaaS-ТЗ §7.2, D4.
 *
 *  - startLogin: адрес `https://<портал>/oauth/authorize/?client_id&state` — только для установленного портала;
 *  - completeLogin: обмен `code` (живёт 30 с) на пару токенов, `profile`, пользователь арендатора создан/обновлён,
 *    его токены сохранены под DEK; портал определяется по member_id из ответа сервера авторизации (доверенный).
 * «Приложение не установлено» → reason PORTAL_NOT_INSTALLED (сервер авторизации покажет страницу установки).
 */
import { AppError } from '../../errors/app-error.js';
import { PORTAL_NOT_INSTALLED, type BitrixLoginGateway, type BitrixLoginIdentity } from '../oauth/gateway.js';
import type { BitrixLoginService } from './login-service.js';

export class BitrixLoginGatewayAdapter implements BitrixLoginGateway {
  constructor(private readonly login: Pick<BitrixLoginService, 'authorizeUrl' | 'completeLogin'>) {}

  async startLogin(portalDomain: string, state: string): Promise<string> {
    try {
      return await this.login.authorizeUrl(portalDomain, state);
    } catch (e) {
      throw mapNotInstalled(e);
    }
  }

  async completeLogin(q: Readonly<Record<string, string | undefined>>): Promise<BitrixLoginIdentity> {
    const code = q['code'];
    if (!code)
      throw new AppError('VALIDATION_ERROR', 'Bitrix24 не вернул код авторизации', { field: 'code' });
    try {
      const r = await this.login.completeLogin(code);
      return {
        tenantId: r.tenant.id,
        bitrixUserId: r.user.bitrixUserId,
        displayName: r.user.displayName,
        email: r.user.email ?? undefined,
      };
    } catch (e) {
      throw mapNotInstalled(e);
    }
  }
}

function mapNotInstalled(e: unknown): unknown {
  if (AppError.is(e) && e.details.reason === 'APP_NOT_INSTALLED') {
    return new AppError(e.code, e.message, { ...e.details, reason: PORTAL_NOT_INSTALLED });
  }
  return e;
}

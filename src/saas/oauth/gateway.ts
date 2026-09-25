/**
 * Вход пользователя делегируется Bitrix24 (SaaS-ТЗ D4, §7.2). Реализация на OAuth тиражного приложения —
 * этап S3 (src/saas/bitrix/*): обмен `code` на токены Bitrix24, сохранение их под DEK арендатора, `user.current`,
 * проверка, что портал (member_id) установлен. Сервер авторизации знает только этот интерфейс.
 */
export interface BitrixLoginIdentity {
  /** Внутренний id арендатора (tenants.id), определённый по member_id из ответа Bitrix24. */
  readonly tenantId: string;
  readonly bitrixUserId: number;
  readonly displayName: string;
  readonly email?: string | undefined;
}

export interface BitrixLoginGateway {
  /**
   * Адрес страницы авторизации Bitrix24 для портала (https://<портал>/oauth/authorize/?client_id=…&state=…).
   * `state` передаётся в Bitrix24 без изменений и вернётся в обратный вызов (документация Bitrix24 OAuth:
   * b24restdocs settings/oauth/index.md — «state: Bitrix24 returns the value unchanged»).
   */
  startLogin(portalDomain: string, state: string): Promise<string>;
  /**
   * Обратный вызов Bitrix24 (query целиком: code, state, domain, member_id, …). Ошибки — AppError; для
   * неустановленного/удалённого приложения — `details.reason = 'PORTAL_NOT_INSTALLED'`.
   */
  completeLogin(callbackQuery: Readonly<Record<string, string | undefined>>): Promise<BitrixLoginIdentity>;
}

/** Причина AppError из completeLogin: портал не установил приложение (показываем страницу «установите»). */
export const PORTAL_NOT_INSTALLED = 'PORTAL_NOT_INSTALLED';

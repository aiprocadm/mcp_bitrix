/**
 * Источник учётных данных для Bitrix24 (ТЗ §2.1 п.3, §4.2).
 * Инструменты не имеют доступа к секретам — только клиент через провайдер.
 */
import type { ApiVersion } from '../bitrix/method-registry.js';

export interface RequestAuth {
  /** Базовый URL для метода: для webhook уже содержит секрет в пути. */
  readonly baseUrl: string;
  /** Дополнительные поля тела (OAuth: `auth`), для webhook — пусто. */
  readonly bodyFields: Readonly<Record<string, string>>;
}

export interface BitrixAuthProvider {
  readonly mode: 'webhook' | 'oauth';
  /** Origin портала без секрета. */
  readonly portalOrigin: string;
  /** Стабильный ключ портала для ledger/аудита. */
  readonly portalKey: string;
  /** ID пользователя Bitrix, от чьего имени работает интеграция (если известен без запроса). */
  readonly identityUserId: number | undefined;
  getAuth(apiVersion: ApiVersion): RequestAuth;
  /**
   * Попытка обновить учётные данные после отказа авторизации.
   * Для webhook всегда false (обновлять нечего).
   */
  tryRefresh(): Promise<boolean>;
}

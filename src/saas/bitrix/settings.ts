/**
 * Настройки тиражного приложения Bitrix24 (SaaS-ТЗ §8, §15). Значения подключает сборка режима saas из окружения:
 *  - `B24_APP_CLIENT_ID` → clientId (код приложения из кабинета разработчика / формы локального приложения);
 *  - `B24_APP_CLIENT_SECRET_FILE` → clientSecret (СЕКРЕТ: читается из файла, в Git/логи/ответы не попадает);
 *  - `B24_OAUTH_SERVER_URL` → oauthServerUrl (по умолчанию `https://oauth.bitrix.info`);
 *  - `PUBLIC_BASE_URL` → publicBaseUrl (адреса обработчиков `/b24/*` и кабинета `/app`).
 *
 * Сервер авторизации: «authorization server `https://oauth.bitrix.info/` — the holder of the application's
 * authorization; only it issues and renews tokens» (официальная документация, settings/oauth/index.md,
 * https://apidocs.bitrix24.ru/settings/oauth/index.html). `client_secret` передаётся ТОЛЬКО ему.
 */
import { AppError } from '../../errors/app-error.js';
import { registerSecret } from '../../security/redaction.js';

export interface BitrixAppSettings {
  /** client_id приложения (не секрет). */
  readonly clientId: string;
  /** client_secret приложения (секрет; только в запросах к серверу авторизации). */
  readonly clientSecret: string;
  /** Origin сервера авторизации Bitrix24 (https, без пути). */
  readonly oauthServerUrl: string;
  /** Публичный https-origin сервиса (PUBLIC_BASE_URL). */
  readonly publicBaseUrl: string;
}

export const DEFAULT_OAUTH_SERVER_URL = 'https://oauth.bitrix.info';

/** Публичные адреса, которые регистрирует/показывает приложение. HTTP-маршруты вешает сборка режима saas. */
export interface BitrixAppUrls {
  /** Обработчик событий приложения (ONAPPINSTALL/ONAPPUNINSTALL/ONAPPUPDATE) и installation callback. */
  readonly eventsHandler: string;
  /** Мастер установки (Installation application URL) — страница с BX24.installFinish(). */
  readonly install: string;
  /** redirect_uri входа через Bitrix24 (указывается в карточке приложения). */
  readonly oauthCallback: string;
  /** Кабинет клиента (ссылка в nextAction ошибок авторизации). */
  readonly cabinet: string;
}

export function bitrixAppUrls(s: Pick<BitrixAppSettings, 'publicBaseUrl'>): BitrixAppUrls {
  const base = s.publicBaseUrl.replace(/\/+$/, '');
  return {
    eventsHandler: `${base}/b24/events`,
    install: `${base}/b24/install`,
    oauthCallback: `${base}/b24/oauth/callback`,
    cabinet: `${base}/app`,
  };
}

const httpsOrigin = (field: string, value: string, allowLoopbackHttp: boolean): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('CONFIG_INVALID', `${field}: ожидается URL`, { field });
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw new AppError('CONFIG_INVALID', `${field}: нужен https`, { field });
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new AppError('CONFIG_INVALID', `${field}: только origin без пути и параметров`, { field });
  }
  return url.origin;
};

/** Проверка и нормализация настроек; client_secret регистрируется в редакторе логов. */
export function validateBitrixAppSettings(s: BitrixAppSettings): BitrixAppSettings {
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(s.clientId)) {
    throw new AppError('CONFIG_INVALID', 'B24_APP_CLIENT_ID: некорректный код приложения', {
      field: 'B24_APP_CLIENT_ID',
    });
  }
  const secret = s.clientSecret.trim();
  if (secret.length < 8) {
    throw new AppError('CONFIG_INVALID', 'B24_APP_CLIENT_SECRET_FILE: секрет пуст или слишком короткий', {
      field: 'B24_APP_CLIENT_SECRET_FILE',
    });
  }
  registerSecret(secret);
  return {
    clientId: s.clientId,
    clientSecret: secret,
    oauthServerUrl: httpsOrigin('B24_OAUTH_SERVER_URL', s.oauthServerUrl, false),
    publicBaseUrl: httpsOrigin('PUBLIC_BASE_URL', s.publicBaseUrl, true),
  };
}

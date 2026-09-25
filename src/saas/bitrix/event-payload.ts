/**
 * Разбор запросов Bitrix24 к обработчикам приложения (SaaS-ТЗ §8). Bitrix24 шлёт события POST-запросом
 * («Data is transmitted as a POST request», api-reference/common/events/*.md) в виде полей формы PHP
 * (`event=…&data[VERSION]=…&auth[access_token]=…`, см. `$_POST` в settings/app-installation/mass-market-apps/
 * installation-callback.md); JSON-тело принимается тоже.
 *
 * Поля события (on-app-install.md, on-app-uninstall.md, on-app-update.md, api-reference/events/safe-event-handlers.md):
 *   event, event_handler_id, data{…}, ts, auth{domain, client_endpoint, server_endpoint, member_id, application_token,
 *   access_token, refresh_token, expires_in, scope, status, user_id?}. В ONAPPUNINSTALL токенов нет.
 *
 * Мастер установки / страница приложения (settings/oauth/simple-way.md): POST-поля DOMAIN, PROTOCOL, LANG, APP_SID,
 *   AUTH_ID, AUTH_EXPIRES, REFRESH_ID, SERVER_ENDPOINT, member_id, status, PLACEMENT, PLACEMENT_OPTIONS.
 */
import { AppError } from '../../errors/app-error.js';

export interface BitrixEventAuth {
  readonly memberId: string;
  readonly applicationToken: string;
  readonly domain: string | undefined;
  readonly clientEndpoint: string | undefined;
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
}

export interface BitrixEventPayload {
  /** Код события в верхнем регистре (ONAPPINSTALL, ONAPPUNINSTALL, …). */
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly auth: BitrixEventAuth;
}

/** Параметры запуска страницы/мастера установки (simple-way.md). */
export interface BitrixLaunchParams {
  readonly memberId: string;
  readonly domain: string;
  readonly authId: string;
  readonly refreshId: string;
  readonly placement: string | undefined;
}

const MAX_FIELDS = 200;
const MAX_VALUE = 4096;

/** Поля формы с PHP-скобками → вложенный объект (глубина ≤ 3, без __proto__). */
export function parseBracketForm(form: URLSearchParams): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let n = 0;
  for (const [rawKey, value] of form) {
    n += 1;
    if (n > MAX_FIELDS) throw new AppError('VALIDATION_ERROR', 'Слишком много полей в запросе Bitrix24');
    const m = /^([^[\]]+)((?:\[[^[\]]*\]){0,3})$/.exec(rawKey);
    if (!m?.[1]) continue;
    const path = [m[1], ...[...(m[2] ?? '').matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1] ?? '')];
    if (path.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype' || p === '')) continue;
    const leaf = path.pop() ?? '';
    let node = root;
    for (const k of path) {
      const next = node[k];
      if (next && typeof next === 'object') node = next as Record<string, unknown>;
      else {
        const created = Object.create(null) as Record<string, unknown>;
        node[k] = created;
        node = created;
      }
    }
    node[leaf] = value.slice(0, MAX_VALUE);
  }
  return root;
}

/** Тело запроса к обработчику (строка формы, URLSearchParams или уже разобранный JSON) → объект полей. */
export function requestFields(
  body: string | URLSearchParams | Record<string, unknown>,
): Record<string, unknown> {
  if (body instanceof URLSearchParams) return parseBracketForm(body);
  if (typeof body === 'string') {
    const t = body.trim();
    if (t.startsWith('{')) {
      try {
        const v: unknown = JSON.parse(t);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
      } catch {
        // ниже — ошибка формата
      }
      throw new AppError('VALIDATION_ERROR', 'Некорректное тело запроса Bitrix24');
    }
    return parseBracketForm(new URLSearchParams(t));
  }
  return body;
}

const str = (v: unknown, max = 512): string | undefined =>
  typeof v === 'string' && v !== '' && v.length <= max ? v : typeof v === 'number' ? String(v) : undefined;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const TOKEN_RE = /^[A-Za-z0-9._-]{8,512}$/;
const MEMBER_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function parseEventPayload(
  body: string | URLSearchParams | Record<string, unknown>,
): BitrixEventPayload {
  const f = requestFields(body);
  const event = str(f['event'], 64)?.toUpperCase();
  const auth = obj(f['auth']);
  const memberId = str(auth['member_id'], 128);
  const applicationToken = str(auth['application_token'], 512);
  if (!event || !/^[A-Z0-9_]+$/.test(event)) {
    throw new AppError('VALIDATION_ERROR', 'Нет кода события Bitrix24', { field: 'event' });
  }
  if (!memberId || !MEMBER_RE.test(memberId) || !applicationToken || !TOKEN_RE.test(applicationToken)) {
    throw new AppError('ACCESS_DENIED', 'Событие без подписи приложения отклонено', {
      reason: 'EVENT_AUTH_MISSING',
    });
  }
  const token = (k: string) => {
    const v = str(auth[k]);
    return v && TOKEN_RE.test(v) ? v : undefined;
  };
  return {
    event,
    data: obj(f['data']),
    auth: {
      memberId,
      applicationToken,
      domain: str(auth['domain'], 253),
      clientEndpoint: str(auth['client_endpoint'], 300),
      accessToken: token('access_token'),
      refreshToken: token('refresh_token'),
    },
  };
}

export function parseLaunchParams(
  body: string | URLSearchParams | Record<string, unknown>,
): BitrixLaunchParams {
  const f = requestFields(body);
  const memberId = str(f['member_id'], 128);
  const domain = str(f['DOMAIN'], 253);
  const authId = str(f['AUTH_ID']);
  const refreshId = str(f['REFRESH_ID']);
  if (
    !memberId ||
    !MEMBER_RE.test(memberId) ||
    !domain ||
    !authId ||
    !TOKEN_RE.test(authId) ||
    !refreshId ||
    !TOKEN_RE.test(refreshId)
  ) {
    throw new AppError('VALIDATION_ERROR', 'Нет параметров запуска приложения Bitrix24', {
      field: 'AUTH_ID',
    });
  }
  return { memberId, domain, authId, refreshId, placement: str(f['PLACEMENT'], 100) };
}

/** HTTP-статус ответа обработчика по ошибке службы (для сборки маршрутов /b24/*). */
export function handlerHttpStatus(err: AppError): number {
  switch (err.code) {
    case 'ACCESS_DENIED':
    case 'BITRIX_AUTH_FAILED':
      return 403;
    case 'VALIDATION_ERROR':
      return 400;
    case 'NOT_FOUND':
      return 404;
    default:
      return err.details.retryable ? 503 : 500;
  }
}

/**
 * Вызовы REST портала из служб приложения (установка, вход, app.info) — только через BitrixClient
 * (src/bitrix/client.ts: allowlist хоста, лимитер, таймауты, нормализация ошибок) и только методами из реестра.
 */
import type { BitrixAuthProvider, RequestAuth } from '../../auth/bitrix-auth-provider.js';
import type { BitrixClient } from '../../bitrix/client.js';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { requireMethod, type ApiVersion } from '../../bitrix/method-registry.js';
import { EVENT_BIND, EVENT_GET } from '../../bitrix/registry/saas-app.js';
import { AppError } from '../../errors/app-error.js';
import type { BitrixOAuthTokens } from './oauth-client.js';
import { portalKeyForMember } from './user-provider.js';

/** То, что службам нужно от BitrixClient. */
export type PortalCaller = Pick<BitrixClient, 'callDescriptor'>;

/**
 * Клиент портала для провайдера авторизации. Сборка режима saas передаёт
 * `(auth, hosts) => new BitrixClient({ auth, allowedHosts: hosts, fetch, limiter портала, logger, … })`.
 */
export type PortalClientFactory = (auth: BitrixAuthProvider, allowedHosts: readonly string[]) => PortalCaller;

/**
 * Разовая авторизация свежей парой токенов (установка/вход, до сохранения в БД). Не обновляется:
 * пара только что выдана сервером авторизации.
 */
export class TransientOAuthAuth implements BitrixAuthProvider {
  readonly mode = 'oauth' as const;
  readonly portalOrigin: string;
  readonly portalKey: string;
  readonly identityUserId: number | undefined;

  constructor(private readonly t: BitrixOAuthTokens) {
    this.portalOrigin = new URL(t.clientEndpoint).origin;
    this.portalKey = portalKeyForMember(t.memberId);
    this.identityUserId = t.userId;
  }

  get allowedHosts(): readonly string[] {
    return [new URL(this.portalOrigin).host];
  }

  getAuth(apiVersion: ApiVersion): RequestAuth {
    return {
      baseUrl: apiVersion === 'v3' ? `${this.portalOrigin}/rest/api/` : `${this.portalOrigin}/rest/`,
      bodyFields: { auth: this.t.accessToken },
    };
  }

  tryRefresh(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export interface BitrixProfile {
  readonly id: number;
  readonly admin: boolean;
  readonly displayName: string;
}

/**
 * `profile` (api-reference/common/users/profile.md): `{result: {ID: "1", ADMIN: true, NAME, LAST_NAME, …}}`;
 * «If the user is inactive, the object is empty».
 */
export async function fetchProfile(caller: PortalCaller): Promise<BitrixProfile> {
  const r = await caller.callDescriptor(requireMethod('legacy', 'profile'), {});
  const p = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : {};
  const id = Number(p['ID']);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('BITRIX_ACCESS_DENIED', 'Пользователь Bitrix24 неактивен', {
      reason: 'PROFILE_EMPTY',
    });
  }
  const name = [p['NAME'], p['LAST_NAME']]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ')
    .slice(0, 200);
  return { id, admin: p['ADMIN'] === true, displayName: name };
}

/**
 * Подписка на события приложения: event.get (есть ли уже обработчик на этот адрес) → event.bind при отсутствии.
 * event.bind: «When an application is deleted or updated, its actions will be removed. Therefore, they must be set
 * from scratch in the installer of each version» (api-reference/events/event-bind.md).
 */
export async function ensureEventBindings(
  caller: PortalCaller,
  events: readonly string[],
  handler: string,
): Promise<string[]> {
  const existing = await caller.callDescriptor(EVENT_GET, {});
  const bound = new Set<string>();
  if (Array.isArray(existing.result)) {
    for (const h of existing.result) {
      if (h && typeof h === 'object' && !Array.isArray(h) && h['handler'] === handler) {
        const ev = h['event'];
        if (typeof ev === 'string') bound.add(ev.toUpperCase());
      }
    }
  }
  const added: string[] = [];
  for (const event of events) {
    if (bound.has(event.toUpperCase())) continue;
    const params: JsonObject = { event, handler };
    const r = await caller.callDescriptor(EVENT_BIND, params);
    if (r.result !== true) {
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'Bitrix24 не подтвердил подписку на событие', {
        method: 'event.bind',
        reason: 'EVENT_BIND_NOT_CONFIRMED',
      });
    }
    added.push(event);
  }
  return added;
}

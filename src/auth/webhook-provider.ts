import { createHash } from 'node:crypto';
import type { WebhookCredentials } from '../config/env.js';
import type { ApiVersion } from '../bitrix/method-registry.js';
import type { BitrixAuthProvider, RequestAuth } from './bitrix-auth-provider.js';

/**
 * Входящий вебхук (ТЗ §6.1):
 *  legacy: {origin}/rest/{userId}/{secret}/{method}.json
 *  v3:     {origin}/rest/api/{userId}/{secret}/{method}
 */
export class WebhookAuthProvider implements BitrixAuthProvider {
  readonly mode = 'webhook' as const;
  readonly portalOrigin: string;
  readonly portalKey: string;
  readonly identityUserId: number;
  private readonly legacyBase: string;
  private readonly v3Base: string;

  constructor(creds: WebhookCredentials) {
    const url = new URL(creds.baseUrl);
    this.portalOrigin = url.origin;
    // Ключ портала не содержит секрета: host + пользователь.
    this.portalKey = createHash('sha256').update(`${url.host}:${creds.userId}`).digest('hex').slice(0, 16);
    this.identityUserId = creds.userId;
    this.legacyBase = creds.baseUrl;
    this.v3Base = `${url.origin}/rest/api/${creds.userId}/${creds.secret}/`;
  }

  getAuth(apiVersion: ApiVersion): RequestAuth {
    return { baseUrl: apiVersion === 'v3' ? this.v3Base : this.legacyBase, bodyFields: {} };
  }

  tryRefresh(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Оповещение экземпляров об отзыве доступа (SaaS-ТЗ §5.2, §7.4): кэш TenantScope (TenantScopeRegistry) сбрасывается
 * по сообщению в канале Coordination. Формат сообщения: `<tenantId>` — весь арендатор, `<tenantId>:<userId>` — один
 * пользователь (идентификаторы — UUID, двоеточий не содержат).
 */
import type { Coordination } from '../coordination.js';

export const TENANT_INVALIDATE_CHANNEL = 'tenant-invalidate';

export function invalidateMessage(tenantId: string, userId?: string): string {
  return userId === undefined ? tenantId : `${tenantId}:${userId}`;
}

export function parseInvalidateMessage(message: string): { tenantId: string; userId?: string } {
  const i = message.indexOf(':');
  return i < 0 ? { tenantId: message } : { tenantId: message.slice(0, i), userId: message.slice(i + 1) };
}

export async function publishInvalidate(c: Coordination, tenantId: string, userId?: string): Promise<void> {
  await c.publish(TENANT_INVALIDATE_CHANNEL, invalidateMessage(tenantId, userId));
}

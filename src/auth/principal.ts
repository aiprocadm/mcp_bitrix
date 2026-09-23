/**
 * Субъект, от имени которого выполняется вызов (ТЗ §4.2, §4.3 п.2).
 * В stdio — локальная учётная запись (LOCAL_PRINCIPAL_ID); роль из access policy.
 */
import type { AccessPolicy, Role } from '../config/policy.js';
import { AppError } from '../errors/app-error.js';

export interface Principal {
  readonly id: string;
  readonly role: Role;
  readonly source: 'local' | 'oauth';
}

export function resolveLocalPrincipal(principalId: string, access: AccessPolicy): Principal {
  const entry = access.principals[principalId];
  if (!entry) {
    throw new AppError('CONFIG_INVALID', 'LOCAL_PRINCIPAL_ID отсутствует в access policy', {
      field: 'LOCAL_PRINCIPAL_ID',
      nextAction: 'Добавьте principal в policies/access.json',
    });
  }
  return { id: principalId, role: entry.role, source: 'local' };
}

const ROLE_RANK: Record<Role, number> = { reader: 1, operator: 2, administrator: 3 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

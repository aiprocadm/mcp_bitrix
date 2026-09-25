/**
 * Каталог арендаторов и пользователей (SaaS-ТЗ §4, §6.2). Арендатор = портал Bitrix24 (`member_id`, D1).
 * tenants — каталог без RLS (поиск по member_id до выбора арендатора); tenant_users/tenant_settings — под RLS.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/app-error.js';
import type { Role } from '../../config/policy.js';
import { toNumber, type SqlDb } from '../../storage/sql.js';
import type { TenantKeyRing } from '../keyring.js';

export type TenantStatus = 'active' | 'suspended' | 'uninstalled' | 'deleted';
export type UserStatus = 'active' | 'disabled' | 'reauth_required';

export interface Tenant {
  id: string;
  memberId: string;
  domain: string;
  status: TenantStatus;
  trialUsed: boolean;
  installedAt: string;
  uninstalledAt: string | null;
  deletedAt: string | null;
}

export interface TenantUser {
  id: string;
  tenantId: string;
  bitrixUserId: number;
  displayName: string;
  email: string | null;
  role: Role;
  status: UserStatus;
  tokenGeneration: number;
  lastLoginAt: string | null;
}

export interface TenantSettings {
  tenantId: string;
  modules: string[];
  approvalPolicy: 'self' | 'admin_for_high_risk';
  userDailyCallLimit: number | null;
  defaultRole: Role;
  outputPolicyJson: string | null;
}

interface TenantRow {
  id: string;
  member_id: string;
  domain: string;
  status: TenantStatus;
  trial_used: number | string;
  installed_at: string;
  uninstalled_at: string | null;
  deleted_at: string | null;
}

interface UserRow {
  id: string;
  tenant_id: string;
  bitrix_user_id: number | string;
  display_name: string;
  email: string | null;
  role: Role;
  status: UserStatus;
  token_generation: number | string;
  last_login_at: string | null;
}

const now = () => new Date().toISOString();

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  memberId: r.member_id,
  domain: r.domain,
  status: r.status,
  trialUsed: toNumber(r.trial_used) === 1,
  installedAt: r.installed_at,
  uninstalledAt: r.uninstalled_at,
  deletedAt: r.deleted_at,
});

const toUser = (r: UserRow): TenantUser => ({
  id: r.id,
  tenantId: r.tenant_id,
  bitrixUserId: toNumber(r.bitrix_user_id),
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  status: r.status,
  tokenGeneration: toNumber(r.token_generation),
  lastLoginAt: r.last_login_at,
});

/** Домен портала: только хост Bitrix24 без схемы/пути (проверка при установке и входе). */
export function normalizePortalDomain(input: string): string {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) {
    throw new AppError('VALIDATION_ERROR', 'Некорректный адрес портала Bitrix24', { field: 'domain' });
  }
  return host;
}

export class TenantsRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly keys: TenantKeyRing,
  ) {}

  /** Установка приложения: новый арендатор либо повторная установка того же портала (member_id). */
  async upsertInstalled(input: {
    memberId: string;
    domain: string;
    appTokenHash: string;
  }): Promise<{ tenant: Tenant; created: boolean }> {
    const domain = normalizePortalDomain(input.domain);
    return this.db.transaction(async (x) => {
      const existing = await x.get<TenantRow>(
        'SELECT * FROM tenants WHERE member_id = ? FOR UPDATE',
        input.memberId,
      );
      if (existing) {
        const revived = existing.status === 'uninstalled' ? 'active' : existing.status;
        if (existing.status === 'deleted') {
          // Данные удалены криптоудалением: новый ключ, пробный период не возвращается (trial_used сохраняется).
          await x.run(
            'UPDATE tenants SET status = ?, domain = ?, app_token_hash = ?, dek_encrypted = ?, installed_at = ?, uninstalled_at = NULL, deleted_at = NULL, updated_at = ? WHERE id = ?',
            'active',
            domain,
            input.appTokenHash,
            this.keys.newWrappedDek(existing.id),
            now(),
            now(),
            existing.id,
          );
          this.keys.forget(existing.id);
        } else {
          await x.run(
            'UPDATE tenants SET status = ?, domain = ?, app_token_hash = ?, uninstalled_at = NULL, updated_at = ? WHERE id = ?',
            revived,
            domain,
            input.appTokenHash,
            now(),
            existing.id,
          );
        }
        const row = await x.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', existing.id);
        if (!row) throw new AppError('INTERNAL_ERROR', 'Арендатор исчез при обновлении');
        return { tenant: toTenant(row), created: false };
      }
      const id = randomUUID();
      await x.run(
        `INSERT INTO tenants (id, member_id, domain, status, dek_encrypted, app_token_hash, trial_used, installed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
        id,
        input.memberId,
        domain,
        this.keys.newWrappedDek(id),
        input.appTokenHash,
        now(),
        now(),
        now(),
      );
      const row = await x.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', id);
      if (!row) throw new AppError('INTERNAL_ERROR', 'Арендатор не создан');
      return { tenant: toTenant(row), created: true };
    });
  }

  async get(id: string): Promise<Tenant | undefined> {
    const r = await this.db.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', id);
    return r ? toTenant(r) : undefined;
  }

  async getByMemberId(memberId: string): Promise<Tenant | undefined> {
    const r = await this.db.get<TenantRow>('SELECT * FROM tenants WHERE member_id = ?', memberId);
    return r ? toTenant(r) : undefined;
  }

  async getByDomain(domain: string): Promise<Tenant | undefined> {
    const r = await this.db.get<TenantRow>(
      'SELECT * FROM tenants WHERE domain = ?',
      normalizePortalDomain(domain),
    );
    return r ? toTenant(r) : undefined;
  }

  /** Хеш application_token установки (проверка подлинности событий, §8). */
  async appTokenHash(id: string): Promise<string | null> {
    const r = await this.db.get<{ app_token_hash: string | null }>(
      'SELECT app_token_hash FROM tenants WHERE id = ?',
      id,
    );
    return r?.app_token_hash ?? null;
  }

  async setStatus(id: string, status: TenantStatus): Promise<void> {
    const extra =
      status === 'uninstalled' ? ', uninstalled_at = ?' : status === 'deleted' ? ', deleted_at = ?' : '';
    const params = extra ? [status, now(), now(), id] : [status, now(), id];
    await this.db.run(`UPDATE tenants SET status = ?${extra}, updated_at = ? WHERE id = ?`, ...params);
  }

  /** Пробный период — один на портал (§9.1): true, если пробный период ещё не использовался и отмечен сейчас. */
  async claimTrial(id: string): Promise<boolean> {
    const n = await this.db.run(
      'UPDATE tenants SET trial_used = 1, updated_at = ? WHERE id = ? AND trial_used = 0',
      now(),
      id,
    );
    return n === 1;
  }

  async list(opts: { status?: TenantStatus; limit: number; offset: number }): Promise<Tenant[]> {
    const rows = opts.status
      ? await this.db.all<TenantRow>(
          'SELECT * FROM tenants WHERE status = ? ORDER BY created_at LIMIT ? OFFSET ?',
          opts.status,
          opts.limit,
          opts.offset,
        )
      : await this.db.all<TenantRow>(
          'SELECT * FROM tenants ORDER BY created_at LIMIT ? OFFSET ?',
          opts.limit,
          opts.offset,
        );
    return rows.map(toTenant);
  }
}

export class TenantUsersRepo {
  constructor(private readonly db: SqlDb) {}

  /** Вход через Bitrix24 (§7.2): пользователь портала создаётся при первом входе с ролью по умолчанию. */
  async upsertFromBitrix(input: {
    tenantId: string;
    bitrixUserId: number;
    displayName: string;
    email: string | null;
    defaultRole: Role;
  }): Promise<TenantUser> {
    return this.db.withTenant(input.tenantId, async (x) => {
      const existing = await x.get<UserRow>(
        'SELECT * FROM tenant_users WHERE tenant_id = ? AND bitrix_user_id = ?',
        input.tenantId,
        input.bitrixUserId,
      );
      if (existing) {
        await x.run(
          'UPDATE tenant_users SET display_name = ?, email = COALESCE(?, email), last_login_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
          input.displayName,
          input.email,
          now(),
          now(),
          input.tenantId,
          existing.id,
        );
      } else {
        await x.run(
          `INSERT INTO tenant_users (id, tenant_id, bitrix_user_id, display_name, email, role, status, token_generation, last_login_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
          randomUUID(),
          input.tenantId,
          input.bitrixUserId,
          input.displayName,
          input.email,
          input.defaultRole,
          now(),
          now(),
          now(),
        );
      }
      const row = await x.get<UserRow>(
        'SELECT * FROM tenant_users WHERE tenant_id = ? AND bitrix_user_id = ?',
        input.tenantId,
        input.bitrixUserId,
      );
      if (!row) throw new AppError('INTERNAL_ERROR', 'Пользователь не сохранён');
      return toUser(row);
    });
  }

  async get(tenantId: string, userId: string): Promise<TenantUser | undefined> {
    const r = await this.db.withTenant(tenantId, (x) =>
      x.get<UserRow>('SELECT * FROM tenant_users WHERE tenant_id = ? AND id = ?', tenantId, userId),
    );
    return r ? toUser(r) : undefined;
  }

  async list(tenantId: string): Promise<TenantUser[]> {
    const rows = await this.db.withTenant(tenantId, (x) =>
      x.all<UserRow>('SELECT * FROM tenant_users WHERE tenant_id = ? ORDER BY display_name, id', tenantId),
    );
    return rows.map(toUser);
  }

  async countActive(tenantId: string): Promise<number> {
    const r = await this.db.withTenant(tenantId, (x) =>
      x.get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM tenant_users WHERE tenant_id = ? AND status = 'active'",
        tenantId,
      ),
    );
    return toNumber(r?.n);
  }

  async setRole(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.run(
        'UPDATE tenant_users SET role = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
        role,
        now(),
        tenantId,
        userId,
      ),
    );
  }

  /**
   * Смена статуса. Отключение и «нужен повторный вход» увеличивают поколение токенов:
   * выданные access-токены сервиса с меньшим поколением отклоняются сразу (§7.4).
   */
  async setStatus(tenantId: string, userId: string, status: UserStatus): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.run(
        `UPDATE tenant_users SET status = ?, token_generation = token_generation + ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        status,
        status === 'active' ? 0 : 1,
        now(),
        tenantId,
        userId,
      ),
    );
  }

  /** Отзыв всех выданных токенов пользователя без смены статуса. */
  async bumpGeneration(tenantId: string, userId: string): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.run(
        'UPDATE tenant_users SET token_generation = token_generation + 1, updated_at = ? WHERE tenant_id = ? AND id = ?',
        now(),
        tenantId,
        userId,
      ),
    );
  }
}

interface SettingsRow {
  tenant_id: string;
  modules_json: string;
  approval_policy: 'self' | 'admin_for_high_risk';
  user_daily_call_limit: number | string | null;
  default_role: Role;
  output_policy_json: string | null;
}

export class TenantSettingsRepo {
  constructor(private readonly db: SqlDb) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const r = await this.db.withTenant(tenantId, (x) =>
      x.get<SettingsRow>('SELECT * FROM tenant_settings WHERE tenant_id = ?', tenantId),
    );
    if (!r) {
      return {
        tenantId,
        modules: [],
        approvalPolicy: 'self',
        userDailyCallLimit: null,
        defaultRole: 'operator',
        outputPolicyJson: null,
      };
    }
    return {
      tenantId,
      modules: JSON.parse(r.modules_json) as string[],
      approvalPolicy: r.approval_policy,
      userDailyCallLimit: r.user_daily_call_limit === null ? null : toNumber(r.user_daily_call_limit),
      defaultRole: r.default_role,
      outputPolicyJson: r.output_policy_json,
    };
  }

  async save(s: TenantSettings): Promise<void> {
    await this.db.withTenant(s.tenantId, (x) =>
      x.run(
        `INSERT INTO tenant_settings (tenant_id, modules_json, approval_policy, user_daily_call_limit, output_policy_json, default_role, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET modules_json = excluded.modules_json, approval_policy = excluded.approval_policy,
           user_daily_call_limit = excluded.user_daily_call_limit, output_policy_json = excluded.output_policy_json,
           default_role = excluded.default_role, updated_at = excluded.updated_at`,
        s.tenantId,
        JSON.stringify(s.modules),
        s.approvalPolicy,
        s.userDailyCallLimit,
        s.outputPolicyJson,
        s.defaultRole,
        now(),
      ),
    );
  }
}

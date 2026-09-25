/**
 * Удаление всех данных арендатора (SaaS-ТЗ §14 «Удаление по запросу», §6.3, тест S13).
 *
 * Порядок (каждый шаг идемпотентен; повторный запуск после сбоя доводит удаление до конца):
 *  1. Отзыв доступа сразу: refresh-токены сервиса, поколение пользователей +1, неисполненные операции → denied,
 *     оповещение экземпляров (колбэк `revokeTenant` сервера авторизации S4).
 *  2. Статус арендатора `deleted` — новые входы и вызовы невозможны ещё до физического удаления строк.
 *  3. Подготовленные файлы (staging на диске) — удаляются.
 *  4. Криптоудаление: DEK арендатора стирается (`TenantKeyRing.destroy`) — всё зашифрованное его ключом
 *     (токены Bitrix24, планы, способ оплаты, контакт для чека) нечитаемо, в том числе в бэкапах.
 *  5. Физическое удаление строк арендатора: таблицы под RLS — в его контексте (`withTenant`), каталог — по tenant_id.
 *
 * Сохраняются отдельно (бухучёт, 5 лет, §6.3): `payments`, `invoices`; строка `tenants` (member_id — правило
 * «пробный период один раз на портал», §9.1) со статусом `deleted`; подписка — остановлена (`canceled`),
 * её зашифрованные поля очищены. Запись о факте удаления — в `support_actions` (журнал вне данных арендатора).
 */
import type { AppLogger } from '../logging/logger.js';
import type { FileStaging } from '../files/staging.js';
import type { SqlDb } from '../storage/sql.js';
import type { Coordination } from './coordination.js';
import type { TenantKeyRing } from './keyring.js';
import { ENTITLEMENTS_CHANNEL } from './billing/entitlements.js';
import { publishInvalidate } from './bitrix/invalidation.js';

/** Таблицы данных арендатора под RLS: удаляются в его контексте (порядок — зависимые раньше). */
export const TENANT_RLS_DATA_TABLES = [
  'cabinet_sessions',
  'bitrix_tokens',
  'mcp_consents',
  'idempotency',
  'operations',
  'cursors',
  'file_manifests',
  'audit',
  'tenant_settings',
  'tenant_users',
] as const;

/** Каталог без RLS со строками арендатора, которые удаляются (не платёжные документы). */
export const TENANT_CATALOG_TABLES = [
  'mcp_auth_codes',
  'mcp_refresh_tokens',
  'usage_counters',
  'usage_tool_counters',
  'tenant_app_status',
] as const;

export interface TenantDeletionDeps {
  readonly db: SqlDb;
  readonly keys: TenantKeyRing;
  /** Staging файлов процесса; арендатору — `forTenant(id)`. */
  readonly fileStaging: Pick<FileStaging, 'forTenant'>;
  /** Отзыв доступа всех пользователей арендатора (AuthorizationServer.revokeTenant, S4). */
  readonly revokeTenant: (tenantId: string) => Promise<unknown>;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
  readonly now?: () => number;
}

export interface TenantDeletionRequest {
  /** Кто инициировал: `tenant_admin` (кабинет) или имя владельца/поддержки (панель). */
  readonly actor: string;
  /** Основание (для журнала): «Запрос администратора арендатора» и т.п. */
  readonly reason: string;
}

export interface TenantDeletionReport {
  readonly tenantId: string;
  readonly deletedAt: string;
  readonly filesRemoved: number;
  readonly rowsDeleted: Readonly<Record<string, number>>;
  readonly keyDestroyed: boolean;
}

export class TenantDataDeletion {
  private readonly now: () => number;

  constructor(private readonly d: TenantDeletionDeps) {
    this.now = d.now ?? Date.now;
  }

  async deleteAll(tenantId: string, req: TenantDeletionRequest): Promise<TenantDeletionReport> {
    const at = new Date(this.now()).toISOString();
    const exists = await this.d.db.get<{ id: string }>('SELECT id FROM tenants WHERE id = ?', tenantId);
    if (!exists) throw new Error('Арендатор не найден');

    // 1–2. Доступ закрыт сразу.
    await this.d.revokeTenant(tenantId);
    await this.d.db.run(
      "UPDATE tenants SET status = 'deleted', deleted_at = ?, app_token_hash = NULL, updated_at = ? WHERE id = ?",
      at,
      at,
      tenantId,
    );

    // 3. Файлы на диске.
    const filesRemoved = await this.d.fileStaging.forTenant(tenantId).purgeAll();

    // 4. Криптоудаление и остановка подписки (зашифрованные поля — под уничтоженным DEK).
    const rowsDeleted: Record<string, number> = {};
    await this.d.db.transaction(async (x) => {
      await this.d.keys.destroy(x, tenantId);
      await x.run(
        `UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 0, payment_method_encrypted = NULL,
           payment_method_title = NULL, receipt_contact_encrypted = NULL, next_retry_at = NULL,
           suspended_at = COALESCE(suspended_at, ?), updated_at = ? WHERE tenant_id = ?`,
        at,
        at,
        tenantId,
      );
      for (const t of TENANT_CATALOG_TABLES) {
        rowsDeleted[t] = await x.run(`DELETE FROM ${t} WHERE tenant_id = ?`, tenantId);
      }
    });

    // 5. Данные арендатора под RLS — в его контексте.
    await this.d.db.withTenant(tenantId, async (x) => {
      for (const t of TENANT_RLS_DATA_TABLES) {
        rowsDeleted[t] = await x.run(`DELETE FROM ${t} WHERE tenant_id = ?`, tenantId);
      }
    });

    await this.d.db.run(
      'INSERT INTO support_actions (actor, tenant_id, action, reason, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      req.actor,
      tenantId,
      'tenant_data_deleted',
      req.reason,
      JSON.stringify({ filesRemoved, rowsDeleted }),
      at,
    );
    this.d.keys.forget(tenantId);
    await publishInvalidate(this.d.coordination, tenantId);
    await this.d.coordination.publish(ENTITLEMENTS_CHANNEL, tenantId);
    this.d.logger.warn({ tenantId, filesRemoved }, 'tenant data deleted');
    return { tenantId, deletedAt: at, filesRemoved, rowsDeleted, keyDestroyed: true };
  }
}

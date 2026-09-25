/**
 * Зависимости кабинета клиента `/app` (SaaS-ТЗ §11.1, §11.2, §4 сценарии 1–3, §12 п.2 и п.5, §14).
 * Кабинет — самостоятельный модуль: сборка режима saas (src/saas/runtime.ts) создаёт его из своих сервисов
 * и вешает маршруты (`registerCabinet`) и обратный вызов входа Bitrix24 (`cabinet.handleBitrixCallback`).
 */
import type { BitrixAuthProvider } from '../../auth/bitrix-auth-provider.js';
import type { Principal } from '../../auth/principal.js';
import type { TenantScope } from '../../app/container.js';
import type { FileStaging } from '../../files/staging.js';
import type { AuditLog } from '../../logging/audit.js';
import type { AppLogger } from '../../logging/logger.js';
import type { SqlDb } from '../../storage/sql.js';
import type { SubscriptionService } from '../billing/subscription-service.js';
import type { UsageMeter } from '../billing/usage-meter.js';
import type { BitrixLoginService } from '../bitrix/login-service.js';
import type { Coordination } from '../coordination.js';
import type { TenantKeyRing } from '../keyring.js';
import type { PlansRepo, SubscriptionsRepo } from '../repos/plans.js';
import type { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from '../repos/tenants.js';
import type { TenantDeletionReport, TenantDeletionRequest } from '../tenant-deletion.js';

/**
 * Контекст пользователя арендатора для кабинета — подмножество TenantScope (тот же объект подходит без адаптера):
 * подтверждения, операции и файлы ИМЕННО того сервиса, который исполняет вызовы MCP (тот же ключ шифрования планов,
 * те же проверки хеша плана и срока).
 */
export type CabinetScope = Pick<TenantScope, 'tenantId' | 'operations' | 'approvals' | 'files'> & {
  /** principal операций (в saas — tenant_users.id). */
  readonly principal: Pick<Principal, 'id'>;
  /** Ключ портала арендатора (portalKeyForMember). */
  readonly auth: Pick<BitrixAuthProvider, 'portalKey'>;
};

/** Оплата и подписка (S7) — только то, что вызывает кабинет. */
export type CabinetBilling = Pick<
  SubscriptionService,
  'checkout' | 'syncPayment' | 'cancel' | 'resume' | 'changePlan' | 'issueInvoice' | 'invoices' | 'payments'
>;

/** Уведомления кабинета (письма — сборка режима saas; SMTP в S5 не реализован). */
export interface CabinetNotifier {
  /** Подтверждение удаления данных (§14): на email, указанный администратором в форме удаления. */
  tenantDataDeleted(e: { tenantId: string; domain: string; email: string | null; at: string }): Promise<void>;
}

export interface CabinetFileSettings {
  readonly maxUploadBytes: number;
  readonly uploadTtlSeconds: number;
  /** Антивирус обязателен (UPLOAD_SCAN_REQUIRED): без вердикта clean файл не сохраняется (проверяет FileStaging). */
  readonly scanRequired: boolean;
}

export interface CabinetDeps {
  /** PUBLIC_BASE_URL (https-origin; http — только loopback для разработки). */
  readonly publicBaseUrl: string;
  readonly db: SqlDb;
  readonly keys: TenantKeyRing;
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly settings: TenantSettingsRepo;
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
  /** Вход через Bitrix24 (S3). */
  readonly login: Pick<BitrixLoginService, 'authorizeUrl' | 'completeLogin'>;
  /** Контекст пользователя: подтверждения/операции/файлы того же сервиса, что исполняет MCP-вызовы. */
  readonly scopeFor: (tenantId: string, userId: string) => Promise<CabinetScope>;
  readonly audit: AuditLog;
  /** Отчёты использования (S6); не задан — блок использования не показывается. */
  readonly usage?: Pick<UsageMeter, 'monthUsage' | 'report'> | undefined;
  /** Подписка и оплата (S7); не задан — раздел оплаты честно сообщает, что недоступен. */
  readonly billing?: CabinetBilling | undefined;
  /** Отзыв доступа пользователя (AuthorizationServer.revokeUser, S4). */
  readonly revokeUser: (tenantId: string, userId: string) => Promise<unknown>;
  /** Отзыв доступа всего арендатора (AuthorizationServer.revokeTenant, S4). */
  readonly revokeTenant: (tenantId: string) => Promise<unknown>;
  /**
   * Удаление всех данных арендатора (§14). Не задано — кабинет использует TenantDataDeletion из src/saas/tenant-deletion.ts
   * с зависимостями выше (`fileStaging` обязателен в этом случае).
   */
  readonly deleteTenantData?:
    ((tenantId: string, req: TenantDeletionRequest) => Promise<TenantDeletionReport>) | undefined;
  /** Staging процесса (для удаления файлов арендатора, если deleteTenantData не задан). */
  readonly fileStaging?: Pick<FileStaging, 'forTenant'> | undefined;
  readonly files: CabinetFileSettings;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
  readonly notifier?: CabinetNotifier | undefined;
  /** Лимит попыток входа на IP в минуту (по умолчанию 10) и решений по подтверждениям на пользователя (30). */
  readonly loginPerMinute?: number | undefined;
  readonly decisionsPerMinute?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** Ответ обратного вызова входа (для маршрута GET /b24/oauth/callback сборки режима saas). */
export interface CabinetResponse {
  status: number;
  headers: Record<string, string>;
  /** Значения заголовков Set-Cookie. */
  setCookies: string[];
  body: string;
}

export interface CabinetCallbackRequest {
  /** Разобранная query-строка обратного вызова Bitrix24 (code, state, domain, member_id, …). */
  readonly query: Readonly<Record<string, unknown>> | undefined;
  /** Заголовок Cookie. */
  readonly cookie?: string | undefined;
  /** Адрес клиента (ключ лимита). */
  readonly ip?: string | undefined;
}

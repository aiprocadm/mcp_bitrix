/**
 * Статус приложения и лицензии портала (SaaS-ТЗ §8): worker раз в сутки вызывает `checkAppStatus(tenantId)`;
 * результат сохраняется в `tenant_app_status` и показывается в кабинете/панели владельца — предупреждение,
 * а не молчаливые ошибки инструментов.
 *
 * `app.info` (api-reference/common/system/app-info.md): `{result: {ID, CODE, VERSION, STATUS: F|D|T|P|L,
 * INSTALLED: bool, PAYMENT_EXPIRED: "Y"|"N", DAYS: number|null, LANGUAGE_ID, LICENSE, LICENSE_TYPE, LICENSE_FAMILY}}`;
 * «After the paid period expires … PAYMENT_EXPIRED flag will be Y, and the DAYS field will contain a negative number».
 * Метод требует контекст приложения — вызывается OAuth-токеном пользователя арендатора (предпочтительно администратора).
 */
import { requireMethod } from '../../bitrix/method-registry.js';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import { toNumber, type SqlDb } from '../../storage/sql.js';
import type { TenantsRepo, TenantUsersRepo } from '../repos/tenants.js';
import type { PortalClientFactory } from './portal.js';
import type { BitrixTokenStore } from './token-store.js';
import type { BitrixOAuthProviderFactory } from './user-provider.js';

/** За сколько дней до конца оплаченного периода приложения предупреждать. */
export const APP_PAYMENT_WARN_DAYS = 7;

export interface AppStatusResult {
  readonly tenantId: string;
  readonly checkedAt: string;
  /** Проверка выполнена (app.info ответил). */
  readonly ok: boolean;
  readonly appStatus: string | null;
  readonly installed: boolean | null;
  readonly paymentExpired: boolean | null;
  readonly daysLeft: number | null;
  readonly license: string | null;
  readonly licenseFamily: string | null;
  /**
   * Коды для кабинета: APP_INSTALL_NOT_FINISHED, APP_PAYMENT_EXPIRED, APP_PAYMENT_EXPIRING, NO_AUTHORIZED_USER,
   * TENANT_NOT_ACTIVE, APP_INFO_FAILED.
   */
  readonly warnings: readonly string[];
  readonly errorCode: string | null;
  readonly errorReason: string | null;
}

export interface BitrixAppStatusDeps {
  readonly db: SqlDb;
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly tokens: BitrixTokenStore;
  readonly providers: Pick<BitrixOAuthProviderFactory, 'open'>;
  readonly portal: PortalClientFactory;
  readonly logger: AppLogger;
  readonly now?: () => Date;
}

interface StatusRow {
  tenant_id: string;
  checked_at: string;
  ok: number | string;
  app_status: string | null;
  installed: number | string | null;
  payment_expired: number | string | null;
  days_left: number | string | null;
  license: string | null;
  license_family: string | null;
  warnings_json: string;
  error_code: string | null;
  error_reason: string | null;
}

const flag = (v: number | string | null): boolean | null => (v === null ? null : toNumber(v) === 1);
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 100) : null);

export class BitrixAppStatusService {
  constructor(private readonly d: BitrixAppStatusDeps) {}

  async checkAppStatus(tenantId: string): Promise<AppStatusResult> {
    const checkedAt = (this.d.now?.() ?? new Date()).toISOString();
    const base = {
      tenantId,
      checkedAt,
      ok: false,
      appStatus: null,
      installed: null,
      paymentExpired: null,
      daysLeft: null,
      license: null,
      licenseFamily: null,
      errorCode: null,
      errorReason: null,
    };
    const tenant = await this.d.tenants.get(tenantId);
    if (!tenant) throw new AppError('NOT_FOUND', 'Арендатор не найден');
    if (tenant.status !== 'active' && tenant.status !== 'suspended') {
      return this.save({ ...base, warnings: ['TENANT_NOT_ACTIVE'] });
    }
    // Администраторы вперёд: их права на портале обычно шире; пользователи без токенов не пробуются.
    const withTokens = new Set(await this.d.tokens.usersWithTokens(tenantId));
    const candidates = (await this.d.users.list(tenantId))
      .filter((u) => u.status === 'active' && withTokens.has(u.id))
      .sort((a, b) => Number(b.role === 'administrator') - Number(a.role === 'administrator'));
    let lastError: AppError | undefined;
    for (const u of candidates.slice(0, 3)) {
      try {
        const provider = await this.d.providers.open(tenantId, u.id);
        const client = this.d.portal(provider, provider.allowedHosts);
        const r = await client.callDescriptor(requireMethod('legacy', 'app.info'), {});
        const info = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : {};
        const installed = typeof info['INSTALLED'] === 'boolean' ? info['INSTALLED'] : null;
        const paymentExpired =
          info['PAYMENT_EXPIRED'] === 'Y' ? true : info['PAYMENT_EXPIRED'] === 'N' ? false : null;
        const days = info['DAYS'];
        const daysLeft = typeof days === 'number' && Number.isFinite(days) ? Math.trunc(days) : null;
        const warnings: string[] = [];
        if (installed === false) warnings.push('APP_INSTALL_NOT_FINISHED');
        if (paymentExpired === true) warnings.push('APP_PAYMENT_EXPIRED');
        else if (daysLeft !== null && daysLeft <= APP_PAYMENT_WARN_DAYS)
          warnings.push('APP_PAYMENT_EXPIRING');
        return await this.save({
          ...base,
          ok: true,
          appStatus: s(info['STATUS']),
          installed,
          paymentExpired,
          daysLeft,
          license: s(info['LICENSE']),
          licenseFamily: s(info['LICENSE_FAMILY']),
          warnings,
        });
      } catch (e) {
        lastError = AppError.from(e);
        this.d.logger.warn({ tenantId, code: lastError.code }, 'app.info check failed');
      }
    }
    return this.save({
      ...base,
      warnings: [lastError ? 'APP_INFO_FAILED' : 'NO_AUTHORIZED_USER'],
      errorCode: lastError?.code ?? 'BITRIX_AUTH_FAILED',
      errorReason: lastError?.details.reason ?? (lastError ? null : 'NO_AUTHORIZED_USER'),
    });
  }

  /** Последний результат проверки (кабинет, панель владельца). */
  async lastStatus(tenantId: string): Promise<AppStatusResult | undefined> {
    const r = await this.d.db.get<StatusRow>('SELECT * FROM tenant_app_status WHERE tenant_id = ?', tenantId);
    if (!r) return undefined;
    return {
      tenantId: r.tenant_id,
      checkedAt: r.checked_at,
      ok: toNumber(r.ok) === 1,
      appStatus: r.app_status,
      installed: flag(r.installed),
      paymentExpired: flag(r.payment_expired),
      daysLeft: r.days_left === null ? null : toNumber(r.days_left),
      license: r.license,
      licenseFamily: r.license_family,
      warnings: JSON.parse(r.warnings_json) as string[],
      errorCode: r.error_code,
      errorReason: r.error_reason,
    };
  }

  private async save(r: AppStatusResult): Promise<AppStatusResult> {
    const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    await this.d.db.run(
      `INSERT INTO tenant_app_status (tenant_id, checked_at, ok, app_status, installed, payment_expired, days_left, license, license_family, warnings_json, error_code, error_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, app_status = excluded.app_status,
         installed = excluded.installed, payment_expired = excluded.payment_expired, days_left = excluded.days_left,
         license = excluded.license, license_family = excluded.license_family, warnings_json = excluded.warnings_json,
         error_code = excluded.error_code, error_reason = excluded.error_reason`,
      r.tenantId,
      r.checkedAt,
      r.ok ? 1 : 0,
      r.appStatus,
      b(r.installed),
      b(r.paymentExpired),
      r.daysLeft,
      r.license,
      r.licenseFamily,
      JSON.stringify(r.warnings),
      r.errorCode,
      r.errorReason,
    );
    return r;
  }
}

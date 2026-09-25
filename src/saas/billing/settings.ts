/**
 * Настройки биллинга и учёта (SaaS-ТЗ §9, §10, §15). Подключаются сборкой режима saas из `AppConfig.deployment`
 * (`billingSettingsFromDeployment`); секретный ключ магазина читается из файла YOOKASSA_SECRET_KEY_FILE
 * и хранится только в памяти (не в конфиге, не в логах).
 */
import { readFileSync } from 'node:fs';
import { AppError, configError } from '../../errors/app-error.js';
import type { DeploymentSettings } from '../../config/env.js';

export interface SellerSettings {
  /** Наименование продавца (счета юрлицам; в чеке продавец — магазин ЮKassa). */
  readonly name: string;
  /** ИНН продавца: 10 или 12 цифр. */
  readonly inn: string;
  /** Система налогообложения чека (`tax_system_code`, 1–6; https://yookassa.ru/developers/payment-acceptance/receipts/54fz/parameters-values#tax-systems). */
  readonly taxSystemCode: number;
  /** Ставка НДС позиции чека (`vat_code`; https://yookassa.ru/developers/payment-acceptance/receipts/54fz/parameters-values#vat-codes). */
  readonly vatCode: number;
  /** Признак предмета расчёта (`payment_subject`), по умолчанию `service` (PaymentSubject.SERVICE в SDK). */
  readonly paymentSubject: string;
  /** Признак способа расчёта (`payment_mode`), по умолчанию `full_payment` (PaymentMode.FULL_PAYMENT в SDK). */
  readonly paymentMode: string;
}

export interface YooKassaSettings {
  readonly shopId: string;
  /** Секретный ключ магазина (из файла). Не логируется и не попадает в ошибки. */
  readonly secretKey: string;
  /** Адрес API; по умолчанию https://api.yookassa.ru/v3 (Configuration.api_url в SDK). */
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

export interface BillingSettings {
  /** Кабинет клиента (для nextAction ошибок и return_url), например https://mcp.example.ru/app. */
  readonly cabinetUrl: string;
  /** Куда ЮKassa возвращает пользователя после оплаты (confirmation.return_url). */
  readonly returnUrl: string;
  /** Не задан — онлайн-оплата недоступна, работает только оплата по счёту. */
  readonly yookassa: YooKassaSettings | undefined;
  readonly seller: SellerSettings;
  /** Льготный период после неуспешного продления (§10.2): 7 дней. */
  readonly graceDays: number;
  /** Смещения попыток списания от конца периода, дни (§10.2: 3 попытки за 7 дней). */
  readonly retryOffsetsDays: readonly number[];
  /** Хранение данных после остановки подписки до события удаления (§6.3): 30 дней. */
  readonly dataRetentionDays: number;
  /** Интервал сброса учёта в PostgreSQL (§9.2): 60 000 мс. */
  readonly usageFlushIntervalMs: number;
  /** Порог уведомления о квоте, проценты (§9.3): 80. */
  readonly quotaWarnPercent: number;
}

export const DEFAULT_YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';

export const BILLING_DEFAULTS = {
  graceDays: 7,
  retryOffsetsDays: [0, 3, 6],
  dataRetentionDays: 30,
  usageFlushIntervalMs: 60_000,
  quotaWarnPercent: 80,
} as const;

export function validateBillingSettings(s: BillingSettings): void {
  if (!/^(\d{10}|\d{12})$/.test(s.seller.inn)) throw configError('SELLER_INN', 'ИНН — 10 или 12 цифр');
  if (!s.seller.name.trim()) throw configError('SELLER_NAME', 'укажите наименование продавца');
  if (!Number.isInteger(s.seller.taxSystemCode) || s.seller.taxSystemCode < 1 || s.seller.taxSystemCode > 6)
    throw configError('SELLER_TAX_SYSTEM_CODE', 'код системы налогообложения ЮKassa: 1–6');
  if (!Number.isInteger(s.seller.vatCode) || s.seller.vatCode < 1)
    throw configError('SELLER_VAT_CODE', 'код ставки НДС ЮKassa: целое число ≥ 1');
  if (s.retryOffsetsDays.some((d) => d < 0 || d >= s.graceDays))
    throw new AppError('CONFIG_INVALID', 'Попытки списания должны укладываться в льготный период');
  if (s.yookassa) {
    if (!/^\d{1,20}$/.test(s.yookassa.shopId))
      throw configError('YOOKASSA_SHOP_ID', 'идентификатор магазина — цифры');
    if (!s.yookassa.secretKey) throw configError('YOOKASSA_SECRET_KEY_FILE', 'файл ключа пуст');
  }
}

/**
 * Настройки из конфигурации saas (`AppConfig.deployment`). Без SELLER_* — CONFIG_INVALID: боевые чеки не
 * включаются до заполнения реквизитов (§20). Без YOOKASSA_SHOP_ID — только оплата по счёту.
 */
export function billingSettingsFromDeployment(
  d: DeploymentSettings,
  readSecret: (path: string) => string = (p) => readFileSync(p, 'utf8').trim(),
): BillingSettings {
  const base = d.publicBaseUrl;
  if (!base) throw configError('PUBLIC_BASE_URL', 'обязателен при DEPLOYMENT_MODE=saas');
  const need = (field: string, v: string | undefined) => {
    if (!v) throw configError(field, 'обязателен для биллинга');
    return v;
  };
  let yookassa: YooKassaSettings | undefined;
  if (d.yookassa.shopId) {
    const file = need('YOOKASSA_SECRET_KEY_FILE', d.files.yookassaSecretKey);
    yookassa = {
      shopId: d.yookassa.shopId,
      secretKey: readSecret(file),
      apiUrl: d.yookassa.apiUrl ?? DEFAULT_YOOKASSA_API_URL,
      timeoutMs: 30_000,
    };
  }
  const s: BillingSettings = {
    cabinetUrl: `${base}/app`,
    returnUrl: `${base}/app/billing/return`,
    yookassa,
    seller: {
      name: need('SELLER_NAME', d.seller.name),
      inn: need('SELLER_INN', d.seller.inn),
      taxSystemCode: Number(need('SELLER_TAX_SYSTEM_CODE', d.seller.taxSystemCode)),
      vatCode: Number(need('SELLER_VAT_CODE', d.seller.vatCode)),
      paymentSubject: 'service',
      paymentMode: 'full_payment',
    },
    ...BILLING_DEFAULTS,
  };
  validateBillingSettings(s);
  return s;
}

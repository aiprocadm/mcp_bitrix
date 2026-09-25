/**
 * Тарифы и подписки (SaaS-ТЗ §9, §10.2, D10). Тарифы — данные: цены и лимиты правит владелец без релиза.
 * Деньги — копейки (целые), без float.
 */
import { AppError } from '../../errors/app-error.js';
import { ALL_MODULES, type ModuleName } from '../../config/modules.js';
import { toNumber, type SqlDb, type SqlExecutor } from '../../storage/sql.js';

export interface PlanLimits {
  readonly users: number;
  readonly callsPerMonth: number;
  readonly writesPerMonth: number;
}

export interface Plan {
  code: string;
  name: string;
  priceKopecks: number;
  periodMonths: 1 | 12;
  trialDays: number;
  limits: PlanLimits;
  /** Модули тарифа; `*` — все. `system` доступен всегда. */
  modules: readonly string[];
  destructiveAllowed: boolean;
  public: boolean;
  active: boolean;
  sort: number;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';

export interface Subscription {
  tenantId: string;
  planCode: string;
  status: SubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanCode: string | null;
  paymentMethodTitle: string | null;
  hasPaymentMethod: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  suspendedAt: string | null;
}

const CORE_MODULES: readonly ModuleName[] = ['system', 'crm', 'tasks', 'calendar', 'chat', 'disk'];

/** Тарифы по умолчанию — таблица §9.1 ТЗ (допущение; владелец меняет в панели). */
export const DEFAULT_PLANS: readonly Plan[] = [
  {
    code: 'trial',
    name: 'Пробный',
    priceKopecks: 0,
    periodMonths: 1,
    trialDays: 14,
    limits: { users: 3, callsPerMonth: 1000, writesPerMonth: 100 },
    modules: ['*'],
    destructiveAllowed: false,
    public: false,
    active: true,
    sort: 0,
  },
  {
    code: 'start',
    name: 'Старт',
    priceKopecks: 99_000,
    periodMonths: 1,
    trialDays: 0,
    limits: { users: 3, callsPerMonth: 5000, writesPerMonth: 300 },
    modules: CORE_MODULES,
    destructiveAllowed: false,
    public: true,
    active: true,
    sort: 10,
  },
  {
    code: 'team',
    name: 'Команда',
    priceKopecks: 299_000,
    periodMonths: 1,
    trialDays: 0,
    limits: { users: 15, callsPerMonth: 30_000, writesPerMonth: 3000 },
    modules: ['*'],
    destructiveAllowed: false,
    public: true,
    active: true,
    sort: 20,
  },
  {
    code: 'business',
    name: 'Бизнес',
    priceKopecks: 799_000,
    periodMonths: 1,
    trialDays: 0,
    limits: { users: 50, callsPerMonth: 150_000, writesPerMonth: 15_000 },
    modules: ['*'],
    destructiveAllowed: true,
    public: true,
    active: true,
    sort: 30,
  },
];

/** Входит ли модуль в тариф. */
export function planAllowsModule(plan: Pick<Plan, 'modules'>, module: string): boolean {
  return module === 'system' || plan.modules.includes('*') || plan.modules.includes(module);
}

export function validatePlan(p: Plan): void {
  const bad = (field: string, why: string) => new AppError('VALIDATION_ERROR', `${field}: ${why}`, { field });
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(p.code)) throw bad('code', 'латиница, 2–32 символа');
  if (!Number.isSafeInteger(p.priceKopecks) || p.priceKopecks < 0) throw bad('priceKopecks', 'целое ≥ 0');
  for (const [k, v] of Object.entries(p.limits))
    if (!Number.isSafeInteger(v) || v < 0) throw bad(`limits.${k}`, 'целое ≥ 0');
  for (const m of p.modules)
    if (m !== '*' && !(ALL_MODULES as readonly string[]).includes(m))
      throw bad('modules', `неизвестный модуль ${m}`);
}

interface PlanRow {
  code: string;
  name: string;
  price_kopecks: string | number;
  period_months: string | number;
  trial_days: string | number;
  limits_json: string;
  modules_json: string;
  destructive_allowed: string | number;
  public: string | number;
  active: string | number;
  sort: string | number;
}

const toPlan = (r: PlanRow): Plan => ({
  code: r.code,
  name: r.name,
  priceKopecks: toNumber(r.price_kopecks),
  periodMonths: toNumber(r.period_months) === 12 ? 12 : 1,
  trialDays: toNumber(r.trial_days),
  limits: JSON.parse(r.limits_json) as PlanLimits,
  modules: JSON.parse(r.modules_json) as string[],
  destructiveAllowed: toNumber(r.destructive_allowed) === 1,
  public: toNumber(r.public) === 1,
  active: toNumber(r.active) === 1,
  sort: toNumber(r.sort),
});

const now = () => new Date().toISOString();

export class PlansRepo {
  constructor(private readonly db: SqlDb) {}

  /** Первичное наполнение: только отсутствующие тарифы (правки владельца не затираются). */
  async seedDefaults(): Promise<void> {
    for (const p of DEFAULT_PLANS) await this.insertIfMissing(this.db, p);
  }

  private async insertIfMissing(x: SqlExecutor, p: Plan): Promise<void> {
    await x.run(
      `INSERT INTO plans (code, name, price_kopecks, period_months, trial_days, limits_json, modules_json, destructive_allowed, public, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
      ...planParams(p),
      now(),
      now(),
    );
  }

  async upsert(p: Plan): Promise<void> {
    validatePlan(p);
    await this.db.run(
      `INSERT INTO plans (code, name, price_kopecks, period_months, trial_days, limits_json, modules_json, destructive_allowed, public, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, price_kopecks = excluded.price_kopecks,
         period_months = excluded.period_months, trial_days = excluded.trial_days, limits_json = excluded.limits_json,
         modules_json = excluded.modules_json, destructive_allowed = excluded.destructive_allowed,
         public = excluded.public, active = excluded.active, sort = excluded.sort, updated_at = excluded.updated_at`,
      ...planParams(p),
      now(),
      now(),
    );
  }

  async get(code: string): Promise<Plan | undefined> {
    const r = await this.db.get<PlanRow>('SELECT * FROM plans WHERE code = ?', code);
    return r ? toPlan(r) : undefined;
  }

  async list(opts: { publicOnly: boolean }): Promise<Plan[]> {
    const rows = opts.publicOnly
      ? await this.db.all<PlanRow>('SELECT * FROM plans WHERE public = 1 AND active = 1 ORDER BY sort, code')
      : await this.db.all<PlanRow>('SELECT * FROM plans ORDER BY sort, code');
    return rows.map(toPlan);
  }
}

function planParams(p: Plan): (string | number)[] {
  return [
    p.code,
    p.name,
    p.priceKopecks,
    p.periodMonths,
    p.trialDays,
    JSON.stringify(p.limits),
    JSON.stringify(p.modules),
    p.destructiveAllowed ? 1 : 0,
    p.public ? 1 : 0,
    p.active ? 1 : 0,
    p.sort,
  ];
}

interface SubRow {
  tenant_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  period_start: string;
  period_end: string;
  cancel_at_period_end: string | number;
  pending_plan_code: string | null;
  payment_method_encrypted: string | null;
  payment_method_title: string | null;
  retry_count: string | number;
  next_retry_at: string | null;
  suspended_at: string | null;
}

const toSub = (r: SubRow): Subscription => ({
  tenantId: r.tenant_id,
  planCode: r.plan_code,
  status: r.status,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  cancelAtPeriodEnd: toNumber(r.cancel_at_period_end) === 1,
  pendingPlanCode: r.pending_plan_code,
  paymentMethodTitle: r.payment_method_title,
  hasPaymentMethod: r.payment_method_encrypted !== null,
  retryCount: toNumber(r.retry_count),
  nextRetryAt: r.next_retry_at,
  suspendedAt: r.suspended_at,
});

export class SubscriptionsRepo {
  constructor(private readonly db: SqlDb) {}

  async get(tenantId: string): Promise<Subscription | undefined> {
    const r = await this.db.get<SubRow>('SELECT * FROM subscriptions WHERE tenant_id = ?', tenantId);
    return r ? toSub(r) : undefined;
  }

  /** Пробный период при первой установке (один на портал — проверяет TenantsRepo.claimTrial). */
  async startTrial(tenantId: string, trial: Plan, at = new Date()): Promise<Subscription> {
    const end = new Date(at.getTime() + trial.trialDays * 86_400_000).toISOString();
    await this.db.run(
      `INSERT INTO subscriptions (tenant_id, plan_code, status, period_start, period_end, updated_at)
       VALUES (?, ?, 'trialing', ?, ?, ?) ON CONFLICT (tenant_id) DO NOTHING`,
      tenantId,
      trial.code,
      at.toISOString(),
      end,
      now(),
    );
    const s = await this.get(tenantId);
    if (!s) throw new AppError('INTERNAL_ERROR', 'Подписка не создана');
    return s;
  }

  /** Полное обновление состояния подписки (жизненный цикл §10.2 ведёт биллинг). */
  async save(s: Subscription & { paymentMethodEncrypted?: string | null }): Promise<void> {
    await this.db.run(
      `INSERT INTO subscriptions (tenant_id, plan_code, status, period_start, period_end, cancel_at_period_end, pending_plan_code,
         payment_method_encrypted, payment_method_title, retry_count, next_retry_at, suspended_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_code = excluded.plan_code, status = excluded.status,
         period_start = excluded.period_start, period_end = excluded.period_end,
         cancel_at_period_end = excluded.cancel_at_period_end, pending_plan_code = excluded.pending_plan_code,
         payment_method_encrypted = COALESCE(excluded.payment_method_encrypted, subscriptions.payment_method_encrypted),
         payment_method_title = COALESCE(excluded.payment_method_title, subscriptions.payment_method_title),
         retry_count = excluded.retry_count, next_retry_at = excluded.next_retry_at,
         suspended_at = excluded.suspended_at, updated_at = excluded.updated_at`,
      s.tenantId,
      s.planCode,
      s.status,
      s.periodStart,
      s.periodEnd,
      s.cancelAtPeriodEnd ? 1 : 0,
      s.pendingPlanCode,
      s.paymentMethodEncrypted ?? null,
      s.paymentMethodTitle,
      s.retryCount,
      s.nextRetryAt,
      s.suspendedAt,
      now(),
    );
  }

  /** Удаление сохранённого способа оплаты (отвязка карты клиентом). */
  async clearPaymentMethod(tenantId: string): Promise<void> {
    await this.db.run(
      'UPDATE subscriptions SET payment_method_encrypted = NULL, payment_method_title = NULL, updated_at = ? WHERE tenant_id = ?',
      now(),
      tenantId,
    );
  }

  /** Зашифрованная ссылка на способ оплаты у провайдера (расшифровывает биллинг ключом арендатора). */
  async paymentMethodEncrypted(tenantId: string): Promise<string | null> {
    const r = await this.db.get<{ payment_method_encrypted: string | null }>(
      'SELECT payment_method_encrypted FROM subscriptions WHERE tenant_id = ?',
      tenantId,
    );
    return r?.payment_method_encrypted ?? null;
  }

  /** Подписки с концом периода/повтором до момента at (задачи worker). */
  async due(at: string, limit: number): Promise<Subscription[]> {
    const rows = await this.db.all<SubRow>(
      `SELECT * FROM subscriptions WHERE (period_end <= ? AND status IN ('trialing','active','past_due','canceled'))
         OR (next_retry_at IS NOT NULL AND next_retry_at <= ?) ORDER BY period_end LIMIT ?`,
      at,
      at,
      limit,
    );
    return rows.map(toSub);
  }
}

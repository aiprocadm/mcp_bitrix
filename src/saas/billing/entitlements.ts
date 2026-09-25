/**
 * Права арендатора по тарифу и подписке (SaaS-ТЗ §5.2 п.3, §9.3, §10.2).
 *
 * `EntitlementService.check` вызывается диспетчером перед каждым tools/call (после проверки токена, до handler):
 *  1. диагностика (`bitrix_connection_info`, `bitrix_server_version`, `operation_status`) — всегда;
 *  2. подписка допускает работу: trialing (до конца пробного периода), active, past_due (льготный период),
 *     canceled — до конца оплаченного периода; suspended и прочее → SUBSCRIPTION_INACTIVE;
 *  3. модуль инструмента входит в тариф (→ FEATURE_UNAVAILABLE / NOT_IN_PLAN) и включён администратором
 *     (`tenant_settings.modules`, пустой список = все модули тарифа; → MODULE_DISABLED);
 *  4. удаления — только если тариф их допускает (→ FEATURE_UNAVAILABLE / DESTRUCTIVE_NOT_IN_PLAN);
 *  5. месячная квота вызовов (и записей для инструментов записи) → QUOTA_EXCEEDED;
 *  6. дневной лимит пользователя (`tenant_settings.user_daily_call_limit`) → QUOTA_EXCEEDED / USER_DAILY_LIMIT.
 *
 * `planHiddenReason` — для регистрации инструментов на сессию (S09: инструмент вне тарифа скрыт в tools/list).
 * Снимок тарифа/подписки/настроек кэшируется на экземпляр (TTL) и сбрасывается событием `billing:entitlements`.
 */
import type { OperationKind } from '../../bitrix/method-registry.js';
import { isWriteOperation } from '../../tools/types.js';
import type { Coordination } from '../coordination.js';
import {
  planAllowsModule,
  type Plan,
  type PlansRepo,
  type Subscription,
  type SubscriptionsRepo,
} from '../repos/plans.js';
import type { TenantSettings, TenantSettingsRepo } from '../repos/tenants.js';
import {
  destructiveNotInPlan,
  moduleDisabled,
  notInPlan,
  quotaExceeded,
  subscriptionInactive,
  userDailyLimit,
} from './errors.js';
import type { UsageMeter } from './usage-meter.js';

/** Диагностика доступна при любой подписке и квоте (§9.3). */
export const DIAGNOSTIC_TOOLS: ReadonlySet<string> = new Set([
  'bitrix_connection_info',
  'bitrix_server_version',
  'operation_status',
]);

export const ENTITLEMENTS_CHANNEL = 'billing:entitlements';

export interface EntitlementTool {
  readonly name: string;
  readonly module: string;
  readonly operation: OperationKind;
}

export interface EntitlementRequest {
  readonly tenantId: string;
  /** tenant_users.id */
  readonly userId: string;
  readonly tool: EntitlementTool;
}

export interface TenantEntitlement {
  readonly tenantId: string;
  readonly plan: Plan | undefined;
  readonly subscription: Subscription | undefined;
  readonly settings: TenantSettings;
  /** Модули, инструменты которых видны арендатору (тариф ∩ включённые администратором; `system` всегда). */
  readonly modules: ReadonlySet<string>;
}

/** Допускает ли подписка работу инструментов в момент now (§10.2). */
export function subscriptionAllowsWork(sub: Subscription | undefined, now: Date): boolean {
  if (!sub) return false;
  const beforeEnd = now.getTime() < new Date(sub.periodEnd).getTime();
  switch (sub.status) {
    case 'active':
    case 'past_due':
      return true;
    case 'trialing':
    case 'canceled':
      return beforeEnd;
    default:
      return false;
  }
}

/** Видимые модули: модули тарифа, суженные списком администратора (пустой список — все модули тарифа). */
export function visibleModulesFor(
  plan: Pick<Plan, 'modules'> | undefined,
  settings: Pick<TenantSettings, 'modules'>,
  allModules: readonly string[],
): Set<string> {
  const out = new Set<string>(['system']);
  if (!plan) return out;
  for (const m of allModules) {
    if (!planAllowsModule(plan, m)) continue;
    if (m !== 'system' && settings.modules.length > 0 && !settings.modules.includes(m)) continue;
    out.add(m);
  }
  return out;
}

/** Причина скрыть инструмент в tools/list по тарифу/настройкам (undefined — показать). */
export function planHiddenReason(tool: EntitlementTool, ent: TenantEntitlement): string | undefined {
  if (DIAGNOSTIC_TOOLS.has(tool.name)) return undefined;
  if (!ent.plan || !planAllowsModule(ent.plan, tool.module)) return 'NOT_IN_PLAN';
  if (!ent.modules.has(tool.module)) return 'MODULE_DISABLED';
  if (tool.operation === 'delete' && !ent.plan.destructiveAllowed) return 'DESTRUCTIVE_NOT_IN_PLAN';
  return undefined;
}

function nextMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function nextDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export interface EntitlementServiceOptions {
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
  readonly settings: TenantSettingsRepo;
  readonly usage: UsageMeter;
  readonly cabinetUrl: string;
  /** Все модули сервиса (ALL_MODULES) — для вычисления видимых. */
  readonly allModules: readonly string[];
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
}

export class EntitlementService {
  private readonly cache = new Map<string, { ent: TenantEntitlement; expiresAt: number }>();
  private readonly now: () => Date;
  private readonly ttl: number;

  constructor(private readonly o: EntitlementServiceOptions) {
    this.now = o.now ?? (() => new Date());
    this.ttl = o.cacheTtlMs ?? 15_000;
  }

  async load(tenantId: string): Promise<TenantEntitlement> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.ent;
    const subscription = await this.o.subscriptions.get(tenantId);
    const plan = subscription ? await this.o.plans.get(subscription.planCode) : undefined;
    const settings = await this.o.settings.get(tenantId);
    const ent: TenantEntitlement = {
      tenantId,
      plan,
      subscription,
      settings,
      modules: visibleModulesFor(plan, settings, this.o.allModules),
    };
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(tenantId, { ent, expiresAt: Date.now() + this.ttl });
    return ent;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Сброс кэша на всех экземплярах по событию смены подписки/тарифа/настроек. */
  listen(coordination: Coordination): Promise<() => Promise<void>> {
    return coordination.subscribe(ENTITLEMENTS_CHANNEL, (tenantId) => this.invalidate(tenantId));
  }

  /** Видимые модули арендатора (регистрация инструментов по тарифу, S09). */
  async visibleModules(tenantId: string): Promise<ReadonlySet<string>> {
    return (await this.load(tenantId)).modules;
  }

  /** Проверка перед вызовом инструмента; бросает AppError. Возвращает снимок (лимиты — для учёта). */
  async check(req: EntitlementRequest): Promise<TenantEntitlement> {
    const ent = await this.load(req.tenantId);
    if (DIAGNOSTIC_TOOLS.has(req.tool.name)) return ent;
    const now = this.now();
    const url = this.o.cabinetUrl;
    if (!subscriptionAllowsWork(ent.subscription, now) || !ent.plan)
      throw subscriptionInactive(url, ent.subscription?.status ?? 'none');
    const plan = ent.plan;
    if (!planAllowsModule(plan, req.tool.module)) throw notInPlan(url, req.tool.module);
    if (!ent.modules.has(req.tool.module)) throw moduleDisabled(req.tool.module);
    if (req.tool.operation === 'delete' && !plan.destructiveAllowed) throw destructiveNotInPlan(url);

    const used = await this.o.usage.monthUsage(req.tenantId, req.userId);
    if (used.calls >= plan.limits.callsPerMonth)
      throw quotaExceeded(url, 'calls', plan.limits.callsPerMonth, nextMonthStart(now));
    if (isWriteOperation(req.tool.operation) && used.writes >= plan.limits.writesPerMonth)
      throw quotaExceeded(url, 'writes', plan.limits.writesPerMonth, nextMonthStart(now));
    const daily = ent.settings.userDailyCallLimit;
    if (daily !== null && daily >= 0) {
      const today = await this.o.usage.userDayCalls(req.tenantId, req.userId);
      if (today >= daily) throw userDailyLimit(daily, nextDayStart(now));
    }
    return ent;
  }
}

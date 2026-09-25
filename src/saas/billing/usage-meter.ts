/**
 * Учёт использования (SaaS-ТЗ §9.2, D11).
 *
 * «Вызов» — tools/call, дошедший хотя бы до одного запроса к Bitrix24; «запись» — операция MutationExecutor в статусе
 * succeeded/unknown. Что считать — решает вызывающий код (диспетчер), здесь — только атомарный учёт.
 *
 * Два набора счётчиков в `Coordination` (Redis в кластере):
 *  - «к сбросу» `usage:p:<арендатор>:<пользователь>:<день>:<инструмент>:<метрика>` — забираются `drain` и одной
 *    транзакцией прибавляются к PostgreSQL (`usage_counters` за месяц и день, `usage_tool_counters` за месяц).
 *    Забранное из Redis больше не считается повторно — двойного счёта нет; при падении процесса между сбросами
 *    теряется не больше интервала сброса (S16);
 *  - «для квот» `usage:q:<арендатор>:<месяц>:<метрика>` и `usage:d:<арендатор>:<пользователь>:<день>` — не
 *    сбрасываются, живут до конца периода; при первом обращении в периоде (или после потери Redis/процесса)
 *    засеваются из PostgreSQL под блокировкой, чтобы квота не обнулялась перезапуском.
 */
import type { AppLogger } from '../../logging/logger.js';
import { toNumber, type SqlDb } from '../../storage/sql.js';
import type { Coordination } from '../coordination.js';
import type { PlanLimits } from '../repos/plans.js';
import { usagePeriods } from './money.js';
import { safeNotify, type BillingNotifier, type UsageMetric } from './notifier.js';

const PENDING = 'usage:p:';
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL_RE = /^[a-z0-9_]{1,64}$/;
const MONTH_TTL_MS = 40 * 86_400_000;
const DAY_TTL_MS = 2 * 86_400_000;
const PENDING_TTL_MS = 7 * 86_400_000;

export interface UsageEvent {
  readonly tenantId: string;
  /** tenant_users.id */
  readonly userId: string;
  readonly tool: string;
  /** Лимиты тарифа — для уведомлений 80%/100% (без них учёт идёт, уведомлений нет). */
  readonly limits?: PlanLimits;
}

export interface UsageTotals {
  readonly calls: number;
  readonly writes: number;
}

export interface UsageReport extends UsageTotals {
  readonly period: string;
  readonly byUser: readonly (UsageTotals & { userId: string })[];
  readonly byTool: readonly (UsageTotals & { tool: string })[];
  readonly byDay: readonly (UsageTotals & { day: string })[];
  /** Честная оговорка для кабинета (§9.2). */
  readonly note: string;
}

export interface UsageMeterOptions {
  readonly db: SqlDb;
  readonly coordination: Coordination;
  readonly notifier: BillingNotifier;
  readonly logger: AppLogger;
  readonly now?: () => Date;
  readonly warnPercent?: number;
}

function assertId(v: string, what: string): void {
  if (!ID_RE.test(v)) throw new Error(`Недопустимый идентификатор ${what} для учёта`);
}

export class UsageMeter {
  /** Локальная память о засеве (сверяется с маркером в Coordination не реже раза в 5 минут). */
  private readonly seeded = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly warnPercent: number;

  constructor(private readonly o: UsageMeterOptions) {
    this.now = o.now ?? (() => new Date());
    this.warnPercent = o.warnPercent ?? 80;
  }

  /** Вызов инструмента, дошедший до Bitrix24. */
  recordCall(e: UsageEvent): Promise<void> {
    return this.record(e, 'calls');
  }

  /** Выполненная запись (операция succeeded или unknown). */
  recordWrite(e: UsageEvent): Promise<void> {
    return this.record(e, 'writes');
  }

  private async record(e: UsageEvent, metric: UsageMetric): Promise<void> {
    assertId(e.tenantId, 'арендатора');
    assertId(e.userId, 'пользователя');
    const tool = TOOL_RE.test(e.tool) ? e.tool : 'other';
    const { month, day } = usagePeriods(this.now());
    await this.ensureSeeded(e.tenantId, e.userId, month, day);
    const c = this.o.coordination;
    await c.incr(`${PENDING}${e.tenantId}:${e.userId}:${day}:${tool}:${metric}`, 1, PENDING_TTL_MS);
    if (metric === 'calls') await c.incr(`usage:d:${e.tenantId}:${e.userId}:${day}`, 1, DAY_TTL_MS);
    const used = await c.incr(`usage:q:${e.tenantId}:${month}:${metric}`, 1, MONTH_TTL_MS);
    const limit = e.limits ? (metric === 'calls' ? e.limits.callsPerMonth : e.limits.writesPerMonth) : 0;
    if (limit > 0) {
      for (const percent of [this.warnPercent, 100]) {
        const threshold = Math.ceil((limit * percent) / 100);
        // Счётчик атомарный: ровно один вызов переходит порог — уведомление одно на период.
        if (used === threshold) {
          await safeNotify(this.o.logger, () =>
            this.o.notifier.quotaThreshold({
              tenantId: e.tenantId,
              metric,
              period: month,
              used,
              limit,
              percent,
            }),
          );
        }
      }
    }
  }

  /** Использование арендатора за текущий месяц (для проверки квоты): живые счётчики. */
  async monthUsage(tenantId: string, userId?: string): Promise<UsageTotals> {
    assertId(tenantId, 'арендатора');
    const { month, day } = usagePeriods(this.now());
    await this.ensureSeeded(tenantId, userId, month, day);
    const c = this.o.coordination;
    return {
      calls: await c.get(`usage:q:${tenantId}:${month}:calls`),
      writes: await c.get(`usage:q:${tenantId}:${month}:writes`),
    };
  }

  /** Вызовы пользователя за текущие сутки UTC (лимит администратора). */
  async userDayCalls(tenantId: string, userId: string): Promise<number> {
    assertId(tenantId, 'арендатора');
    assertId(userId, 'пользователя');
    const { month, day } = usagePeriods(this.now());
    await this.ensureSeeded(tenantId, userId, month, day);
    return this.o.coordination.get(`usage:d:${tenantId}:${userId}:${day}`);
  }

  /**
   * Засев квотных счётчиков из PostgreSQL один раз на период. Маркер `usage:qs`/`usage:ds` живёт столько же,
   * сколько счётчик: если Redis/процесс потерял счётчик, потерян и маркер — засев повторится.
   */
  private async ensureSeeded(
    tenantId: string,
    userId: string | undefined,
    month: string,
    day: string,
  ): Promise<void> {
    const c = this.o.coordination;
    const monthMarker = `usage:qs:${tenantId}:${month}`;
    if (!this.isSeeded(monthMarker)) {
      await c.withLock(`usage:seed:${tenantId}:${month}`, { ttlMs: 10_000, waitMs: 10_000 }, async () => {
        if ((await c.get(monthMarker)) > 0) return;
        const r = await this.o.db.get<{ calls: unknown; writes: unknown }>(
          'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(writes), 0) AS writes FROM usage_counters WHERE tenant_id = ? AND period = ?',
          tenantId,
          month,
        );
        const calls = toNumber(r?.calls);
        const writes = toNumber(r?.writes);
        if (calls > 0) await c.incr(`usage:q:${tenantId}:${month}:calls`, calls, MONTH_TTL_MS);
        if (writes > 0) await c.incr(`usage:q:${tenantId}:${month}:writes`, writes, MONTH_TTL_MS);
        await c.incr(monthMarker, 1, MONTH_TTL_MS);
      });
      this.remember(monthMarker);
    }
    if (!userId) return;
    const dayMarker = `usage:ds:${tenantId}:${userId}:${day}`;
    if (this.isSeeded(dayMarker)) return;
    await c.withLock(
      `usage:seed:${tenantId}:${userId}:${day}`,
      { ttlMs: 10_000, waitMs: 10_000 },
      async () => {
        if ((await c.get(dayMarker)) > 0) return;
        const r = await this.o.db.get<{ calls: unknown }>(
          'SELECT calls FROM usage_counters WHERE tenant_id = ? AND user_id = ? AND period = ?',
          tenantId,
          userId,
          day,
        );
        const calls = toNumber(r?.calls);
        if (calls > 0) await c.incr(`usage:d:${tenantId}:${userId}:${day}`, calls, DAY_TTL_MS);
        await c.incr(dayMarker, 1, DAY_TTL_MS);
      },
    );
    this.remember(dayMarker);
  }

  private isSeeded(marker: string): boolean {
    return (this.seeded.get(marker) ?? 0) > Date.now();
  }

  private remember(marker: string): void {
    if (this.seeded.size > 50_000) this.seeded.clear();
    this.seeded.set(marker, Date.now() + 300_000);
  }

  /**
   * Сброс накопленного в PostgreSQL: `drain` забирает счётчики атомарно, затем одна транзакция прибавляет их
   * (UPSERT со сложением). Ошибка БД — счётчики возвращаются в Coordination (повтор на следующем сбросе).
   */
  flush(): Promise<number> {
    const run = this.flushing.then(() => this.flushOnce());
    this.flushing = run.catch(() => undefined);
    return run;
  }

  private async flushOnce(): Promise<number> {
    const drained = await this.o.coordination.drain(PENDING);
    if (drained.size === 0) return 0;
    interface Acc {
      calls: number;
      writes: number;
    }
    const byUserPeriod = new Map<string, Acc>();
    const byTool = new Map<string, Acc>();
    const add = (m: Map<string, Acc>, k: string, metric: UsageMetric, v: number) => {
      const a = m.get(k) ?? { calls: 0, writes: 0 };
      a[metric] += v;
      m.set(k, a);
    };
    for (const [key, value] of drained) {
      const [tenantId, userId, day, tool, metric] = key.slice(PENDING.length).split(':');
      if (!tenantId || !userId || !day || !tool || (metric !== 'calls' && metric !== 'writes')) continue;
      const month = day.slice(0, 7);
      add(byUserPeriod, `${tenantId}:${userId}:${month}`, metric, value);
      add(byUserPeriod, `${tenantId}:${userId}:${day}`, metric, value);
      add(byTool, `${tenantId}:${userId}:${month}:${tool}`, metric, value);
    }
    const at = this.now().toISOString();
    try {
      await this.o.db.transaction(async (tx) => {
        for (const [k, a] of byUserPeriod) {
          const [tenantId, userId, period] = k.split(':');
          await tx.run(
            `INSERT INTO usage_counters (tenant_id, user_id, period, calls, writes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, user_id, period) DO UPDATE SET calls = usage_counters.calls + excluded.calls,
               writes = usage_counters.writes + excluded.writes, updated_at = excluded.updated_at`,
            tenantId ?? '',
            userId ?? '',
            period ?? '',
            a.calls,
            a.writes,
            at,
          );
        }
        for (const [k, a] of byTool) {
          const [tenantId, userId, period, tool] = k.split(':');
          await tx.run(
            `INSERT INTO usage_tool_counters (tenant_id, user_id, period, tool, calls, writes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, user_id, period, tool) DO UPDATE SET calls = usage_tool_counters.calls + excluded.calls,
               writes = usage_tool_counters.writes + excluded.writes, updated_at = excluded.updated_at`,
            tenantId ?? '',
            userId ?? '',
            period ?? '',
            tool ?? '',
            a.calls,
            a.writes,
            at,
          );
        }
      });
    } catch (e) {
      for (const [key, value] of drained) await this.o.coordination.incr(key, value, PENDING_TTL_MS);
      this.o.logger.error({ reason: e instanceof Error ? e.name : typeof e }, 'usage flush failed');
      throw e;
    }
    return drained.size;
  }

  /** Периодический сброс (§9.2: раз в минуту) — в web и worker; `stop` делает последний сброс при остановке. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** Отчёт кабинета: использование арендатора за месяц по пользователям, инструментам и дням (сохранённое). */
  async report(tenantId: string, month: string): Promise<UsageReport> {
    assertId(tenantId, 'арендатора');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Период учёта — YYYY-MM');
    const users = await this.o.db.all<{ user_id: string; calls: unknown; writes: unknown }>(
      'SELECT user_id, calls, writes FROM usage_counters WHERE tenant_id = ? AND period = ? ORDER BY user_id',
      tenantId,
      month,
    );
    const tools = await this.o.db.all<{ tool: string; calls: unknown; writes: unknown }>(
      `SELECT tool, SUM(calls) AS calls, SUM(writes) AS writes FROM usage_tool_counters
       WHERE tenant_id = ? AND period = ? GROUP BY tool ORDER BY tool`,
      tenantId,
      month,
    );
    const days = await this.o.db.all<{ period: string; calls: unknown; writes: unknown }>(
      `SELECT period, SUM(calls) AS calls, SUM(writes) AS writes FROM usage_counters
       WHERE tenant_id = ? AND period LIKE ? AND LENGTH(period) = 10 GROUP BY period ORDER BY period`,
      tenantId,
      `${month}-%`,
    );
    const byUser = users.map((r) => ({
      userId: r.user_id,
      calls: toNumber(r.calls),
      writes: toNumber(r.writes),
    }));
    return {
      period: month,
      calls: byUser.reduce((s, u) => s + u.calls, 0),
      writes: byUser.reduce((s, u) => s + u.writes, 0),
      byUser,
      byTool: tools.map((r) => ({ tool: r.tool, calls: toNumber(r.calls), writes: toNumber(r.writes) })),
      byDay: days.map((r) => ({ day: r.period, calls: toNumber(r.calls), writes: toNumber(r.writes) })),
      note: 'Данные с задержкой до 1 минуты',
    };
  }

  /** Панель владельца: использование по арендаторам за месяц (только числа, без данных порталов). */
  async ownerReport(month: string): Promise<(UsageTotals & { tenantId: string })[]> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Период учёта — YYYY-MM');
    const rows = await this.o.db.all<{ tenant_id: string; calls: unknown; writes: unknown }>(
      `SELECT tenant_id, SUM(calls) AS calls, SUM(writes) AS writes FROM usage_counters
       WHERE period = ? GROUP BY tenant_id ORDER BY tenant_id`,
      month,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, calls: toNumber(r.calls), writes: toNumber(r.writes) }));
  }
}

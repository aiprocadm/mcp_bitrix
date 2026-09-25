/**
 * Процесс worker (SaaS-ТЗ §5.1, §13; этап S8): один активный worker в кластере по аренде лидера в Redis,
 * расписание задач, изоляция ошибок, метрики, корректная остановка по SIGTERM.
 *
 * Лидерство — аренда с продлением (`LeaseStore`: SET NX PX + продление/снятие своим токеном). Продление идёт каждые
 * `renewIntervalMs` (< `leaseTtlMs`). Потеря аренды (продление вернуло false) или невозможность продлить её дольше
 * срока аренды (Redis недоступен) → немедленный отказ от лидерства: всем задачам уходит abort, новые не запускаются.
 * Между истечением аренды у старого лидера и взятием её новым возможно короткое пересечение (если задача не
 * реагирует на signal): задачи обязаны быть идемпотентными (продления — по идемпотентному ключу провайдера, сброс
 * счётчиков — GETDEL). Это стандартное ограничение аренды без fencing-токенов.
 */
import type { AppLogger } from '../../logging/logger.js';
import type { SaasMetrics } from './metrics.js';
import type { LeaseStore } from './redis-coordination.js';

export interface WorkerTask {
  /** Имя задачи (латиница, для метрик и журнала). */
  readonly name: string;
  /** Пауза между окончанием одного запуска и началом следующего. */
  readonly intervalMs: number;
  /** Задержка первого запуска после получения лидерства (по умолчанию 0). */
  readonly initialDelayMs?: number;
  /** Предел длительности запуска: по истечении — abort (по умолчанию intervalMs, не меньше 1 мин). */
  readonly timeoutMs?: number;
  run(signal: AbortSignal): Promise<void>;
}

export interface WorkerSettings {
  /** Ключ аренды лидера в Redis (в пространстве имён координации). */
  readonly leaseKey: string;
  readonly leaseTtlMs: number;
  readonly renewIntervalMs: number;
  /** Сколько ждать завершения задач при остановке, прежде чем снять аренду. */
  readonly shutdownGraceMs: number;
}

export const DEFAULT_WORKER_SETTINGS: WorkerSettings = {
  leaseKey: 'worker:leader',
  leaseTtlMs: 15_000,
  renewIntervalMs: 5_000,
  shutdownGraceMs: 25_000,
};

export interface WorkerRunnerOptions {
  readonly lease: LeaseStore;
  readonly tasks: readonly WorkerTask[];
  readonly settings?: Partial<WorkerSettings>;
  readonly logger?: Pick<AppLogger, 'info' | 'warn' | 'error'>;
  readonly metrics?: Pick<SaasMetrics, 'workerRuns' | 'workerDuration' | 'workerLeader' | 'redisErrors'>;
  /** Идентификатор экземпляра для журнала (hostname/pod). */
  readonly instanceId?: string;
}

interface TaskState {
  task: WorkerTask;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: Promise<void> | undefined;
  runs: number;
  failures: number;
  lastError: string | undefined;
}

const TASK_NAME_RE = /^[a-z][a-z0-9_.-]{0,62}$/;

export class WorkerRunner {
  private readonly s: WorkerSettings;
  private readonly states: TaskState[];
  private token: string | null = null;
  private lastRenewAt = 0;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private leaderAbort: AbortController | undefined;
  private stopped = true;
  private stopping: Promise<void> | undefined;
  private tickInFlight: Promise<void> | undefined;

  constructor(private readonly o: WorkerRunnerOptions) {
    this.s = { ...DEFAULT_WORKER_SETTINGS, ...o.settings };
    if (this.s.renewIntervalMs >= this.s.leaseTtlMs)
      throw new Error('renewIntervalMs должен быть меньше leaseTtlMs');
    const names = new Set<string>();
    for (const t of o.tasks) {
      if (!TASK_NAME_RE.test(t.name)) throw new Error(`Недопустимое имя задачи worker: ${t.name}`);
      if (names.has(t.name)) throw new Error(`Задача worker ${t.name} указана дважды`);
      if (!(t.intervalMs >= 1)) throw new Error(`Интервал задачи ${t.name} должен быть ≥ 1 мс`);
      names.add(t.name);
    }
    this.states = o.tasks.map((task) => ({
      task,
      timer: undefined,
      running: undefined,
      runs: 0,
      failures: 0,
      lastError: undefined,
    }));
  }

  isLeader(): boolean {
    return this.token !== null;
  }

  /** Сводка по задачам (для /readyz worker и журнала). */
  status(): { leader: boolean; tasks: { name: string; runs: number; failures: number; running: boolean }[] } {
    return {
      leader: this.isLeader(),
      tasks: this.states.map((st) => ({
        name: st.task.name,
        runs: st.runs,
        failures: st.failures,
        running: st.running !== undefined,
      })),
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = undefined;
    this.scheduleLeaseTick(0);
  }

  private scheduleLeaseTick(ms: number): void {
    if (this.stopped) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      this.tickInFlight = this.leaseTick().finally(() => {
        this.tickInFlight = undefined;
        this.scheduleLeaseTick(this.s.renewIntervalMs);
      });
    }, ms);
  }

  private async leaseTick(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.token === null) {
        const token = await this.o.lease.tryAcquire(this.s.leaseKey, this.s.leaseTtlMs);
        if (token && !this.stopped) {
          this.token = token;
          this.lastRenewAt = Date.now();
          this.becomeLeader();
        } else if (token) {
          await this.o.lease.release(this.s.leaseKey, token);
        }
        return;
      }
      const ok = await this.o.lease.renew(this.s.leaseKey, this.token, this.s.leaseTtlMs);
      if (ok) {
        this.lastRenewAt = Date.now();
      } else {
        this.o.logger?.warn({ instance: this.o.instanceId }, 'worker: аренда лидера потеряна');
        this.stepDown();
      }
    } catch (e) {
      this.o.metrics?.redisErrors.inc({ where: 'worker_lease' });
      this.o.logger?.warn({ instance: this.o.instanceId, err: errorText(e) }, 'worker: ошибка аренды лидера');
      // Не удалось продлить: до истечения своего срока аренда ещё наша; дальше — считаем её потерянной.
      if (
        this.token !== null &&
        Date.now() - this.lastRenewAt >= this.s.leaseTtlMs - this.s.renewIntervalMs
      ) {
        this.stepDown();
      }
    }
  }

  private becomeLeader(): void {
    this.leaderAbort = new AbortController();
    this.o.metrics?.workerLeader.set({}, 1);
    this.o.logger?.info({ instance: this.o.instanceId }, 'worker: получено лидерство');
    for (const st of this.states) this.scheduleTask(st, st.task.initialDelayMs ?? 0);
  }

  private stepDown(): void {
    this.token = null;
    this.o.metrics?.workerLeader.set({}, 0);
    this.leaderAbort?.abort(new Error('Лидерство worker утрачено'));
    this.leaderAbort = undefined;
    for (const st of this.states) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = undefined;
    }
  }

  private scheduleTask(st: TaskState, delayMs: number): void {
    const leader = this.leaderAbort;
    if (!leader || leader.signal.aborted) return;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (this.leaderAbort !== leader || leader.signal.aborted) return;
      st.running = this.runTask(st, leader.signal).finally(() => {
        st.running = undefined;
        if (this.leaderAbort === leader && !leader.signal.aborted) this.scheduleTask(st, st.task.intervalMs);
      });
    }, delayMs);
  }

  /** Один запуск: ошибка задачи не трогает остальные задачи и сам worker. */
  private async runTask(st: TaskState, leaderSignal: AbortSignal): Promise<void> {
    const name = st.task.name;
    const timeoutMs = st.task.timeoutMs ?? Math.max(st.task.intervalMs, 60_000);
    const signal = AbortSignal.any([leaderSignal, AbortSignal.timeout(timeoutMs)]);
    const done = this.o.metrics?.workerDuration.startTimer({ task: name });
    try {
      await st.task.run(signal);
      st.runs += 1;
      this.o.metrics?.workerRuns.inc({ task: name, result: signal.aborted ? 'aborted' : 'ok' });
    } catch (e) {
      st.runs += 1;
      st.failures += 1;
      st.lastError = errorText(e);
      const result = signal.aborted ? 'aborted' : 'error';
      this.o.metrics?.workerRuns.inc({ task: name, result });
      this.o.logger?.error({ task: name, err: st.lastError }, 'worker: задача завершилась ошибкой');
    } finally {
      done?.();
    }
  }

  /** Остановка: новые запуски прекращаются, задачам — abort, ожидание до shutdownGraceMs, снятие аренды. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    await this.tickInFlight;
    const token = this.token;
    const running = this.states.map((st) => st.running).filter((p): p is Promise<void> => p !== undefined);
    this.stepDown();
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(running),
      new Promise<void>((r) => (grace = setTimeout(r, this.s.shutdownGraceMs))),
    ]);
    clearTimeout(grace);
    if (token) {
      try {
        await this.o.lease.release(this.s.leaseKey, token);
      } catch {
        // Redis недоступен: аренда истечёт сама через leaseTtlMs
      }
    }
    this.o.logger?.info({ instance: this.o.instanceId }, 'worker: остановлен');
  }

  /**
   * SIGTERM/SIGINT → stop(); по завершении — `onStopped` (например, закрыть Redis/PG и выставить exitCode).
   * Возвращает функцию снятия обработчиков.
   */
  bindSignals(
    onStopped: () => void | Promise<void>,
    proc: Pick<NodeJS.Process, 'once' | 'off'> = process,
    signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
  ): () => void {
    const handler = () => {
      void this.stop().then(onStopped);
    };
    for (const s of signals) proc.once(s, handler);
    return () => {
      for (const s of signals) proc.off(s, handler);
    };
  }
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : 'неизвестная ошибка';
  return text.slice(0, 300);
}

/** Аренда в памяти процесса (single/тесты без Redis): семантика как у Redis-реализации. */
export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, { token: string; expiresAt: number }>();
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): { token: string; expiresAt: number } | undefined {
    const l = this.leases.get(key);
    if (l && l.expiresAt <= this.now()) {
      this.leases.delete(key);
      return undefined;
    }
    return l;
  }

  tryAcquire(key: string, ttlMs: number): Promise<string | null> {
    if (this.live(key)) return Promise.resolve(null);
    this.seq += 1;
    const token = `mem-${String(this.seq)}`;
    this.leases.set(key, { token, expiresAt: this.now() + ttlMs });
    return Promise.resolve(token);
  }

  renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const l = this.live(key);
    if (l?.token !== token) return Promise.resolve(false);
    l.expiresAt = this.now() + ttlMs;
    return Promise.resolve(true);
  }

  release(key: string, token: string): Promise<void> {
    if (this.live(key)?.token === token) this.leases.delete(key);
    return Promise.resolve();
  }
}

/**
 * Общий лимитер портала для кластера (SaaS-ТЗ §2 «лимитер общий для всех экземпляров (Redis)», §5.2 п.4, S15).
 * Реализует `PortalLimiter` (src/bitrix/rate-limiter.ts) — BitrixClient принимает его вместо процессного RateLimiter
 * (`TenantSpec.limiter` в src/app/container.ts).
 *
 * Два уровня:
 *  - частота — суммарно по ВСЕМ экземплярам: слот в скользящем окне Redis (`acquireSlot`, ключ `rl:portal:<portalKey>`);
 *  - параллельность и очередь — на экземпляр (как у RateLimiter): очередь FIFO, `maxQueueSize` → BITRIX_RATE_LIMITED,
 *    отмена по signal → BITRIX_TIMEOUT (те же коды, что у RateLimiter, — контракт клиента не меняется).
 * Redis недоступен → запасной ЛОКАЛЬНЫЙ лимит `fallbackRequestsPerSecond` на экземпляр (по умолчанию rps/2 при двух
 * web): сервис не останавливается, превышение суммарного лимита в аварии ограничено; событие — в метрике и журнале.
 */
import type { PortalLimiter } from '../../bitrix/rate-limiter.js';
import { AppError } from '../../errors/app-error.js';
import { portalAlias, type SaasMetrics } from './metrics.js';

/** Хранилище окна (RedisCoordination). */
export interface SlotStore {
  acquireSlot(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterMs: number }>;
}

export interface ClusterPortalLimiterOptions {
  readonly store: SlotStore;
  /** Ключ портала (id арендатора); в метках — только псевдоним. */
  readonly portalKey: string;
  /** Запросов за окно суммарно по кластеру (Bitrix24: по умолчанию 2/с на портал). */
  readonly requestsPerSecond: number;
  /** Окно, мс (1000 — «в секунду»; меньше — только в тестах). */
  readonly windowMs?: number;
  readonly maxConcurrency: number;
  readonly maxQueueSize: number;
  readonly fallbackRequestsPerSecond?: number;
  readonly metrics?: Pick<SaasMetrics, 'limiterQueue' | 'limiterWait' | 'limiterRejected' | 'redisErrors'>;
  readonly onStoreError?: (message: string) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  signal: AbortSignal | undefined;
  enqueuedAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ClusterPortalLimiter implements PortalLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private pumping = false;
  private readonly key: string;
  private readonly alias: string;
  private readonly windowMs: number;
  private localStarts: number[] = [];

  constructor(private readonly o: ClusterPortalLimiterOptions) {
    if (!(o.requestsPerSecond >= 1)) throw new Error('requestsPerSecond должен быть ≥ 1');
    this.key = `rl:portal:${o.portalKey}`;
    this.alias = portalAlias(o.portalKey);
    this.windowMs = o.windowMs ?? 1000;
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  private reportQueue(): void {
    this.o.metrics?.limiterQueue.set({ portal: this.alias }, this.queue.length);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AppError('BITRIX_TIMEOUT', 'Запрос отменён до постановки в очередь');
    if (this.queue.length >= this.o.maxQueueSize) {
      this.o.metrics?.limiterRejected.inc({ portal: this.alias, reason: 'queue_full' });
      throw new AppError('BITRIX_RATE_LIMITED', 'Очередь запросов к Bitrix24 переполнена', {
        nextAction: 'Подождите и повторите; снизьте частоту вызовов',
        retryable: true,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, enqueuedAt: performance.now() };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        this.reportQueue();
        this.o.metrics?.limiterRejected.inc({ portal: this.alias, reason: 'aborted' });
        reject(new AppError('BITRIX_TIMEOUT', 'Ожидание в очереди прервано по таймауту'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.resolve = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.queue.push(waiter);
      this.reportQueue();
      void this.pump();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      void this.pump();
    };
  }

  /** Один цикл раздачи на экземпляр: голова очереди ждёт слот кластера, остальные — за ней (FIFO). */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.active < this.o.maxConcurrency) {
        const head = this.queue[0];
        if (!head) break;
        if (head.signal?.aborted) {
          this.queue.shift();
          continue;
        }
        const wait = await this.takeSlot();
        if (wait > 0) {
          await sleep(wait);
          continue; // голова могла быть отменена за время ожидания
        }
        if (this.queue[0] !== head) {
          // голова ушла по отмене, пока ждали ответа Redis: слот отдаём следующему
          const next = this.queue.shift();
          if (!next) break;
          this.grant(next);
          continue;
        }
        this.queue.shift();
        this.grant(head);
      }
    } finally {
      this.pumping = false;
      this.reportQueue();
    }
    // гонка: запрос мог прийти, пока цикл завершался
    if (this.queue.length > 0 && this.active < this.o.maxConcurrency) void this.pump();
  }

  private grant(w: Waiter): void {
    this.active += 1;
    this.o.metrics?.limiterWait.observe({ portal: this.alias }, (performance.now() - w.enqueuedAt) / 1000);
    w.resolve();
  }

  /** 0 — слот получен; иначе сколько ждать, мс. */
  private async takeSlot(): Promise<number> {
    try {
      const r = await this.o.store.acquireSlot(this.key, this.o.requestsPerSecond, this.windowMs);
      if (r.ok) return 0;
      // небольшой джиттер, чтобы экземпляры не приходили за слотом одновременно
      return Math.max(1, r.retryAfterMs) + Math.floor(Math.random() * 5);
    } catch {
      this.o.metrics?.redisErrors.inc({ where: 'portal_limiter' });
      this.o.onStoreError?.('Лимитер портала: Redis недоступен, действует локальный запасной лимит');
      return this.localSlot();
    }
  }

  private localSlot(): number {
    const limit = this.o.fallbackRequestsPerSecond ?? Math.max(1, Math.floor(this.o.requestsPerSecond / 2));
    const t = performance.now();
    this.localStarts = this.localStarts.filter((x) => t - x < this.windowMs);
    if (this.localStarts.length < limit) {
      this.localStarts.push(t);
      return 0;
    }
    return Math.max(1, Math.ceil(this.windowMs - (t - (this.localStarts[0] ?? t))));
  }
}

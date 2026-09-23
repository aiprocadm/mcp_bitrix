/**
 * Лимитер исходящих запросов (ТЗ §8.6): N запросов/с на портал, concurrency, очередь.
 * Счётчик общий для raw и именованных инструментов — один экземпляр на процесс.
 */
import { AppError } from '../errors/app-error.js';

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  signal: AbortSignal | undefined;
}

export interface RateLimiterOptions {
  requestsPerSecond: number;
  maxConcurrency: number;
  maxQueueSize: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
}

export class RateLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private lastStartTimes: number[] = [];
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: RateLimiterOptions) {
    this.intervalMs = 1000;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.setTimeoutFn ?? setTimeout;
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AppError('BITRIX_TIMEOUT', 'Запрос отменён до постановки в очередь');
    if (this.queue.length >= this.opts.maxQueueSize) {
      throw new AppError('BITRIX_RATE_LIMITED', 'Очередь запросов к Bitrix24 переполнена', {
        nextAction: 'Подождите и повторите; снизьте частоту вызовов',
        retryable: true,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new AppError('BITRIX_TIMEOUT', 'Ожидание в очереди прервано по таймауту'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.resolve = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.queue.push(waiter);
      this.pump();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  private pump(): void {
    if (this.timer) return;
    while (this.queue.length > 0 && this.active < this.opts.maxConcurrency) {
      const wait = this.msUntilSlot();
      if (wait > 0) {
        this.timer = this.schedule(() => {
          this.timer = undefined;
          this.pump();
        }, wait);
        return;
      }
      const w = this.queue.shift();
      if (!w) return;
      if (w.signal?.aborted) continue;
      this.active += 1;
      this.lastStartTimes.push(this.now());
      w.resolve();
    }
  }

  private msUntilSlot(): number {
    const t = this.now();
    this.lastStartTimes = this.lastStartTimes.filter((x) => t - x < this.intervalMs);
    if (this.lastStartTimes.length < this.opts.requestsPerSecond) return 0;
    const oldest = this.lastStartTimes[0] ?? t;
    return Math.max(1, this.intervalMs - (t - oldest));
  }
}

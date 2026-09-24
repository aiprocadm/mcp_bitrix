/**
 * Лимит входящих вызовов на оператора (ТЗ §8.6: read — 60/мин; write-подготовки ограничивает
 * MutationExecutor, 10/мин). Скользящее окно в памяти одного процесса: production — один экземпляр (§17.6).
 */
import { AppError } from '../errors/app-error.js';

export class InboundLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Учитывает вызов; при превышении бросает RATE_LIMITED, не учитывая вызов. */
  take(key: string): void {
    const t = this.now();
    const since = t - 60_000;
    let stamps = this.windows.get(key);
    if (!stamps) {
      stamps = [];
      this.windows.set(key, stamps);
    }
    while (stamps.length > 0 && (stamps[0] ?? 0) <= since) stamps.shift();
    if (stamps.length >= this.perMinute) {
      const retryAfterMs = Math.max(0, (stamps[0] ?? t) + 60_000 - t);
      throw new AppError(
        'RATE_LIMITED',
        `Превышен лимит входящих запросов: ${String(this.perMinute)} в минуту на оператора`,
        {
          nextAction: `Повторите через ${String(Math.ceil(retryAfterMs / 1000))} с`,
        },
      );
    }
    stamps.push(t);
    if (this.windows.size > 10_000) this.prune(since);
  }

  private prune(since: number): void {
    for (const [k, v] of this.windows) {
      if (v.length === 0 || (v[v.length - 1] ?? 0) <= since) this.windows.delete(k);
    }
  }
}

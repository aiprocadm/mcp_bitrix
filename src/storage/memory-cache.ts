/**
 * Кэш метаданных портала в памяти процесса (поля CRM, scope, method.get): TTL + ограничение размера (LRU).
 * Это только кэш — промах повторяет запрос к Bitrix24, поэтому в SaaS он не обязан быть общим для экземпляров.
 * Ключи обязаны содержать portalKey: метаданные разных порталов не пересекаются.
 */
export class MemoryTtlCache {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: недавно прочитанное — в конец.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value as T;
  }

  set(key: string, value: unknown): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  deletePrefix(prefix: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

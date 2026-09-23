/**
 * Политика выдачи (ТЗ §8.4, T47): применяется ко ВСЕМ ответам — именованным инструментам и raw.
 * Удаляет поля по denylist-паттернам; профили по роли/модулю ограничивают allowlist.
 */
import type { OutputPolicy, Role } from '../config/policy.js';

export class OutputPolicyEngine {
  private readonly denied: RegExp[];

  constructor(private readonly policy: OutputPolicy) {
    // Регистр учитывается намеренно: поля Bitrix24 — ВЕРХНИЙ_РЕГИСТР (PERSONAL_PHONE),
    // поля нашего конверта — camelCase (authMode). Шаблон ^AUTH не должен вырезать authMode.
    this.denied = policy.deniedFieldPatterns.map((p) => new RegExp(p));
  }

  isDeniedKey(key: string): boolean {
    return this.denied.some((re) => re.test(key));
  }

  /** Разрешённые поля для роли/модуля/сущности; undefined = ограничений allowlist нет. */
  allowedFields(role: Role, module: string, entity: string): ReadonlySet<string> | undefined {
    const profile =
      this.policy.profiles[
        role === 'administrator' ? 'administrator' : role === 'operator' ? 'operator' : 'restricted'
      ] ?? this.policy.profiles['restricted'];
    const list = profile?.[module]?.[entity];
    return list ? new Set(list) : undefined;
  }

  /** Рекурсивно удаляет запрещённые ключи. Возвращает новую структуру. */
  apply<T>(value: T, allow?: ReadonlySet<string>, depth = 0): T {
    if (depth > 32) return value;
    if (Array.isArray(value)) return value.map((v: unknown) => this.apply(v, allow, depth + 1)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (this.isDeniedKey(k)) continue;
        if (allow && depth === 0 && !allow.has(k)) continue;
        out[k] = this.apply(v, undefined, depth + 1);
      }
      return out as T;
    }
    return value;
  }
}

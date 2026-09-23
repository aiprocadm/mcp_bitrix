/**
 * Редактирование чувствительных данных (ТЗ §8.1, T19).
 *
 * Применяется ко ВСЕМ строкам, которые могут попасть в лог, в tool result или в
 * текст исключения: URL вебхука, токены, e-mail, телефоны, Authorization.
 * Список известных секретов пополняется при загрузке конфигурации
 * (`registerSecret`), чтобы даже случайно склеенный текст не пронёс секрет наружу.
 */

const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) knownSecrets.add(value);
}

/** Только для тестов. */
export function _resetSecretsForTests(): void {
  knownSecrets.clear();
}

const PATTERNS: readonly { re: RegExp; sub: string }[] = [
  // https://portal/rest/123/abcdef.../ — секрет вебхука в пути
  { re: /(\/rest\/\d+\/)[A-Za-z0-9_-]{6,}(\/?)/g, sub: '$1[REDACTED]$2' },
  { re: /(\/rest\/api\/\d+\/)[A-Za-z0-9_-]{6,}(\/?)/g, sub: '$1[REDACTED]$2' },
  // auth=..., access_token=..., refresh_token=... в query/body
  { re: /((?:auth|access_token|refresh_token|client_secret|code)=)[^&\s"']+/gi, sub: '$1[REDACTED]' },
  // Authorization: Bearer xxx
  { re: /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, sub: '$1[REDACTED]' },
  // e-mail
  { re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, sub: '[EMAIL]' },
  // телефоны: +7 999 123-45-67, 8(999)1234567 и т. п. (7+ цифр с разделителями)
  { re: /\+?\d[\d\s()-]{6,}\d/g, sub: '[PHONE]' },
];

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const { re, sub } of PATTERNS) out = out.replace(re, sub);
  return out;
}

/** Рекурсивно редактирует строки внутри произвольного значения (для логов). */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 8) return '[DEPTH]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactValue(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message) } as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Ключи, значения которых никогда не логируются целиком. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'auth',
  'access_token',
  'refresh_token',
  'client_secret',
  'password',
  'webhook',
  'bitrix_webhook_base_url',
  'bitrix_client_secret',
  'bitrix_access_token',
  'bitrix_refresh_token',
  'secret',
  'token',
  'body',
  'message',
  'text',
  'description',
]);

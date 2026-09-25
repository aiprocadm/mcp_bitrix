/**
 * Нормализованные коды ошибок сервера (ТЗ §14.5).
 * Это ЕДИНСТВЕННЫЙ набор кодов, который видит MCP-клиент; сырые ошибки Bitrix и
 * исключения fetch наружу не выходят.
 */
export const ERROR_CODES = [
  'CONFIG_INVALID',
  'BITRIX_AUTH_FAILED',
  'BITRIX_SCOPE_MISSING',
  'BITRIX_ACCESS_DENIED',
  'BITRIX_APP_CONTEXT_REQUIRED',
  'FEATURE_UNAVAILABLE',
  'METHOD_NOT_ALLOWED',
  'VALIDATION_ERROR',
  'BITRIX_RATE_LIMITED',
  'BITRIX_RESOURCE_LIMITED',
  'BITRIX_TIMEOUT',
  'BITRIX_UPSTREAM_ERROR',
  'OPERATION_OUTCOME_UNKNOWN',
  'NOT_FOUND',
  'READ_ONLY_MODE',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'PARTIAL_SUCCESS',
  'FILE_TOO_LARGE',
  'UNSAFE_FILE',
  'AUDIT_UNAVAILABLE',
  'ACCESS_DENIED',
  'RATE_LIMITED',
  // SaaS-ТЗ §9.3: квота тарифа/лимит пользователя исчерпаны; §10.2: подписка не активна.
  'QUOTA_EXCEEDED',
  'SUBSCRIPTION_INACTIVE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Только allowlist полей попадает в `error.details` ответа (ТЗ §14.4). */
export interface ErrorDetails {
  method?: string;
  apiVersion?: 'legacy' | 'v3';
  requiredScope?: string;
  retryable?: boolean;
  nextAction?: string;
  field?: string;
  upstreamCode?: string;
  httpStatus?: number;
  operationId?: string;
  expiresAt?: string;
  reason?: string;
  /** Безопасное краткое описание плана записи (без секретов) при APPROVAL_REQUIRED. */
  plan?: Record<string, unknown>;
  status?: string;
  /** SaaS-ТЗ §11.2 (D12): ссылка на подтверждение плана в кабинете и короткий код для сверки. */
  approvalUrl?: string;
  approvalCode?: string;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['BITRIX_TIMEOUT', 'BITRIX_RATE_LIMITED']);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = { retryable: RETRYABLE.has(code), ...details };
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }

  /** Любое исключение → AppError. Сообщение чужой ошибки НЕ копируется (может содержать URL с секретом). */
  static from(value: unknown, fallbackMessage = 'Внутренняя ошибка сервера'): AppError {
    if (AppError.is(value)) return value;
    return new AppError('INTERNAL_ERROR', fallbackMessage, {
      reason: value instanceof Error ? value.name : typeof value,
    });
  }

  toJSON(): { code: ErrorCode; message: string; details: ErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function configError(field: string, message: string): AppError {
  return new AppError('CONFIG_INVALID', `${field}: ${message}`, {
    field,
    nextAction: `Исправьте ${field} в .env (значение в сообщении не показывается намеренно)`,
  });
}

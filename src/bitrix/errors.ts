/**
 * Нормализация ошибок Bitrix24 → коды ТЗ §14.5.
 * Bitrix может вернуть бизнес-ошибку при HTTP 200 — всегда проверяем тело (T04).
 * `error_description` может содержать чувствительные данные — наружу идёт только код.
 */
import { AppError, type ErrorCode } from '../errors/app-error.js';
import type { ApiVersion } from './method-registry.js';

export interface UpstreamError {
  readonly httpStatus: number;
  /** Код из тела ответа Bitrix (`error`) или из v3-структуры, уже очищенный. */
  readonly upstreamCode: string | undefined;
  readonly retryAfterMs: number | undefined;
}

const EXACT: Record<string, ErrorCode> = {
  expired_token: 'BITRIX_AUTH_FAILED',
  invalid_token: 'BITRIX_AUTH_FAILED',
  invalid_grant: 'BITRIX_AUTH_FAILED',
  NO_AUTH_FOUND: 'BITRIX_AUTH_FAILED',
  INVALID_CREDENTIALS: 'BITRIX_AUTH_FAILED',
  insufficient_scope: 'BITRIX_SCOPE_MISSING',
  INSUFFICIENT_SCOPE: 'BITRIX_SCOPE_MISSING',
  ACCESS_DENIED: 'BITRIX_ACCESS_DENIED',
  allowed_only_for_admins: 'BITRIX_ACCESS_DENIED',
  ACCESS_ERROR: 'BITRIX_ACCESS_DENIED',
  WRONG_AUTH_TYPE: 'BITRIX_APP_CONTEXT_REQUIRED',
  ERROR_METHOD_NOT_FOUND: 'FEATURE_UNAVAILABLE',
  METHOD_NOT_FOUND: 'FEATURE_UNAVAILABLE',
  ERROR_MANIFEST_IS_NOT_AVAILABLE: 'FEATURE_UNAVAILABLE',
  MODULE_NOT_INSTALLED: 'FEATURE_UNAVAILABLE',
  QUERY_LIMIT_EXCEEDED: 'BITRIX_RATE_LIMITED',
  OPERATION_TIME_LIMIT: 'BITRIX_RESOURCE_LIMITED',
  ERROR_NOT_FOUND: 'NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  ERROR_ARGUMENT: 'VALIDATION_ERROR',
  ARGUMENT_ERROR: 'VALIDATION_ERROR',
  INVALID_ARG_VALUE: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'VALIDATION_ERROR',
  ERROR_CORE: 'BITRIX_UPSTREAM_ERROR',
  INTERNAL_SERVER_ERROR: 'BITRIX_UPSTREAM_ERROR',
  PORTAL_DELETED: 'BITRIX_AUTH_FAILED',
  PAYMENT_REQUIRED: 'FEATURE_UNAVAILABLE',
};

export function mapUpstreamError(
  up: UpstreamError,
  method: string,
  apiVersion: ApiVersion,
  scope?: string,
): AppError {
  const code = up.upstreamCode ?? '';
  let mapped: ErrorCode | undefined = EXACT[code];
  if (!mapped) {
    if (/NOT_FOUND/i.test(code)) mapped = 'NOT_FOUND';
    else if (/ACCESS|PERMISSION|DENIED/i.test(code)) mapped = 'BITRIX_ACCESS_DENIED';
    else if (/SCOPE/i.test(code)) mapped = 'BITRIX_SCOPE_MISSING';
    else if (/LIMIT/i.test(code)) mapped = 'BITRIX_RATE_LIMITED';
    else if (/ARGUMENT|VALIDATION|INVALID/i.test(code)) mapped = 'VALIDATION_ERROR';
  }
  if (!mapped) {
    if (up.httpStatus === 401) mapped = 'BITRIX_AUTH_FAILED';
    else if (up.httpStatus === 403) mapped = 'BITRIX_ACCESS_DENIED';
    else if (up.httpStatus === 404) mapped = code ? 'NOT_FOUND' : 'FEATURE_UNAVAILABLE';
    else if (up.httpStatus === 429) mapped = 'BITRIX_RATE_LIMITED';
    else if (up.httpStatus === 503 && !code) mapped = 'BITRIX_RATE_LIMITED';
    else if (up.httpStatus >= 500) mapped = 'BITRIX_UPSTREAM_ERROR';
    else mapped = 'BITRIX_UPSTREAM_ERROR';
  }

  const messages: Partial<Record<ErrorCode, [string, string]>> = {
    BITRIX_AUTH_FAILED: [
      'Bitrix24 не принял авторизацию вебхука/токена',
      'Проверьте вебхук в портале и переподключите интеграцию',
    ],
    BITRIX_SCOPE_MISSING: [
      'Вебхуку не выдан нужный scope',
      `Добавьте scope ${scope ?? 'метода'} в настройках вебхука`,
    ],
    BITRIX_ACCESS_DENIED: [
      'Недостаточно прав на выбранный объект Bitrix24',
      'Проверьте доступ владельца вебхука к этому объекту',
    ],
    BITRIX_APP_CONTEXT_REQUIRED: [
      'Метод требует контекста приложения, вебхук не подходит',
      'Запланируйте локальное приложение/OAuth',
    ],
    FEATURE_UNAVAILABLE: [
      'Метод или модуль недоступен на портале',
      'Проверьте название, версию REST, тариф и установленные модули',
    ],
    BITRIX_RATE_LIMITED: ['Bitrix24 ограничил частоту запросов', 'Снизьте нагрузку и повторите позже'],
    BITRIX_RESOURCE_LIMITED: [
      'Bitrix24 ограничил ресурсоёмкость запроса',
      'Уменьшите объём выборки и повторите позже',
    ],
    NOT_FOUND: [
      'Объект не найден или недоступен',
      'Проверьте ID и права; сервер не раскрывает существование объекта',
    ],
    VALIDATION_ERROR: ['Bitrix24 отклонил параметры запроса', 'Исправьте параметры согласно схеме метода'],
    BITRIX_UPSTREAM_ERROR: [
      'Bitrix24 вернул ошибку выполнения',
      'Повторите позже; при повторении сообщите requestId',
    ],
  };
  const [message, nextAction] = messages[mapped] ?? ['Ошибка Bitrix24', 'Сообщите requestId администратору'];
  return new AppError(mapped, message, {
    method,
    apiVersion,
    ...(scope ? { requiredScope: scope } : {}),
    ...(code ? { upstreamCode: sanitizeCode(code) } : {}),
    httpStatus: up.httpStatus,
    nextAction,
    retryable: mapped === 'BITRIX_RATE_LIMITED',
  });
}

/** Код ошибки хранится очищенным: только буквы/цифры/подчёркивания, ≤ 64 символов. */
export function sanitizeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
}

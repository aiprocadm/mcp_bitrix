/**
 * Ошибки тарифов, квот и подписки (SaaS-ТЗ §9.3, §10.2). Коды — из ERROR_CODES; уточнение — в `details.reason`.
 * QUOTA_EXCEEDED и SUBSCRIPTION_INACTIVE — класс «без автоповтора» (retryable: false).
 */
import { AppError } from '../../errors/app-error.js';
import type { SubscriptionStatus } from '../repos/plans.js';
import type { UsageMetric } from './notifier.js';

export function subscriptionInactive(cabinetUrl: string, status: SubscriptionStatus | 'none'): AppError {
  return new AppError(
    'SUBSCRIPTION_INACTIVE',
    'Подписка на сервис не активна: инструменты недоступны (данные сохраняются)',
    {
      reason: 'SUBSCRIPTION_INACTIVE',
      status,
      retryable: false,
      nextAction: `Оплатите подписку в кабинете: ${cabinetUrl}/billing`,
    },
  );
}

export function notInPlan(cabinetUrl: string, module: string): AppError {
  return new AppError('FEATURE_UNAVAILABLE', `Модуль ${module} не входит в ваш тариф`, {
    reason: 'NOT_IN_PLAN',
    retryable: false,
    nextAction: `Смените тариф в кабинете: ${cabinetUrl}/billing`,
  });
}

export function moduleDisabled(module: string): AppError {
  return new AppError('FEATURE_UNAVAILABLE', `Модуль ${module} выключен администратором портала`, {
    reason: 'MODULE_DISABLED',
    retryable: false,
    nextAction: 'Попросите администратора портала включить модуль в кабинете',
  });
}

export function destructiveNotInPlan(cabinetUrl: string): AppError {
  return new AppError('FEATURE_UNAVAILABLE', 'Удаления не входят в ваш тариф', {
    reason: 'DESTRUCTIVE_NOT_IN_PLAN',
    retryable: false,
    nextAction: `Удаления доступны на тарифе «Бизнес»: ${cabinetUrl}/billing`,
  });
}

export function quotaExceeded(
  cabinetUrl: string,
  metric: UsageMetric,
  limit: number,
  resetsAt: string,
): AppError {
  const what = metric === 'calls' ? 'вызовов' : 'записей';
  return new AppError('QUOTA_EXCEEDED', `Исчерпана месячная квота ${what} тарифа (${String(limit)})`, {
    reason: metric === 'calls' ? 'MONTHLY_CALLS' : 'MONTHLY_WRITES',
    retryable: false,
    expiresAt: resetsAt,
    nextAction: `Смените тариф в кабинете (${cabinetUrl}/billing) или дождитесь начала следующего месяца`,
  });
}

export function userDailyLimit(limit: number, resetsAt: string): AppError {
  return new AppError(
    'QUOTA_EXCEEDED',
    `Исчерпан дневной лимит вызовов пользователя (${String(limit)}), заданный администратором портала`,
    {
      reason: 'USER_DAILY_LIMIT',
      retryable: false,
      expiresAt: resetsAt,
      nextAction: 'Продолжите завтра или попросите администратора портала увеличить лимит',
    },
  );
}

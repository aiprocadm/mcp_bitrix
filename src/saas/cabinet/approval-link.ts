/**
 * Ссылка на подтверждение и правила «повышенного риска» (SaaS-ТЗ §11.1 п.3, §11.2, D12).
 *
 * `approvalUrl` и `approvalShortCode` — то, что сборка режима saas добавляет в `APPROVAL_REQUIRED`: пользователь
 * открывает ссылку, сверяет короткий код с чатом и подтверждает. Ссылка без входа ничего не раскрывает
 * (перенаправление на вход одинаково для любых id).
 *
 * Повышенный риск: удаление (`operationKind = delete`) или инструмент с `destructiveHint` (массовые замены вроде
 * `crm_deal_products_replace`, `company_employee_departments_set`). Для них — повторный ввод слова ПОДТВЕРЖДАЮ,
 * свежий вход (не старше 15 минут) и, если так настроено у арендатора, решение администратора.
 */
import { createHash } from 'node:crypto';
import { allTools } from '../../tools/index.js';

export const FRESH_LOGIN_MS = 15 * 60_000;
export const CONFIRM_WORD = 'ПОДТВЕРЖДАЮ';

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(
  allTools()
    .filter((t) => t.annotations.destructiveHint)
    .map((t) => t.name),
);

export function isHighRiskOperation(tool: string, operationKind: string): boolean {
  return operationKind === 'delete' || DESTRUCTIVE_TOOLS.has(tool);
}

export function approvalUrl(publicBaseUrl: string, operationId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/app/approvals/${encodeURIComponent(operationId)}`;
}

/** Короткий код для сверки ссылки с чатом: 6 символов без похожих букв, производная от operationId. */
export function approvalShortCode(operationId: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = createHash('sha256').update(`approval-code:${operationId}`).digest();
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet.charAt((digest[i] ?? 0) % alphabet.length);
  return out;
}

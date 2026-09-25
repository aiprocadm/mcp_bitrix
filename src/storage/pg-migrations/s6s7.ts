/**
 * Миграции PostgreSQL этапа S6/S7: тарифы, учёт, биллинг. Номера — только из диапазона 60–79
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 *
 * Таблицы миграции 2 (plans, subscriptions, payments, invoices, usage_counters) не меняются по смыслу — только
 * дополняются (expand, SaaS-ТЗ §6.1). Всё здесь — каталог без RLS (§6.2, решение S2): данных порталов нет.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S6S7_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 60,
    name: 's6s7-billing-usage',
    sql: `
-- Контакт для чека 54-ФЗ (email/телефон покупателя) — под DEK арендатора (SecretBox, AAD), как способ оплаты.
ALTER TABLE subscriptions ADD COLUMN receipt_contact_encrypted TEXT;
-- Когда отправлено событие «пора удалить данные» (suspended/canceled дольше срока хранения, §6.3): один раз.
ALTER TABLE subscriptions ADD COLUMN deletion_requested_at TEXT;
CREATE INDEX idx_subscriptions_period_end ON subscriptions(status, period_end);
CREATE INDEX idx_subscriptions_retry ON subscriptions(status, next_retry_at);

-- Платёж продления относится к конкретному периоду (конец периода на момент списания):
-- повторное уведомление или повторный запуск worker не продлевают подписку дважды.
ALTER TABLE payments ADD COLUMN period_anchor TEXT;
ALTER TABLE payments ADD COLUMN refunded_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (refunded_kopecks >= 0);
ALTER TABLE payments ADD COLUMN processed_at TEXT;
CREATE INDEX idx_payments_status ON payments(status, created_at);

-- Учёт по инструментам (§9.2: «по пользователям и инструментам»), период — месяц YYYY-MM.
-- usage_counters (миграция 2) хранит итоги по пользователю за месяц (period = YYYY-MM) и за день (YYYY-MM-DD).
CREATE TABLE usage_tool_counters (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  tool TEXT NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0,
  writes BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, period, tool)
);
CREATE INDEX idx_usage_counters_period ON usage_counters(period, tenant_id);

-- Номера счетов юрлицам: сквозная последовательность (без пропусков при откатах не гарантируется — это норма PG).
CREATE SEQUENCE invoice_number_seq START 1;
`,
  },
];

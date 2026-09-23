/**
 * Аудит (ТЗ §8.6): UTC, correlation ID, псевдоним principal, операция, хеш аргументов,
 * подтверждение, результат. При недоступном журнале записи в Bitrix запрещены
 * (AUDIT_UNAVAILABLE), чтение продолжается в degraded-режиме.
 */
import { createHmac } from 'node:crypto';
import type { Database } from '../storage/database.js';
import type { AppLogger } from './logger.js';
import { AppError } from '../errors/app-error.js';

export type AuditOutcome = 'success' | 'error' | 'denied' | 'prepared' | 'unknown';

export interface AuditEntry {
  requestId: string;
  principalId: string;
  portalKey: string;
  tool?: string | undefined;
  method?: string | undefined;
  apiVersion?: 'legacy' | 'v3' | undefined;
  operationKind: string;
  targetAlias?: string | undefined;
  argsHash?: string | undefined;
  approvalId?: string | undefined;
  outcome: AuditOutcome;
  attempts?: number | undefined;
  errorCode?: string | undefined;
  durationMs?: number | undefined;
}

export class AuditLog {
  private available: boolean;
  private lastError: string | undefined;

  constructor(
    private readonly db: Database | undefined,
    private readonly hmacKey: Buffer,
    private readonly logger: AppLogger,
    private readonly enabled: boolean,
    private readonly retentionDays: number,
  ) {
    this.available = enabled ? db !== undefined : true;
    if (this.enabled && this.db) this.cleanup();
  }

  /** Псевдоним principal: HMAC, чтобы журнал не раскрывал идентификаторы (ТЗ §8.1). */
  alias(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex').slice(0, 16);
  }

  isAvailable(): boolean {
    return this.available;
  }

  status(): { enabled: boolean; available: boolean; lastError: string | undefined } {
    return { enabled: this.enabled, available: this.available, lastError: this.lastError };
  }

  /** Перед любой записью в Bitrix: проактивная проба журнала, а не только память о прошлой ошибке. */
  assertAvailableForWrite(): void {
    if (!this.enabled) return;
    if (this.available && this.db) {
      try {
        this.db.get('SELECT 1 AS one FROM audit LIMIT 1');
      } catch (e) {
        this.available = false;
        this.lastError = e instanceof Error ? e.name : 'unknown';
      }
    }
    if (!this.available) {
      throw new AppError('AUDIT_UNAVAILABLE', 'Журнал аудита недоступен; запись в Bitrix24 запрещена', {
        nextAction: 'Восстановите доступ к базе данных и перезапустите сервер',
      });
    }
  }

  record(entry: AuditEntry): void {
    if (!this.enabled) return;
    if (!this.db) {
      this.available = false;
      return;
    }
    try {
      this.db.run(
        `INSERT INTO audit (ts, request_id, principal_hash, portal_key, tool, method, api_version, operation_kind,
           target_alias, args_hash, approval_id, outcome, attempts, error_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        new Date().toISOString(),
        entry.requestId,
        this.alias(entry.principalId),
        entry.portalKey,
        entry.tool ?? null,
        entry.method ?? null,
        entry.apiVersion ?? null,
        entry.operationKind,
        entry.targetAlias ?? null,
        entry.argsHash ?? null,
        entry.approvalId ?? null,
        entry.outcome,
        entry.attempts ?? 1,
        entry.errorCode ?? null,
        entry.durationMs ?? null,
      );
      this.available = true;
    } catch (e) {
      this.available = false;
      this.lastError = e instanceof Error ? e.name : 'unknown';
      this.logger.error({ requestId: entry.requestId, reason: this.lastError }, 'audit write failed');
    }
  }

  private cleanup(): void {
    if (!this.db) return;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
      this.db.run('DELETE FROM audit WHERE ts < ?', cutoff);
    } catch (e) {
      this.logger.warn({ reason: e instanceof Error ? e.name : 'unknown' }, 'audit cleanup failed');
    }
  }
}

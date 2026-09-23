/**
 * Ledger операций записи (ТЗ §4.4): prepared → approved → executing → succeeded/failed/unknown,
 * плюс denied/expired. На этом этапе — чтение статуса и восстановление после сбоя;
 * подготовка/подтверждение/выполнение добавляются на этапе 6 (MutationExecutor).
 */
import type { Database } from './database.js';

export type OperationStatus =
  'prepared' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'denied' | 'expired';

export interface OperationRow {
  id: string;
  principal_id: string;
  portal_key: string;
  tool: string;
  operation_kind: string;
  status: OperationStatus;
  canonical_args_hash: string;
  target: string | null;
  expected_state_hash: string | null;
  file_hash: string | null;
  policy_version: string;
  plan_encrypted: string;
  idempotency_key: string | null;
  result_encrypted: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  executing_at: string | null;
  finished_at: string | null;
}

export interface OperationView {
  operationId: string;
  tool: string;
  operationKind: string;
  status: OperationStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  errorCode: string | null;
  target: string | null;
}

export class OperationsStore {
  constructor(private readonly db: Database) {}

  /** После сбоя процесса: всё, что было executing, становится unknown (ТЗ §4.4). */
  recoverAfterRestart(): number {
    const r = this.db.run(
      "UPDATE operations SET status = 'unknown', finished_at = ? WHERE status = 'executing'",
      new Date().toISOString(),
    );
    return Number(r.changes);
  }

  expireStale(): number {
    const r = this.db.run(
      "UPDATE operations SET status = 'expired' WHERE status IN ('prepared','approved') AND expires_at < ?",
      new Date().toISOString(),
    );
    return Number(r.changes);
  }

  get(operationId: string): OperationRow | undefined {
    return this.db.get<OperationRow>('SELECT * FROM operations WHERE id = ?', operationId);
  }

  /** Только своя операция; чужая выглядит как отсутствующая (не раскрываем существование). */
  view(operationId: string, principalId: string, portalKey: string): OperationView | undefined {
    const row = this.get(operationId);
    if (row?.principal_id !== principalId || row.portal_key !== portalKey) return undefined;
    return {
      operationId: row.id,
      tool: row.tool,
      operationKind: row.operation_kind,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedAt: row.approved_at,
      finishedAt: row.finished_at,
      attempts: row.attempts,
      errorCode: row.error_code,
      target: row.target,
    };
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM operations GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

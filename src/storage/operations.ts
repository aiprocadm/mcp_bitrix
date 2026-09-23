/**
 * Ledger операций записи (ТЗ §4.4): prepared → approved → executing → succeeded/failed/unknown,
 * плюс denied/expired. Переходы атомарны (UPDATE ... WHERE status = ожидаемый).
 * Полные объекты CRM здесь не хранятся: план и минимальный результат — зашифрованы.
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

export interface NewOperation {
  id: string;
  principalId: string;
  portalKey: string;
  tool: string;
  operationKind: string;
  argsHash: string;
  target: string | null;
  expectedStateHash: string | null;
  fileHash: string | null;
  policyVersion: string;
  planEncrypted: string;
  idempotencyKey: string | null;
  expiresAt: string;
}

export interface IdempotencyRow {
  principal_id: string;
  portal_key: string;
  tool: string;
  idempotency_key: string;
  args_hash: string;
  operation_id: string;
  created_at: string;
  expires_at: string;
}

const now = () => new Date().toISOString();

export class OperationsStore {
  constructor(private readonly db: Database) {}

  /** После сбоя процесса: всё, что было executing, становится unknown (ТЗ §4.4, T16). */
  recoverAfterRestart(): number {
    const r = this.db.run(
      "UPDATE operations SET status = 'unknown', finished_at = ? WHERE status = 'executing'",
      now(),
    );
    return Number(r.changes);
  }

  expireStale(): number {
    const r = this.db.run(
      "UPDATE operations SET status = 'expired' WHERE status IN ('prepared','approved') AND expires_at < ?",
      now(),
    );
    this.db.run('DELETE FROM idempotency WHERE expires_at < ?', now());
    return Number(r.changes);
  }

  get(operationId: string): OperationRow | undefined {
    return this.db.get<OperationRow>('SELECT * FROM operations WHERE id = ?', operationId);
  }

  /** Только своя операция; чужая выглядит как отсутствующая (не раскрываем существование). */
  getOwn(operationId: string, principalId: string, portalKey: string): OperationRow | undefined {
    const row = this.get(operationId);
    if (row?.principal_id !== principalId || row.portal_key !== portalKey) return undefined;
    return row;
  }

  view(operationId: string, principalId: string, portalKey: string): OperationView | undefined {
    const row = this.getOwn(operationId, principalId, portalKey);
    if (!row) return undefined;
    return toView(row);
  }

  listPending(principalId: string, portalKey: string): OperationView[] {
    return this.db
      .all<OperationRow>(
        "SELECT * FROM operations WHERE principal_id = ? AND portal_key = ? AND status IN ('prepared','approved') AND expires_at >= ? ORDER BY created_at",
        principalId,
        portalKey,
        now(),
      )
      .map(toView);
  }

  createPrepared(op: NewOperation): void {
    this.db.run(
      `INSERT INTO operations (id, principal_id, portal_key, tool, operation_kind, status, canonical_args_hash, target,
         expected_state_hash, file_hash, policy_version, plan_encrypted, idempotency_key, attempts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      op.id,
      op.principalId,
      op.portalKey,
      op.tool,
      op.operationKind,
      op.argsHash,
      op.target,
      op.expectedStateHash,
      op.fileHash,
      op.policyVersion,
      op.planEncrypted,
      op.idempotencyKey,
      now(),
      op.expiresAt,
    );
  }

  findIdempotency(
    principalId: string,
    portalKey: string,
    tool: string,
    key: string,
  ): IdempotencyRow | undefined {
    const row = this.db.get<IdempotencyRow>(
      'SELECT * FROM idempotency WHERE principal_id = ? AND portal_key = ? AND tool = ? AND idempotency_key = ?',
      principalId,
      portalKey,
      tool,
      key,
    );
    if (row && Date.parse(row.expires_at) < Date.now()) return undefined;
    return row;
  }

  upsertIdempotency(row: Omit<IdempotencyRow, 'created_at'>): void {
    this.db.run(
      `INSERT INTO idempotency (principal_id, portal_key, tool, idempotency_key, args_hash, operation_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal_id, portal_key, tool, idempotency_key)
       DO UPDATE SET args_hash = excluded.args_hash, operation_id = excluded.operation_id, expires_at = excluded.expires_at`,
      row.principal_id,
      row.portal_key,
      row.tool,
      row.idempotency_key,
      row.args_hash,
      row.operation_id,
      now(),
      row.expires_at,
    );
  }

  /** Человек подтвердил: prepared → approved, только если срок не истёк. */
  approve(operationId: string): 'approved' | 'expired' | 'not-prepared' {
    const row = this.get(operationId);
    if (row?.status !== 'prepared') return 'not-prepared';
    if (Date.parse(row.expires_at) < Date.now()) {
      this.db.run(
        "UPDATE operations SET status = 'expired' WHERE id = ? AND status = 'prepared'",
        operationId,
      );
      return 'expired';
    }
    const r = this.db.run(
      "UPDATE operations SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'prepared'",
      now(),
      operationId,
    );
    return Number(r.changes) === 1 ? 'approved' : 'not-prepared';
  }

  deny(operationId: string): boolean {
    const r = this.db.run(
      "UPDATE operations SET status = 'denied', finished_at = ? WHERE id = ? AND status IN ('prepared','approved')",
      now(),
      operationId,
    );
    return Number(r.changes) === 1;
  }

  /** Атомарное расходование подтверждения: approved → executing. Второй вызов не пройдёт. */
  tryStartExecuting(operationId: string): boolean {
    const r = this.db.run(
      "UPDATE operations SET status = 'executing', executing_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'approved' AND expires_at >= ?",
      now(),
      operationId,
      now(),
    );
    return Number(r.changes) === 1;
  }

  finish(
    operationId: string,
    status: 'succeeded' | 'failed' | 'unknown',
    data: { resultEncrypted?: string; errorCode?: string; errorMessage?: string },
  ): void {
    this.db.run(
      "UPDATE operations SET status = ?, finished_at = ?, result_encrypted = ?, error_code = ?, error_message = ? WHERE id = ? AND status = 'executing'",
      status,
      now(),
      data.resultEncrypted ?? null,
      data.errorCode ?? null,
      data.errorMessage ?? null,
      operationId,
    );
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM operations GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

function toView(row: OperationRow): OperationView {
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

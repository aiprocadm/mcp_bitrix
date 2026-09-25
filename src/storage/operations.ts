/**
 * Ledger операций записи (ТЗ §4.4): prepared → approved → executing → succeeded/failed/unknown,
 * плюс denied/expired. Переходы атомарны (UPDATE ... WHERE status = ожидаемый).
 * Полные объекты CRM здесь не хранятся: план и минимальный результат — зашифрованы.
 * Хранилище привязано к арендатору (SaaS-ТЗ §6.2): каждый запрос фильтрует tenant_id,
 * операция чужого арендатора выглядит как отсутствующая.
 */
import { toNumber, type SqlDb, type SqlExecutor } from './sql.js';

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
  constructor(
    private readonly db: SqlDb,
    readonly tenantId: string,
  ) {}

  private q<T>(fn: (x: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.withTenant(this.tenantId, fn);
  }

  /** После сбоя процесса: всё, что было executing, становится unknown (ТЗ §4.4, T16). */
  async recoverAfterRestart(): Promise<number> {
    return this.q((x) =>
      x.run(
        "UPDATE operations SET status = 'unknown', finished_at = ? WHERE tenant_id = ? AND status = 'executing'",
        now(),
        this.tenantId,
      ),
    );
  }

  async expireStale(): Promise<number> {
    return this.q(async (x) => {
      const n = await x.run(
        "UPDATE operations SET status = 'expired' WHERE tenant_id = ? AND status IN ('prepared','approved') AND expires_at < ?",
        this.tenantId,
        now(),
      );
      await x.run('DELETE FROM idempotency WHERE tenant_id = ? AND expires_at < ?', this.tenantId, now());
      return n;
    });
  }

  get(operationId: string): Promise<OperationRow | undefined> {
    return this.q((x) =>
      x.get<OperationRow>(
        'SELECT * FROM operations WHERE tenant_id = ? AND id = ?',
        this.tenantId,
        operationId,
      ),
    ).then((r) => (r ? normalize(r) : undefined));
  }

  /** Только своя операция; чужая выглядит как отсутствующая (не раскрываем существование). */
  async getOwn(
    operationId: string,
    principalId: string,
    portalKey: string,
  ): Promise<OperationRow | undefined> {
    const row = await this.get(operationId);
    if (row?.principal_id !== principalId || row.portal_key !== portalKey) return undefined;
    return row;
  }

  async view(
    operationId: string,
    principalId: string,
    portalKey: string,
  ): Promise<OperationView | undefined> {
    const row = await this.getOwn(operationId, principalId, portalKey);
    return row ? toView(row) : undefined;
  }

  async listPending(principalId: string, portalKey: string): Promise<OperationView[]> {
    const rows = await this.q((x) =>
      x.all<OperationRow>(
        "SELECT * FROM operations WHERE tenant_id = ? AND principal_id = ? AND portal_key = ? AND status IN ('prepared','approved') AND expires_at >= ? ORDER BY created_at",
        this.tenantId,
        principalId,
        portalKey,
        now(),
      ),
    );
    return rows.map(normalize).map(toView);
  }

  /**
   * История операций principal (кабинет SaaS, §11.1 п.4): статус, инструмент, цель, время — без плана и результата.
   * Последние сначала; limit ограничен 1..500.
   */
  async listRecent(principalId: string, portalKey: string, limit: number): Promise<OperationView[]> {
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = await this.q((x) =>
      x.all<OperationRow>(
        'SELECT * FROM operations WHERE tenant_id = ? AND principal_id = ? AND portal_key = ? ORDER BY created_at DESC, id LIMIT ?',
        this.tenantId,
        principalId,
        portalKey,
        n,
      ),
    );
    return rows.map(normalize).map(toView);
  }

  /** Все ожидающие решения операции портала — для панели владельца (любой principal арендатора). */
  async listPendingAll(portalKey: string): Promise<(OperationView & { principalId: string })[]> {
    const rows = await this.q((x) =>
      x.all<OperationRow>(
        "SELECT * FROM operations WHERE tenant_id = ? AND portal_key = ? AND status IN ('prepared','approved') AND expires_at >= ? ORDER BY created_at",
        this.tenantId,
        portalKey,
        now(),
      ),
    );
    return rows.map(normalize).map((r) => ({ ...toView(r), principalId: r.principal_id }));
  }

  /** Строка операции по id в пределах портала (панель): без привязки к principal. */
  async getForPortal(operationId: string, portalKey: string): Promise<OperationRow | undefined> {
    const row = await this.get(operationId);
    return row?.portal_key === portalKey ? row : undefined;
  }

  async createPrepared(op: NewOperation): Promise<void> {
    await this.q((x) =>
      x.run(
        `INSERT INTO operations (id, tenant_id, principal_id, portal_key, tool, operation_kind, status, canonical_args_hash, target,
           expected_state_hash, file_hash, policy_version, plan_encrypted, idempotency_key, attempts, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        op.id,
        this.tenantId,
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
      ),
    );
  }

  async findIdempotency(
    principalId: string,
    portalKey: string,
    tool: string,
    key: string,
  ): Promise<IdempotencyRow | undefined> {
    const row = await this.q((x) =>
      x.get<IdempotencyRow>(
        'SELECT * FROM idempotency WHERE tenant_id = ? AND principal_id = ? AND portal_key = ? AND tool = ? AND idempotency_key = ?',
        this.tenantId,
        principalId,
        portalKey,
        tool,
        key,
      ),
    );
    if (row && Date.parse(row.expires_at) < Date.now()) return undefined;
    return row;
  }

  async upsertIdempotency(row: Omit<IdempotencyRow, 'created_at'>): Promise<void> {
    await this.q((x) =>
      x.run(
        `INSERT INTO idempotency (tenant_id, principal_id, portal_key, tool, idempotency_key, args_hash, operation_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, principal_id, portal_key, tool, idempotency_key)
         DO UPDATE SET args_hash = excluded.args_hash, operation_id = excluded.operation_id, expires_at = excluded.expires_at`,
        this.tenantId,
        row.principal_id,
        row.portal_key,
        row.tool,
        row.idempotency_key,
        row.args_hash,
        row.operation_id,
        now(),
        row.expires_at,
      ),
    );
  }

  /** Человек подтвердил: prepared → approved, только если срок не истёк. */
  async approve(operationId: string): Promise<'approved' | 'expired' | 'not-prepared'> {
    const row = await this.get(operationId);
    if (row?.status !== 'prepared') return 'not-prepared';
    if (Date.parse(row.expires_at) < Date.now()) {
      await this.q((x) =>
        x.run(
          "UPDATE operations SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'prepared'",
          this.tenantId,
          operationId,
        ),
      );
      return 'expired';
    }
    const n = await this.q((x) =>
      x.run(
        "UPDATE operations SET status = 'approved', approved_at = ? WHERE tenant_id = ? AND id = ? AND status = 'prepared'",
        now(),
        this.tenantId,
        operationId,
      ),
    );
    return n === 1 ? 'approved' : 'not-prepared';
  }

  async deny(operationId: string): Promise<boolean> {
    const n = await this.q((x) =>
      x.run(
        "UPDATE operations SET status = 'denied', finished_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('prepared','approved')",
        now(),
        this.tenantId,
        operationId,
      ),
    );
    return n === 1;
  }

  /** Отзыв доступа пользователя (SaaS-ТЗ §7.4): его неисполненные подтверждения аннулируются. */
  async denyAllPending(principalId: string): Promise<number> {
    return this.q((x) =>
      x.run(
        "UPDATE operations SET status = 'denied', finished_at = ? WHERE tenant_id = ? AND principal_id = ? AND status IN ('prepared','approved')",
        now(),
        this.tenantId,
        principalId,
      ),
    );
  }

  /** Атомарное расходование подтверждения: approved → executing. Второй вызов не пройдёт. */
  async tryStartExecuting(operationId: string): Promise<boolean> {
    const n = await this.q((x) =>
      x.run(
        "UPDATE operations SET status = 'executing', executing_at = ?, attempts = attempts + 1 WHERE tenant_id = ? AND id = ? AND status = 'approved' AND expires_at >= ?",
        now(),
        this.tenantId,
        operationId,
        now(),
      ),
    );
    return n === 1;
  }

  async finish(
    operationId: string,
    status: 'succeeded' | 'failed' | 'unknown',
    data: { resultEncrypted?: string; errorCode?: string; errorMessage?: string },
  ): Promise<void> {
    await this.q((x) =>
      x.run(
        "UPDATE operations SET status = ?, finished_at = ?, result_encrypted = ?, error_code = ?, error_message = ? WHERE tenant_id = ? AND id = ? AND status = 'executing'",
        status,
        now(),
        data.resultEncrypted ?? null,
        data.errorCode ?? null,
        data.errorMessage ?? null,
        this.tenantId,
        operationId,
      ),
    );
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.q((x) =>
      x.all<{ status: string; n: unknown }>(
        'SELECT status, COUNT(*) AS n FROM operations WHERE tenant_id = ? GROUP BY status',
        this.tenantId,
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.status, toNumber(r.n)]));
  }
}

/** PostgreSQL отдаёт BIGINT строкой: приводим числовые поля. */
function normalize(row: OperationRow): OperationRow {
  return { ...row, attempts: toNumber(row.attempts) };
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

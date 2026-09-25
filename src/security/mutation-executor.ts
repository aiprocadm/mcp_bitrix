/**
 * MutationExecutor — ЕДИНСТВЕННАЯ точка реального create/update/delete/upload (ТЗ §12, §8.2, §14.2).
 *
 * Порядок:
 *  1. аудит доступен; ключ идемпотентности есть (если не dryRun);
 *  2. dryRun → только план, без записей в ledger;
 *  3. ключ уже известен → повтор: replay результата / unknown / conflict / тот же план;
 *  4. без approvalId → подготовить план, вернуть APPROVAL_REQUIRED (записи в Bitrix нет);
 *  5. с approvalId → сверить principal/portal/tool/argsHash/policy/stateHash/fileHash, срок, статус;
 *     атомарно approved → executing; precheck (CONFLICT); perform; verify; результат в ledger.
 *  Мутация никогда не повторяется автоматически; потеря ответа → unknown.
 */
import { randomUUID } from 'node:crypto';
import type { OperationKind } from '../bitrix/method-registry.js';
import { AppError } from '../errors/app-error.js';
import type { AuditLog } from '../logging/audit.js';
import type { AppLogger } from '../logging/logger.js';
import type { OperationRow, OperationsStore } from '../storage/operations.js';
import { ApprovalService, type PlanSummary } from './approval-service.js';
import type { SecretBox } from './crypto.js';
import { canonicalJson } from '../bitrix/pagination.js';
import { argsHash, canonicalArgs, idempotencyScope } from './idempotency.js';

export interface MutationPrincipal {
  readonly id: string;
  readonly portalKey: string;
  readonly portalOrigin: string;
}

export interface PerformResult {
  /** ID созданного/изменённого объекта Bitrix; null, если метод не возвращает ID. */
  id: number | string | null;
  /** Минимальный результат для ответа и replay (без больших объектов). */
  result: Record<string, unknown>;
}

export interface MutationRequest {
  requestId: string;
  principal: MutationPrincipal;
  tool: string;
  operationKind: OperationKind;
  /** Полные аргументы инструмента (с управляющими полями). */
  args: Record<string, unknown>;
  summary: PlanSummary;
  expectedStateHash?: string | null;
  fileHash?: string | null;
  /** Локальный уровень проверки для dry-run: что реально проверено без записи. */
  validationLevel?: 'local' | 'local+metadata';
  /** Непосредственно перед выполнением: перечитать объект и бросить CONFLICT при расхождении (T15). */
  precheck?: () => Promise<void>;
  perform: () => Promise<PerformResult>;
  /** Сверка после записи (§15.3); ошибка сверки не повод создавать объект повторно. */
  verify?: (performed: PerformResult) => Promise<{ verified: boolean; warnings: string[] }>;
}

export interface DryRunOutcome {
  kind: 'dry-run';
  plan: Record<string, unknown>;
  validationLevel: 'local' | 'local+metadata';
}

export interface ExecutedOutcome {
  kind: 'executed';
  operationId: string;
  id: number | string | null;
  result: Record<string, unknown>;
  verified: boolean;
  warnings: string[];
  /** true — результат взят из ledger по тому же ключу, новой записи не было. */
  replayed: boolean;
}

export type MutationOutcome = DryRunOutcome | ExecutedOutcome;

interface StoredResult {
  id: number | string | null;
  result: Record<string, unknown>;
  verified: boolean;
  warnings: string[];
}

const REUSABLE_STATUSES = new Set(['failed', 'denied', 'expired']);

export class MutationExecutor {
  private readonly inflight = new Map<string, Promise<MutationOutcome>>();
  private readonly prepareTimes = new Map<string, number[]>();

  constructor(
    private readonly ops: OperationsStore,
    private readonly approvals: ApprovalService,
    private readonly box: SecretBox,
    private readonly audit: AuditLog,
    private readonly logger: AppLogger,
    private readonly opts: {
      idempotencyTtlHours: number;
      policyVersion: string;
      confirmAllWrites: boolean;
      maxPreparationsPerMinute: number;
    },
  ) {}

  async execute(req: MutationRequest): Promise<MutationOutcome> {
    const dryRun = req.args['dryRun'] === true;
    if (dryRun) {
      return {
        kind: 'dry-run',
        plan: ApprovalService.publicPlan(req.summary),
        validationLevel: req.validationLevel ?? 'local',
      };
    }
    this.audit.assertAvailableForWrite();
    const key = typeof req.args['idempotencyKey'] === 'string' ? req.args['idempotencyKey'] : undefined;
    if (!key) {
      throw new AppError('VALIDATION_ERROR', 'idempotencyKey обязателен для реальной записи', {
        field: 'idempotencyKey',
      });
    }
    const scope = idempotencyScope(req.principal.id, req.principal.portalKey, req.tool, key);
    // T08: одновременные вызовы с одним ключом делят одно выполнение.
    const running = this.inflight.get(scope);
    if (running) return running;
    const p = this.run(req, key).finally(() => this.inflight.delete(scope));
    this.inflight.set(scope, p);
    return p;
  }

  private async run(req: MutationRequest, key: string): Promise<MutationOutcome> {
    const hash = argsHash(req.args);
    const approvalId = typeof req.args['approvalId'] === 'string' ? req.args['approvalId'] : undefined;
    const expectedStateHash =
      req.expectedStateHash ??
      (typeof req.args['expectedStateHash'] === 'string' ? req.args['expectedStateHash'] : null);
    const fileHash = req.fileHash ?? null;

    const existing = this.ops.findIdempotency(req.principal.id, req.principal.portalKey, req.tool, key);
    if (existing && existing.args_hash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Тот же idempotencyKey уже использован с другими параметрами',
        {
          operationId: existing.operation_id,
          nextAction: 'Проверьте намерение; для нового действия используйте новый ключ',
        },
      );
    }

    if (approvalId) return this.runApproved(req, key, hash, approvalId, expectedStateHash, fileHash);

    if (existing) {
      const op = this.ops.get(existing.operation_id);
      if (op) {
        const handled = this.handleExistingWithoutApproval(op, req);
        if (handled) return handled;
      }
    }
    // Новый план: записи в Bitrix нет.
    return this.prepare(req, key, hash, expectedStateHash, fileHash);
  }

  /** Повтор без approvalId по известному ключу. Возвращает результат или бросает; undefined = нужен новый план. */
  private handleExistingWithoutApproval(op: OperationRow, req: MutationRequest): MutationOutcome | undefined {
    if (op.status === 'succeeded') return this.replay(op);
    if (op.status === 'unknown') throw unknownOutcome(op.id);
    if (op.status === 'executing') throw inProgress(op.id);
    if (op.status === 'prepared' || op.status === 'approved') {
      if (Date.parse(op.expires_at) < Date.now()) return undefined;
      throw approvalRequired(op.id, op.expires_at, req.summary, op.status === 'approved');
    }
    if (REUSABLE_STATUSES.has(op.status)) return undefined;
    return undefined;
  }

  private prepare(
    req: MutationRequest,
    key: string,
    hash: string,
    expectedStateHash: string | null,
    fileHash: string | null,
  ): never {
    this.checkPreparationRate(req.principal.id);
    const prepared = this.approvals.prepare({
      tool: req.tool,
      operationKind: req.operationKind,
      principalId: req.principal.id,
      portalKey: req.principal.portalKey,
      requestId: req.requestId,
      argsHash: hash,
      canonicalArgs: canonicalArgs(req.args),
      summary: req.summary,
      expectedStateHash,
      fileHash,
      idempotencyKey: key,
    });
    this.ops.upsertIdempotency({
      principal_id: req.principal.id,
      portal_key: req.principal.portalKey,
      tool: req.tool,
      idempotency_key: key,
      args_hash: hash,
      operation_id: prepared.operationId,
      expires_at: new Date(Date.now() + this.opts.idempotencyTtlHours * 3_600_000).toISOString(),
    });
    this.audit.record({
      requestId: req.requestId,
      principalId: req.principal.id,
      portalKey: req.principal.portalKey,
      tool: req.tool,
      operationKind: req.operationKind,
      targetAlias: req.summary.target,
      argsHash: hash,
      approvalId: prepared.operationId,
      outcome: 'prepared',
    });
    this.logger.info({ operationId: prepared.operationId, tool: req.tool }, 'mutation plan prepared');
    throw approvalRequired(prepared.operationId, prepared.expiresAt, req.summary, false);
  }

  private async runApproved(
    req: MutationRequest,
    key: string,
    hash: string,
    approvalId: string,
    expectedStateHash: string | null,
    fileHash: string | null,
  ): Promise<MutationOutcome> {
    const op = this.ops.getOwn(approvalId, req.principal.id, req.principal.portalKey);
    // T14: чужой principal/portal, другой инструмент, другие аргументы, другая политика — единый отказ.
    if (
      op?.tool !== req.tool ||
      op.canonical_args_hash !== hash ||
      op.policy_version !== this.opts.policyVersion ||
      (op.expected_state_hash ?? null) !== expectedStateHash ||
      (op.file_hash ?? null) !== fileHash ||
      op.idempotency_key !== key
    ) {
      throw new AppError('APPROVAL_MISMATCH', 'Подтверждение не найдено или не соответствует этому запросу', {
        operationId: approvalId,
        nextAction:
          'Повторите вызов с теми же параметрами, что были подтверждены, либо подготовьте новый план',
      });
    }
    switch (op.status) {
      case 'succeeded':
        return this.replay(op); // T13: второй записи нет
      case 'unknown':
        throw unknownOutcome(op.id);
      case 'executing':
        throw inProgress(op.id);
      case 'prepared':
        if (Date.parse(op.expires_at) < Date.now()) throw expired(op.id);
        throw approvalRequired(op.id, op.expires_at, req.summary, false);
      case 'denied':
        throw new AppError('ACCESS_DENIED', 'План отклонён человеком; выполнение запрещено', {
          operationId: op.id,
          status: 'denied',
        });
      case 'expired':
        throw expired(op.id);
      case 'failed':
        throw new AppError('CONFLICT', 'Операция уже завершилась ошибкой; подготовьте новый план', {
          operationId: op.id,
          status: 'failed',
          ...(op.error_code ? { reason: op.error_code } : {}),
        });
      case 'approved':
        break;
    }
    if (Date.parse(op.expires_at) < Date.now()) throw expired(op.id);
    if (!this.ops.tryStartExecuting(op.id)) throw inProgress(op.id);

    const warnings: string[] = [];
    let performed: PerformResult;
    try {
      if (req.precheck) await req.precheck();
      // §8.2 п.4: выполняется ровно подтверждённый план. Обработчик пересчитал план по свежему состоянию
      // портала; если действие, цель или детали (режим create/update, итоговые параметры, diff) разошлись
      // с подтверждёнными — записи нет, операция failed, нужен новый план. Работает и без expectedStateHash;
      // специфичные проверки инструмента (precheck) идут раньше и дают более точную причину.
      const approved = this.approvals.readPlan(op.id, req.principal.id, req.principal.portalKey).plan.summary;
      if (!samePlan(approved, req.summary)) {
        throw new AppError(
          'CONFLICT',
          'Состояние портала изменилось: план выполнения отличается от подтверждённого',
          {
            operationId: op.id,
            reason: 'PLAN_CHANGED',
            nextAction: 'Подготовьте новый план (вызов без approvalId) и подтвердите его заново',
          },
        );
      }
      performed = await req.perform();
    } catch (e) {
      const err = AppError.from(e);
      const status = err.code === 'OPERATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed';
      this.ops.finish(op.id, status, { errorCode: err.code, errorMessage: err.message });
      this.audit.record({
        requestId: req.requestId,
        principalId: req.principal.id,
        portalKey: req.principal.portalKey,
        tool: req.tool,
        method: err.details.method,
        apiVersion: err.details.apiVersion,
        operationKind: req.operationKind,
        targetAlias: req.summary.target,
        argsHash: hash,
        approvalId: op.id,
        outcome: status === 'unknown' ? 'unknown' : 'error',
        errorCode: err.code,
      });
      throw new AppError(err.code, err.message, { ...err.details, operationId: op.id });
    }

    let verified = false;
    if (req.verify) {
      try {
        const v = await req.verify(performed);
        verified = v.verified;
        warnings.push(...v.warnings);
      } catch (e) {
        warnings.push(`Создано, проверка не завершена: ${AppError.from(e).code}`);
      }
    }
    const stored: StoredResult = { id: performed.id, result: performed.result, verified, warnings };
    this.ops.finish(op.id, 'succeeded', { resultEncrypted: this.box.encrypt(JSON.stringify(stored), op.id) });
    this.audit.record({
      requestId: req.requestId,
      principalId: req.principal.id,
      portalKey: req.principal.portalKey,
      tool: req.tool,
      operationKind: req.operationKind,
      targetAlias: req.summary.target,
      argsHash: hash,
      approvalId: op.id,
      outcome: 'success',
    });
    this.logger.info({ operationId: op.id, tool: req.tool, verified }, 'mutation executed');
    return { kind: 'executed', operationId: op.id, ...stored, replayed: false };
  }

  private replay(op: OperationRow): ExecutedOutcome {
    if (!op.result_encrypted) {
      throw new AppError('CONFLICT', 'Операция завершена, но результат недоступен; сверьте объект вручную', {
        operationId: op.id,
      });
    }
    const stored = JSON.parse(this.box.decrypt(op.result_encrypted, op.id)) as StoredResult;
    return {
      kind: 'executed',
      operationId: op.id,
      id: stored.id,
      result: stored.result,
      verified: stored.verified,
      warnings: [
        ...stored.warnings,
        'Повтор с тем же idempotencyKey: возвращён сохранённый результат, новой записи не было',
      ],
      replayed: true,
    };
  }

  /** ТЗ §8.6: не более N подготовок записи в минуту на оператора. */
  private checkPreparationRate(principalId: string): void {
    const now = Date.now();
    const times = (this.prepareTimes.get(principalId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= this.opts.maxPreparationsPerMinute) {
      throw new AppError('RATE_LIMITED', 'Слишком много подготовок записи за минуту', {
        nextAction: 'Подождите минуту; подтвердите или отклоните уже подготовленные планы',
        retryable: true,
      });
    }
    times.push(now);
    this.prepareTimes.set(principalId, times);
  }
}

function approvalRequired(
  operationId: string,
  expiresAt: string,
  summary: PlanSummary,
  alreadyApproved: boolean,
): AppError {
  return new AppError(
    'APPROVAL_REQUIRED',
    alreadyApproved
      ? 'План подтверждён; повторите вызов с теми же параметрами и approvalId'
      : 'Требуется подтверждение человеком; запись в Bitrix24 ещё НЕ выполнена',
    {
      operationId,
      expiresAt,
      plan: ApprovalService.publicPlan(summary),
      status: alreadyApproved ? 'approved' : 'prepared',
      nextAction: alreadyApproved
        ? `Вызовите инструмент повторно с approvalId=${operationId}`
        : `Владелец выполняет: npm run approval:review -- --id ${operationId}; затем повторите вызов с теми же параметрами и approvalId=${operationId}`,
    },
  );
}

function expired(operationId: string): AppError {
  return new AppError('APPROVAL_EXPIRED', 'Срок подтверждения истёк; подготовьте новый план', {
    operationId,
    status: 'expired',
  });
}

function inProgress(operationId: string): AppError {
  return new AppError('CONFLICT', 'Операция уже выполняется; дождитесь результата через operation_status', {
    operationId,
    status: 'executing',
  });
}

function unknownOutcome(operationId: string): AppError {
  return new AppError(
    'OPERATION_OUTCOME_UNKNOWN',
    'Исход предыдущей попытки неизвестен; сверьте объект в Bitrix24 перед новой попыткой',
    {
      operationId,
      status: 'unknown',
      nextAction:
        'Проверьте объект в интерфейсе Bitrix24; для нового действия используйте новый idempotencyKey',
    },
  );
}

export function newOperationId(): string {
  return randomUUID();
}

/** Сравнение планов без рисков: риски — пояснения, а действие, цель и детали определяют запись. */
function samePlan(a: PlanSummary, b: PlanSummary): boolean {
  return (
    a.action === b.action &&
    a.target === b.target &&
    canonicalJson(a.details ?? {}) === canonicalJson(b.details ?? {})
  );
}

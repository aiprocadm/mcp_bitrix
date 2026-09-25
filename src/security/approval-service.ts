/**
 * Подтверждения (ТЗ §8.2): подготовка плана, просмотр человеком, одобрение/отказ.
 * Никакого MCP-инструмента «approve_anything» нет: одобрить может только локальная CLI
 * (или защищённая панель на удалённом этапе). Планы хранятся зашифрованными с TTL.
 */
import { randomUUID } from 'node:crypto';
import type { OperationKind } from '../bitrix/method-registry.js';
import { AppError } from '../errors/app-error.js';
import type { SecretBox } from './crypto.js';
import type { OperationsStore, OperationView } from '../storage/operations.js';

/** Человекочитаемый план: то, что увидит владелец в approval:review. Секретов не содержит. */
export interface PlanSummary {
  /** Что будет сделано, одной фразой: «Создать сделку», «Отправить сообщение в чат …». */
  action: string;
  /** Целевая сущность/область: crm.deal, task, chat:chat123, disk.folder:12, calendar:user/7/5. */
  target: string;
  portalOrigin: string;
  /** Точные поля/текст, которые уйдут в Bitrix24 (полностью, без сокращений). */
  details: Record<string, unknown>;
  /** Возможные побочные эффекты: роботы, уведомления, участники. */
  risks: string[];
}

export interface StoredPlan {
  operationId: string;
  tool: string;
  operationKind: OperationKind;
  principalId: string;
  requestId: string;
  createdAt: string;
  canonicalArgs: Record<string, unknown>;
  summary: PlanSummary;
}

export interface PreparedApproval {
  operationId: string;
  expiresAt: string;
}

export class ApprovalService {
  constructor(
    private readonly ops: OperationsStore,
    private readonly box: SecretBox,
    private readonly ttlSeconds: number,
    private readonly policyVersion: string,
  ) {}

  async prepare(input: {
    tool: string;
    operationKind: OperationKind;
    principalId: string;
    portalKey: string;
    requestId: string;
    argsHash: string;
    canonicalArgs: Record<string, unknown>;
    summary: PlanSummary;
    expectedStateHash: string | null;
    fileHash: string | null;
    idempotencyKey: string | null;
  }): Promise<PreparedApproval> {
    const operationId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1000).toISOString();
    const plan: StoredPlan = {
      operationId,
      tool: input.tool,
      operationKind: input.operationKind,
      principalId: input.principalId,
      requestId: input.requestId,
      createdAt: createdAt.toISOString(),
      canonicalArgs: input.canonicalArgs,
      summary: input.summary,
    };
    await this.ops.createPrepared({
      id: operationId,
      principalId: input.principalId,
      portalKey: input.portalKey,
      tool: input.tool,
      operationKind: input.operationKind,
      argsHash: input.argsHash,
      target: input.summary.target,
      expectedStateHash: input.expectedStateHash,
      fileHash: input.fileHash,
      policyVersion: this.policyVersion,
      planEncrypted: this.box.encrypt(JSON.stringify(plan), operationId),
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    });
    return { operationId, expiresAt };
  }

  async readPlan(
    operationId: string,
    principalId: string,
    portalKey: string,
  ): Promise<{ view: OperationView; plan: StoredPlan }> {
    const row = await this.ops.getOwn(operationId, principalId, portalKey);
    if (!row) throw new AppError('NOT_FOUND', 'Операция не найдена', { operationId });
    const plan = JSON.parse(this.box.decrypt(row.plan_encrypted, operationId)) as StoredPlan;
    const view = await this.ops.view(operationId, principalId, portalKey);
    if (!view) throw new AppError('NOT_FOUND', 'Операция не найдена', { operationId });
    return { view, plan };
  }

  /** Вызывается только из интерактивной CLI после ручного ввода человека. */
  async approve(operationId: string, principalId: string, portalKey: string): Promise<OperationView> {
    const row = await this.ops.getOwn(operationId, principalId, portalKey);
    if (!row) throw new AppError('NOT_FOUND', 'Операция не найдена', { operationId });
    const r = await this.ops.approve(operationId);
    if (r === 'expired') {
      throw new AppError('APPROVAL_EXPIRED', 'Срок подтверждения истёк; создайте новый план', {
        operationId,
      });
    }
    if (r === 'not-prepared') {
      throw new AppError(
        'CONFLICT',
        `Операция в состоянии ${row.status}; подтвердить можно только prepared`,
        {
          operationId,
          status: row.status,
        },
      );
    }
    const view = await this.ops.view(operationId, principalId, portalKey);
    if (!view) throw new AppError('INTERNAL_ERROR', 'Операция исчезла после подтверждения');
    return view;
  }

  async deny(operationId: string, principalId: string, portalKey: string): Promise<OperationView> {
    const row = await this.ops.getOwn(operationId, principalId, portalKey);
    if (!row) throw new AppError('NOT_FOUND', 'Операция не найдена', { operationId });
    if (!(await this.ops.deny(operationId))) {
      throw new AppError('CONFLICT', `Операция в состоянии ${row.status}; отклонить нельзя`, {
        operationId,
        status: row.status,
      });
    }
    const view = await this.ops.view(operationId, principalId, portalKey);
    if (!view) throw new AppError('INTERNAL_ERROR', 'Операция исчезла после отказа');
    return view;
  }

  listPending(principalId: string, portalKey: string): Promise<OperationView[]> {
    return this.ops.listPending(principalId, portalKey);
  }

  /** Безопасная сводка для ответа модели: только summary без служебных полей. */
  static publicPlan(summary: PlanSummary): Record<string, unknown> {
    return { action: summary.action, target: summary.target, details: summary.details, risks: summary.risks };
  }
}

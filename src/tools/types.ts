/**
 * Контракт инструмента (ТЗ §15.1): стабильное имя, русское описание, Zod-схемы входа/выхода,
 * верные MCP annotations, тип операции. Handler работает только через сервисы контекста;
 * прямого доступа к секретам и fetch у него нет.
 */
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import type { CapabilityService } from '../bitrix/capabilities.js';
import type { BitrixClient } from '../bitrix/client.js';
import type { OperationKind } from '../bitrix/method-registry.js';
import type { CursorStore } from '../bitrix/pagination.js';
import type { AppConfig } from '../config/env.js';
import type { ModuleName } from '../config/modules.js';
import type { Policies } from '../config/policy.js';
import type { AuditLog } from '../logging/audit.js';
import type { AppLogger } from '../logging/logger.js';
import type { FileStaging } from '../files/staging.js';
import type { MutationExecutor } from '../security/mutation-executor.js';
import type { OutputPolicyEngine } from '../security/output-policy.js';
import type { OperationsStore } from '../storage/operations.js';
import type { Envelope } from '../mcp/result.js';

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolContext {
  readonly requestId: string;
  readonly principal: Principal;
  readonly config: AppConfig;
  readonly policies: Policies;
  readonly bitrix: BitrixClient;
  readonly capabilities: CapabilityService;
  readonly cursors: CursorStore;
  readonly operations: OperationsStore;
  /** Единственный путь к записи в Bitrix24 (ТЗ §12 mutation-executor). */
  readonly mutations: MutationExecutor;
  readonly files: FileStaging;
  readonly audit: AuditLog;
  readonly outputPolicy: OutputPolicyEngine;
  readonly logger: AppLogger;
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
}

export interface ToolDefinition<TInput extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly module: ModuleName;
  readonly title: string;
  /** Русское описание: назначение, «использовать, когда…», ограничения. */
  readonly description: string;
  readonly operation: OperationKind;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: TInput;
  /** Схема полезной нагрузки `data` успешного ответа (для документации и outputSchema). */
  readonly outputDataSchema: z.ZodType;
  /** Требует ли инструмент связи с Bitrix24 (для smoke без портала). */
  readonly requiresBitrix: boolean;
  readonly handler: (args: z.output<TInput>, ctx: ToolContext) => Promise<Envelope>;
}

export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const LOCAL_READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function defineTool<TInput extends z.ZodObject>(def: ToolDefinition<TInput>): ToolDefinition<TInput> {
  return def;
}

export function isWriteOperation(kind: OperationKind): boolean {
  return kind === 'create' || kind === 'update' || kind === 'delete' || kind === 'upload';
}

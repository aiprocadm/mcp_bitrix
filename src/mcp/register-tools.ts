/**
 * Регистрация инструментов в McpServer и единый диспетчер вызова (ТЗ §4.3):
 * контекст → политика (модуль, режим записи, роль) → handler → аудит → output policy →
 * лимит объёма → CallToolResult. Скрытые инструменты (read-only) отключены в SDK и
 * дополнительно отказывают в handler (T10).
 */
import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import type { AppContainer } from '../app/container.js';
import { roleAtLeast } from '../auth/principal.js';
import { AppError } from '../errors/app-error.js';
import { isWriteOperation, type ToolContext, type ToolDefinition } from '../tools/types.js';
import { enforceResponseLimit, envelopeSchema, fail, toCallToolResult, type Envelope } from './result.js';

export interface RegisteredToolInfo {
  name: string;
  module: string;
  operation: string;
  visible: boolean;
  hiddenReason?: string;
}

export function hiddenReason(def: ToolDefinition, app: AppContainer): string | undefined {
  const p = app.config.policy;
  if (isWriteOperation(def.operation) && p.readOnlyMode) return 'READ_ONLY_MODE=true';
  if (def.operation === 'delete' && !p.enableDestructiveTools) return 'ENABLE_DESTRUCTIVE_TOOLS=false';
  if (def.name === 'bitrix_rest_call' && (!p.enableRawRest || p.rawRestMode === 'disabled'))
    return 'ENABLE_RAW_REST=false';
  const denied = app.policies.access.deniedTools[app.principal.role] ?? [];
  if (denied.includes(def.name)) return `запрещён ролью ${app.principal.role}`;
  return undefined;
}

/** Проверки до вызова handler. Выполняются на каждом tools/call, даже если инструмент скрыт. */
export function gate(def: ToolDefinition, app: AppContainer): void {
  if (!app.config.policy.enabledModules.has(def.module)) {
    throw new AppError('FEATURE_UNAVAILABLE', `Модуль ${def.module} выключен в ENABLED_MODULES`, {
      nextAction: 'Включите модуль в конфигурации',
    });
  }
  const reason = hiddenReason(def, app);
  if (reason) {
    if (reason.startsWith('READ_ONLY_MODE')) {
      throw new AppError('READ_ONLY_MODE', 'Сервер в режиме только чтения; запись выключена', {
        nextAction:
          'Включите запись (READ_ONLY_MODE=false) только после проверки подключения и тестовых объектов',
      });
    }
    if (reason.startsWith('запрещён')) throw new AppError('ACCESS_DENIED', `Инструмент ${reason}`);
    throw new AppError('METHOD_NOT_ALLOWED', `Инструмент отключён: ${reason}`);
  }
  if (isWriteOperation(def.operation) && !roleAtLeast(app.principal.role, 'operator')) {
    throw new AppError('ACCESS_DENIED', 'Роль reader не может выполнять записи');
  }
  if (def.operation === 'delete' && !roleAtLeast(app.principal.role, 'administrator')) {
    throw new AppError('ACCESS_DENIED', 'Удаления доступны только роли administrator');
  }
}

export async function dispatch(
  def: ToolDefinition,
  args: unknown,
  app: AppContainer,
  signal?: AbortSignal,
): Promise<Envelope> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const ctx: ToolContext = {
    requestId,
    principal: app.principal,
    config: app.config,
    policies: app.policies,
    bitrix: app.bitrix,
    capabilities: app.capabilities,
    cursors: app.cursors,
    operations: app.operations,
    audit: app.audit,
    outputPolicy: app.outputPolicy,
    logger: app.logger.child({ requestId, tool: def.name }),
    signal,
    startedAt,
  };
  let envelope: Envelope;
  try {
    gate(def, app);
    const parsed = def.inputSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.') ?? '';
      throw new AppError(
        'VALIDATION_ERROR',
        `Неверные параметры: ${field} ${issue?.message ?? ''}`.trim(),
        field ? { field } : {},
      );
    }
    envelope = await def.handler(parsed.data, ctx);
  } catch (e) {
    const err = AppError.from(e);
    if (err.code === 'INTERNAL_ERROR')
      ctx.logger.error({ reason: err.details.reason }, 'tool handler failed');
    envelope = fail(err, { requestId, durationMs: Date.now() - startedAt });
  }
  app.audit.record({
    requestId,
    principalId: app.principal.id,
    portalKey: app.auth.portalKey,
    tool: def.name,
    method: envelope.success ? envelope.meta.method : envelope.error.details.method,
    apiVersion: envelope.meta.apiVersion,
    operationKind: def.operation,
    outcome: envelope.success
      ? 'success'
      : envelope.error.code === 'READ_ONLY_MODE' ||
          envelope.error.code === 'ACCESS_DENIED' ||
          envelope.error.code === 'METHOD_NOT_ALLOWED'
        ? 'denied'
        : 'error',
    attempts: envelope.success ? envelope.meta.attempts : undefined,
    errorCode: envelope.success ? undefined : envelope.error.code,
    durationMs: envelope.meta.durationMs,
  });
  if (envelope.success) envelope = { ...envelope, data: app.outputPolicy.apply(envelope.data) };
  return enforceResponseLimit(envelope, app.config.limits.maxResponseBytes);
}

export function registerTools(server: McpServer, app: AppContainer): RegisteredToolInfo[] {
  const infos: RegisteredToolInfo[] = [];
  for (const def of app.tools) {
    const registered: RegisteredTool = server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: envelopeSchema(def.outputDataSchema),
        annotations: { ...def.annotations },
      },
      async (args, ctx): Promise<CallToolResult> => {
        // Схема уже проверена SDK; повторная проверка в dispatch защищает прямые вызовы (CLI/HTTP-обёртки).
        const envelope = await dispatch(def, args, app, ctx.mcpReq.signal);
        return toCallToolResult(envelope) as CallToolResult;
      },
    );
    const reason = hiddenReason(def, app);
    if (reason) registered.disable();
    infos.push({
      name: def.name,
      module: def.module,
      operation: def.operation,
      visible: !reason,
      ...(reason ? { hiddenReason: reason } : {}),
    });
  }
  return infos;
}

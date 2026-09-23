import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, LOCAL_READ_ANNOTATIONS } from '../types.js';

export const operationStatusTool = defineTool({
  name: 'operation_status',
  module: 'system',
  title: 'Состояние операции записи',
  description:
    'Состояние своей операции записи по operationId: prepared, approved, executing, succeeded, failed, unknown, denied, expired. ' +
    'Использовать после ответа APPROVAL_REQUIRED или OPERATION_OUTCOME_UNKNOWN. Не обращается к Bitrix24 и не выдаёт секреты.',
  operation: 'read',
  annotations: LOCAL_READ_ANNOTATIONS,
  requiresBitrix: false,
  inputSchema: z.object({ operationId: z.uuid() }).strict(),
  outputDataSchema: z.object({
    operationId: z.string(),
    tool: z.string(),
    operationKind: z.string(),
    status: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    approvedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    attempts: z.number(),
    errorCode: z.string().nullable(),
    target: z.string().nullable(),
  }),
  handler: (args, ctx) => {
    const view = ctx.operations.view(args.operationId, ctx.principal.id, ctx.bitrix.auth.portalKey);
    if (!view) {
      throw new AppError('NOT_FOUND', 'Операция не найдена или принадлежит другому субъекту', {
        operationId: args.operationId,
      });
    }
    return Promise.resolve(ok(view, { requestId: ctx.requestId, durationMs: Date.now() - ctx.startedAt }));
  },
});

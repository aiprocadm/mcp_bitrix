/**
 * Тестовый инструмент записи, проходящий через MutationExecutor как настоящие MVP-записи.
 * Позволяет проверить контур подтверждений до появления crm_create_record (этап 7).
 */
import { z } from 'zod';
import { AppError } from '../../src/errors/app-error.js';
import { ok } from '../../src/mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../src/schemas/common.js';
import {
  CREATE_ANNOTATIONS,
  defineTool,
  type ToolContext,
  type ToolDefinition,
} from '../../src/tools/types.js';

export const fakeCreateInput = z
  .object({ title: z.string().min(1).max(255), ...writeArgsShape })
  .strict()
  .superRefine(requireIdempotencyUnlessDryRun);

export interface FakeWriteHooks {
  performCalls: number;
  verifyCalls: number;
  precheckCalls: number;
  failPerformWith?: AppError | undefined;
  failPrecheckWith?: AppError | undefined;
  failVerify?: boolean;
}

export function makeFakeCreateTool(hooks: FakeWriteHooks): ToolDefinition {
  return defineTool({
    name: 'test_create',
    module: 'crm',
    title: 'тестовая запись',
    description: 'использовать только в тестах',
    operation: 'create',
    annotations: CREATE_ANNOTATIONS,
    requiresBitrix: true,
    inputSchema: fakeCreateInput,
    outputDataSchema: z.object({
      id: z.number().nullable(),
      operationId: z.string().optional(),
      verified: z.boolean().optional(),
    }),
    handler: async (args, ctx: ToolContext) => {
      const outcome = await ctx.mutations.execute({
        requestId: ctx.requestId,
        principal: {
          id: ctx.principal.id,
          portalKey: ctx.bitrix.auth.portalKey,
          portalOrigin: ctx.bitrix.auth.portalOrigin,
        },
        tool: 'test_create',
        operationKind: 'create',
        args,
        summary: {
          action: 'Создать тестовую сделку',
          target: 'crm.deal',
          portalOrigin: ctx.bitrix.auth.portalOrigin,
          details: { TITLE: args.title },
          risks: ['Могут сработать роботы стадии NEW'],
        },
        validationLevel: 'local',
        precheck: async () => {
          hooks.precheckCalls += 1;
          if (hooks.failPrecheckWith) throw hooks.failPrecheckWith;
          await Promise.resolve();
        },
        perform: async () => {
          hooks.performCalls += 1;
          if (hooks.failPerformWith) throw hooks.failPerformWith;
          const r = await ctx.bitrix.call(
            'legacy',
            'crm.deal.add',
            { fields: { TITLE: args.title } },
            { requestId: ctx.requestId },
          );
          return { id: Number(r.result), result: { id: Number(r.result) } };
        },
        verify: async (performed) => {
          hooks.verifyCalls += 1;
          if (hooks.failVerify) throw new AppError('BITRIX_TIMEOUT', 'verify timeout');
          await Promise.resolve();
          return { verified: performed.id !== null, warnings: [] };
        },
      });
      if (outcome.kind === 'dry-run') {
        return ok(
          { id: null, dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel } as never,
          {
            requestId: ctx.requestId,
            durationMs: 0,
          },
        );
      }
      return ok(
        {
          id: outcome.id as number | null,
          operationId: outcome.operationId,
          verified: outcome.verified,
          replayed: outcome.replayed,
        } as never,
        { requestId: ctx.requestId, durationMs: 0, warnings: outcome.warnings },
      );
    },
  });
}

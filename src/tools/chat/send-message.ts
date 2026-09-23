/**
 * chat_send_message (ТЗ §9.9, §10.1, §15.3): одно сообщение в известный диалог от владельца вебхука.
 * dialogId не конструируется из ФИО; план содержит точный dialogId, название/тип диалога и ПОЛНЫЙ текст.
 * После отправки — попытка прочитать сообщение обратно; недоступное чтение → verified=false.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool, type ToolContext } from '../types.js';
import { asText } from '../crm/deal-fields.js';

/** Личный диалог — числовой ID сотрудника; групповой чат — chat<id>. Ничего другого (ТЗ §9.9). */
export const DIALOG_ID_RE = /^(chat\d{1,15}|\d{1,15})$/;

interface DialogInfo {
  id: string;
  type: string;
  title: string;
  userCounter: number | null;
}

async function getDialogInfo(ctx: ToolContext, dialogId: string): Promise<DialogInfo> {
  const r = await ctx.bitrix.call(
    'legacy',
    'im.dialog.get',
    { DIALOG_ID: dialogId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const d =
    r.result && typeof r.result === 'object' && !Array.isArray(r.result)
      ? (r.result as Record<string, unknown>)
      : undefined;
  if (!d)
    throw new AppError('NOT_FOUND', 'Диалог не найден или недоступен', {
      method: 'im.dialog.get',
      apiVersion: 'legacy',
    });
  const counter = Number(d['user_counter']);
  return {
    id: dialogId,
    type: asText(d['type']) || 'unknown',
    title: asText(d['title']) || asText(d['name']) || '(без названия)',
    userCounter: Number.isFinite(counter) && counter > 0 ? counter : null,
  };
}

export const chatSendMessageTool = defineTool({
  name: 'chat_send_message',
  module: 'chat',
  title: 'Отправить сообщение в чат',
  description:
    'Отправить одно сообщение в известный диалог Bitrix24 от имени владельца интеграции (im.message.add). ' +
    'dialogId — числовой ID сотрудника для личного диалога или chat<id> для группового чата; из имён он не выводится. ' +
    'Использовать только когда пользователь явно просит написать в конкретный чат и dialogId известен. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом (диалог, название, полный текст) — ' +
    'сообщение ещё не отправлено; после подтверждения человеком повторный вызов с approvalId отправляет ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      dialogId: z
        .string()
        .regex(DIALOG_ID_RE, 'числовой ID сотрудника или chat<id>')
        .describe('ID диалога: 123 или chat456'),
      message: z.string().min(1).max(10_000).describe('Полный текст сообщения'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    messageId: z.number().nullable().optional(),
    dialogId: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const dialog = await getDialogInfo(ctx, args.dialogId);
    const text = args.message;
    const risks = [
      'Получатели увидят сообщение сразу и получат уведомление; отозвать сообщение сервер не умеет',
    ];
    if (dialog.userCounter && dialog.userCounter > 2)
      risks.push(`Групповой чат: участников ${dialog.userCounter}`);
    if (dialog.type === 'user') risks.push('Личный диалог с сотрудником');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'chat_send_message',
      operationKind: 'create',
      args,
      summary: {
        action: `Отправить сообщение в «${dialog.title}» (${args.dialogId})`,
        target: `chat:${args.dialogId}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'im.message.add',
          dialogId: args.dialogId,
          dialogType: dialog.type,
          dialogTitle: dialog.title,
          participants: dialog.userCounter,
          sender: 'владелец вебхука',
          message: text,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const params: JsonObject = { DIALOG_ID: args.dialogId, MESSAGE: text };
        const r = await ctx.bitrix.call('legacy', 'im.message.add', params, {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        const id = typeof r.result === 'number' ? r.result : Number(asText(r.result));
        if (!Number.isInteger(id) || id <= 0) {
          throw new AppError(
            'OPERATION_OUTCOME_UNKNOWN',
            'im.message.add вернул ответ без ID сообщения; исход неизвестен',
            {
              method: 'im.message.add',
              apiVersion: 'legacy',
              reason: 'outcome-unknown',
              nextAction: 'Проверьте чат в Bitrix24 перед повторной отправкой',
            },
          );
        }
        return { id, result: { messageId: id, dialogId: args.dialogId } };
      },
      verify: async (performed) => {
        const r = await ctx.bitrix.call(
          'legacy',
          'im.dialog.messages.get',
          { DIALOG_ID: args.dialogId, LIMIT: 20 },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const obj =
          r.result && typeof r.result === 'object' && !Array.isArray(r.result)
            ? (r.result as Record<string, unknown>)
            : {};
        const messages = Array.isArray(obj['messages']) ? (obj['messages'] as Record<string, unknown>[]) : [];
        const found = messages.find((m) => Number(m['id']) === Number(performed.id));
        if (!found)
          return {
            verified: false,
            warnings: ['Сообщение отправлено, но не найдено в последних 20 сообщениях диалога'],
          };
        const sameText = asText(found['text']) === text;
        return {
          verified: sameText,
          warnings: sameText
            ? []
            : ['Текст в чате отличается от отправленного (возможна обработка BB-кодов/ссылок порталом)'],
        };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        { dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: сообщение не отправлялось, подтверждение не создано'],
        },
      );
    }
    return ok(
      {
        messageId: typeof outcome.id === 'number' ? outcome.id : null,
        dialogId: args.dialogId,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'im.message.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

/**
 * Запись в Базу знаний 2.0 (ТЗ §9.14, §8.2, §15.3; REST 3.0 `note.*`):
 * kb2_base_create, kb2_document_create, kb2_document_update — только через MutationExecutor
 * (план → подтверждение человеком → одна запись → сверка повторным чтением).
 *
 * Совместное редактирование (T38): note.document.update по умолчанию вызывается с overwrite=false; ошибка
 * NOTE_DOCUMENT_HAS_UNSAVED_CHANGES или изменившийся contentHash → CONFLICT (COLLABORATIVE_EDIT_CONFLICT).
 * overwrite=true автоматически не включается: это отдельный аргумент, входящий в хеш подтверждения,
 * с отдельным риском в плане. Наш mutex не блокирует редактор Bitrix24, атомарного CAS у API нет —
 * повторное чтение в precheck лишь сужает окно гонки.
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import {
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import {
  appendMarkdown,
  byteLength,
  callV3,
  collaborativeConflict,
  contentHash,
  getCollection,
  getDocument,
  INPUT_MARKDOWN_MAX_BYTES,
  INVALID_PARENT_CODE,
  invalidParent,
  itemOf,
  normalizeCollection,
  normalizeDocument,
  planText,
  UNSAVED_CHANGES_CODE,
  UPSTREAM_MARKDOWN_MAX_BYTES,
  upstreamCodeOf,
  type Kb2Collection,
  type Kb2Document,
} from './service.js';

const titleSchema = z.string().trim().min(1).max(255);

const markdownSchema = z
  .string()
  .max(INPUT_MARKDOWN_MAX_BYTES)
  .refine((s) => byteLength(s) <= INPUT_MARKDOWN_MAX_BYTES, {
    message: `не более ${String(INPUT_MARKDOWN_MAX_BYTES)} байт UTF-8 (256 KiB, предел сервера MCP)`,
  });

// ---------- kb2_base_create ----------

export const kb2BaseCreateTool = defineTool({
  name: 'kb2_base_create',
  module: 'knowledgeBase',
  title: 'Создать базу знаний 2.0',
  description:
    'Создать новую базу Базы знаний 2.0 (REST 3.0 note.collection.add; поля name и position по документации). ' +
    'Использовать, когда пользователь явно просит завести новую базу; для документов в существующей базе — kb2_document_create. ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с планом; после подтверждения человеком повтор с approvalId создаёт базу один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      title: titleSchema.describe('Название базы (fields.name), до 255 символов'),
      position: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .optional()
        .describe('Позиция в общем списке баз (fields.position), по умолчанию 0'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    collectionId: z.number().optional(),
    name: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const method = 'note.collection.add';
    const fields: Record<string, string | number> = { name: args.title };
    if (args.position !== undefined) fields['position'] = args.position;
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb2_base_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать базу знаний 2.0 «${args.title}»`,
        target: 'note.collection',
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method, apiVersion: 'v3', fields },
        risks: [
          'Права доступа к новой базе выставляются порталом по умолчанию; проверьте их в интерфейсе Bitrix24',
          'Создание базы не отменяется этим сервером: удаление/архивирование — вручную в интерфейсе',
        ],
      },
      validationLevel: 'local',
      perform: async () => {
        const result = await callV3(ctx, method, { fields });
        let created: Kb2Collection;
        try {
          created = normalizeCollection(itemOf(result, method), method);
        } catch {
          throw outcomeUnknown(
            method,
            'v3',
            'Проверьте список баз (kb2_bases_list) перед повторной попыткой',
          );
        }
        return {
          id: created.collectionId,
          result: { collectionId: created.collectionId, name: created.name },
        };
      },
      verify: async (performed) => {
        const after = await getCollection(ctx, Number(performed.id));
        const warnings = after.name === args.title ? [] : [`Название базы после записи: «${after.name}»`];
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: {},
      method,
      apiVersion: 'v3',
      resultFields: ['collectionId', 'name'],
    });
  },
});

// ---------- kb2_document_create ----------

async function assertParent(ctx: ToolContext, parentId: number, collectionId: number): Promise<Kb2Document> {
  let parent: Kb2Document;
  try {
    parent = await getDocument(ctx, parentId);
  } catch (e) {
    if (AppError.is(e) && e.code === 'NOT_FOUND') {
      throw invalidParent('Родительский документ не найден или недоступен');
    }
    throw e;
  }
  if (parent.collectionId !== collectionId) {
    throw invalidParent(
      `Родительский документ #${String(parentId)} принадлежит другой базе (${String(parent.collectionId)}), а не ${String(collectionId)}`,
    );
  }
  return parent;
}

export const kb2DocumentCreateTool = defineTool({
  name: 'kb2_document_create',
  module: 'knowledgeBase',
  title: 'Создать документ базы 2.0',
  description:
    'Создать документ или вложенный раздел в базе Базы знаний 2.0 (REST 3.0 note.document.add): название до 255 символов, текст Markdown до 256 KiB. ' +
    'Использовать, когда пользователь просит добавить страницу; вложенность — через parentId документа из той же базы (иначе INVALID_PARENT). ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с планом; после подтверждения повтор с approvalId создаёт документ один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      collectionId: idSchema.describe('ID базы (kb2_bases_list)'),
      title: titleSchema.describe('Название документа, до 255 символов'),
      parentId: idSchema
        .optional()
        .describe('ID родительского документа из той же базы (для вложенной страницы)'),
      markdown: markdownSchema.optional().describe('Начальный текст в Markdown, до 256 KiB'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    documentId: z.number().optional(),
    collectionId: z.number(),
    parentId: z.number().nullable().optional(),
    title: z.string().optional(),
    contentHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const method = 'note.document.add';
    // До плана: база существует и доступна; родитель — в той же базе (INVALID_PARENT без плана).
    const collection = await getCollection(ctx, args.collectionId);
    const parent =
      args.parentId !== undefined ? await assertParent(ctx, args.parentId, args.collectionId) : undefined;
    const fields: Record<string, string | number> = { collectionId: args.collectionId, title: args.title };
    if (args.parentId !== undefined) fields['parentId'] = args.parentId;
    if (args.markdown !== undefined) fields['markdown'] = args.markdown;
    const md = args.markdown ?? '';
    const risks = ['Документ станет виден всем, у кого есть доступ к базе'];
    if (collection.policyLevel && !['manage', 'moderate'].includes(collection.policyLevel)) {
      risks.push(`Уровень доступа к базе «${collection.policyLevel}»: портал может отказать в записи`);
    }

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb2_document_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать документ «${args.title}» в базе «${collection.name}»${parent ? ` внутри «${parent.title}»` : ''}`,
        target: `note.collection:${String(args.collectionId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method,
          apiVersion: 'v3',
          collectionId: args.collectionId,
          title: args.title,
          parentId: args.parentId ?? null,
          ...(args.markdown !== undefined ? { content: planText(args.markdown) } : { content: null }),
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (args.parentId !== undefined) await assertParent(ctx, args.parentId, args.collectionId);
      },
      perform: async () => {
        let result;
        try {
          result = await callV3(ctx, method, { fields });
        } catch (e) {
          if (upstreamCodeOf(e) === INVALID_PARENT_CODE) {
            throw invalidParent('Портал отклонил parentId: родитель не из этой базы', INVALID_PARENT_CODE);
          }
          throw e;
        }
        let created: Kb2Document;
        try {
          created = normalizeDocument(itemOf(result, method), method);
        } catch {
          throw outcomeUnknown(
            method,
            'v3',
            'Проверьте дерево базы (kb2_documents_list) перед повторной попыткой',
          );
        }
        return {
          id: created.documentId,
          result: {
            documentId: created.documentId,
            parentId: created.parentId,
            title: created.title,
            contentHash: contentHash(created.markdown),
          },
        };
      },
      verify: async (performed) => {
        const after = await getDocument(ctx, Number(performed.id));
        const warnings: string[] = [];
        if (after.collectionId !== args.collectionId) warnings.push('Документ оказался в другой базе');
        if ((after.parentId ?? null) !== (args.parentId ?? null))
          warnings.push('Родитель документа отличается от запрошенного');
        if (after.title !== args.title) warnings.push(`Название после записи: «${after.title}»`);
        if (contentHash(after.markdown) !== contentHash(md)) {
          warnings.push(
            'Текст после записи отличается от отправленного (возможна нормализация Markdown порталом)',
          );
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { collectionId: args.collectionId },
      method,
      apiVersion: 'v3',
      resultFields: ['documentId', 'parentId', 'title', 'contentHash'],
    });
  },
});

// ---------- kb2_document_update ----------

export const kb2DocumentUpdateTool = defineTool({
  name: 'kb2_document_update',
  module: 'knowledgeBase',
  title: 'Дописать или переписать документ базы 2.0',
  description:
    'Дописать (mode=append) или переписать (mode=replace) текст документа Базы знаний 2.0 и при необходимости название ' +
    '(REST 3.0 note.document.get + note.document.update). Использовать, когда пользователь явно просит изменить документ. ' +
    'Сначала kb2_document_get: его contentHash передаётся как expectedStateHash (для append и overwrite=true обязателен). ' +
    'Если документ правят в редакторе Bitrix24 — CONFLICT (COLLABORATIVE_EDIT_CONFLICT); overwrite=true (затирание несохранённых правок) ' +
    'только отдельным планом по явному решению человека. Порядок: APPROVAL_REQUIRED → подтверждение → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      documentId: idSchema.describe('ID документа'),
      mode: z
        .enum(['append', 'replace'])
        .describe('append — дописать в конец; replace — заменить весь текст'),
      markdown: markdownSchema.describe(
        'Текст Markdown: добавляемый (append) или новый целиком (replace), до 256 KiB',
      ),
      title: titleSchema.optional().describe('Новое название документа, до 255 символов'),
      overwrite: z
        .boolean()
        .default(false)
        .describe(
          'true — принудительно затереть несохранённые правки совместного редактора. Не включайте без явного решения человека',
        ),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun)
    .superRefine((data, rc) => {
      if (data.dryRun || data.expectedStateHash) return;
      if (data.mode === 'append') {
        rc.addIssue({
          code: 'custom',
          path: ['expectedStateHash'],
          message: 'обязателен для mode=append: передайте contentHash из kb2_document_get',
        });
      } else if (data.overwrite) {
        rc.addIssue({
          code: 'custom',
          path: ['expectedStateHash'],
          message: 'обязателен при overwrite=true: передайте contentHash из свежего kb2_document_get',
        });
      }
    }),
  outputDataSchema: z.object({
    documentId: z.number(),
    mode: z.enum(['append', 'replace']),
    contentHash: z.string().optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const method = 'note.document.update';
    const current = await getDocument(ctx, args.documentId);
    const currentHash = contentHash(current.markdown);
    // С approvalId сверку делают исполнитель (mismatch/replay) и precheck: после записи хеш закономерно другой.
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw collaborativeConflict(
        'Текст документа изменился после чтения: expectedStateHash не совпадает с текущим contentHash',
      );
    }
    const nextMarkdown = (base: string) =>
      args.mode === 'append' ? appendMarkdown(base, args.markdown) : args.markdown;
    const assertSize = (text: string) => {
      if (byteLength(text) > UPSTREAM_MARKDOWN_MAX_BYTES) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Итоговый текст документа превысит документированный предел 1 MiB',
          {
            field: 'markdown',
            reason: 'MARKDOWN_TOO_LARGE',
            nextAction: 'Сократите текст или разделите документ на несколько страниц',
          },
        );
      }
    };
    if (!args.approvalId) assertSize(nextMarkdown(current.markdown));

    const risks: string[] = [
      'Наш сервер не блокирует редактор Bitrix24 и у API нет атомарной проверки версии (CAS): ' +
        'повторное чтение перед записью сужает окно гонки, но не исключает конкурирующую правку',
    ];
    if (args.mode === 'replace') risks.push('mode=replace: весь текущий текст документа будет заменён новым');
    if (args.overwrite) {
      risks.unshift(
        'overwrite=true: ПРИНУДИТЕЛЬНО ЗАТРЁТ НЕСОХРАНЁННЫЕ ПРАВКИ совместного редактора; ' +
          'активные редакторы получат сигнал перезагрузить содержимое — их несохранённый текст будет потерян',
      );
    }
    if (!args.expectedStateHash) {
      risks.push(
        'expectedStateHash не передан: если документ изменят до выполнения, замена всё равно применится',
      );
    }
    const content =
      args.mode === 'append'
        ? { append: planText(args.markdown), resultChars: nextMarkdown(current.markdown).length }
        : {
            replaceWith: planText(args.markdown),
            before: {
              chars: current.markdown.length,
              contentHash: currentHash,
              head: current.markdown.slice(0, 500),
            },
          };

    // Итоговый текст считается в precheck от свежего чтения (для append база сверена по expectedStateHash).
    let planned: string | undefined;
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb2_document_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action:
          `${args.mode === 'append' ? 'Дописать в конец документа' : 'Заменить текст документа'} #${String(args.documentId)} «${current.title}»` +
          (args.title !== undefined && args.title !== current.title ? `; название → «${args.title}»` : '') +
          (args.overwrite ? ' (overwrite=true)' : ''),
        target: `note.document:${String(args.documentId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method,
          apiVersion: 'v3',
          documentId: args.documentId,
          mode: args.mode,
          baseContentHash: args.expectedStateHash ?? currentHash,
          ...(args.title !== undefined ? { title: { from: current.title, to: args.title } } : {}),
          content,
          overwrite: args.overwrite,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await getDocument(ctx, args.documentId);
        if (args.expectedStateHash && contentHash(fresh.markdown) !== args.expectedStateHash) {
          throw collaborativeConflict('Текст документа изменился после подтверждения; запись отменена');
        }
        assertSize(nextMarkdown(fresh.markdown));
        planned = nextMarkdown(fresh.markdown);
      },
      perform: async () => {
        const text = planned ?? nextMarkdown(current.markdown);
        const fields: Record<string, string> = { markdown: text };
        if (args.title !== undefined) fields['title'] = args.title;
        let result;
        try {
          result = await callV3(ctx, method, { id: args.documentId, fields, overwrite: args.overwrite });
        } catch (e) {
          if (upstreamCodeOf(e) === UNSAVED_CHANGES_CODE) {
            // T38: не повторяем с overwrite=true — это отдельное решение человека через новый план.
            throw collaborativeConflict(
              'В редакторе Bitrix24 есть несохранённые правки этого документа; запись не выполнена (overwrite=false)',
              UNSAVED_CHANGES_CODE,
            );
          }
          throw e;
        }
        let updated: Kb2Document;
        try {
          updated = normalizeDocument(itemOf(result, method), method);
        } catch {
          throw outcomeUnknown(
            method,
            'v3',
            'Перечитайте документ (kb2_document_get) перед повторной попыткой',
          );
        }
        if (updated.documentId !== args.documentId) {
          throw outcomeUnknown(
            method,
            'v3',
            'Перечитайте документ (kb2_document_get) перед повторной попыткой',
          );
        }
        return { id: args.documentId, result: { documentId: args.documentId, sentHash: contentHash(text) } };
      },
      verify: async (performed) => {
        const after = await getDocument(ctx, args.documentId);
        const warnings: string[] = [];
        const afterHash = contentHash(after.markdown);
        // Новый contentHash сохраняется в результате операции (ledger) и возвращается и при replay.
        performed.result['contentHash'] = afterHash;
        if (afterHash !== performed.result['sentHash']) {
          warnings.push(
            'Текст после записи отличается от отправленного: возможна нормализация Markdown порталом или параллельная правка — перечитайте документ',
          );
        }
        if (args.title !== undefined && after.title !== args.title)
          warnings.push(`Название после записи: «${after.title}»`);
        return { verified: warnings.length === 0, warnings };
      },
    });
    if (outcome.kind === 'dry-run') {
      return mutationResponse(ctx, outcome, {
        base: { documentId: args.documentId, mode: args.mode, stateHash: currentHash },
        method,
        apiVersion: 'v3',
      });
    }
    const hash =
      typeof outcome.result['contentHash'] === 'string' ? outcome.result['contentHash'] : undefined;
    return ok(
      {
        documentId: args.documentId,
        mode: args.mode,
        ...(hash ? { contentHash: hash, stateHash: hash } : {}),
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method,
        apiVersion: 'v3',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

/**
 * Запись в классическую базу знаний (ТЗ §9.13, T36). Всё через MutationExecutor:
 * план → подтверждение человеком → запись → сверка.
 *
 * - Статьи создаются черновиком (ACTIVE=N) и сами НЕ публикуются; публикация — отдельный kb_legacy_article_publish.
 * - Составная запись (страница + блоки) при сбое на блоках завершается PARTIAL_SUCCESS: ID страницы и статусы шагов
 *   сохраняются в ledger, повтор возвращает тот же результат без второго landing.landing.add.
 * - Замена содержимого — только конкретных blockIds после чтения, с expectedStateHash (CONFLICT по хешу блоков).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import type { Envelope } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import type { MutationOutcome } from '../../security/mutation-executor.js';
import {
  asText,
  idOf,
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import { htmlToText } from '../feed/sanitize.js';
import {
  addBlock,
  assertBlockCode,
  blockCodeSchema,
  blocksStateHash,
  contentSchema,
  formatSchema,
  getArticle,
  getBase,
  getFolder,
  kbScopeSchema,
  listBases,
  listBlocks,
  prepareBlocks,
  stepsText,
  type StepStatus,
} from './kb-service.js';

const PREVIEW_MAX = 2_000;
const preview = (html: string) => {
  const t = htmlToText(html);
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
};

const publishFlag = z
  .boolean()
  .default(false)
  .describe('Всегда false: статья остаётся черновиком. Публикация — отдельным kb_legacy_article_publish');

function rejectPublish(publish: boolean): void {
  if (publish) {
    throw new AppError('VALIDATION_ERROR', 'Публикация при создании/изменении не выполняется', {
      field: 'publish',
      reason: 'PUBLISH_IS_SEPARATE_ACTION',
      nextAction:
        'Сохраните черновик, проверьте его и опубликуйте отдельным вызовом kb_legacy_article_publish',
    });
  }
}

const errCode = (e: unknown): string => {
  const err = AppError.from(e);
  return err.details.upstreamCode ?? err.code;
};

/** Составная запись завершилась частично: сохранённый результат → PARTIAL_SUCCESS (и при replay тоже). */
function partialOrResponse(
  ctx: ToolContext,
  outcome: MutationOutcome,
  opts: Parameters<typeof mutationResponse>[2],
  describe: (r: Record<string, unknown>) => { message: string; nextAction: string },
): Envelope {
  if (outcome.kind === 'executed' && outcome.result['partial'] === true) {
    const d = describe(outcome.result);
    throw new AppError('PARTIAL_SUCCESS', d.message, {
      operationId: outcome.operationId,
      status: 'partial',
      reason: 'STEPS_INCOMPLETE',
      nextAction: d.nextAction,
    });
  }
  return mutationResponse(ctx, outcome, opts);
}

// ---------- kb_legacy_base_create ----------

export const kbLegacyBaseCreateTool = defineTool({
  name: 'kb_legacy_base_create',
  module: 'knowledgeBase',
  title: 'Создать классическую базу знаний',
  description:
    'Создать классическую базу знаний (сайт landing) через landing.site.add с согласованными fields.TYPE и внутренним scope ' +
    '(KNOWLEDGE или GROUP). Использовать, когда пользователь явно просит новую базу знаний. База создаётся неопубликованной ' +
    '(ACTIVE=N). Порядок: APPROVAL_REQUIRED с планом → подтверждение человеком → повтор с approvalId создаёт базу один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      title: z.string().trim().min(1).max(255).describe('Название базы'),
      code: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i, 'латиница, цифры, «-» и «_», без «/»')
        .optional()
        .describe('Символьный код; без него генерируется порталом из названия'),
      description: z.string().trim().max(255).optional(),
      scope: kbScopeSchema,
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({ siteId: z.number().nullable().optional(), ...mutationOutputShape }),
  handler: async (args, ctx) => {
    const fields: JsonObject = {
      TITLE: args.title,
      // CODE обязателен по документации; пустая строка → код генерируется из TITLE.
      CODE: args.code ?? '',
      TYPE: args.scope,
      ...(args.description ? { DESCRIPTION: args.description } : {}),
    };
    const risks = [
      'База создаётся неопубликованной (ACTIVE=N); статьи в ней — черновики до явной публикации',
    ];
    if (args.scope === 'GROUP') risks.push('Тип GROUP доступен только на порталах с базами знаний групп');
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb_legacy_base_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать базу знаний «${args.title}» (${args.scope})`,
        target: `landing.site:new:${args.scope}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'landing.site.add', scope: args.scope, fields },
        risks,
      },
      validationLevel: 'local',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'landing.site.add',
          { scope: args.scope, fields },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const id = idOf(r.result);
        if (id === undefined)
          throw outcomeUnknown(
            'landing.site.add',
            'legacy',
            'Проверьте список баз (kb_legacy_bases_list) перед новой попыткой',
          );
        return { id, result: { siteId: id } };
      },
      verify: async (performed) => {
        const base = await getBase(ctx, args.scope, Number(performed.id));
        const warnings: string[] = [];
        if (base.type !== args.scope)
          warnings.push(`Тип базы в портале ${base.type}, ожидался ${args.scope}`);
        if (base.title !== args.title) warnings.push('Название базы в портале отличается от плана');
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, { base: {}, method: 'landing.site.add', resultFields: ['siteId'] });
  },
});

// ---------- kb_legacy_section_create ----------

export const kbLegacySectionCreateTool = defineTool({
  name: 'kb_legacy_section_create',
  module: 'knowledgeBase',
  title: 'Создать раздел классической базы знаний',
  description:
    'Создать раздел (папку) в классической базе знаний через landing.site.addFolder (siteId, название, родительский раздел). ' +
    'Использовать, когда пользователь просит завести раздел для статей. Раздел создаётся неактивным (ACTIVE=N) и публикуется ' +
    'вместе со статьёй. Если метод недоступен на портале — FEATURE_UNAVAILABLE. Порядок: APPROVAL_REQUIRED → подтверждение → повтор с approvalId.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      siteId: idSchema.describe('ID базы знаний'),
      title: z.string().trim().min(1).max(255).describe('Название раздела'),
      parentId: idSchema.optional().describe('ID родительского раздела; без него — в корне базы'),
      code: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i, 'латиница, цифры, «-» и «_», без «/»')
        .optional(),
      scope: kbScopeSchema,
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    siteId: z.number(),
    sectionId: z.number().nullable().optional(),
    sectionType: z.literal('folder').optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const base = await getBase(ctx, args.scope, args.siteId);
    const parent =
      args.parentId !== undefined ? await getFolder(ctx, args.scope, args.siteId, args.parentId) : undefined;
    const fields: JsonObject = {
      TITLE: args.title,
      ...(args.code ? { CODE: args.code } : {}),
      ...(args.parentId !== undefined ? { PARENT_ID: args.parentId } : {}),
    };
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb_legacy_section_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать раздел «${args.title}» в базе «${base.title}»${parent ? ` внутри «${asText(parent['TITLE'])}»` : ''}`,
        target: `landing.site:${String(args.siteId)}:folder`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'landing.site.addFolder', scope: args.scope, siteId: args.siteId, fields },
        risks: ['Раздел создаётся неактивным; он станет видимым при публикации статьи в нём'],
      },
      validationLevel: 'local',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'landing.site.addfolder',
          { scope: args.scope, siteId: args.siteId, fields },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const id = idOf(r.result);
        if (id === undefined)
          throw outcomeUnknown(
            'landing.site.addFolder',
            'legacy',
            'Проверьте разделы базы в интерфейсе перед новой попыткой',
          );
        return { id, result: { sectionId: id, sectionType: 'folder' } };
      },
      verify: async (performed) => {
        const folder = await getFolder(ctx, args.scope, args.siteId, Number(performed.id));
        const warnings: string[] = [];
        if (asText(folder['TITLE']) !== args.title)
          warnings.push('Название раздела в портале отличается от плана');
        if (args.parentId !== undefined && idOf(folder['PARENT_ID']) !== args.parentId)
          warnings.push('Родительский раздел в портале отличается от плана');
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { siteId: args.siteId },
      method: 'landing.site.addFolder',
      resultFields: ['sectionId', 'sectionType'],
    });
  },
});

// ---------- kb_legacy_article_create ----------

export const kbLegacyArticleCreateTool = defineTool({
  name: 'kb_legacy_article_create',
  module: 'knowledgeBase',
  title: 'Создать статью классической базы знаний',
  description:
    'Создать статью классической базы знаний: страница landing.landing.add и HTML-блоки landing.landing.addblock в заданном порядке. ' +
    'Использовать, когда пользователь просит написать статью в базу знаний. Статья создаётся ЧЕРНОВИКОМ и не публикуется ' +
    '(publish=false; публикация — kb_legacy_article_publish). blockCode — код блока из репозитория портала; без него вернётся список ' +
    'текстовых блоков. Если страница создана, а блоки нет — PARTIAL_SUCCESS с ID страницы и статусами шагов; повтор не создаёт ' +
    'вторую страницу. Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      siteId: idSchema.describe('ID базы знаний'),
      title: z.string().trim().min(1).max(255).describe('Название статьи'),
      content: contentSchema,
      format: formatSchema,
      blockCode: blockCodeSchema,
      folderId: idSchema.optional().describe('ID раздела (папки) базы'),
      publish: publishFlag,
      scope: kbScopeSchema,
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    articleId: z.number().nullable().optional(),
    blockIds: z.array(z.number()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).optional(),
    draft: z.boolean().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    rejectPublish(args.publish);
    const prepared = prepareBlocks(args.content, args.format);
    const base = await getBase(ctx, args.scope, args.siteId);
    if (args.folderId !== undefined) await getFolder(ctx, args.scope, args.siteId, args.folderId);
    const blockCode = await assertBlockCode(ctx, args.scope, args.blockCode);
    const risks = [
      'Статья создаётся черновиком (ACTIVE=N) и не публикуется; видимость — только после kb_legacy_article_publish',
      'Портал дополнительно очищает и проверяет HTML блока (CONTENT); итоговая разметка может отличаться',
      `Составная операция: 1 страница + ${String(prepared.blocks.length)} блок(ов); при сбое на блоках страница останется (PARTIAL_SUCCESS)`,
    ];
    if (prepared.removed.length)
      risks.push(`HTML очищен перед отправкой, удалено: ${prepared.removed.join(', ')}`);
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb_legacy_article_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать черновик статьи «${args.title}» в базе «${base.title}» (${String(prepared.blocks.length)} блок(ов))`,
        target: `landing.site:${String(args.siteId)}:landing:new`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          methods: ['landing.landing.add', 'landing.landing.addblock'],
          scope: args.scope,
          siteId: args.siteId,
          folderId: args.folderId ?? null,
          title: args.title,
          blockCode,
          publish: false,
          blocks: prepared.blocks,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'landing.landing.add',
          {
            scope: args.scope,
            fields: {
              TITLE: args.title,
              SITE_ID: args.siteId,
              ...(args.folderId !== undefined ? { FOLDER_ID: args.folderId } : {}),
            },
          },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const articleId = idOf(r.result);
        if (articleId === undefined)
          throw outcomeUnknown(
            'landing.landing.add',
            'legacy',
            'Проверьте статьи базы (kb_legacy_articles_list) перед новой попыткой',
          );
        const steps: StepStatus[] = [{ step: 'page', method: 'landing.landing.add', status: 'done' }];
        const blockIds: number[] = [];
        let afterId: number | undefined;
        let broken = false;
        for (const b of prepared.blocks) {
          const step = `block ${String(b.position)}`;
          if (broken) {
            steps.push({ step, method: 'landing.landing.addblock', status: 'skipped', position: b.position });
            continue;
          }
          try {
            // Без AFTER_ID блок встаёт в начало страницы: цепочка AFTER_ID сохраняет порядок.
            const id = await addBlock(ctx, args.scope, articleId, blockCode, b.html, afterId);
            if (id === undefined) {
              steps.push({
                step,
                method: 'landing.landing.addblock',
                status: 'unknown',
                position: b.position,
              });
              broken = true;
              continue;
            }
            blockIds.push(id);
            afterId = id;
            steps.push({
              step,
              method: 'landing.landing.addblock',
              status: 'done',
              blockId: id,
              position: b.position,
            });
          } catch (e) {
            const code = errCode(e);
            steps.push({
              step,
              method: 'landing.landing.addblock',
              status: code === 'OPERATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
              position: b.position,
              errorCode: code,
            });
            broken = true;
          }
        }
        return {
          id: articleId,
          result: {
            articleId,
            blockIds,
            steps: steps,
            draft: true,
            partial: broken,
          },
        };
      },
      verify: async (performed) => {
        if (performed.result['partial'] === true)
          return { verified: false, warnings: ['Не все блоки добавлены: см. статусы шагов'] };
        const blocks = await listBlocks(ctx, args.scope, Number(performed.id), 'draft');
        const want = (performed.result['blockIds'] as number[]).join(',');
        const got = blocks.map((b) => b.blockId).join(',');
        const warnings =
          want === got
            ? []
            : [`Порядок/состав блоков в черновике (${got}) отличается от созданного (${want})`];
        return { verified: warnings.length === 0, warnings };
      },
    });
    return partialOrResponse(
      ctx,
      outcome,
      {
        base: {},
        method: 'landing.landing.add',
        resultFields: ['articleId', 'blockIds', 'steps', 'draft'],
      },
      (r) => ({
        message: `Статья #${String(r['articleId'])} создана черновиком, но блоки добавлены не все: ${stepsText(r['steps'] as StepStatus[])}`,
        nextAction:
          `Страница #${String(r['articleId'])} уже существует — НЕ повторяйте kb_legacy_article_create. Прочитайте её ` +
          `(kb_legacy_article_get) и допишите недостающее через kb_legacy_article_update mode=append articleId=${String(r['articleId'])}`,
      }),
    );
  },
});

// ---------- kb_legacy_article_update ----------

export const kbLegacyArticleUpdateTool = defineTool({
  name: 'kb_legacy_article_update',
  module: 'knowledgeBase',
  title: 'Дописать или заменить блоки статьи',
  description:
    'Изменить черновик статьи классической базы знаний. Использовать, когда пользователь просит дописать статью ' +
    '(mode=append: новые блоки landing.landing.addblock после последнего блока) или переписать конкретные блоки ' +
    '(mode=replace: landing.block.updatecontent только для blockIds, content — по элементу на блок). Для replace сначала ' +
    'прочитайте статью (kb_legacy_article_get) и передайте её stateHash как expectedStateHash: при расхождении — CONFLICT. ' +
    'title меняет название (landing.landing.update). Изменения остаются в черновике (publish=false). ' +
    'Порядок: APPROVAL_REQUIRED с «было → станет» → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      articleId: idSchema.describe('ID статьи'),
      mode: z.enum(['append', 'replace']),
      blockIds: z
        .array(idSchema)
        .min(1)
        .max(20)
        .optional()
        .describe('Для replace обязательно: ID заменяемых блоков из kb_legacy_article_get'),
      content: contentSchema,
      format: formatSchema,
      blockCode: blockCodeSchema.describe(
        'Для append: код блока из репозитория (как в kb_legacy_article_create)',
      ),
      title: z.string().trim().min(1).max(255).optional().describe('Новое название статьи'),
      publish: publishFlag,
      scope: kbScopeSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    articleId: z.number(),
    mode: z.string(),
    changedBlockIds: z.array(z.number()).optional(),
    addedBlockIds: z.array(z.number()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).optional(),
    draft: z.boolean().optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    rejectPublish(args.publish);
    const prepared = prepareBlocks(args.content, args.format);
    if (args.mode === 'replace') {
      const ids = args.blockIds ?? [];
      if (ids.length === 0)
        throw new AppError('VALIDATION_ERROR', 'Для mode=replace нужны blockIds конкретных блоков', {
          field: 'blockIds',
          reason: 'BLOCK_IDS_REQUIRED',
          nextAction: 'Прочитайте статью (kb_legacy_article_get) и укажите ID заменяемых блоков',
        });
      if (new Set(ids).size !== ids.length)
        throw new AppError('VALIDATION_ERROR', 'blockIds содержит повторы', { field: 'blockIds' });
      if (ids.length !== prepared.blocks.length)
        throw new AppError(
          'VALIDATION_ERROR',
          'Для replace число элементов content должно совпадать с числом blockIds',
          {
            field: 'content',
            reason: 'BLOCK_COUNT_MISMATCH',
          },
        );
      if (!args.expectedStateHash)
        throw new AppError(
          'VALIDATION_ERROR',
          'Для mode=replace обязателен expectedStateHash из kb_legacy_article_get',
          {
            field: 'expectedStateHash',
            reason: 'STATE_HASH_REQUIRED',
            nextAction: 'Прочитайте статью (kb_legacy_article_get) и передайте её stateHash',
          },
        );
    } else if (args.blockIds !== undefined) {
      throw new AppError('VALIDATION_ERROR', 'blockIds используется только с mode=replace', {
        field: 'blockIds',
      });
    }
    const article = await getArticle(ctx, args.scope, args.articleId);
    const before = await listBlocks(ctx, args.scope, args.articleId, 'draft');
    const currentHash = blocksStateHash(before);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Статья изменилась после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Прочитайте статью заново (kb_legacy_article_get) и подготовьте новый план',
      });
    }
    const byId = new Map(before.map((b) => [b.blockId, b]));
    let blockCode: string | undefined;
    const changes: Record<string, unknown>[] = [];
    if (args.mode === 'replace') {
      for (const [i, id] of (args.blockIds ?? []).entries()) {
        const cur = byId.get(id);
        if (!cur)
          throw new AppError(
            'VALIDATION_ERROR',
            `Блока #${String(id)} нет в черновике статьи #${String(args.articleId)}`,
            {
              field: 'blockIds',
              reason: 'BLOCK_NOT_ON_PAGE',
              nextAction: 'Прочитайте статью заново и укажите ID из её блоков',
            },
          );
        changes.push({
          blockId: id,
          code: cur.code,
          before: preview(cur.html),
          after: prepared.blocks[i]?.html ?? '',
        });
      }
    } else {
      blockCode = await assertBlockCode(ctx, args.scope, args.blockCode);
    }
    const lastBlockId = before.at(-1)?.blockId;
    const risks: string[] = [];
    if (args.mode === 'replace')
      risks.push(
        `HTML ${String(changes.length)} блок(ов) заменяется целиком (landing.block.updatecontent); прежнее содержимое показано в плане`,
      );
    else
      risks.push(
        `В конец черновика добавляются ${String(prepared.blocks.length)} блок(ов) после блока #${String(lastBlockId ?? '— (страница пуста)')}`,
      );
    risks.push(
      article.published
        ? 'Статья опубликована: изменения попадут в черновик и станут видны после kb_legacy_article_publish'
        : 'Статья — черновик; изменения не публикуются',
    );
    if (prepared.removed.length)
      risks.push(`HTML очищен перед отправкой, удалено: ${prepared.removed.join(', ')}`);
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если статью изменят до выполнения, блоки всё равно добавятся',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb_legacy_article_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `${args.mode === 'replace' ? 'Заменить блоки' : 'Дописать'} статью #${String(args.articleId)} «${article.title}»${args.title ? `, новое название «${args.title}»` : ''}`,
        target: `landing.landing:${String(args.articleId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          methods: [
            ...(args.title ? ['landing.landing.update'] : []),
            args.mode === 'replace' ? 'landing.block.updatecontent' : 'landing.landing.addblock',
          ],
          scope: args.scope,
          articleId: args.articleId,
          mode: args.mode,
          stateHash: currentHash,
          ...(args.title ? { title: { from: article.title, to: args.title } } : {}),
          ...(args.mode === 'replace'
            ? { replace: changes }
            : { append: { afterBlockId: lastBlockId ?? null, blockCode, blocks: prepared.blocks } }),
          publish: false,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await listBlocks(ctx, args.scope, args.articleId, 'draft');
        if (blocksStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Статья изменилась после подтверждения; изменение отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте статью заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const steps: StepStatus[] = [];
        const changedBlockIds: number[] = [];
        const addedBlockIds: number[] = [];
        let broken = false;
        let done = 0;
        const runStep = async (s: StepStatus, fn: () => Promise<boolean | number | undefined>) => {
          if (broken) {
            steps.push({ ...s, status: 'skipped' });
            return;
          }
          try {
            const r = await fn();
            if (r === undefined || r === false) {
              steps.push({ ...s, status: 'unknown' });
              broken = true;
              return;
            }
            steps.push({ ...s, status: 'done', ...(typeof r === 'number' ? { blockId: r } : {}) });
            done += 1;
          } catch (e) {
            const code = errCode(e);
            steps.push({
              ...s,
              status: code === 'OPERATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
              errorCode: code,
            });
            broken = true;
          }
        };
        if (args.title) {
          await runStep({ step: 'title', method: 'landing.landing.update', status: 'done' }, async () => {
            const r = await ctx.bitrix.call(
              'legacy',
              'landing.landing.update',
              { scope: args.scope, lid: args.articleId, fields: { TITLE: args.title ?? '' } },
              { requestId: ctx.requestId, signal: ctx.signal },
            );
            return r.result === true ? true : undefined;
          });
        }
        if (args.mode === 'replace') {
          for (const [i, id] of (args.blockIds ?? []).entries()) {
            await runStep(
              { step: `replace block #${String(id)}`, method: 'landing.block.updatecontent', status: 'done' },
              async () => {
                const r = await ctx.bitrix.call(
                  'legacy',
                  'landing.block.updatecontent',
                  {
                    scope: args.scope,
                    lid: args.articleId,
                    block: id,
                    content: prepared.blocks[i]?.html ?? '',
                  },
                  { requestId: ctx.requestId, signal: ctx.signal },
                );
                if (r.result !== true) return undefined;
                changedBlockIds.push(id);
                return id;
              },
            );
          }
        } else {
          let afterId = lastBlockId;
          for (const b of prepared.blocks) {
            await runStep(
              {
                step: `block ${String(b.position)}`,
                method: 'landing.landing.addblock',
                status: 'done',
                position: b.position,
              },
              async () => {
                const id = await addBlock(ctx, args.scope, args.articleId, blockCode ?? '', b.html, afterId);
                if (id === undefined) return undefined;
                addedBlockIds.push(id);
                afterId = id;
                return id;
              },
            );
          }
        }
        if (done === 0) {
          // Ни один шаг не выполнен: обычная ошибка/unknown без частичного результата.
          const first = steps[0];
          if (first?.status === 'unknown')
            throw outcomeUnknown(
              first.method,
              'legacy',
              'Проверьте статью (kb_legacy_article_get) перед новой попыткой',
            );
          throw new AppError('BITRIX_UPSTREAM_ERROR', `Изменение статьи не выполнено: ${stepsText(steps)}`, {
            method: first?.method ?? 'landing.landing.addblock',
            apiVersion: 'legacy',
            ...(first?.errorCode ? { upstreamCode: first.errorCode } : {}),
          });
        }
        return {
          id: args.articleId,
          result: {
            articleId: args.articleId,
            mode: args.mode,
            changedBlockIds,
            addedBlockIds,
            steps: steps,
            draft: true,
            partial: broken,
          },
        };
      },
      verify: async (performed) => {
        if (performed.result['partial'] === true)
          return { verified: false, warnings: ['Выполнены не все шаги: см. статусы шагов'] };
        const after = await listBlocks(ctx, args.scope, args.articleId, 'draft');
        const ids = after.map((b) => b.blockId);
        const warnings: string[] = [];
        for (const id of performed.result['changedBlockIds'] as number[])
          if (!ids.includes(id)) warnings.push(`Блок #${String(id)} не найден в черновике после замены`);
        const added = performed.result['addedBlockIds'] as number[];
        if (added.length) {
          const tail = ids.slice(-added.length).join(',');
          if (tail !== added.join(','))
            warnings.push('Новые блоки не оказались в конце черновика в заданном порядке');
        }
        if (args.title) {
          const a = await getArticle(ctx, args.scope, args.articleId);
          if (a.title !== args.title) warnings.push('Название статьи в портале отличается от плана');
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    let stateHash: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed) {
      try {
        stateHash = blocksStateHash(await listBlocks(ctx, args.scope, args.articleId, 'draft'));
      } catch {
        stateHash = undefined;
      }
    }
    return partialOrResponse(
      ctx,
      outcome,
      {
        base: { articleId: args.articleId, mode: args.mode, ...(stateHash ? { stateHash } : {}) },
        method: args.mode === 'replace' ? 'landing.block.updatecontent' : 'landing.landing.addblock',
        resultFields: ['changedBlockIds', 'addedBlockIds', 'steps', 'draft'],
        dryRunExtra: { stateHash: currentHash },
      },
      (r) => ({
        message: `Статья #${String(args.articleId)} изменена частично: ${stepsText(r['steps'] as StepStatus[])}`,
        nextAction:
          'Не повторяйте тот же вызов: прочитайте статью (kb_legacy_article_get), сверьте блоки и подготовьте новое изменение только для невыполненных шагов',
      }),
    );
  },
});

// ---------- kb_legacy_article_publish ----------

export const kbLegacyArticlePublishTool = defineTool({
  name: 'kb_legacy_article_publish',
  module: 'knowledgeBase',
  title: 'Опубликовать статью классической базы знаний',
  description:
    'Опубликовать проверенную статью классической базы знаний через landing.landing.publication. Использовать только по явной ' +
    'просьбе пользователя после проверки черновика (kb_legacy_article_get). Перед планом проверяется база: публикуются только ' +
    'статьи баз знаний (KNOWLEDGE/GROUP), не обычных сайтов; план показывает, что вместе со статьёй опубликуются её разделы и ' +
    'неопубликованная база станет активной. expectedStateHash из kb_legacy_article_get гарантирует, что публикуется прочитанная версия. ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      articleId: idSchema.describe('ID статьи'),
      scope: kbScopeSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    articleId: z.number(),
    published: z.boolean().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const article = await getArticle(ctx, args.scope, args.articleId);
    if (article.siteId === null)
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'У статьи нет SITE_ID', {
        method: 'landing.landing.getlist',
      });
    const rows = await listBases(ctx, args.scope, 0, 1, { ID: article.siteId });
    const siteRow = rows.find((r) => idOf(r['ID']) === article.siteId);
    const siteType = siteRow ? asText(siteRow['TYPE']) : '';
    // Публикация страницы обычного сайта сделала бы её общедоступной — это не задача инструмента базы знаний.
    if (!siteRow || !(siteType === 'KNOWLEDGE' || siteType === 'GROUP')) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Статья не принадлежит базе знаний (KNOWLEDGE/GROUP); публикация сайта запрещена',
        {
          field: 'articleId',
          reason: 'NOT_KNOWLEDGE_BASE',
          nextAction: 'Публикация обычных сайтов landing выполняется вручную в интерфейсе Bitrix24',
        },
      );
    }
    const siteTitle = asText(siteRow['TITLE']);
    const sitePublished = asText(siteRow['ACTIVE']).toUpperCase() === 'Y';
    const blocks = await listBlocks(ctx, args.scope, args.articleId, 'draft');
    const currentHash = blocksStateHash(blocks);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError(
        'CONFLICT',
        'Черновик статьи изменился после чтения: expectedStateHash не совпадает',
        {
          field: 'expectedStateHash',
          reason: 'STATE_CHANGED',
          nextAction: 'Прочитайте статью заново (kb_legacy_article_get) и подготовьте новый план',
        },
      );
    }
    const risks = [
      `Статья станет видимой пользователям базы «${siteTitle}» в соответствии с правами доступа базы`,
    ];
    if (!sitePublished)
      risks.unshift(
        `БАЗА «${siteTitle}» СЕЙЧАС НЕ ОПУБЛИКОВАНА: по документации публикация страницы делает сайт активным — база станет видимой`,
      );
    if (article.folderId !== null)
      risks.push(`Будут опубликованы раздел #${String(article.folderId)} и все его родительские разделы`);
    if (article.published)
      risks.push('Статья уже опубликована: публикуется текущий черновик (изменения станут видимы)');
    if (blocks.length === 0) risks.push('В черновике нет блоков: опубликуется пустая статья');
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если черновик изменят до выполнения, опубликуется изменённая версия',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'kb_legacy_article_publish',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Опубликовать статью #${String(args.articleId)} «${article.title}» в базе «${siteTitle}»`,
        target: `landing.landing:${String(args.articleId)}:publication`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'landing.landing.publication',
          scope: args.scope,
          articleId: args.articleId,
          site: { siteId: article.siteId, type: siteType, published: sitePublished },
          folderId: article.folderId,
          blocks: blocks.length,
          stateHash: currentHash,
        },
        risks,
      },
      validationLevel: 'local',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await listBlocks(ctx, args.scope, args.articleId, 'draft');
        if (blocksStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Черновик изменился после подтверждения; публикация отменена', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте статью заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'landing.landing.publication',
          { scope: args.scope, lid: args.articleId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (r.result !== true)
          throw outcomeUnknown(
            'landing.landing.publication',
            'legacy',
            'Проверьте статус статьи (kb_legacy_articles_list)',
          );
        return { id: args.articleId, result: { published: true } };
      },
      verify: async () => {
        const a = await getArticle(ctx, args.scope, args.articleId);
        return a.published
          ? { verified: true, warnings: [] }
          : { verified: false, warnings: ['После публикации статья всё ещё ACTIVE=N'] };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { articleId: args.articleId },
      method: 'landing.landing.publication',
      resultFields: ['published'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

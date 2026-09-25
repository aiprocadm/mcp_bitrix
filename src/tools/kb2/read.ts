/**
 * Чтение Базы знаний 2.0 (ТЗ §9.14, REST 3.0 `note.*`):
 * kb2_bases_list, kb2_base_get, kb2_documents_list, kb2_document_get, kb2_documents_search.
 * Курсоры — только серверные непрозрачные ключи: native cursor {position,id} и снимки дерева/текста
 * хранятся зашифрованными и привязаны к principal/инструменту/выборке. Поиск курсора не имеет (T37).
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import {
  asText,
  cursorBinding,
  idOf,
  idSchema,
  isObj,
  num,
  pageMeta,
  pageSizeOf,
  statefulPage,
  upstreamShapeError,
} from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  callV3,
  contentHash,
  documentMeta,
  flattenTree,
  getCollection,
  getDocument,
  normalizeCollection,
  sliceChunk,
  snippetText,
  subtreeOf,
  type Kb2Document,
  type Kb2TreeNode,
} from './service.js';

const collectionShape = z.object({
  collectionId: z.number(),
  name: z.string(),
  position: z.number().nullable(),
  policyLevel: z.string().nullable(),
  createdBy: z.number().nullable(),
  updatedBy: z.number().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

// ---------- kb2_bases_list ----------

interface NativeCursor {
  position: number;
  id: number;
}

export const kb2BasesListTool = defineTool({
  name: 'kb2_bases_list',
  module: 'knowledgeBase',
  title: 'Базы знаний 2.0',
  description:
    'Список баз Базы знаний 2.0 (REST 3.0 note.collection.list), доступных владельцу вебхука: ID, название, уровень доступа. ' +
    'Использовать, чтобы найти collectionId перед чтением дерева документов или созданием документа. ' +
    'Страницы с непрозрачным cursor; это НЕ классическая база знаний на landing (для неё — kb_legacy_*).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ ...pageArgsShape }).strict(),
  outputDataSchema: z.object({ items: z.array(collectionShape) }),
  handler: async (args, ctx) => {
    const method = 'note.collection.list';
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const page = await statefulPage<NativeCursor | null>(ctx, {
      tool: 'kb2_bases_list',
      bindingParts: { pageSize },
      cursor: args.cursor,
      initial: null,
      fetch: async (after) => {
        const result = await callV3(ctx, method, {
          pagination: after
            ? { limit: pageSize, afterCursor: { position: after.position, id: after.id } }
            : { limit: pageSize },
        });
        if (!isObj(result) || !Array.isArray(result['items'])) throw upstreamShapeError(method, 'v3');
        const items = result['items'].map((i) => normalizeCollection(i, method) as unknown as JsonValue);
        const nc = result['nextCursor'];
        let next: NativeCursor | undefined;
        if (isObj(nc)) {
          const position = num(nc['position']);
          const id = idOf(nc['id']);
          if (position === undefined || id === undefined) throw upstreamShapeError(method, 'v3');
          next = { position, id };
        } else if (nc !== null && nc !== undefined) {
          throw upstreamShapeError(method, 'v3');
        }
        // Пустая страница с курсором означала бы бесконечный обход — считаем выборку законченной.
        return { items, next: items.length > 0 ? next : undefined };
      },
    });
    return ok({ items: page.items }, pageMeta(ctx, method, page, 'v3'));
  },
});

// ---------- kb2_base_get ----------

export const kb2BaseGetTool = defineTool({
  name: 'kb2_base_get',
  module: 'knowledgeBase',
  title: 'База знаний 2.0 по ID',
  description:
    'Метаданные одной базы Базы знаний 2.0 по collectionId (REST 3.0 note.collection.get): название, позиция, уровень доступа, авторы и даты. ' +
    'Использовать, чтобы проверить базу и права (policyLevel) перед работой с её документами.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ collectionId: idSchema.describe('ID базы из kb2_bases_list') }).strict(),
  outputDataSchema: collectionShape,
  handler: async (args, ctx) => {
    const c = await getCollection(ctx, args.collectionId);
    return ok(c, {
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      method: 'note.collection.get',
      apiVersion: 'v3',
    });
  },
});

// ---------- kb2_documents_list ----------

interface TreeSnapshot {
  rest: Kb2TreeNode[];
  total: number;
  truncated: boolean;
}

const treeNodeShape = z.object({
  documentId: z.number(),
  parentId: z.number().nullable(),
  title: z.string(),
  position: z.number().nullable(),
  depth: z.number(),
  childCount: z.number(),
});

export const kb2DocumentsListTool = defineTool({
  name: 'kb2_documents_list',
  module: 'knowledgeBase',
  title: 'Дерево документов базы 2.0',
  description:
    'Дерево документов и разделов одной базы Базы знаний 2.0 (REST 3.0 note.document.tree.list) плоским списком в порядке обхода: ' +
    'documentId, parentId, title, depth, число дочерних. Использовать, чтобы найти документ или раздел (разделы — это документы с дочерними). ' +
    'parentId ограничивает выдачу поддеревом. Портал отдаёт дерево целиком (до 5000 узлов); страницы идут по сохранённому снимку с курсором.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      collectionId: idSchema.describe('ID базы'),
      parentId: idSchema.optional().describe('Показать только потомков этого документа'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    collectionId: z.number(),
    parentId: z.number().nullable(),
    total: z.number(),
    truncated: z.boolean(),
    items: z.array(treeNodeShape),
  }),
  handler: async (args, ctx) => {
    const method = 'note.document.tree.list';
    const pageSize = pageSizeOf(ctx, args.pageSize);
    let snapshotInfo = { total: 0, truncated: false };
    const page = await statefulPage<TreeSnapshot | null>(ctx, {
      tool: 'kb2_documents_list',
      bindingParts: { collectionId: args.collectionId, parentId: args.parentId ?? null, pageSize },
      cursor: args.cursor,
      initial: null,
      fetch: async (snap) => {
        let s = snap;
        if (!s) {
          const result = await callV3(ctx, method, { collectionId: args.collectionId });
          if (!isObj(result) || !Array.isArray(result['items'])) throw upstreamShapeError(method, 'v3');
          const truncated = result['truncated'] === true;
          let nodes = flattenTree(result['items'], method);
          if (args.parentId !== undefined) {
            const sub = subtreeOf(nodes, args.parentId);
            if (!sub) {
              throw new AppError('NOT_FOUND', 'Документ parentId не найден в дереве этой базы', {
                field: 'parentId',
                method,
                apiVersion: 'v3',
                nextAction: truncated
                  ? 'Дерево базы усечено порталом (более 5000 узлов); проверьте документ через kb2_document_get'
                  : 'Проверьте parentId и collectionId (kb2_documents_list без parentId)',
              });
            }
            nodes = sub;
          }
          s = { rest: nodes, total: nodes.length, truncated };
        }
        snapshotInfo = { total: s.total, truncated: s.truncated };
        const items = s.rest.slice(0, pageSize);
        const rest = s.rest.slice(pageSize);
        return {
          items: items as unknown as JsonValue[],
          next: rest.length > 0 ? { rest, total: s.total, truncated: s.truncated } : undefined,
        };
      },
    });
    const warnings = snapshotInfo.truncated
      ? ['Портал усёк дерево по внутреннему пределу TREE_MAX_NODES=5000: показаны не все документы']
      : [];
    const meta = pageMeta(ctx, method, page, 'v3', warnings);
    return ok(
      {
        collectionId: args.collectionId,
        parentId: args.parentId ?? null,
        total: snapshotInfo.total,
        truncated: snapshotInfo.truncated,
        items: page.items as unknown as Kb2TreeNode[],
      },
      snapshotInfo.truncated ? { ...meta, completeness: 'partial' } : meta,
    );
  },
});

// ---------- kb2_document_get ----------

interface ContentSnapshot {
  meta: ReturnType<typeof documentMeta>;
  markdown: string;
  contentHash: string;
  offset: number;
}

const DEFAULT_MAX_CHARS = 20_000;
/** Запас под метаданные и конверт ответа при ужатии куска по байтам. */
const ENVELOPE_RESERVE_BYTES = 6_000;

export const kb2DocumentGetTool = defineTool({
  name: 'kb2_document_get',
  module: 'knowledgeBase',
  title: 'Документ базы 2.0',
  description:
    'Документ Базы знаний 2.0 (REST 3.0 note.document.get): метаданные, текст в Markdown и contentHash (sha256 полного текста). ' +
    'Использовать, чтобы прочитать документ и получить contentHash перед kb2_document_update (передаётся как expectedStateHash). ' +
    'Длинный текст отдаётся кусками по maxChars: completeness=partial и contentCursor для продолжения по тому же снимку.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      documentId: idSchema.describe('ID документа'),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(50_000)
        .optional()
        .describe('Сколько символов текста вернуть за вызов (500..50000, по умолчанию 20000)'),
      contentCursor: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Курсор продолжения текста из предыдущего ответа (тот же documentId)'),
    })
    .strict(),
  outputDataSchema: z.object({
    documentId: z.number(),
    collectionId: z.number().nullable(),
    parentId: z.number().nullable(),
    title: z.string(),
    position: z.number().nullable(),
    createdBy: z.number().nullable(),
    updatedBy: z.number().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    markdown: z.string(),
    contentHash: z.string(),
    stateHash: z.string(),
    content: z.object({
      offset: z.number(),
      returnedChars: z.number(),
      totalChars: z.number(),
      truncated: z.boolean(),
    }),
    contentCursor: z.string().nullable(),
  }),
  handler: async (args, ctx) => {
    const method = 'note.document.get';
    const tool = 'kb2_document_get';
    const binding = cursorBinding(ctx, tool, { documentId: args.documentId });
    let snap: ContentSnapshot;
    if (args.contentCursor) {
      snap = ctx.cursors.consume<ContentSnapshot>(args.contentCursor, binding);
      // Снимок зашифрован сервером; хеш сверяется как защита от повреждения.
      if (contentHash(snap.markdown) !== snap.contentHash) {
        throw new AppError('CONFLICT', 'Снимок текста повреждён; начните чтение заново', {
          field: 'contentCursor',
          nextAction: 'Вызовите kb2_document_get без contentCursor',
        });
      }
    } else {
      const doc: Kb2Document = await getDocument(ctx, args.documentId);
      snap = {
        meta: documentMeta(doc),
        markdown: doc.markdown,
        contentHash: contentHash(doc.markdown),
        offset: 0,
      };
    }
    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
    const maxBytes = Math.max(1024, ctx.config.limits.maxResponseBytes - ENVELOPE_RESERVE_BYTES);
    const chunk = sliceChunk(snap.markdown, snap.offset, maxChars, maxBytes);
    const end = snap.offset + chunk.length;
    const truncated = end < snap.markdown.length;
    const contentCursor = truncated ? ctx.cursors.create(binding, { ...snap, offset: end }) : null;
    const warnings: string[] = [];
    if (truncated) {
      warnings.push(
        `CONTENT_TRUNCATED: показаны символы ${String(snap.offset)}–${String(end)} из ${String(snap.markdown.length)}; ` +
          'продолжение — тот же вызов с contentCursor (снимок действует ограниченное время)',
      );
    }
    if (args.contentCursor) {
      warnings.push(
        'Продолжение по снимку: текст мог измениться после первого чтения — contentHash относится к снимку',
      );
    }
    return ok(
      {
        ...snap.meta,
        markdown: chunk,
        contentHash: snap.contentHash,
        stateHash: snap.contentHash,
        content: {
          offset: snap.offset,
          returnedChars: chunk.length,
          totalChars: snap.markdown.length,
          truncated,
        },
        contentCursor,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method,
        apiVersion: 'v3',
        completeness: truncated ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

// ---------- kb2_documents_search ----------

export const kb2DocumentsSearchTool = defineTool({
  name: 'kb2_documents_search',
  module: 'knowledgeBase',
  title: 'Поиск документов базы 2.0',
  description:
    'Поиск документов Базы знаний 2.0 по названию и содержимому (REST 3.0 note.document.search.list): documentId, база, название, ' +
    'релевантность, фрагмент текста. Использовать, чтобы найти документ по словам. Портал отдаёт ТОЛЬКО первую страницу с флагом hasMore ' +
    'и без курсора продолжения: при hasMore=true уточните запрос или увеличьте pageSize (до 50).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      query: z.string().trim().min(3).max(200).describe('Поисковый запрос, 3–200 символов'),
      pageSize: z.number().int().min(1).max(50).optional().describe('1..50, по умолчанию DEFAULT_PAGE_SIZE'),
    })
    .strict(),
  outputDataSchema: z.object({
    query: z.string(),
    hasMore: z.boolean(),
    coverage: z.literal('first-page-only'),
    suggestion: z.string().optional(),
    items: z.array(
      z.object({
        documentId: z.number(),
        collectionId: z.number().nullable(),
        title: z.string(),
        score: z.number().nullable(),
        snippet: z.string(),
        sharedAccess: z.boolean(),
      }),
    ),
  }),
  handler: async (args, ctx) => {
    const method = 'note.document.search.list';
    const pageSize = Math.min(args.pageSize ?? ctx.config.limits.defaultPageSize, 50);
    const result = await callV3(ctx, method, { query: args.query, pagination: { limit: pageSize } });
    if (!isObj(result) || !Array.isArray(result['items'])) throw upstreamShapeError(method, 'v3');
    const items = result['items'].map((i) => {
      if (!isObj(i)) throw upstreamShapeError(method, 'v3');
      const documentId = idOf(i['documentId']);
      if (documentId === undefined) throw upstreamShapeError(method, 'v3');
      return {
        documentId,
        collectionId: idOf(i['collectionId']) ?? null,
        title: asText(i['title']),
        score: num(i['score']) ?? null,
        snippet: snippetText(asText(i['snippet'])),
        sharedAccess: i['sharedAccess'] === true,
      };
    });
    const hasMore = result['hasMore'] === true;
    // T37: курсора следующей страницы у метода нет — nextCursor всегда null, пагинация не выдумывается.
    const suggestion = hasMore
      ? pageSize < 50
        ? 'Есть ещё совпадения: уточните запрос (больше слов, точная фраза) или увеличьте pageSize до 50'
        : 'Есть ещё совпадения сверх 50: уточните запрос (больше слов, точная фраза); следующей страницы у метода нет'
      : undefined;
    return ok(
      {
        query: args.query,
        hasMore,
        coverage: 'first-page-only' as const,
        ...(suggestion ? { suggestion } : {}),
        items,
      },
      pageMeta(
        ctx,
        method,
        { nextCursor: null, hasMore },
        'v3',
        hasMore
          ? [`PARTIAL_RESULT: показана только первая страница совпадений. ${suggestion ?? ''}`.trim()]
          : [],
      ),
    );
  },
});

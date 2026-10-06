/**
 * Генератор документов CRM (scope crm): шаблоны, документы записи, карточка документа и создание документа
 * по шаблону через MutationExecutor (план → подтверждение → одна запись → сверка по crm.documentgenerator.document.get).
 *
 * Только белый список полей: живой портал (2026-10-06) отдаёт в шаблонах `downloadMachine` с КОДОМ ВЕБХУКА в адресе,
 * а в документах — ссылки скачивания (downloadUrl/pdfUrl/…Machine). Ни одна ссылка наружу не выходит;
 * готовность PDF сообщается признаком pdfReady, сам документ виден в карточке записи в портале.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape, requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  legacyListPage,
  mutationPrincipal,
  mutationResponse,
  num,
  pageMeta,
  pageSizeOf,
  upstreamShapeError,
  yn,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { recordTitle } from './entities.js';
import { getRecord } from './crm-service.js';
import { getItem, itemTitle } from './item-service.js';
import { resolveRecordTarget, type RecordTarget } from './item-ops.js';

/** Типы записей, к которым привязываются документы (официальная страница crm.documentgenerator.document.add). */
const DOC_ENTITY_TYPES = ['deal', 'lead', 'contact', 'company', 'quote', 'invoice'] as const;
const docEntitySchema = z
  .enum(DOC_ENTITY_TYPES)
  .describe('Запись CRM: deal, lead, contact, company, quote (КП), invoice (новый счёт)');
const ENTITY_NAMES: Record<number, string> = {
  1: 'lead',
  2: 'deal',
  3: 'contact',
  4: 'company',
  7: 'quote',
  31: 'invoice',
};

const entityTypeIdOf = (t: RecordTarget): number =>
  t.kind === 'classic' ? t.entity.entityTypeId : t.target.entityTypeId;

async function recordInfo(ctx: ToolContext, t: RecordTarget, id: number): Promise<string> {
  if (t.kind === 'classic') return recordTitle(t.entity, await getRecord(ctx, t.entity, id));
  return itemTitle(await getItem(ctx, t.target, id));
}

// ---------- шаблоны ----------

export interface DocTemplate {
  id: number;
  name: string;
  active: boolean;
  entityTypes: string[];
  numeratorId: number | null;
  sort: number;
}

/** Ответ template.list: result.templates — объект по ID (живой портал) или массив (страница документации). */
export function parseTemplates(result: JsonValue): DocTemplate[] {
  const raw = isObj(result) ? result['templates'] : undefined;
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : undefined;
  if (!list) throw upstreamShapeError('crm.documentgenerator.template.list', 'legacy');
  return list.filter(isObj).flatMap((x) => {
    const id = idOf(x['id']);
    if (id === undefined) return [];
    const types = Array.isArray(x['entityTypeId']) ? x['entityTypeId'] : [x['entityTypeId']];
    return [
      {
        id,
        name: asText(x['name']),
        active: yn(x['active']),
        entityTypes: types.map((v) => ENTITY_NAMES[Number(asText(v))] ?? asText(v)).filter((v) => v !== ''),
        numeratorId: idOf(x['numeratorId']) ?? null,
        sort: num(x['sort']) ?? 0,
      },
    ];
  });
}

/** Все шаблоны (до 4 страниц по 50) — белый список полей, без download/downloadMachine/users. */
export async function listTemplates(ctx: ToolContext): Promise<{ items: DocTemplate[]; hasMore: boolean }> {
  const items: DocTemplate[] = [];
  let start: number | undefined = 0;
  for (let i = 0; i < 4 && start !== undefined; i += 1) {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.documentgenerator.template.list',
      {
        select: ['id', 'name', 'active', 'entityTypeId', 'numeratorId', 'sort'],
        order: { sort: 'ASC', id: 'ASC' },
        start,
      },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const page = parseTemplates(r.result);
    items.push(...page);
    start = page.length === 0 ? undefined : r.next;
  }
  // Объект с числовыми ключами JavaScript перебирает по возрастанию ID, а не в порядке портала — сортируем явно.
  items.sort((a, b) => a.sort - b.sort || a.id - b.id);
  return { items, hasMore: start !== undefined };
}

const templateOut = z.object({
  id: z.number(),
  name: z.string(),
  active: z.boolean(),
  entityTypes: z.array(z.string()),
  numeratorId: z.number().nullable(),
  sort: z.number(),
});

export const crmDocumentTemplatesListTool = defineTool({
  name: 'crm_document_templates_list',
  module: 'crm',
  title: 'Шаблоны документов CRM',
  description:
    'Шаблоны генератора документов (договоры, счета, КП, акты): ID, название, к каким записям CRM привязан, активен ли. ' +
    'Использовать перед crm_document_create, когда просят «сформируй договор/счёт по сделке». Файлы шаблонов не отдаются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: docEntitySchema.optional().describe('Только шаблоны для этого типа записи'),
      includeInactive: z.boolean().default(false).describe('Показать и выключенные шаблоны'),
    })
    .strict(),
  outputDataSchema: z.object({ items: z.array(templateOut), returnedCount: z.number() }),
  handler: async (args, ctx) => {
    const { items, hasMore } = await listTemplates(ctx);
    const shown = items.filter(
      (t) =>
        (args.includeInactive || t.active) && (!args.entityType || t.entityTypes.includes(args.entityType)),
    );
    return ok(
      { items: shown, returnedCount: shown.length },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.documentgenerator.template.list',
        apiVersion: 'legacy',
        completeness: hasMore ? 'partial' : 'complete',
        warnings: hasMore ? ['Шаблонов больше 200: показаны первые'] : [],
      },
    );
  },
});

// ---------- документы ----------

/** Документ: только безопасные поля; ссылки скачивания и значения полей шаблона не выдаются. */
export function normalizeDocument(raw: JsonValue) {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['id']);
  if (id === undefined) return undefined;
  const etid = num(raw['entityTypeId']);
  return {
    id,
    title: asText(raw['title']),
    number: asText(raw['number']),
    templateId: idOf(raw['templateId']) ?? null,
    entityType: etid === undefined ? null : (ENTITY_NAMES[etid] ?? String(etid)),
    entityId: idOf(raw['entityId']) ?? null,
    createTime: asText(raw['createTime']),
    pdfReady: (idOf(raw['pdfId']) ?? 0) > 0,
    hasPublicLink: asText(raw['publicUrl']) !== '',
  };
}

const documentOut = z.object({
  id: z.number(),
  title: z.string(),
  number: z.string(),
  templateId: z.number().nullable(),
  entityType: z.string().nullable(),
  entityId: z.number().nullable(),
  createTime: z.string(),
  pdfReady: z.boolean(),
  hasPublicLink: z.boolean(),
});

export const crmDocumentsListTool = defineTool({
  name: 'crm_documents_list',
  module: 'crm',
  title: 'Документы записи CRM',
  description:
    'Документы, сформированные генератором по записи CRM (договоры, счета, КП): ID, название, номер, шаблон, дата, готов ли PDF. ' +
    'Использовать, когда спрашивают «какие документы уже сделаны по сделке», «есть ли договор». Ссылки на файлы не отдаются — документ открывается в карточке записи.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: docEntitySchema,
      recordId: idSchema.describe('ID записи CRM'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({ items: z.array(documentOut), returnedCount: z.number() }),
  handler: async (args, ctx) => {
    const target = await resolveRecordTarget(ctx, args.entityType, undefined);
    const filter: JsonObject = { entityTypeId: entityTypeIdOf(target), entityId: args.recordId };
    const page = await legacyListPage(ctx, {
      tool: 'crm_documents_list',
      method: 'crm.documentgenerator.document.list',
      params: {
        select: ['id', 'title', 'number', 'templateId', 'entityTypeId', 'entityId', 'createTime', 'pdfId'],
        filter,
        order: { id: 'DESC' },
      },
      bindingParts: { filter },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
      extract: (r) => (isObj(r) && Array.isArray(r['documents']) ? r['documents'] : undefined),
    });
    const items = page.items.map(normalizeDocument).filter((d) => d !== undefined);
    return ok(
      { items, returnedCount: items.length },
      pageMeta(ctx, 'crm.documentgenerator.document.list', page),
    );
  },
});

async function readDocument(ctx: ToolContext, id: number) {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.documentgenerator.document.get',
    { id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const doc = normalizeDocument(isObj(r.result) ? (r.result['document'] ?? null) : null);
  if (!doc) {
    throw new AppError('NOT_FOUND', 'Документ не найден или недоступен', {
      method: 'crm.documentgenerator.document.get',
      apiVersion: 'legacy',
    });
  }
  const raw = isObj(r.result) && isObj(r.result['document']) ? r.result['document'] : {};
  return {
    ...doc,
    isTransformationError: yn(raw['isTransformationError']),
    transformationError: asText(raw['transformationErrorMessage']) || null,
  };
}

export const crmDocumentGetTool = defineTool({
  name: 'crm_document_get',
  module: 'crm',
  title: 'Документ CRM',
  description:
    'Карточка документа генератора по ID: название, номер, шаблон, запись CRM, готов ли PDF, была ли ошибка преобразования. ' +
    'Использовать после crm_document_create, чтобы узнать, готов ли PDF. Ссылки на файл не отдаются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ id: idSchema.describe('ID документа') }).strict(),
  outputDataSchema: documentOut.extend({
    isTransformationError: z.boolean(),
    transformationError: z.string().nullable(),
  }),
  handler: async (args, ctx) =>
    ok(await readDocument(ctx, args.id), {
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      method: 'crm.documentgenerator.document.get',
      apiVersion: 'legacy',
      completeness: 'complete',
    }),
});

// ---------- создание ----------

export const crmDocumentCreateTool = defineTool({
  name: 'crm_document_create',
  module: 'crm',
  title: 'Сформировать документ по шаблону',
  description:
    'Сформировать документ (договор, счёт, КП, акт) по шаблону генератора для записи CRM (crm.documentgenerator.document.add). ' +
    'Использовать, когда просят «сделай договор по сделке». Шаблон — из crm_document_templates_list, он должен быть привязан к типу записи. ' +
    'values — необязательные значения полей шаблона. Документ появится в карточке записи; PDF готовится порталом, проверка — crm_document_get. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом; человек подтверждает; повтор с approvalId создаёт документ ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      templateId: idSchema.describe('ID шаблона'),
      entityType: docEntitySchema,
      recordId: idSchema.describe('ID записи CRM'),
      values: z
        .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,99}$/), z.string().max(2000))
        .refine((v) => Object.keys(v).length <= 50, 'не больше 50 полей')
        .optional()
        .describe('Значения полей шаблона, например {"DocumentNumber": "15"}'),
      stampsEnabled: z.boolean().optional().describe('Печати и подписи в документе'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    templateId: z.number(),
    entityType: z.string(),
    recordId: z.number(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    documentId: z.number().optional(),
    title: z.string().optional(),
    number: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const target = await resolveRecordTarget(ctx, args.entityType, undefined);
    const entityTypeId = entityTypeIdOf(target);
    const { items } = await listTemplates(ctx);
    const template = items.find((t) => t.id === args.templateId);
    if (!template) {
      throw new AppError('NOT_FOUND', `Шаблон ${String(args.templateId)} не найден`, {
        field: 'templateId',
        nextAction: 'Список шаблонов — crm_document_templates_list',
      });
    }
    if (!template.active) {
      throw new AppError('VALIDATION_ERROR', `Шаблон «${template.name}» выключен`, {
        field: 'templateId',
        reason: 'TEMPLATE_INACTIVE',
      });
    }
    if (!template.entityTypes.includes(args.entityType)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Шаблон «${template.name}» не привязан к типу ${args.entityType} (привязан к: ${template.entityTypes.join(', ') || 'нет'})`,
        { field: 'templateId', reason: 'TEMPLATE_ENTITY_MISMATCH' },
      );
    }
    const title = await recordInfo(ctx, target, args.recordId);
    const params: JsonObject = { templateId: args.templateId, entityTypeId, entityId: args.recordId };
    if (args.values) params['values'] = args.values;
    if (args.stampsEnabled !== undefined) params['stampsEnabled'] = args.stampsEnabled ? 1 : 0;
    const risks = ['Документ появится в карточке записи и в списке документов CRM'];
    if (template.numeratorId)
      risks.push('Номер документа берётся из нумератора шаблона — счётчик увеличится');
    if (args.stampsEnabled) risks.push('В документ попадут печать и подпись компании');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_document_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Сформировать документ по шаблону «${template.name}» для записи ${args.entityType} #${String(args.recordId)} «${title}»`,
        target: `crm.documentgenerator:${args.entityType}:${String(args.recordId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'crm.documentgenerator.document.add', ...params },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const r = await ctx.bitrix.call('legacy', 'crm.documentgenerator.document.add', params, {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        const doc = normalizeDocument(isObj(r.result) ? (r.result['document'] ?? null) : null);
        if (!doc) {
          throw new AppError('OPERATION_OUTCOME_UNKNOWN', 'Портал не вернул созданный документ', {
            method: 'crm.documentgenerator.document.add',
            apiVersion: 'legacy',
          });
        }
        // В ledger — только безопасные поля (ответ портала содержит ссылки скачивания).
        return { id: doc.id, result: { documentId: doc.id, title: doc.title, number: doc.number } };
      },
      verify: async (performed) => {
        const saved = await readDocument(ctx, Number(performed.id));
        const warnings: string[] = [];
        if (saved.templateId !== args.templateId) warnings.push('Документ создан по другому шаблону');
        if (saved.entityId !== args.recordId) warnings.push('Документ привязан к другой записи');
        if (saved.isTransformationError)
          warnings.push(`PDF не сформирован: ${saved.transformationError ?? 'ошибка преобразования'}`);
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { templateId: args.templateId, entityType: args.entityType, recordId: args.recordId },
      method: 'crm.documentgenerator.document.add',
      resultFields: ['documentId', 'title', 'number'],
    });
  },
});

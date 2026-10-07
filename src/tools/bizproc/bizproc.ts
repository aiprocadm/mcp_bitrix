/**
 * Бизнес-процессы (чтение, scope bizproc): шаблоны из дизайнера и запущенные процессы.
 * Роботы стадий CRM в REST не отдаются (официальная страница bizproc.workflow.template.list; bizproc.robot.list и
 * crm.automation.trigger.list требуют контекст приложения). Но их запуски видны в bizproc.workflow.instances:
 * живой портал (2026-10-07) — у сделок и лидов работают шаблоны 7 и 1, которых нет в списке шаблонов.
 * Такие процессы помечаются как «автоматизация стадии (шаблон вне REST)».
 * Из шаблона отдаются только тип и название действий: константы и параметры (TEMPLATE/CONSTANTS) не выдаются.
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { asText, idOf, idSchema, isObj, legacyListPage, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';

const AUTO_EXECUTE: Record<string, string> = {
  '0': 'manual',
  '1': 'onCreate',
  '2': 'onUpdate',
  '3': 'onCreateAndUpdate',
};
const DOC_TYPES = ['LEAD', 'DEAL', 'CONTACT', 'COMPANY', 'QUOTE', 'SMART_INVOICE'] as const;
/** ENTITY документа CRM для фильтра запущенных процессов (официальная страница bizproc.workflow.template.list). */
const DOC_ENTITY: Record<(typeof DOC_TYPES)[number], string> = {
  LEAD: 'CCrmDocumentLead',
  DEAL: 'CCrmDocumentDeal',
  CONTACT: 'CCrmDocumentContact',
  COMPANY: 'CCrmDocumentCompany',
  QUOTE: 'Bitrix\\Crm\\Integration\\BizProc\\Document\\Quote',
  SMART_INVOICE: 'Bitrix\\Crm\\Integration\\BizProc\\Document\\SmartInvoice',
};

export interface BpAction {
  depth: number;
  type: string;
  title: string;
}

/** Дерево действий шаблона → плоский список «глубина, тип, название» (без свойств действий). */
export function flattenActions(tree: JsonValue, max = 200): BpAction[] {
  const out: BpAction[] = [];
  const walk = (node: JsonValue, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth);
      return;
    }
    if (!isObj(node)) return;
    if (typeof node['Type'] === 'string') {
      const props = isObj(node['Properties']) ? node['Properties'] : {};
      out.push({ depth, type: node['Type'], title: asText(props['Title']) });
    }
    if (node['Children'] !== undefined) walk(node['Children'], depth + 1);
  };
  walk(tree, 0);
  return out;
}

export interface BpTemplate {
  id: number;
  name: string;
  moduleId: string;
  documentType: string;
  autoExecute: string;
  modified: string;
  userId: number | null;
  actions?: BpAction[];
}

function normalizeTemplate(x: Record<string, JsonValue>, withActions: boolean): BpTemplate | undefined {
  const id = idOf(x['ID']);
  if (id === undefined) return undefined;
  const docType = Array.isArray(x['DOCUMENT_TYPE'])
    ? asText(x['DOCUMENT_TYPE'][2])
    : asText(x['DOCUMENT_TYPE']);
  return {
    id,
    name: asText(x['NAME']),
    moduleId: asText(x['MODULE_ID']),
    documentType: docType,
    autoExecute: AUTO_EXECUTE[asText(x['AUTO_EXECUTE'])] ?? asText(x['AUTO_EXECUTE']),
    modified: asText(x['MODIFIED']),
    userId: idOf(x['USER_ID']) ?? null,
    ...(withActions ? { actions: flattenActions(x['TEMPLATE'] ?? null) } : {}),
  };
}

/** Названия всех шаблонов дизайнера (до 4 страниц) — для подписи запущенных процессов. */
export async function templateNames(ctx: ToolContext): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  let start: number | undefined = 0;
  for (let i = 0; i < 4 && start !== undefined; i += 1) {
    const r = await ctx.bitrix.call(
      'legacy',
      'bizproc.workflow.template.list',
      { select: ['ID', 'NAME'], order: { ID: 'ASC' }, start },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const list = Array.isArray(r.result) ? r.result : [];
    for (const x of list.filter(isObj)) {
      const id = idOf(x['ID']);
      if (id !== undefined) names.set(id, asText(x['NAME']));
    }
    start = list.length === 0 ? undefined : r.next;
  }
  return names;
}

const actionOut = z.object({ depth: z.number(), type: z.string(), title: z.string() });

export const bizprocTemplatesListTool = defineTool({
  name: 'bizproc_templates_list',
  module: 'bizproc',
  title: 'Шаблоны бизнес-процессов',
  description:
    'Шаблоны бизнес-процессов из дизайнера (bizproc.workflow.template.list): название, для чего (сделки, лиды, компании, списки), ' +
    'когда запускается (вручную / при создании / при изменении); includeActions — список действий шаблона (тип и название шага). ' +
    'Использовать, когда спрашивают «какая автоматизация создаёт задачи/сделки». Роботы стадий CRM в REST недоступны — их запуски видны в bizproc_workflows_list.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      documentType: z.enum(DOC_TYPES).optional().describe('Только шаблоны для этого типа записи CRM'),
      includeActions: z.boolean().default(false).describe('Добавить список действий (до 200 на шаблон)'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        moduleId: z.string(),
        documentType: z.string(),
        autoExecute: z.string(),
        modified: z.string(),
        userId: z.number().nullable(),
        actions: z.array(actionOut).optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const select = ['ID', 'NAME', 'MODULE_ID', 'DOCUMENT_TYPE', 'AUTO_EXECUTE', 'MODIFIED', 'USER_ID'];
    if (args.includeActions) select.push('TEMPLATE');
    const filter = args.documentType ? { MODULE_ID: 'crm' } : {};
    const page = await legacyListPage(ctx, {
      tool: 'bizproc_templates_list',
      method: 'bizproc.workflow.template.list',
      params: { select, filter, order: { ID: 'ASC' } },
      bindingParts: { select, filter },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const items = page.items
      .filter(isObj)
      .map((x) => normalizeTemplate(x, args.includeActions))
      .filter(
        (t): t is BpTemplate =>
          t !== undefined && (!args.documentType || t.documentType === args.documentType),
      );
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'bizproc.workflow.template.list', page));
  },
});

export const bizprocWorkflowsListTool = defineTool({
  name: 'bizproc_workflows_list',
  module: 'bizproc',
  title: 'Запущенные бизнес-процессы и роботы',
  description:
    'Работающие сейчас бизнес-процессы и роботы стадий (bizproc.workflow.instances): по какой записи, какой шаблон, когда и кем запущен ' +
    '(startedBy=0 — автоматически), не завис ли. Использовать, когда спрашивают «что автоматически происходит со сделкой», «почему сделка создалась сама». ' +
    'Шаблон, которого нет в bizproc_templates_list, помечается isStageAutomation=true — это роботы стадий (их настройки REST не отдаёт). ' +
    'Показываются только незавершённые процессы.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      documentType: z.enum(DOC_TYPES).optional().describe('Тип записи'),
      recordId: idSchema.optional().describe('ID записи (вместе с documentType)'),
      templateId: idSchema.optional(),
      ...pageArgsShape,
    })
    .strict()
    .refine((a) => a.recordId === undefined || a.documentType !== undefined, {
      message: 'recordId передаётся вместе с documentType',
      path: ['recordId'],
    }),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        documentType: z.string(),
        recordId: z.number().nullable(),
        templateId: z.number().nullable(),
        templateName: z.string().nullable(),
        isStageAutomation: z.boolean(),
        started: z.string(),
        startedBy: z.number().nullable(),
        automatic: z.boolean(),
        modified: z.string(),
        stuck: z.boolean(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const filter: Record<string, string | number> = { MODULE_ID: 'crm' };
    if (args.documentType && args.recordId !== undefined)
      filter['DOCUMENT_ID'] = `${args.documentType}_${String(args.recordId)}`;
    else if (args.documentType) filter['ENTITY'] = DOC_ENTITY[args.documentType];
    if (args.templateId !== undefined) filter['TEMPLATE_ID'] = args.templateId;
    const select = ['ID', 'MODIFIED', 'OWNED_UNTIL', 'DOCUMENT_ID', 'STARTED', 'STARTED_BY', 'TEMPLATE_ID'];
    const [names, page] = await Promise.all([
      templateNames(ctx),
      legacyListPage(ctx, {
        tool: 'bizproc_workflows_list',
        method: 'bizproc.workflow.instances',
        params: { select, filter, order: { STARTED: 'desc' } },
        bindingParts: { select, filter },
        pageSize: pageSizeOf(ctx, args.pageSize),
        cursor: args.cursor,
      }),
    ]);
    const now = Date.now();
    const items = page.items.filter(isObj).map((x) => {
      const doc = asText(x['DOCUMENT_ID']);
      const sep = doc.lastIndexOf('_');
      const templateId = idOf(x['TEMPLATE_ID']) ?? null;
      const startedBy = idOf(x['STARTED_BY']) ?? (asText(x['STARTED_BY']) === '0' ? 0 : null);
      const owned = Date.parse(asText(x['OWNED_UNTIL']));
      return {
        id: asText(x['ID']),
        documentType: sep > 0 ? doc.slice(0, sep) : doc,
        recordId: sep > 0 ? (idOf(doc.slice(sep + 1)) ?? null) : null,
        templateId,
        templateName: templateId === null ? null : (names.get(templateId) ?? null),
        isStageAutomation: templateId !== null && !names.has(templateId),
        started: asText(x['STARTED']),
        startedBy,
        automatic: startedBy === 0,
        modified: asText(x['MODIFIED']),
        // Официальная страница: процесс завис, если блокировка старше 5 минут.
        stuck: Number.isFinite(owned) && now - owned > 5 * 60_000,
      };
    });
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'bizproc.workflow.instances', page));
  },
});

export const bizprocTools = [bizprocTemplatesListTool, bizprocWorkflowsListTool] as const;

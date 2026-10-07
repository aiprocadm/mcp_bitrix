/**
 * Дела CRM по всему порталу (чтение): поиск crm.activity.list с фильтрами вида, направления, периода, темы,
 * ответственного и привязки (BINDINGS — дело находится по любой записи, к которой привязано, а не только по владельцу);
 * привязки одного дела (crm.activity.binding.list); расшифровка звонка (crm.activity.call.getTranscript).
 * Контакты участников (COMMUNICATIONS) и вложения (FILES) не запрашиваются; ссылки на записи разговоров не выдаются.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  isoDateSchema,
  legacyListPage,
  pageMeta,
  pageSizeOf,
  upstreamShapeError,
  yn,
} from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { classicEntity, entityTypeSchema } from './entities.js';
import { ACTIVITY_TYPE_IDS, withPlainDescription } from './related-read.js';

const ENTITY_NAMES: Record<number, string> = {
  1: 'lead',
  2: 'deal',
  3: 'contact',
  4: 'company',
  7: 'quote',
  14: 'order',
  31: 'invoice',
};
const entityName = (id: number | undefined): string | null =>
  id === undefined ? null : (ENTITY_NAMES[id] ?? String(id));

const SEARCH_FIELDS = [
  'ID',
  'TYPE_ID',
  'PROVIDER_ID',
  'PROVIDER_TYPE_ID',
  'SUBJECT',
  'DIRECTION',
  'COMPLETED',
  'RESPONSIBLE_ID',
  'OWNER_TYPE_ID',
  'OWNER_ID',
  'CREATED',
  'START_TIME',
  'END_TIME',
  'DEADLINE',
  'LAST_UPDATED',
] as const;

const KINDS = ['email', 'call', 'meeting', 'task', 'todo'] as const;

/** Дело списка → компактная запись; текст — только при includeDescription (HTML письма → обычный текст). */
export function compactActivity(raw: Record<string, JsonValue>) {
  const dir = asText(raw['DIRECTION']);
  return {
    id: idOf(raw['ID']) ?? 0,
    typeId: idOf(raw['TYPE_ID']) ?? null,
    providerId: asText(raw['PROVIDER_ID']),
    subject: asText(raw['SUBJECT']),
    direction: dir === '1' ? 'incoming' : dir === '2' ? 'outgoing' : null,
    completed: yn(raw['COMPLETED']),
    responsibleId: idOf(raw['RESPONSIBLE_ID']) ?? null,
    owner: { entityType: entityName(idOf(raw['OWNER_TYPE_ID'])), id: idOf(raw['OWNER_ID']) ?? null },
    created: asText(raw['CREATED']),
    startTime: asText(raw['START_TIME']),
    deadline: asText(raw['DEADLINE']),
    ...(raw['DESCRIPTION'] !== undefined
      ? {
          description: asText(raw['DESCRIPTION']),
          ...(raw['DESCRIPTION_TRUNCATED']
            ? { descriptionTruncated: true, descriptionLength: raw['DESCRIPTION_LENGTH'] }
            : {}),
        }
      : {}),
  };
}

export const crmActivitiesSearchTool = defineTool({
  name: 'crm_activities_search',
  module: 'crm',
  title: 'Поиск дел CRM по всему порталу',
  description:
    'Дела CRM по всему порталу (crm.activity.list): письма, звонки, встречи, дела «Сделать». Фильтры: kind (email/call/meeting/task/todo) или providerId ' +
    '(CRM_EMAIL, VOXIMPLANT_CALL, CRM_TODO…), direction (incoming/outgoing), период по dateField, часть темы, ответственный, выполнено, ' +
    'boundTo — все дела, привязанные к записи (в т. ч. звонки, где запись не владелец). ' +
    'Использовать для вопросов «какие письма об оплате пришли сегодня», «какие звонки были по сделкам за неделю», «все звонки клиента». ' +
    'includeDescription — текст (у писем тело письма, HTML → текст, обрезка descriptionMaxChars). Контакты участников и вложения не отдаются. ' +
    'До 50 дел на страницу, продолжение — по cursor; без периода и boundTo выборка по всему порталу очень большая.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      kind: z
        .enum(KINDS)
        .optional()
        .describe(
          'email — письма, call — звонки, meeting — встречи, task — старые задачи CRM, todo — дела «Сделать»',
        ),
      providerId: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,59}$/)
        .optional()
        .describe('Точный PROVIDER_ID, например CRM_EMAIL, VOXIMPLANT_CALL, CRM_TODO, IMOPENLINES_SESSION'),
      direction: z.enum(['incoming', 'outgoing']).optional(),
      dateField: z.enum(['CREATED', 'START_TIME', 'DEADLINE', 'LAST_UPDATED']).default('CREATED'),
      from: isoDateSchema.optional().describe('Начало периода (ISO 8601 с зоной)'),
      to: isoDateSchema.optional().describe('Конец периода'),
      subjectContains: z
        .string()
        .trim()
        .min(2)
        .max(200)
        .optional()
        .describe('Часть темы (SUBJECT), например «оплат»'),
      responsibleId: idSchema.optional(),
      completed: z.boolean().optional(),
      boundTo: z
        .object({ entityType: entityTypeSchema, recordId: idSchema })
        .strict()
        .optional()
        .describe('Только дела, привязанные к этой записи (фильтр BINDINGS)'),
      includeDescription: z.boolean().default(false),
      descriptionMaxChars: z.number().int().min(200).max(20_000).default(2000),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const filter: JsonObject = {};
    if (args.kind === 'todo') filter['PROVIDER_ID'] = 'CRM_TODO';
    else if (args.kind !== undefined) filter['TYPE_ID'] = ACTIVITY_TYPE_IDS[args.kind];
    if (args.providerId) filter['PROVIDER_ID'] = args.providerId;
    if (args.direction) filter['DIRECTION'] = args.direction === 'incoming' ? 1 : 2;
    if (args.from) filter[`>=${args.dateField}`] = args.from;
    if (args.to) filter[`<=${args.dateField}`] = args.to;
    if (args.subjectContains) filter['%SUBJECT'] = args.subjectContains;
    if (args.responsibleId !== undefined) filter['RESPONSIBLE_ID'] = args.responsibleId;
    if (args.completed !== undefined) filter['COMPLETED'] = args.completed ? 'Y' : 'N';
    if (args.boundTo) {
      filter['BINDINGS'] = [
        {
          OWNER_TYPE_ID: classicEntity(args.boundTo.entityType).entityTypeId,
          OWNER_ID: args.boundTo.recordId,
        },
      ];
    }
    const select: string[] = [...SEARCH_FIELDS];
    if (args.includeDescription) select.push('DESCRIPTION', 'DESCRIPTION_TYPE');
    const page = await legacyListPage(ctx, {
      tool: 'crm_activities_search',
      method: 'crm.activity.list',
      params: { filter, select, order: { [args.dateField]: 'DESC', ID: 'DESC' } },
      bindingParts: { filter, select, dateField: args.dateField },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const items = page.items
      .filter(isObj)
      .map((it) =>
        compactActivity(
          args.includeDescription
            ? (withPlainDescription(it, args.descriptionMaxChars) as Record<string, JsonValue>)
            : it,
        ),
      );
    const warnings: string[] = [];
    if (!args.from && !args.to && !args.boundTo)
      warnings.push('Без периода и boundTo поиск идёт по всем делам портала — сузьте выборку');
    return ok(
      { items, returnedCount: items.length },
      pageMeta(ctx, 'crm.activity.list', page, 'legacy', warnings),
    );
  },
});

export const crmActivityBindingsTool = defineTool({
  name: 'crm_activity_bindings',
  module: 'crm',
  title: 'Привязки дела CRM',
  description:
    'Все записи CRM, к которым привязано дело (crm.activity.binding.list): например, звонок привязан к контакту, компании и сделке сразу. ' +
    'Использовать, когда по делу нужно понять, к какой сделке или клиенту оно относится. Возвращаются только записи, доступные пользователю вебхука.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ activityId: idSchema.describe('ID дела') }).strict(),
  outputDataSchema: z.object({
    activityId: z.number(),
    items: z.array(
      z.object({ entityType: z.string().nullable(), entityTypeId: z.number(), entityId: z.number() }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.activity.binding.list',
      { activityId: args.activityId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError('crm.activity.binding.list', 'legacy');
    const items = r.result.filter(isObj).flatMap((b) => {
      const entityTypeId = idOf(b['entityTypeId']);
      const entityId = idOf(b['entityId']);
      return entityTypeId === undefined || entityId === undefined
        ? []
        : [{ entityType: entityName(entityTypeId), entityTypeId, entityId }];
    });
    return ok(
      { activityId: args.activityId, items, returnedCount: items.length },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.activity.binding.list',
        apiVersion: 'legacy',
        completeness: 'complete',
      },
    );
  },
});

export const crmCallTranscriptTool = defineTool({
  name: 'crm_call_transcript',
  module: 'crm',
  title: 'Расшифровка звонка',
  description:
    'Текст расшифровки звонка, сделанной ИИ Битрикс24 (crm.activity.call.getTranscript), по ID дела-звонка. ' +
    'Использовать, когда спрашивают «о чём говорили с клиентом». activityId — из crm_activities_search (kind=call) или crmActivityId в telephony_calls_list. ' +
    'Если расшифровки нет (не делалась, не готова, ошибка) — available=false. Сама запись разговора не выдаётся.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      activityId: idSchema.describe('ID дела-звонка'),
      maxChars: z.number().int().min(500).max(50_000).default(10_000).describe('Предел длины текста'),
    })
    .strict(),
  outputDataSchema: z.object({
    activityId: z.number(),
    available: z.boolean(),
    text: z.string().nullable(),
    truncated: z.boolean(),
    length: z.number(),
  }),
  handler: async (args, ctx) => {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.activity.call.gettranscript',
      { activityId: args.activityId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const text = isObj(r.result) ? asText(r.result['transcription']) : '';
    const truncated = text.length > args.maxChars;
    return ok(
      {
        activityId: args.activityId,
        available: text !== '',
        text: text === '' ? null : truncated ? text.slice(0, args.maxChars) : text,
        truncated,
        length: text.length,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.activity.call.gettranscript',
        apiVersion: 'legacy',
        completeness: truncated ? 'partial' : 'complete',
        warnings:
          text === ''
            ? ['Расшифровки нет: ИИ-обработка звонка не выполнялась, не готова или завершилась ошибкой']
            : [],
      },
    );
  },
});

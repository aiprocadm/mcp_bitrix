/**
 * Универсальные списки (чтение, scope lists): перечень списков, поля списка, элементы.
 * Методы lists.get, lists.field.get, lists.element.get. Значения пользовательских свойств (PROPERTY_N)
 * подписываются названиями полей и значениями из DISPLAY_VALUES_FORM. Запись в списки не реализована.
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
  legacyListPage,
  pageMeta,
  pageSizeOf,
  upstreamShapeError,
  yn,
} from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';

const typeSchema = z
  .enum(['lists', 'bitrix_processes', 'lists_socnet'])
  .default('lists')
  .describe('Тип: lists — универсальные списки, bitrix_processes — процессы, lists_socnet — списки групп');

// ---------- lists_list ----------

export const listsListTool = defineTool({
  name: 'lists_list',
  module: 'lists',
  title: 'Универсальные списки',
  description:
    'Перечень универсальных списков портала (lists.get): ID, название, код, описание. ' +
    'Использовать, когда спрашивают «какие у нас списки/реестры», перед чтением элементов списка.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      iblockType: typeSchema,
      socnetGroupId: idSchema.optional().describe('Для lists_socnet: ID рабочей группы (обязателен)'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        code: z.string(),
        description: z.string(),
        active: z.boolean(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const params: JsonObject = { IBLOCK_TYPE_ID: args.iblockType, IBLOCK_ORDER: { SORT: 'asc' } };
    if (args.socnetGroupId !== undefined) params['SOCNET_GROUP_ID'] = args.socnetGroupId;
    const page = await legacyListPage(ctx, {
      tool: 'lists_list',
      method: 'lists.get',
      params,
      bindingParts: params,
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const items = page.items.filter(isObj).flatMap((x) => {
      const id = idOf(x['ID']);
      return id === undefined
        ? []
        : [
            {
              id,
              name: asText(x['NAME']),
              code: asText(x['CODE']),
              description: asText(x['DESCRIPTION']),
              active: yn(x['ACTIVE']),
            },
          ];
    });
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'lists.get', page));
  },
});

// ---------- поля ----------

export interface ListField {
  fieldId: string;
  name: string;
  type: string;
  required: boolean;
  multiple: boolean;
  values: Record<string, string>;
}

export async function listFields(
  ctx: ToolContext,
  iblockType: string,
  iblockId: number,
): Promise<ListField[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'lists.field.get',
    { IBLOCK_TYPE_ID: iblockType, IBLOCK_ID: iblockId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const raw = Array.isArray(r.result) ? r.result : isObj(r.result) ? Object.values(r.result) : undefined;
  if (!raw) throw upstreamShapeError('lists.field.get', 'legacy');
  return raw.filter(isObj).flatMap((f) => {
    const fieldId = asText(f['FIELD_ID']);
    if (fieldId === '') return [];
    const display = isObj(f['DISPLAY_VALUES_FORM']) ? f['DISPLAY_VALUES_FORM'] : {};
    return [
      {
        fieldId,
        name: asText(f['NAME']) || fieldId,
        type: asText(f['TYPE']),
        required: yn(f['IS_REQUIRED']),
        multiple: yn(f['MULTIPLE']),
        values: Object.fromEntries(Object.entries(display).map(([k, v]) => [k, asText(v)])),
      },
    ];
  });
}

const fieldOut = z.object({
  fieldId: z.string(),
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  multiple: z.boolean(),
  values: z.record(z.string(), z.string()),
});

export const listsFieldsGetTool = defineTool({
  name: 'lists_fields_get',
  module: 'lists',
  title: 'Поля универсального списка',
  description:
    'Поля универсального списка (lists.field.get): код (NAME или PROPERTY_N), название, тип, обязательность, варианты значений. ' +
    'Использовать, чтобы понять структуру списка перед lists_elements_list.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({ iblockType: typeSchema, iblockId: idSchema.describe('ID списка из lists_list') })
    .strict(),
  outputDataSchema: z.object({ iblockId: z.number(), items: z.array(fieldOut), returnedCount: z.number() }),
  handler: async (args, ctx) => {
    const items = await listFields(ctx, args.iblockType, args.iblockId);
    return ok(
      { iblockId: args.iblockId, items, returnedCount: items.length },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'lists.field.get',
        apiVersion: 'legacy',
        completeness: 'complete',
      },
    );
  },
});

// ---------- элементы ----------

/** Значение свойства элемента: {"3743":"1269"} или массив/скаляр → список строк; для списков — подписи вариантов. */
function propertyValues(raw: JsonValue, field: ListField | undefined): string[] {
  const vals = isObj(raw)
    ? Object.values(raw)
    : Array.isArray(raw)
      ? raw
      : raw === null || raw === undefined
        ? []
        : [raw];
  return vals
    .map((v) => asText(v))
    .filter((v) => v !== '')
    .map((v) => field?.values[v] ?? v);
}

export function labelElement(raw: Record<string, JsonValue>, fields: Map<string, ListField>) {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('PROPERTY_')) continue;
    const field = fields.get(key);
    const vals = propertyValues(value, field);
    if (vals.length === 0) continue;
    out[field?.name ?? key] = field?.multiple || vals.length > 1 ? vals : (vals[0] ?? '');
  }
  return {
    id: idOf(raw['ID']) ?? 0,
    name: asText(raw['NAME']),
    code: asText(raw['CODE']),
    createdBy: idOf(raw['CREATED_BY']) ?? null,
    dateCreate: asText(raw['DATE_CREATE']),
    sectionId: idOf(raw['IBLOCK_SECTION_ID']) ?? null,
    fields: out,
  };
}

export const listsElementsListTool = defineTool({
  name: 'lists_elements_list',
  module: 'lists',
  title: 'Элементы универсального списка',
  description:
    'Элементы универсального списка (lists.element.get) с полями, подписанными по-человечески (название поля → значение). ' +
    'Использовать, когда спрашивают «что в списке/реестре», «найди элемент списка». nameContains — поиск по названию элемента. ' +
    'До 50 элементов на страницу, продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      iblockType: typeSchema,
      iblockId: idSchema.describe('ID списка из lists_list'),
      nameContains: z.string().trim().min(1).max(200).optional().describe('Часть названия элемента'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    iblockId: z.number(),
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        code: z.string(),
        createdBy: z.number().nullable(),
        dateCreate: z.string(),
        sectionId: z.number().nullable(),
        fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const fields = new Map(
      (await listFields(ctx, args.iblockType, args.iblockId)).map((f) => [f.fieldId, f]),
    );
    const params: JsonObject = {
      IBLOCK_TYPE_ID: args.iblockType,
      IBLOCK_ID: args.iblockId,
      ELEMENT_ORDER: { ID: 'DESC' },
    };
    if (args.nameContains) params['FILTER'] = { '%NAME': args.nameContains };
    const page = await legacyListPage(ctx, {
      tool: 'lists_elements_list',
      method: 'lists.element.get',
      params,
      bindingParts: params,
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const items = page.items.filter(isObj).map((x) => labelElement(x, fields));
    const unknown = new Set(
      page.items
        .filter(isObj)
        .flatMap((x) => Object.keys(x))
        .filter((k) => k.startsWith('PROPERTY_') && !fields.has(k)),
    );
    const warnings = unknown.size
      ? [`Поля без описания в lists.field.get показаны кодом: ${[...unknown].join(', ')}`]
      : [];
    return ok(
      { iblockId: args.iblockId, items, returnedCount: items.length },
      pageMeta(ctx, 'lists.element.get', page, 'legacy', warnings),
    );
  },
});

export const listsTools = [listsListTool, listsFieldsGetTool, listsElementsListTool] as const;

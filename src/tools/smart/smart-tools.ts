/**
 * Смарт-процессы (ТЗ §9.7): типы (crm.type.list) и элементы через универсальный адаптер crm.item.*.
 * id типа crm.type и entityTypeId — разные идентификаторы: список типов отдаёт оба, остальные инструменты
 * принимают только entityTypeId и проверяют его по порталу (crm.type.getByEntityTypeId), без «зашитых» номеров.
 * Перед записью читаются crm.item.fields (кэш 5 минут) и справочник стадий DYNAMIC_{entityTypeId}_STAGE_{categoryId}.
 */
import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import {
  pageArgsShape,
  requireIdempotencyUnlessDryRun,
  updateArgsShape,
  writeArgsShape,
} from '../../schemas/common.js';
import { idSchema, isObj, legacyListPage, mutationOutputShape, pageMeta, pageSizeOf } from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  defineTool,
  READ_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  type ToolDefinition,
} from '../types.js';
import { crmFieldsSchema } from '../crm/create-record.js';
import {
  itemCreateEnvelope,
  itemGetEnvelope,
  itemListEnvelope,
  itemUpdateEnvelope,
} from '../crm/item-ops.js';
import { normalizeSmartType, smartTarget, type SmartType } from '../crm/item-service.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const filterSchema = z
  .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
  .default({})
  .describe(
    'Фильтр crm.item.list: [префикс]имяПоля в camelCase, например {"%title": "договор", "stageId": "DT1256_7:NEW"}',
  );
const orderSchema = z
  .record(z.string().max(100), z.enum(['ASC', 'DESC', 'asc', 'desc']))
  .optional()
  .describe('Сортировка, например {"createdTime": "DESC"}; по умолчанию id по убыванию');
const selectSchema = z
  .array(z.string().max(100))
  .max(100)
  .optional()
  .describe('Поля camelCase из crm_fields_get (entityType=smart); по умолчанию ключевые поля');
const entityTypeId = z
  .number()
  .int()
  .positive()
  .max(1_000_000)
  .describe('entityTypeId смарт-процесса из smart_process_types_list (НЕ id типа)');
const fieldsSchema = crmFieldsSchema.describe(
  'Поля элемента в camelCase по crm_fields_get (entityType=smart, entityTypeId): title, stageId, categoryId, assignedById, ufCrm*_…',
);

const smartTypeOutput = z.object({
  typeId: z.number(),
  entityTypeId: z.number(),
  title: z.string(),
  code: z.string(),
  isCategoriesEnabled: z.boolean(),
  isStagesEnabled: z.boolean(),
  isLinkWithProductsEnabled: z.boolean(),
  isRecyclebinEnabled: z.boolean(),
  isAutomationEnabled: z.boolean(),
  isBizProcEnabled: z.boolean(),
  isClientEnabled: z.boolean(),
  isObserversEnabled: z.boolean(),
  isBeginCloseDatesEnabled: z.boolean(),
});

export const smartProcessTypesListTool = defineTool({
  name: 'smart_process_types_list',
  module: 'smartProcesses',
  title: 'Типы смарт-процессов',
  description:
    'Список типов смарт-процессов портала (crm.type.list): для каждого — typeId (ID записи типа), entityTypeId (идентификатор, ' +
    'который нужен всем инструментам элементов), название и настройки (воронки, стадии, товары, корзина, автоматизация). ' +
    'Использовать первым, чтобы узнать entityTypeId; typeId и entityTypeId не путать. По документации метод требует ' +
    'административного доступа к CRM; без него — BITRIX_ACCESS_DENIED. Страница до 50 типов, продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      title: z.string().trim().min(1).max(100).optional().describe('Часть названия типа'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({ items: z.array(smartTypeOutput), returnedCount: z.number() }),
  handler: async (args, ctx) => {
    const filter = args.title ? { '%title': args.title } : {};
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const page = await legacyListPage(ctx, {
      tool: 'smart_process_types_list',
      method: 'crm.type.list',
      params: { filter, order: { id: 'ASC' } },
      bindingParts: { filter },
      pageSize,
      cursor: args.cursor,
      extract: (result) => {
        const types = isObj(result) ? result['types'] : undefined;
        return Array.isArray(types) ? types : undefined;
      },
    });
    const items = page.items.map(normalizeSmartType).filter((x): x is SmartType => x !== undefined);
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'crm.type.list', page));
  },
});

export const smartProcessItemsListTool = defineTool({
  name: 'smart_process_items_list',
  module: 'smartProcesses',
  title: 'Элементы смарт-процесса',
  description:
    'Страница элементов смарт-процесса (crm.item.list) с фильтром, сортировкой и выбором полей в camelCase по схеме портала. ' +
    'Использовать, когда нужен список элементов конкретного смарт-процесса по условию (стадия, ответственный, даты, название). ' +
    'entityTypeId проверяется по порталу. Страница до 50 элементов; продолжение — по cursor из ответа.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityTypeId,
      filter: filterSchema,
      order: orderSchema,
      select: selectSchema,
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    entityTypeId: z.number(),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const target = await smartTarget(ctx, args.entityTypeId);
    return itemListEnvelope(
      ctx,
      target,
      { tool: 'smart_process_items_list', ...args },
      { entityTypeId: args.entityTypeId },
    );
  },
});

export const smartProcessItemGetTool = defineTool({
  name: 'smart_process_item_get',
  module: 'smartProcesses',
  title: 'Элемент смарт-процесса',
  description:
    'Элемент смарт-процесса по ID (crm.item.get) со всеми доступными полями в camelCase или выбранными через select. ' +
    'Использовать, когда известны entityTypeId и ID элемента. Возвращает stateHash для expectedStateHash в smart_process_item_update.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({ entityTypeId, id: idSchema.describe('ID элемента'), select: selectSchema })
    .strict(),
  outputDataSchema: z.object({
    entityTypeId: z.number(),
    id: z.number(),
    title: z.string(),
    record: z.record(z.string(), z.unknown()),
    stateHash: z.string(),
  }),
  handler: async (args, ctx) => {
    const target = await smartTarget(ctx, args.entityTypeId);
    return itemGetEnvelope(ctx, target, args.id, args.select, { entityTypeId: args.entityTypeId });
  },
});

export const smartProcessItemCreateTool = defineTool({
  name: 'smart_process_item_create',
  module: 'smartProcesses',
  title: 'Создать элемент смарт-процесса',
  description:
    'Создать элемент смарт-процесса (crm.item.add). Поля camelCase проверяются по crm.item.fields портала: неизвестные, read-only ' +
    'и незаполненные обязательные отклоняются; stageId — по стадиям воронки. Использовать, когда пользователь явно просит создать элемент. ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с планом (записи нет); после подтверждения человеком повтор с теми же ' +
    'параметрами и approvalId создаёт элемент ровно один раз. dryRun=true только показывает план.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({ entityTypeId, fields: fieldsSchema, ...writeArgsShape })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityTypeId: z.number(),
    id: z.number().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const target = await smartTarget(ctx, args.entityTypeId);
    const { envelope } = await itemCreateEnvelope(ctx, target, {
      tool: 'smart_process_item_create',
      rawFields: args.fields,
      args,
      base: { entityTypeId: args.entityTypeId },
    });
    return envelope;
  },
});

export const smartProcessItemUpdateTool = defineTool({
  name: 'smart_process_item_update',
  module: 'smartProcesses',
  title: 'Изменить элемент смарт-процесса',
  description:
    'Изменить поля элемента смарт-процесса (crm.item.update); передавайте только изменяемые поля в camelCase. ' +
    'Использовать, когда пользователь явно просит изменить элемент. Поля проверяются по crm.item.fields (immutable и read-only ' +
    'отклоняются), stageId — по стадиям воронки. Рекомендуется expectedStateHash из smart_process_item_get: при расхождении — CONFLICT. ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с diff «было → станет»; повтор с approvalId применяет изменение один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({ entityTypeId, id: idSchema.describe('ID элемента'), fields: fieldsSchema, ...updateArgsShape })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityTypeId: z.number(),
    id: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const target = await smartTarget(ctx, args.entityTypeId);
    return itemUpdateEnvelope(ctx, target, {
      tool: 'smart_process_item_update',
      id: args.id,
      rawFields: args.fields,
      args,
      base: { entityTypeId: args.entityTypeId },
    });
  },
});

export const smartTools: readonly ToolDefinition[] = [
  smartProcessTypesListTool,
  smartProcessItemsListTool,
  smartProcessItemGetTool,
  smartProcessItemCreateTool,
  smartProcessItemUpdateTool,
];

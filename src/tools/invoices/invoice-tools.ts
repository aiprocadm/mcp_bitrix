/**
 * Счета (ТЗ §9.5): новые смарт-счета — универсальная сущность CRM entityTypeId=31 через crm.item.*.
 * Старые crm.invoice.* не используются; crm.type.get для 31 не вызывается.
 * «Выставить счёт» здесь = создать карточку счёта: PDF, отправка, ссылка на оплату, фискализация и отметка оплаты
 * НЕ выполняются и не заявляются.
 * invoice_create — составная операция: crm.item.add, затем товарные позиции отдельным шагом crm.item.productrow.set
 * (ownerType=SI). Оба шага — внутри одной подтверждённой операции; если товары не записались, счёт уже создан:
 * результат (ID счёта и статус шага) сохраняется в ledger, ответ — PARTIAL_SUCCESS, повтор с тем же ключом/approvalId
 * возвращает тот же результат и второй счёт НЕ создаёт (T34).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import {
  pageArgsShape,
  requireIdempotencyUnlessDryRun,
  updateArgsShape,
  writeArgsShape,
} from '../../schemas/common.js';
import { idOf, idSchema, isObj, mutationOutputShape } from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  defineTool,
  READ_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  type ToolDefinition,
} from '../types.js';
import { crmFieldsSchema } from '../crm/create-record.js';
import { listCategories } from '../crm/crm-service.js';
import { itemCreateEnvelope, itemListEnvelope, itemUpdateEnvelope } from '../crm/item-ops.js';
import {
  INVOICE_ENTITY_TYPE_ID,
  INVOICE_TARGET,
  itemRowsFirstPage,
  itemStages,
  setItemRows,
} from '../crm/item-service.js';
import { rowsTotal, rowToBitrix } from '../crm/related-service.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const fieldsSchema = crmFieldsSchema.describe(
  'Поля счёта в camelCase по crm_fields_get (entityType=invoice): title, stageId, categoryId, companyId, contactId, ' +
    'assignedById, currencyId, begindate, closedate, ufCrm*_…; регистр автоматически не переводится',
);

const rowInput = z
  .object({
    productId: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('ID товара каталога; 0 или нет — произвольная позиция'),
    productName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Название (обязательно без productId)'),
    price: z.number().min(0).max(1e12).describe('Цена за единицу'),
    quantity: z.number().gt(0).max(1e9).default(1).describe('Количество (> 0)'),
    discountTypeId: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('1 — скидка суммой, 2 — процентом'),
    discountRate: z.number().min(0).max(100).optional().describe('Скидка, %'),
    discountSum: z.number().min(0).max(1e12).optional().describe('Скидка суммой на единицу'),
    taxRate: z.number().min(0).max(100).optional().describe('Ставка налога, %'),
    taxIncluded: z.boolean().optional().describe('Налог включён в цену'),
    measureCode: z.number().int().positive().max(10_000).optional().describe('Код единицы измерения'),
    sort: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((r) => (r.productId !== undefined && r.productId > 0) || r.productName !== undefined, {
    message: 'нужен productId товара каталога или productName произвольной позиции',
  });

const productRowsStep = z.object({
  status: z.enum(['saved', 'failed', 'unknown']),
  requested: z.number(),
  saved: z.number().optional(),
  errorCode: z.string().optional(),
});
type ProductRowsStep = z.infer<typeof productRowsStep>;

export const invoiceListTool = defineTool({
  name: 'invoice_list',
  module: 'invoices',
  title: 'Список счетов',
  description:
    'Страница новых смарт-счетов (crm.item.list, entityTypeId=31) с фильтром, сортировкой и выбором полей в camelCase. ' +
    'Использовать, когда нужен список счетов по условию: стадия, компания, ответственный, даты. Старые счета crm.invoice.* не читаются. ' +
    'Страница до 50 счетов; продолжение — по cursor из ответа.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      filter: z
        .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
        .default({})
        .describe(
          'Фильтр crm.item.list: [префикс]имяПоля, например {"companyId": 5, ">=createdTime": "2026-09-01"}',
        ),
      order: z
        .record(z.string().max(100), z.enum(['ASC', 'DESC', 'asc', 'desc']))
        .optional()
        .describe('Сортировка, например {"createdTime": "DESC"}; по умолчанию id по убыванию'),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe('Поля camelCase; по умолчанию ключевые'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => itemListEnvelope(ctx, INVOICE_TARGET, { tool: 'invoice_list', ...args }, {}),
});

export const invoiceCreateTool = defineTool({
  name: 'invoice_create',
  module: 'invoices',
  title: 'Создать счёт',
  description:
    'Создать карточку нового смарт-счёта (crm.item.add, entityTypeId=31) и, если переданы productRows, записать товарные позиции ' +
    'отдельным шагом (crm.item.productrow.set, ownerType=SI). Использовать, когда пользователь явно просит создать счёт. ' +
    'PDF, отправка клиенту, ссылка на оплату и отметка оплаты НЕ выполняются. Поля проверяются по crm.item.fields, стадия — по воронке счетов. ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с планом; после подтверждения повтор с approvalId создаёт счёт один раз. ' +
    'Если счёт создан, а товары нет — PARTIAL_SUCCESS с ID счёта; повтор не создаёт второй счёт.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      fields: fieldsSchema,
      productRows: z.array(rowInput).min(1).max(100).optional().describe('Товарные позиции счёта (до 100)'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    id: z.number().optional(),
    productRows: productRowsStep.optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const rows: JsonObject[] | undefined = args.productRows?.map((r) => rowToBitrix(r));
    const requested = rows?.length ?? 0;
    const { envelope, result, operationId } = await itemCreateEnvelope(ctx, INVOICE_TARGET, {
      tool: 'invoice_create',
      rawFields: args.fields,
      args,
      base: {},
      resultFields: ['productRows'],
      planDetails: rows
        ? {
            steps: ['crm.item.add (entityTypeId=31)', 'crm.item.productrow.set (ownerType=SI)'],
            productRows: rows,
            productRowsTotal: rowsTotal(args.productRows ?? []),
          }
        : { steps: ['crm.item.add (entityTypeId=31)'] },
      extraRisks: rows
        ? [
            'Составная операция: если товарные позиции не запишутся, счёт останется без товаров (PARTIAL_SUCCESS), повторно не создаётся',
            'Сумма счёта может быть пересчитана порталом по товарным позициям',
          ]
        : [],
      afterCreate: async (id) => {
        if (!rows) return {};
        let step: ProductRowsStep;
        try {
          const saved = await setItemRows(ctx, INVOICE_TARGET.ownerType, id, rows);
          step = { status: 'saved', requested, saved };
        } catch (e) {
          // Счёт уже создан: ошибка шага фиксируется в результате, чтобы ID счёта сохранился в ledger.
          const err = AppError.from(e);
          step = {
            status: err.code === 'OPERATION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
            requested,
            errorCode: err.code,
          };
        }
        return { productRows: step };
      },
      verifyExtra: async (performed) => {
        const step = performed.result['productRows'] as ProductRowsStep | undefined;
        if (!step) return { verified: true, warnings: [] };
        if (step.status !== 'saved')
          return { verified: false, warnings: ['Товарные позиции счёта не записаны'] };
        const page = await itemRowsFirstPage(ctx, INVOICE_TARGET.ownerType, Number(performed.id), 100);
        const count = page.total ?? page.rows.length;
        const same = count === requested;
        return {
          verified: same,
          warnings: same
            ? []
            : [
                `Товарных позиций в счёте ${String(count)}, запрошено ${String(requested)}: сверьте счёт в Bitrix24`,
              ],
        };
      },
    });
    const step =
      result && isObj(result['productRows']) ? (result['productRows'] as ProductRowsStep) : undefined;
    if (step && step.status !== 'saved') {
      const id = String(idOf(result?.['id']) ?? '');
      throw new AppError(
        'PARTIAL_SUCCESS',
        `Счёт #${id} создан, но товарные позиции ${step.status === 'unknown' ? 'имеют неизвестный исход' : 'не записаны'}` +
          ` (${step.errorCode ?? 'ошибка'}). Повторный вызов вернёт этот же результат и второй счёт не создаст`,
        {
          ...(operationId ? { operationId } : {}),
          field: 'productRows',
          reason: step.status === 'unknown' ? 'PRODUCT_ROWS_OUTCOME_UNKNOWN' : 'PRODUCT_ROWS_FAILED',
          nextAction: `Откройте счёт #${id} в Bitrix24, сверьте и при необходимости добавьте товарные позиции вручную; не создавайте счёт заново`,
        },
      );
    }
    return envelope;
  },
});

export const invoiceUpdateTool = defineTool({
  name: 'invoice_update',
  module: 'invoices',
  title: 'Изменить счёт',
  description:
    'Изменить поля смарт-счёта (crm.item.update, entityTypeId=31); передавайте только изменяемые поля в camelCase. ' +
    'Использовать, когда пользователь явно просит изменить счёт (стадия, ответственный, даты, реквизиты полей). Товарные позиции этим ' +
    'инструментом не меняются. Рекомендуется expectedStateHash из crm_get_record (entityType=invoice): при расхождении — CONFLICT. ' +
    'Вызов без approvalId возвращает APPROVAL_REQUIRED с diff; повтор с approvalId применяет изменение один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({ invoiceId: idSchema.describe('ID счёта'), fields: fieldsSchema, ...updateArgsShape })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    invoiceId: z.number(),
    id: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) =>
    itemUpdateEnvelope(ctx, INVOICE_TARGET, {
      tool: 'invoice_update',
      id: args.invoiceId,
      rawFields: args.fields,
      args,
      base: { invoiceId: args.invoiceId },
    }),
});

const MAX_CATEGORIES = 20;

export const invoiceStagesListTool = defineTool({
  name: 'invoice_stages_list',
  module: 'invoices',
  title: 'Воронки и стадии счетов',
  description:
    'Воронки (crm.category.list, entityTypeId=31) и стадии смарт-счетов (crm.status.list, ENTITY_ID=SMART_INVOICE_STAGE_{categoryId}) ' +
    'с ID, названием, порядком и семантикой. Использовать перед созданием/сменой стадии счёта, чтобы взять точный stageId.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      categoryId: z.number().int().min(0).max(1_000_000).optional().describe('Только эта воронка счетов'),
    })
    .strict(),
  outputDataSchema: z.object({
    categories: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        isDefault: z.boolean(),
        sort: z.number(),
        statusEntityId: z.string(),
        stages: z.array(
          z.object({
            statusId: z.string(),
            name: z.string(),
            sort: z.number(),
            semantics: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
  handler: async (args, ctx) => {
    const all = await listCategories(ctx, INVOICE_ENTITY_TYPE_ID);
    const chosen = args.categoryId === undefined ? all : all.filter((c) => c.id === args.categoryId);
    if (args.categoryId !== undefined && chosen.length === 0) {
      throw new AppError('NOT_FOUND', `Воронка счетов ${String(args.categoryId)} не найдена или недоступна`, {
        field: 'categoryId',
        nextAction: 'Вызовите invoice_stages_list без categoryId',
      });
    }
    const limited = chosen.slice(0, MAX_CATEGORIES);
    const categories = [];
    for (const c of limited) {
      const { entityId, stages } = await itemStages(ctx, INVOICE_TARGET, c.id);
      categories.push({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
        sort: c.sort,
        statusEntityId: entityId,
        stages: stages.map((s) => ({
          statusId: s.statusId,
          name: s.name,
          sort: s.sort,
          ...(s.semantics ? { semantics: s.semantics } : {}),
        })),
      });
    }
    const partial = chosen.length > limited.length;
    return ok(
      { categories },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.status.list',
        apiVersion: 'legacy',
        completeness: partial ? 'partial' : 'complete',
        warnings: partial
          ? [
              `Показаны первые ${String(MAX_CATEGORIES)} воронок из ${String(chosen.length)}; укажите categoryId`,
            ]
          : [],
      },
    );
  },
});

export const invoiceTools: readonly ToolDefinition[] = [
  invoiceListTool,
  invoiceCreateTool,
  invoiceUpdateTool,
  invoiceStagesListTool,
];

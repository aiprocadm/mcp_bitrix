/**
 * Заказы магазина (ТЗ §9.6, модуль sale): store_order_get и store_orders_list — только чтение.
 * Персональные данные покупателя минимизируются (§8.4): свойства заказа (ФИО, телефон, email, адрес — propertyValues),
 * комментарии покупателя/менеджера, адреса и трек-номера отгрузок, реквизиты не выводятся — только ID-ссылки.
 * Состав заказа берётся из basketItems ответа sale.order.get; если его там нет — дочитывается sale.basketitem.list
 * с ограничением по страницам; неполный состав помечается completeness=partial и reason=PARTIAL_RESULT.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  isoDateSchema,
  legacyListPage,
  num,
  pageMeta,
  pageSizeOf,
  upstreamShapeError,
  yn,
} from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';

const PII_WARNING =
  'Персональные данные покупателя (свойства заказа, комментарии, адреса доставки) не выводятся политикой минимизации';

/** Не больше позиций в ответе и страниц дочитывания состава (по 50). */
const MAX_ITEMS = 200;
const MAX_BASKET_PAGES = 4;

const opt = (k: string, v: unknown) => (v === undefined || v === '' || v === null ? {} : { [k]: v });

function orderSummary(o: Record<string, JsonValue>) {
  return {
    id: idOf(o['id']) ?? 0,
    ...opt('accountNumber', asText(o['accountNumber'])),
    ...opt('statusId', asText(o['statusId'])),
    ...opt('createdAt', asText(o['dateInsert'])),
    ...opt('updatedAt', asText(o['dateUpdate'])),
    ...opt('price', num(o['price'])),
    ...opt('currency', asText(o['currency'])),
    paid: yn(o['payed']),
    canceled: yn(o['canceled']),
    deducted: yn(o['deducted']),
    ...opt('personTypeId', idOf(o['personTypeId'])),
    ...opt('responsibleId', idOf(o['responsibleId'])),
    ...opt('userId', idOf(o['userId'])),
  };
}

const orderSummarySchema = z.object({
  id: z.number(),
  accountNumber: z.string().optional(),
  statusId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  paid: z.boolean(),
  canceled: z.boolean(),
  deducted: z.boolean(),
  personTypeId: z.number().optional(),
  responsibleId: z.number().optional(),
  userId: z.number().optional(),
});

const itemSchema = z.object({
  id: z.number(),
  productId: z.number().optional(),
  name: z.string(),
  quantity: z.number().optional(),
  measureName: z.string().optional(),
  price: z.number().optional(),
  basePrice: z.number().optional(),
  discountPrice: z.number().optional(),
  currency: z.string().optional(),
  vatRate: z.number().optional(),
  vatIncluded: z.boolean().optional(),
});

function normalizeItem(raw: JsonValue): z.infer<typeof itemSchema> | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['id']);
  if (id === undefined) return undefined;
  return {
    id,
    ...opt('productId', idOf(raw['productId'])),
    name: asText(raw['name']),
    ...opt('quantity', num(raw['quantity'])),
    ...opt('measureName', asText(raw['measureName'])),
    ...opt('price', num(raw['price'])),
    ...opt('basePrice', num(raw['basePrice'])),
    ...opt('discountPrice', num(raw['discountPrice'])),
    ...opt('currency', asText(raw['currency'])),
    ...opt('vatRate', num(raw['vatRate'])),
    ...(raw['vatIncluded'] !== undefined && raw['vatIncluded'] !== null
      ? { vatIncluded: yn(raw['vatIncluded']) }
      : {}),
  };
}

const BASKET_SELECT = [
  'id',
  'orderId',
  'productId',
  'name',
  'quantity',
  'measureName',
  'price',
  'basePrice',
  'discountPrice',
  'currency',
  'vatRate',
  'vatIncluded',
];

/** Состав заказа через sale.basketitem.list: до MAX_BASKET_PAGES страниц; дальше — partial. */
async function basketItems(
  ctx: ToolContext,
  orderId: number,
): Promise<{ items: JsonValue[]; complete: boolean; total: number | undefined }> {
  const items: JsonValue[] = [];
  let start: number | undefined = 0;
  let total: number | undefined;
  for (let page = 0; page < MAX_BASKET_PAGES && start !== undefined; page++) {
    const r = await ctx.bitrix.call(
      'legacy',
      'sale.basketitem.list',
      { select: BASKET_SELECT, filter: { orderId }, order: { id: 'asc' }, start },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const arr = isObj(r.result) ? r.result['basketItems'] : undefined;
    if (!Array.isArray(arr)) throw upstreamShapeError('sale.basketitem.list', 'legacy');
    items.push(...arr);
    total = r.total ?? total;
    start = r.next;
  }
  return { items, complete: start === undefined, total };
}

// ---------- store_order_get ----------

export const storeOrderGetTool = defineTool({
  name: 'store_order_get',
  module: 'orders',
  title: 'Заказ магазина',
  description:
    'Заказ интернет-магазина (sale.order.get) со статусом, суммой, оплатой/отгрузкой и составом позиций. ' +
    'Использовать, когда спрашивают о конкретном заказе по его ID. Если состав не пришёл вместе с заказом, ' +
    'он дочитывается sale.basketitem.list; неполный состав честно помечается completeness=partial (PARTIAL_RESULT). ' +
    'Персональные данные покупателя (ФИО, телефоны, email, адреса, комментарии) не выводятся — только ID покупателя и CRM-привязки.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      orderId: idSchema.describe('ID заказа'),
      includeItems: z.boolean().default(true).describe('Включить состав заказа'),
    })
    .strict(),
  outputDataSchema: z.object({
    order: orderSummarySchema.extend({
      discountValue: z.number().optional(),
      taxValue: z.number().optional(),
      clients: z.array(z.object({ entityTypeId: z.number(), entityId: z.number(), isPrimary: z.boolean() })),
      payments: z.array(
        z.object({
          id: z.number(),
          sum: z.number().optional(),
          currency: z.string().optional(),
          paid: z.boolean(),
          paySystemName: z.string().optional(),
        }),
      ),
      shipments: z.array(
        z.object({
          id: z.number(),
          deliveryName: z.string().optional(),
          statusId: z.string().optional(),
          deducted: z.boolean(),
        }),
      ),
    }),
    items: z.array(itemSchema).optional(),
    itemsSource: z.enum(['order', 'basketitem.list']).optional(),
    itemsCompleteness: z.enum(['complete', 'partial']).optional(),
    partialReason: z.literal('PARTIAL_RESULT').optional(),
  }),
  handler: async (args, ctx) => {
    const r = await ctx.bitrix.call(
      'legacy',
      'sale.order.get',
      { id: args.orderId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const o = isObj(r.result) ? r.result['order'] : undefined;
    if (o === null || o === undefined) {
      throw new AppError('NOT_FOUND', `Заказ #${String(args.orderId)} не найден или недоступен`, {
        method: 'sale.order.get',
        apiVersion: 'legacy',
      });
    }
    if (!isObj(o)) throw upstreamShapeError('sale.order.get', 'legacy');

    const list = (v: JsonValue | undefined) => (Array.isArray(v) ? v.filter(isObj) : []);
    const order = {
      ...orderSummary(o),
      ...opt('discountValue', num(o['discountValue'])),
      ...opt('taxValue', num(o['taxValue'])),
      clients: list(o['clients']).flatMap((c) => {
        const entityTypeId = idOf(c['entityTypeId']);
        const entityId = idOf(c['entityId']);
        return entityTypeId && entityId ? [{ entityTypeId, entityId, isPrimary: yn(c['isPrimary']) }] : [];
      }),
      payments: list(o['payments']).flatMap((p) => {
        const id = idOf(p['id']);
        return id
          ? [
              {
                id,
                ...opt('sum', num(p['sum'])),
                ...opt('currency', asText(p['currency'])),
                paid: yn(p['paid']),
                ...opt('paySystemName', asText(p['paySystemName'])),
              },
            ]
          : [];
      }),
      // Отгрузки без адресов, трек-номеров и комментариев.
      shipments: list(o['shipments']).flatMap((s) => {
        const id = idOf(s['id']);
        if (!id || yn(s['system'])) return [];
        return [
          {
            id,
            ...opt('deliveryName', asText(s['deliveryName'])),
            ...opt('statusId', asText(s['statusId'])),
            deducted: yn(s['deducted']),
          },
        ];
      }),
    };

    const warnings = [PII_WARNING];
    if (!args.includeItems) {
      return ok(
        { order },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          method: 'sale.order.get',
          apiVersion: 'legacy',
          warnings,
        },
      );
    }

    let rawItems: JsonValue[];
    let source: 'order' | 'basketitem.list';
    let complete = true;
    if (Array.isArray(o['basketItems'])) {
      rawItems = o['basketItems'];
      source = 'order';
    } else {
      const b = await basketItems(ctx, args.orderId);
      rawItems = b.items;
      source = 'basketitem.list';
      if (!b.complete) {
        complete = false;
        warnings.push(
          `Состав прочитан не полностью: ${String(b.items.length)} из ${b.total !== undefined ? String(b.total) : 'неизвестного числа'} позиций`,
        );
      }
    }
    const items = rawItems.map(normalizeItem).filter((i): i is z.infer<typeof itemSchema> => i !== undefined);
    if (items.length < rawItems.length) {
      complete = false;
      warnings.push('Часть позиций пришла в неожиданном формате и пропущена');
    }
    let shown = items;
    if (items.length > MAX_ITEMS) {
      shown = items.slice(0, MAX_ITEMS);
      complete = false;
      warnings.push(`Показаны первые ${String(MAX_ITEMS)} позиций из ${String(items.length)}`);
    }
    return ok(
      {
        order,
        items: shown,
        itemsSource: source,
        itemsCompleteness: complete ? ('complete' as const) : ('partial' as const),
        ...(complete ? {} : { partialReason: 'PARTIAL_RESULT' as const }),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: source === 'order' ? 'sale.order.get' : 'sale.basketitem.list',
        apiVersion: 'legacy',
        completeness: complete ? 'complete' : 'partial',
        warnings,
      },
    );
  },
});

// ---------- store_orders_list ----------

const ORDER_SELECT = [
  'id',
  'accountNumber',
  'statusId',
  'dateInsert',
  'dateUpdate',
  'price',
  'currency',
  'payed',
  'canceled',
  'deducted',
  'personTypeId',
  'responsibleId',
  'userId',
];

export const storeOrdersListTool = defineTool({
  name: 'store_orders_list',
  module: 'orders',
  title: 'Заказы магазина',
  description:
    'Список заказов интернет-магазина (sale.order.list): номер, статус, дата создания, сумма, оплачен/отменён/отгружен. ' +
    'Использовать, когда спрашивают «какие заказы пришли за период» или «заказы в статусе…»; состав конкретного заказа — ' +
    'store_order_get. from/to — период по дате создания (ISO 8601), status — код статуса (например, N, P, F). ' +
    'Персональные данные покупателя не выводятся.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      from: isoDateSchema.optional().describe('Создан не раньше (включительно)'),
      to: isoDateSchema.optional().describe('Создан не позже (включительно)'),
      status: z
        .string()
        .regex(/^[A-Z0-9_]{1,20}$/, 'код статуса заказа, например N')
        .optional()
        .describe('Код статуса заказа'),
      ...pageArgsShape,
    })
    .strict()
    .superRefine((a, c) => {
      if (a.from && a.to && Date.parse(a.from) > Date.parse(a.to))
        c.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'to раньше from',
          params: { reason: 'INVALID_DATE_RANGE' },
        });
    }),
  outputDataSchema: z.object({ items: z.array(orderSummarySchema), returnedCount: z.number() }),
  handler: async (args, ctx) => {
    const filter: JsonObject = {};
    if (args.from) filter['>=dateInsert'] = args.from;
    if (args.to) filter['<=dateInsert'] = args.to;
    if (args.status) filter['statusId'] = args.status;
    const page = await legacyListPage(ctx, {
      tool: 'store_orders_list',
      method: 'sale.order.list',
      params: { select: ORDER_SELECT, filter, order: { id: 'desc' } },
      bindingParts: { filter },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
      extract: (result) => {
        const arr = isObj(result) ? result['orders'] : undefined;
        return Array.isArray(arr) ? arr : undefined;
      },
    });
    const items = page.items
      .filter(isObj)
      .map(orderSummary)
      .filter((o) => o.id > 0);
    return ok(
      { items, returnedCount: items.length },
      pageMeta(ctx, 'sale.order.list', page, 'legacy', [PII_WARNING]),
    );
  },
});

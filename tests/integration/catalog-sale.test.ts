/**
 * Этап 13 (ТЗ §9.6): каталог, цены, склады, заказы магазина на mock.
 * Чтения (формы ответов по документации, параметры запроса, курсор), decimal-цена без float,
 * INVALID_CURRENCY / INVALID_PRODUCT_TYPE / INVALID_PRICE_TYPE, выбор add/update цены, CONFLICT,
 * полный путь APPROVAL_REQUIRED → approve → запись → replay, неизвестный исход, частичный состав заказа.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyListPage, legacyOk } from '../helpers/mock-bitrix.js';
import { installCatalogMock, product, type CatalogState } from '../helpers/mock-catalog-sale.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
let state: CatalogState;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

const STORES = [
  {
    id: 1,
    title: 'Основной склад',
    active: 'Y',
    address: 'ул. Складская, 1',
    code: 'main',
    issuingCenter: 'N',
    sort: 100,
    phone: '+7 900 000-00-00',
    email: 'store@example.invalid',
  },
  { id: 2, title: 'Резервный', active: 'N', address: '', code: '', issuingCenter: 'Y', sort: 200 },
];

const ORDER = {
  id: 236,
  accountNumber: '392',
  statusId: 'N',
  dateInsert: '2026-09-20T17:36:55+03:00',
  dateUpdate: '2026-09-20T17:37:11+03:00',
  price: 1480,
  currency: 'RUB',
  payed: 'N',
  canceled: 'N',
  deducted: 'N',
  personTypeId: 3,
  responsibleId: 1,
  userId: 9,
  discountValue: 0,
  taxValue: 163.33,
  comments: 'Позвоните на +7 999 111-22-33',
  userDescription: 'Домофон 12, ivan@example.invalid',
  propertyValues: [
    { code: 'FIO', value: 'Иванов Иван' },
    { code: 'PHONE', value: '+7 999 111-22-33' },
    { code: 'EMAIL', value: 'ivan@example.invalid' },
    { code: 'ADDRESS', value: 'Москва, ул. Пушкина, 1' },
  ],
  clients: [{ entityId: 6, entityTypeId: 3, id: 901, isPrimary: 'Y', orderId: 236, roleId: 0, sort: 0 }],
  payments: [{ id: 123, sum: 1480, currency: 'RUB', paid: 'N', paySystemName: 'Оплата картой' }],
  shipments: [
    { id: 1, system: 'Y', deliveryName: 'Без доставки', statusId: 'DN', deducted: 'N' },
    {
      id: 2,
      system: 'N',
      deliveryName: 'Курьер',
      statusId: 'DN',
      deducted: 'N',
      trackingNumber: 'TRK123',
      comments: 'Оставить у двери',
    },
  ],
  basketItems: [
    {
      id: '255',
      orderId: '236',
      productId: 348,
      name: 'Футболка',
      quantity: 1,
      measureName: 'шт',
      price: 980,
      basePrice: 980,
      discountPrice: 0,
      currency: 'RUB',
      vatRate: 0.2,
      vatIncluded: 'Y',
      properties: [{ code: 'CATALOG.XML_ID', value: 'x' }],
    },
  ],
};

const basketItem = (i: number) => ({
  id: 1000 + i,
  orderId: 237,
  productId: 400 + i,
  name: `Позиция ${String(i)}`,
  price: 10,
  quantity: 1,
  currency: 'RUB',
});

function setup(overrides: Record<string, string> = {}) {
  state = {
    products: new Map([
      [10, product(10, 1, { name: 'Кружка' })],
      [11, product(11, 7, { name: 'Доставка' })],
      [12, product(12, 4, { name: 'Футболка M', parentId: { value: '200', valueId: '9867' } })],
      ...Array.from({ length: 60 }, (_, i) => [100 + i, product(100 + i, 1)] as const),
    ]),
    prices: [{ id: 500, productId: 10, catalogGroupId: 1, price: 1000, currency: 'RUB' }],
    nextProductId: 2000,
    nextPriceId: 900,
  };
  t = createTestApp({
    BITRIX_REQUESTS_PER_SECOND: '10',
    ENABLED_MODULES: 'system,catalog,orders',
    READ_ONLY_MODE: 'false',
    ...overrides,
  });
  installCatalogMock(t.bitrix, state);
  t.bitrix
    .on('catalog.store.list', (c) => {
      const f = (c.body['filter'] ?? {}) as Record<string, unknown>;
      const rows = STORES.filter((s) => f['active'] === undefined || s.active === f['active']);
      return legacyOk({ stores: rows }, { total: rows.length });
    })
    .on(
      'catalog.storeproduct.list',
      legacyOk(
        {
          storeProducts: [
            { id: 11, productId: 10, storeId: 1, amount: 54, quantityReserved: 4 },
            { id: 13, productId: 10, storeId: 2, amount: 14, quantityReserved: null },
          ],
        },
        { total: 2 },
      ),
    )
    .on('sale.order.get', (c) => {
      const id = Number(c.body['id']);
      if (id === 236) return legacyOk({ order: ORDER });
      if (id === 237) {
        const { basketItems: _omit, ...rest } = ORDER;
        return legacyOk({ order: { ...rest, id: 237 } });
      }
      return legacyError('ERROR_ORDER_NOT_FOUND', 400, 'order not found');
    })
    .on('sale.basketitem.list', (c) => {
      const all = Array.from({ length: 230 }, (_, i) => basketItem(i));
      const page = legacyListPage(all, Number(c.body['start'] ?? 0), 50);
      const body = page.body as Record<string, unknown>;
      return { ...page, body: { ...body, result: { basketItems: body['result'] } } };
    })
    .on('sale.order.list', (c) => {
      const all = Array.from({ length: 30 }, (_, i) => ({ ...ORDER, id: 300 - i, basketItems: undefined }));
      const page = legacyListPage(all, Number(c.body['start'] ?? 0), 50);
      const body = page.body as Record<string, unknown>;
      return { ...page, body: { ...body, result: { orders: body['result'] } } };
    });
}

async function reconnect(overrides: Record<string, string> = {}) {
  setup(overrides);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  await reconnect();
});
afterEach(async () => {
  await close();
  t.app.close();
});

const setPrice = (id: number, price: number) => {
  for (const p of state.prices) if (p['id'] === id) p['price'] = price;
};

async function approveAndRun(name: string, args: Record<string, unknown>) {
  const prep = await call(name, args);
  expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(name, { ...args, approvalId: operationId });
  return { prep, done, operationId };
}

describe('каталог и склад: чтение', () => {
  it('catalog_list: result.catalogs, вид каталога (товары/вариации), минимальный select', async () => {
    const env = await call('catalog_list', {});
    expect(env.success).toBe(true);
    expect(env.data?.['items']).toEqual([
      {
        iblockId: 23,
        name: 'Товарный каталог CRM',
        kind: 'products',
        iblockTypeId: 'CRM_PRODUCT_CATALOG',
        vatId: 1,
      },
      {
        iblockId: 24,
        name: 'Товарный каталог CRM (предложения)',
        kind: 'variations',
        productIblockId: 23,
        iblockTypeId: 'CRM_PRODUCT_CATALOG',
        vatId: 1,
      },
    ]);
    const body = t.bitrix.callsTo('catalog.catalog.list')[0]?.body;
    expect(body?.['select']).toContain('productIblockId');
    expect(body?.['start']).toBe(0);
  });

  it('catalog_products_list: select с id/iblockId, фильтр iblockId и %name; курсор проходит все 61 позицию без пропусков (T20)', async () => {
    const first = await call('catalog_products_list', {
      iblockId: 23,
      nameContains: 'Позиция',
      pageSize: 20,
    });
    expect(first.success).toBe(true);
    const body = t.bitrix.callsTo('catalog.product.list')[0]?.body;
    expect(body?.['filter']).toEqual({ iblockId: 23, '%name': 'Позиция' });
    expect(body?.['select']).toEqual(expect.arrayContaining(['id', 'iblockId', 'name', 'type']));
    expect(body?.['select']).not.toContain('purchasingPrice');
    const seen: number[] = [];
    let env = first;
    for (let i = 0; i < 10; i++) {
      seen.push(...(env.data?.['items'] as { id: number }[]).map((x) => x.id));
      const next = env.meta.page?.nextCursor;
      if (!next) break;
      env = await call('catalog_products_list', {
        iblockId: 23,
        nameContains: 'Позиция',
        pageSize: 20,
        cursor: next,
      });
      expect(env.success).toBe(true);
    }
    expect(seen).toEqual([...state.products.values()].filter((p) => p['type'] === 1).map((p) => p['id']));
    expect(new Set(seen).size).toBe(61);
    // курсор привязан к фильтру (T21)
    const cursor = first.meta.page?.nextCursor ?? '';
    const alien = await call('catalog_products_list', { iblockId: 23, pageSize: 20, cursor });
    expect(alien.success).toBe(false);
  });

  it('catalog_products_list: услуги — catalog.product.service.list и result.services; вариации — parentId из объекта {value}', async () => {
    const services = await call('catalog_products_list', { iblockId: 23, productKind: 'service' });
    expect(services.data?.['items']).toEqual([
      expect.objectContaining({ id: 11, name: 'Доставка', type: 7, typeName: 'услуга' }),
    ]);
    expect(t.bitrix.callsTo('catalog.product.service.list')).toHaveLength(1);
    const offers = await call('catalog_products_list', { iblockId: 24, productKind: 'offer' });
    expect(offers.data?.['items']).toEqual([
      expect.objectContaining({ id: 12, parentId: 200, typeName: 'вариация' }),
    ]);
    expect(t.bitrix.callsTo('catalog.product.offer.list')[0]?.body['select']).toContain('parentId');
  });

  it('warehouse_list: activeOnly → filter active=Y; телефоны/email складов не выводятся', async () => {
    const all = await call('warehouse_list', {});
    expect(all.data?.['items']).toHaveLength(2);
    expect(JSON.stringify(all.data)).not.toContain('+7 900');
    expect(JSON.stringify(all.data)).not.toContain('store@example');
    const active = await call('warehouse_list', { activeOnly: true });
    expect(active.data?.['items']).toEqual([
      {
        id: 1,
        title: 'Основной склад',
        active: true,
        address: 'ул. Складская, 1',
        code: 'main',
        issuingCenter: false,
        sort: 100,
      },
    ]);
    expect(t.bitrix.callsTo('catalog.store.list')[1]?.body['filter']).toEqual({ active: 'Y' });
  });

  it('warehouse_stock_list: фильтры @storeId/@productId, остаток и резерв как есть, без вывода о доступности', async () => {
    const env = await call('warehouse_stock_list', { storeIds: [2, 1], productIds: [10] });
    expect(env.data?.['items']).toEqual([
      { id: 11, productId: 10, storeId: 1, amount: 54, quantityReserved: 4 },
      { id: 13, productId: 10, storeId: 2, amount: 14, quantityReserved: null },
    ]);
    expect(t.bitrix.callsTo('catalog.storeproduct.list')[0]?.body['filter']).toEqual({
      '@storeId': [1, 2],
      '@productId': [10],
    });
    expect(env.meta.warnings?.join(' ')).toContain('доступность к продаже не рассчитывалась');
    expect(JSON.stringify(env.data)).not.toMatch(/available/i);
  });

  it('модуль каталога выключен → инструментов нет в tools/list', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLED_MODULES: 'system,crm' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('catalog_list');
    expect(names).not.toContain('store_order_get');
  });
});

describe('заказы магазина', () => {
  it('store_order_get: состав из basketItems, полнота complete; персональные данные покупателя не выводятся', async () => {
    const env = await call('store_order_get', { orderId: 236 });
    expect(env.success).toBe(true);
    expect(env.meta['completeness']).toBe('complete');
    expect(env.data?.['itemsSource']).toBe('order');
    expect(env.data?.['itemsCompleteness']).toBe('complete');
    expect(env.data?.['items']).toEqual([
      {
        id: 255,
        productId: 348,
        name: 'Футболка',
        quantity: 1,
        measureName: 'шт',
        price: 980,
        basePrice: 980,
        discountPrice: 0,
        currency: 'RUB',
        vatRate: 0.2,
        vatIncluded: true,
      },
    ]);
    const order = env.data?.['order'] as Record<string, unknown>;
    expect(order).toMatchObject({
      id: 236,
      accountNumber: '392',
      statusId: 'N',
      price: 1480,
      paid: false,
      clients: [{ entityTypeId: 3, entityId: 6, isPrimary: true }],
      payments: [{ id: 123, sum: 1480, currency: 'RUB', paid: false, paySystemName: 'Оплата картой' }],
      shipments: [{ id: 2, deliveryName: 'Курьер', statusId: 'DN', deducted: false }],
    });
    const text = JSON.stringify(env.data);
    for (const pii of ['+7 999', 'ivan@', 'Иванов', 'Пушкина', 'Домофон', 'TRK123', 'у двери'])
      expect(text).not.toContain(pii);
    expect(t.bitrix.callsTo('sale.basketitem.list')).toHaveLength(0);
  });

  it('store_order_get: нет basketItems → sale.basketitem.list по orderId; 230 позиций при лимите 4 страниц → partial, PARTIAL_RESULT', async () => {
    const env = await call('store_order_get', { orderId: 237 });
    expect(env.success).toBe(true);
    expect(env.data?.['itemsSource']).toBe('basketitem.list');
    expect(env.data?.['itemsCompleteness']).toBe('partial');
    expect(env.data?.['partialReason']).toBe('PARTIAL_RESULT');
    expect(env.meta['completeness']).toBe('partial');
    expect((env.data?.['items'] as unknown[]).length).toBe(200);
    expect(env.meta.warnings?.join(' ')).toContain('200 из 230');
    const calls = t.bitrix.callsTo('sale.basketitem.list');
    expect(calls).toHaveLength(4);
    expect(calls[0]?.body['filter']).toEqual({ orderId: 237 });
    expect(calls.map((c) => c.body['start'])).toEqual([0, 50, 100, 150]);
  });

  it('store_order_get: includeItems=false не читает состав; неизвестный заказ → NOT_FOUND', async () => {
    const env = await call('store_order_get', { orderId: 237, includeItems: false });
    expect(env.data?.['items']).toBeUndefined();
    expect(t.bitrix.callsTo('sale.basketitem.list')).toHaveLength(0);
    const missing = await call('store_order_get', { orderId: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('store_orders_list: период и статус в фильтре, минимальный select без ПДн, курсор; to раньше from → ошибка валидации', async () => {
    const env = await call('store_orders_list', {
      from: '2026-09-01T00:00:00+03:00',
      to: '2026-09-30T23:59:59+03:00',
      status: 'N',
      pageSize: 20,
    });
    expect(env.success).toBe(true);
    const body = t.bitrix.callsTo('sale.order.list')[0]?.body;
    expect(body?.['filter']).toEqual({
      '>=dateInsert': '2026-09-01T00:00:00+03:00',
      '<=dateInsert': '2026-09-30T23:59:59+03:00',
      statusId: 'N',
    });
    expect(body?.['select']).not.toContain('userDescription');
    expect(body?.['select']).not.toContain('comments');
    expect((env.data?.['items'] as unknown[]).length).toBe(20);
    expect(env.meta.page?.hasMore).toBe(true);
    const next = await call('store_orders_list', {
      from: '2026-09-01T00:00:00+03:00',
      to: '2026-09-30T23:59:59+03:00',
      status: 'N',
      pageSize: 20,
      cursor: env.meta.page?.nextCursor,
    });
    expect((next.data?.['items'] as unknown[]).length).toBe(10);
    expect(next.meta.page?.hasMore).toBe(false);
    expect(t.bitrix.callsTo('sale.order.list')).toHaveLength(1);
    const bad = await client.callTool({
      name: 'store_orders_list',
      arguments: { from: '2026-09-30', to: '2026-09-01' },
    });
    expect(bad.isError).toBe(true);
  });
});

describe('catalog_price_set: decimal, валюта, тип цены, add/update', () => {
  it('создание: "1234.10" → catalog.price.add с точным значением 1234.1; план create (было → нет); сверка; replay без второй записи', async () => {
    const args = {
      productId: 11,
      productKind: 'service',
      priceTypeId: 1,
      amount: '1234.10',
      currency: 'RUB',
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('catalog_price_set', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details).toMatchObject({
      method: 'catalog.price.add',
      mode: 'create',
      before: null,
      after: { amount: '1234.1', currency: 'RUB' },
      priceTypeName: 'BASE',
    });
    expect(plan.risks.join(' ')).toContain('базовый тип цены');
    expect(done.data).toMatchObject({
      mode: 'create',
      priceId: 900,
      amount: '1234.1',
      verified: true,
      replayed: false,
    });
    const sent = t.bitrix.callsTo('catalog.price.add');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      fields: { productId: 11, catalogGroupId: 1, price: 1234.1, currency: 'RUB' },
    });
    // без двоичной ошибки: в JSON-теле ровно 1234.1
    expect(JSON.stringify(sent[0]?.body)).toContain('"price":1234.1,');
    const again = await call('catalog_price_set', {
      ...args,
      approvalId: prep.error?.details['operationId'],
    });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('catalog.price.update')).toHaveLength(0);
  });

  it('изменение существующей цены: catalog.price.update по id из catalog.price.list, план «1000 RUB → 1500.5 RUB»', async () => {
    const args = {
      productId: 10,
      priceTypeId: 1,
      amount: '1500.50',
      currency: 'RUB',
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('catalog_price_set', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; action: string };
    expect(plan.details).toMatchObject({
      mode: 'update',
      priceId: 500,
      before: { amount: '1000', currency: 'RUB' },
      after: { amount: '1500.5', currency: 'RUB' },
    });
    expect(plan.action).toContain('1000 RUB → 1500.5 RUB');
    expect(done.data).toMatchObject({ mode: 'update', priceId: 500, verified: true });
    expect(t.bitrix.callsTo('catalog.price.update')[0]?.body).toEqual({
      id: 500,
      fields: { price: 1500.5, currency: 'RUB' },
    });
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(0);
    expect(t.bitrix.callsTo('catalog.price.list')[0]?.body['filter']).toEqual({
      productId: 10,
      catalogGroupId: 1,
    });
  });

  it('сумма: отказ для "1e3", "-5", "1.1234", "", числа 1234.1 и лишних знаков для валюты (RUB — 2, JPY — 0) без записи', async () => {
    for (const amount of ['1e3', '-5', '1.1234', '', '01.5', '1,5', ' 10', 1234.1]) {
      const r = await client.callTool({
        name: 'catalog_price_set',
        arguments: { productId: 10, priceTypeId: 1, amount, currency: 'RUB', dryRun: true },
      });
      expect(r.isError, String(amount)).toBe(true);
    }
    const rub = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '10.123',
      currency: 'RUB',
      dryRun: true,
    });
    expect(rub.error?.code).toBe('VALIDATION_ERROR');
    expect(rub.error?.details['reason']).toBe('INVALID_PRECISION');
    const jpy = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '100.5',
      currency: 'JPY',
      dryRun: true,
    });
    expect(jpy.error?.details['reason']).toBe('INVALID_PRECISION');
    const zero = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '0.10',
      currency: 'RUB',
      dryRun: true,
    });
    expect(zero.success).toBe(true);
    expect(t.bitrix.callsTo('catalog.price.update')).toHaveLength(0);
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(0);
  });

  it('INVALID_CURRENCY и INVALID_PRICE_TYPE — до плана, операция не создаётся', async () => {
    const cur = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '10',
      currency: 'XXX',
      idempotencyKey: randomUUID(),
    });
    expect(cur.error?.code).toBe('VALIDATION_ERROR');
    expect(cur.error?.details['reason']).toBe('INVALID_CURRENCY');
    expect(cur.error?.details['nextAction']).toContain('RUB, USD, JPY');
    const type = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 99,
      amount: '10',
      currency: 'RUB',
      idempotencyKey: randomUUID(),
    });
    expect(type.error?.details['reason']).toBe('INVALID_PRICE_TYPE');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('INVALID_PRODUCT_TYPE: цена услуги с productKind=product; отсутствующий товар → NOT_FOUND', async () => {
    const wrong = await call('catalog_price_set', {
      productId: 11,
      priceTypeId: 1,
      amount: '10',
      currency: 'RUB',
      dryRun: true,
    });
    expect(wrong.error?.code).toBe('VALIDATION_ERROR');
    expect(wrong.error?.details['reason']).toBe('INVALID_PRODUCT_TYPE');
    const missing = await call('catalog_price_set', {
      productId: 777,
      priceTypeId: 1,
      amount: '10',
      currency: 'RUB',
      dryRun: true,
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('ревью: план «создать цену» без expectedStateHash, цену создали до повтора с approvalId → CONFLICT PLAN_CHANGED, update не вызывается', async () => {
    const args = {
      productId: 12,
      productKind: 'offer',
      priceTypeId: 2,
      amount: '5',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    };
    const prep = await call('catalog_price_set', args);
    expect(prep.error?.details['plan']).toMatchObject({ details: { mode: 'create' } });
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    state.prices.push({ id: 778, productId: 12, catalogGroupId: 2, price: 90, currency: 'USD' });
    const run = await call('catalog_price_set', { ...args, approvalId: operationId });
    expect(run.error?.code).toBe('CONFLICT');
    expect(run.error?.details['reason']).toBe('PLAN_CHANGED');
    expect(t.bitrix.callsTo('catalog.price.update')).toHaveLength(0);
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(0);
  });

  it('CONFLICT: stateHash из dryRun устарел до плана; цену создали/изменили между подтверждением и записью', async () => {
    const dry = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '1100',
      currency: 'RUB',
      dryRun: true,
    });
    const hash = dry.data?.['stateHash'] as string;
    expect(dry.data).toMatchObject({ mode: 'update', priceId: 500 });
    setPrice(500, 1050);
    const stale = await call('catalog_price_set', {
      productId: 10,
      priceTypeId: 1,
      amount: '1100',
      currency: 'RUB',
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');

    const fresh = (
      await call('catalog_price_set', {
        productId: 10,
        priceTypeId: 1,
        amount: '1100',
        currency: 'RUB',
        dryRun: true,
      })
    ).data?.['stateHash'] as string;
    const args = {
      productId: 10,
      priceTypeId: 1,
      amount: '1100',
      currency: 'RUB',
      expectedStateHash: fresh,
      idempotencyKey: randomUUID(),
    };
    const prep = await call('catalog_price_set', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    setPrice(500, 1070);
    const raced = await call('catalog_price_set', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('catalog.price.update')).toHaveLength(0);
    expect((await call('operation_status', { operationId })).data?.['status']).toBe('failed');

    // без expectedStateHash: план «создать», а цену успели создать — режим устарел → CONFLICT, не дубль
    const createArgs = {
      productId: 12,
      productKind: 'offer',
      priceTypeId: 2,
      amount: '5',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    };
    const p2 = await call('catalog_price_set', createArgs);
    const op2 = p2.error?.details['operationId'] as string;
    await t.app.approvals.approve(op2, 'owner', t.app.auth.portalKey);
    // Handler при повторе читает цену заново; параллельное создание между чтением и записью ловит precheck.
    let injected = false;
    const orig = t.bitrix.callsTo('catalog.price.list').length;
    t.bitrix.on('catalog.price.list', (c) => {
      const f = (c.body['filter'] ?? {}) as Record<string, unknown>;
      const n = t.bitrix.callsTo('catalog.price.list').length - orig;
      if (!injected && n >= 2) {
        injected = true;
        state.prices.push({ id: 777, productId: 12, catalogGroupId: 2, price: 4, currency: 'USD' });
      }
      const rows = state.prices.filter(
        (p) => p['productId'] === f['productId'] && p['catalogGroupId'] === f['catalogGroupId'],
      );
      return legacyOk({ prices: rows }, { total: rows.length });
    });
    const r2 = await call('catalog_price_set', { ...createArgs, approvalId: op2 });
    expect(r2.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(0);
  });

  it('ответ catalog.price.add без price.id → OPERATION_OUTCOME_UNKNOWN; повтор не пишет второй раз', async () => {
    t.bitrix.on('catalog.price.add', legacyOk({ price: {} }));
    const args = {
      productId: 11,
      productKind: 'service',
      priceTypeId: 2,
      amount: '99.90',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    };
    const { done, operationId } = await approveAndRun('catalog_price_set', args);
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const retry = await call('catalog_price_set', { ...args, approvalId: operationId });
    expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(1);
  });

  it('READ_ONLY_MODE=true: запись скрыта и отклоняется без обращения к Bitrix', async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'true' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('catalog_list');
    expect(names).not.toContain('catalog_price_set');
    // Скрытый инструмент отклоняется ещё на уровне протокола MCP (T10): до Bitrix дело не доходит.
    await expect(
      client.callTool({
        name: 'catalog_price_set',
        arguments: {
          productId: 10,
          priceTypeId: 1,
          amount: '1',
          currency: 'RUB',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow(/disabled/);
    expect(t.bitrix.calls).toHaveLength(0);
  });
});

describe('карточки товаров: create/update', () => {
  it('INVALID_PRODUCT_TYPE: вариация в каталоге товаров, товар в каталоге вариаций; неизвестный каталог', async () => {
    const offer = await call('catalog_product_create', {
      iblockId: 23,
      productKind: 'offer',
      fields: { name: 'Размер L' },
      dryRun: true,
    });
    expect(offer.error?.details['reason']).toBe('INVALID_PRODUCT_TYPE');
    const prod = await call('catalog_product_create', {
      iblockId: 24,
      productKind: 'product',
      fields: { name: 'Кружка' },
      dryRun: true,
    });
    expect(prod.error?.details['reason']).toBe('INVALID_PRODUCT_TYPE');
    const unknown = await call('catalog_product_create', {
      iblockId: 99,
      productKind: 'product',
      fields: { name: 'Кружка' },
      dryRun: true,
    });
    expect(unknown.error?.details['reason']).toBe('UNKNOWN_CATALOG');
    const bad = await client.callTool({
      name: 'catalog_product_create',
      arguments: { iblockId: 23, productKind: 'bundle', fields: { name: 'x' }, dryRun: true },
    });
    expect(bad.isError).toBe(true);
  });

  it('поля: неприменимое к виду, запрещённые цена/остаток, неизвестное порталу поле и отсутствие name — отказ до плана', async () => {
    const svc = await call('catalog_product_create', {
      iblockId: 23,
      productKind: 'service',
      fields: { name: 'Монтаж', canBuyZero: 'Y' },
      dryRun: true,
    });
    expect(svc.error?.details['reason']).toBe('FIELD_NOT_ALLOWED_FOR_KIND');
    for (const f of [{ purchasingPrice: 10 }, { quantity: 5 }, { property258: 'x' }]) {
      const r = await client.callTool({
        name: 'catalog_product_create',
        arguments: { iblockId: 23, productKind: 'product', fields: { name: 'x', ...f }, dryRun: true },
      });
      expect(r.isError, JSON.stringify(f)).toBe(true);
    }
    const noMeta = await call('catalog_product_create', {
      iblockId: 23,
      productKind: 'product',
      fields: { name: 'Кружка', height: 10 },
      dryRun: true,
    });
    expect(noMeta.error?.details['reason']).toBe('UNKNOWN_FIELD');
    const noName = await call('catalog_product_create', {
      iblockId: 23,
      productKind: 'product',
      fields: { active: 'Y' },
      dryRun: true,
    });
    expect(noName.error?.details['reason']).toBe('REQUIRED_FIELD_MISSING');
  });

  it('создание услуги: план → подтверждение → catalog.product.service.add с iblockId → сверка через .get → replay без второй записи', async () => {
    const args = {
      iblockId: 23,
      productKind: 'service',
      fields: { name: 'Монтаж', active: 'N', vatIncluded: 'Y' },
      idempotencyKey: randomUUID(),
    };
    const { prep, done, operationId } = await approveAndRun('catalog_product_create', args);
    const plan = prep.error?.details['plan'] as {
      details: Record<string, unknown>;
      risks: string[];
      action: string;
    };
    expect(plan.action).toContain('Создать услуга «Монтаж»');
    expect(plan.details).toMatchObject({ method: 'catalog.product.service.add', iblockId: 23 });
    expect(plan.risks.join(' ')).toContain('Цены, закупочная цена и складские остатки не меняются');
    expect(done.data).toMatchObject({ productId: 2000, verified: true, replayed: false });
    expect(t.bitrix.callsTo('catalog.product.service.add')[0]?.body).toEqual({
      fields: { iblockId: 23, name: 'Монтаж', active: 'N', vatIncluded: 'Y' },
    });
    expect(t.bitrix.callsTo('catalog.product.service.get')).toHaveLength(1);
    const again = await call('catalog_product_create', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ productId: 2000, replayed: true });
    expect(t.bitrix.callsTo('catalog.product.service.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('catalog.price.add')).toHaveLength(0);
  });

  it('создание: ответ без element.id → OPERATION_OUTCOME_UNKNOWN, повтор не создаёт дубль', async () => {
    t.bitrix.on('catalog.product.add', legacyOk({ element: null }));
    const args = {
      iblockId: 23,
      productKind: 'product',
      fields: { name: 'Кружка' },
      idempotencyKey: randomUUID(),
    };
    const { done, operationId } = await approveAndRun('catalog_product_create', args);
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    await call('catalog_product_create', { ...args, approvalId: operationId });
    expect(t.bitrix.callsTo('catalog.product.add')).toHaveLength(1);
  });

  it('изменение: diff «было → станет», catalog.product.update только с переданными полями, сверка, stateHash; replay', async () => {
    const dry = await call('catalog_product_update', {
      productId: 10,
      productKind: 'product',
      fields: { name: 'Кружка 300 мл', active: 'N' },
      dryRun: true,
    });
    const hash = dry.data?.['stateHash'] as string;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const plan = dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['changes']).toEqual({
      name: { from: 'Кружка', to: 'Кружка 300 мл' },
      active: { from: 'Y', to: 'N' },
    });
    expect(plan.risks.join(' ')).toContain('Деактивация');
    const args = {
      productId: 10,
      productKind: 'product',
      fields: { name: 'Кружка 300 мл', active: 'N' },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    };
    const { done, operationId } = await approveAndRun('catalog_product_update', args);
    expect(done.data).toMatchObject({
      productId: 10,
      verified: true,
      replayed: false,
      changedFields: ['name', 'active'],
    });
    expect(done.data?.['stateHash']).not.toBe(hash);
    expect(t.bitrix.callsTo('catalog.product.update')[0]?.body).toEqual({
      id: 10,
      fields: { name: 'Кружка 300 мл', active: 'N' },
    });
    // карточка не трогает цену и остатки
    expect(state.products.get(10)?.['purchasingPrice']).toBe(500);
    expect(state.products.get(10)?.['quantity']).toBe(10);
    const again = await call('catalog_product_update', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('catalog.product.update')).toHaveLength(1);
  });

  it('изменение: productKind не совпадает с типом позиции → INVALID_PRODUCT_TYPE; CONFLICT до плана и в precheck', async () => {
    const wrong = await call('catalog_product_update', {
      productId: 12,
      productKind: 'product',
      fields: { name: 'x' },
      dryRun: true,
    });
    expect(wrong.error?.details['reason']).toBe('INVALID_PRODUCT_TYPE');

    const dry = await call('catalog_product_update', {
      productId: 12,
      productKind: 'offer',
      fields: { weight: 250 },
      dryRun: true,
    });
    const hash = dry.data?.['stateHash'] as string;
    Object.assign(state.products.get(12) ?? {}, { name: 'Футболка M (изм.)' });
    const stale = await call('catalog_product_update', {
      productId: 12,
      productKind: 'offer',
      fields: { weight: 250 },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');

    const fresh = (
      await call('catalog_product_update', {
        productId: 12,
        productKind: 'offer',
        fields: { weight: 250 },
        dryRun: true,
      })
    ).data?.['stateHash'] as string;
    const args = {
      productId: 12,
      productKind: 'offer',
      fields: { weight: 250 },
      expectedStateHash: fresh,
      idempotencyKey: randomUUID(),
    };
    const prep = await call('catalog_product_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    Object.assign(state.products.get(12) ?? {}, { active: 'N' });
    const raced = await call('catalog_product_update', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('catalog.product.offer.update')).toHaveLength(0);
  });
});

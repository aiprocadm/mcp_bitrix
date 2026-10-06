/**
 * Мок универсального адаптера crm.item.* (усечённые формы со страниц документации):
 * crm.type.list → result.types; crm.type.getByEntityTypeId → result.type (не найден — ошибка «0»);
 * crm.item.fields → result.fields (camelCase); crm.item.list → result.items + total/next;
 * crm.item.get/add/update → result.item; crm.item.delete → result: [];
 * crm.item.productrow.list/set → result.productRows.
 */
import {
  legacyError,
  legacyOk,
  type MockBitrix,
  type MockResponse,
  type RecordedCall,
} from './mock-bitrix.js';

const F = (
  type: string,
  title: string,
  extra: Partial<{
    isRequired: boolean;
    isReadOnly: boolean;
    isImmutable: boolean;
    isMultiple: boolean;
  }> = {},
) => ({
  type,
  isRequired: extra.isRequired ?? false,
  isReadOnly: extra.isReadOnly ?? false,
  isImmutable: extra.isImmutable ?? false,
  isMultiple: extra.isMultiple ?? false,
  isDynamic: false,
  title,
  upperName: title.toUpperCase(),
});

export const SMART_TYPES = [
  {
    id: 37,
    title: 'Проекты',
    code: '',
    createdBy: 1,
    entityTypeId: 1256,
    customSectionId: null,
    isCategoriesEnabled: 'Y',
    isStagesEnabled: 'Y',
    isBeginCloseDatesEnabled: 'Y',
    isClientEnabled: 'Y',
    isUseInUserfieldEnabled: 'Y',
    isLinkWithProductsEnabled: 'Y',
    isMycompanyEnabled: 'N',
    isDocumentsEnabled: 'N',
    isSourceEnabled: 'N',
    isObserversEnabled: 'Y',
    isRecyclebinEnabled: 'Y',
    isAutomationEnabled: 'Y',
    isBizProcEnabled: 'N',
    isSetOpenPermissions: 'N',
    isPaymentsEnabled: 'N',
    isCountersEnabled: 'N',
    createdTime: '2026-07-08T17:24:55+03:00',
    updatedTime: '2026-07-08T17:24:55+03:00',
    updatedBy: 1,
  },
  {
    id: 32,
    title: 'Заявки',
    code: 'requests',
    createdBy: 1,
    entityTypeId: 1246,
    customSectionId: null,
    isCategoriesEnabled: 'N',
    isStagesEnabled: 'N',
    isBeginCloseDatesEnabled: 'N',
    isClientEnabled: 'Y',
    isUseInUserfieldEnabled: 'Y',
    isLinkWithProductsEnabled: 'N',
    isMycompanyEnabled: 'N',
    isDocumentsEnabled: 'N',
    isSourceEnabled: 'N',
    isObserversEnabled: 'N',
    isRecyclebinEnabled: 'N',
    isAutomationEnabled: 'N',
    isBizProcEnabled: 'Y',
    isSetOpenPermissions: 'Y',
    isPaymentsEnabled: 'N',
    isCountersEnabled: 'N',
    createdTime: '2026-07-08T17:24:52+03:00',
    updatedTime: '2026-07-08T17:24:52+03:00',
    updatedBy: 1,
  },
];

export const SMART_FIELDS = {
  id: F('integer', 'ID', { isReadOnly: true }),
  title: F('string', 'Название'),
  xmlId: F('string', 'Внешний код', { isImmutable: true }),
  categoryId: F('crm_category', 'Воронка'),
  stageId: F('crm_status', 'Стадия'),
  assignedById: F('user', 'Ответственный'),
  opened: F('boolean', 'Доступен для всех', { isRequired: true }),
  opportunity: F('double', 'Сумма'),
  currencyId: F('crm_currency', 'Валюта'),
  companyId: F('crm_company', 'Компания'),
  contactIds: F('crm_contact', 'Контакты', { isMultiple: true }),
  createdTime: F('datetime', 'Создан', { isReadOnly: true }),
  updatedTime: F('datetime', 'Изменён', { isReadOnly: true }),
  createdBy: F('user', 'Кем создан', { isReadOnly: true }),
  ufCrm5_1700000000: F('string', 'Код проекта', { isRequired: true }),
};

export const INVOICE_FIELDS = {
  id: F('integer', 'ID', { isReadOnly: true }),
  title: F('string', 'Название'),
  accountNumber: F('string', 'Номер', { isReadOnly: true }),
  categoryId: F('crm_category', 'Воронка'),
  stageId: F('crm_status', 'Стадия'),
  assignedById: F('user', 'Ответственный'),
  opened: F('boolean', 'Доступен для всех', { isRequired: true }),
  opportunity: F('double', 'Сумма'),
  currencyId: F('crm_currency', 'Валюта'),
  companyId: F('crm_company', 'Компания'),
  begindate: F('date', 'Дата выставления'),
  closedate: F('date', 'Срок оплаты'),
  createdTime: F('datetime', 'Создан', { isReadOnly: true }),
  updatedTime: F('datetime', 'Изменён', { isReadOnly: true }),
};

/** Коммерческое предложение (entityTypeId=7) как на живом портале 2026-10-06: без categoryId, стадии QUOTE_STATUS. */
export const QUOTE_FIELDS = {
  id: F('integer', 'ID', { isReadOnly: true }),
  title: F('string', 'Название'),
  quoteNumber: F('string', 'Номер', { isReadOnly: true }),
  stageId: F('crm_status', 'Стадия'),
  assignedById: F('user', 'Ответственный'),
  opened: F('boolean', 'Доступен для всех', { isRequired: true }),
  opportunity: F('double', 'Сумма'),
  currencyId: F('crm_currency', 'Валюта'),
  companyId: F('crm_company', 'Компания'),
  dealId: F('crm_deal', 'Сделка'),
  closedate: F('date', 'Действительно до'),
  createdTime: F('datetime', 'Создан', { isReadOnly: true }),
  updatedTime: F('datetime', 'Изменён', { isReadOnly: true }),
};

export const ITEM_CATEGORIES: Record<number, unknown[]> = {
  1256: [
    { id: 7, name: 'Основная', sort: 100, entityTypeId: 1256, isDefault: 'Y' },
    { id: 8, name: 'Внедрение', sort: 200, entityTypeId: 1256, isDefault: 'N' },
  ],
  1246: [{ id: 3, name: 'Общая', sort: 100, entityTypeId: 1246, isDefault: 'Y' }],
  31: [{ id: 2, name: 'Счета', sort: 100, entityTypeId: 31, isDefault: 'Y' }],
};

const S = (entityId: string, statusId: string, name: string, sort: number, semantics?: string) => ({
  ID: String(sort),
  ENTITY_ID: entityId,
  STATUS_ID: statusId,
  NAME: name,
  SORT: String(sort),
  ...(semantics ? { SEMANTICS: semantics } : {}),
});

export const ITEM_STATUSES: Record<string, unknown[]> = {
  DYNAMIC_1256_STAGE_7: [
    S('DYNAMIC_1256_STAGE_7', 'DT1256_7:NEW', 'Новый', 10),
    S('DYNAMIC_1256_STAGE_7', 'DT1256_7:WORK', 'В работе', 20),
    S('DYNAMIC_1256_STAGE_7', 'DT1256_7:SUCCESS', 'Успех', 30, 'S'),
  ],
  DYNAMIC_1256_STAGE_8: [S('DYNAMIC_1256_STAGE_8', 'DT1256_8:NEW', 'Новый', 10)],
  QUOTE_STATUS: [
    S('QUOTE_STATUS', 'DRAFT', 'Новое', 10),
    S('QUOTE_STATUS', 'SENT', 'Отправлено клиенту', 20),
    S('QUOTE_STATUS', 'APPROVED', 'Принято', 30, 'S'),
    S('QUOTE_STATUS', 'DECLAINED', 'Отклонено', 40, 'F'),
  ],
  SMART_INVOICE_STAGE_2: [
    S('SMART_INVOICE_STAGE_2', 'DT31_2:N', 'Новый', 10),
    S('SMART_INVOICE_STAGE_2', 'DT31_2:S', 'Отправлен', 20),
    S('SMART_INVOICE_STAGE_2', 'DT31_2:P', 'Оплачен', 30, 'S'),
  ],
};

export function smartItem(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `[MCP TEST] Проект ${String(id)}`,
    xmlId: `X${String(id)}`,
    categoryId: 7,
    stageId: 'DT1256_7:NEW',
    assignedById: 7,
    opened: 'Y',
    opportunity: 1000,
    currencyId: 'RUB',
    companyId: 0,
    contactIds: [],
    createdTime: '2026-09-20T10:00:00+03:00',
    updatedTime: '2026-09-20T10:00:00+03:00',
    createdBy: 1,
    ufCrm5_1700000000: `P-${String(id)}`,
    ...overrides,
  };
}

export function invoiceItem(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `[MCP TEST] Счёт ${String(id)}`,
    accountNumber: `INV-${String(id)}`,
    categoryId: 2,
    stageId: 'DT31_2:N',
    assignedById: 7,
    opened: 'Y',
    opportunity: 0,
    currencyId: 'RUB',
    companyId: 5,
    createdTime: '2026-09-20T10:00:00+03:00',
    updatedTime: '2026-09-20T10:00:00+03:00',
    ...overrides,
  };
}

export function quoteItem(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `[MCP TEST] КП ${String(id)}`,
    quoteNumber: String(id),
    stageId: 'DRAFT',
    assignedById: 7,
    opened: 'Y',
    opportunity: 16320,
    currencyId: 'RUB',
    companyId: 5,
    dealId: 5,
    createdTime: '2026-09-20T10:00:00+03:00',
    updatedTime: '2026-09-20T10:00:00+03:00',
    ...overrides,
  };
}

export interface ItemsStore {
  items: Record<number, Map<number, Record<string, unknown>>>;
  rows: Map<string, Record<string, unknown>[]>;
  nextId: number;
  /** Ответ crm.item.productrow.set вместо записи (для T34). */
  rowsSetFailure: MockResponse | undefined;
}

const body = (c: RecordedCall) => c.body;
const etidOf = (c: RecordedCall) => Number(body(c)['entityTypeId']);

/** Регистрирует маршруты crm.item.*, crm.type.*, crm.category.list / crm.status.list для типов 1256/1246/31. */
export function mockCrmItems(bitrix: MockBitrix, extraStatuses: Record<string, unknown[]> = {}): ItemsStore {
  const store: ItemsStore = {
    items: {
      1256: new Map(Array.from({ length: 60 }, (_, i) => [i + 1, smartItem(i + 1)])),
      1246: new Map(),
      31: new Map([[40, invoiceItem(40)]]),
      7: new Map([[29, quoteItem(29)]]),
    },
    rows: new Map(),
    nextId: 500,
    rowsSetFailure: undefined,
  };
  const fieldsFor: Record<number, unknown> = {
    1256: SMART_FIELDS,
    1246: SMART_FIELDS,
    31: INVOICE_FIELDS,
    7: QUOTE_FIELDS,
  };
  const statuses = { ...ITEM_STATUSES, ...extraStatuses };
  bitrix
    .on('crm.type.list', (c) => {
      const start = Number(body(c)['start'] ?? 0);
      return legacyOk({ types: SMART_TYPES.slice(start, start + 50) }, { total: SMART_TYPES.length });
    })
    .on('crm.type.getbyentitytypeid', (c) => {
      const type = SMART_TYPES.find((x) => x.entityTypeId === etidOf(c));
      return type ? legacyOk({ type }) : legacyError('0', 400, 'Smart process not found');
    })
    .on('crm.item.fields', (c) => {
      const f = fieldsFor[etidOf(c)];
      return f ? legacyOk({ fields: f }) : legacyError('NOT_FOUND', 400, 'Smart process not found');
    })
    .on('crm.item.list', (c) => {
      const all = [...(store.items[etidOf(c)]?.values() ?? [])].sort(
        (a, b) => Number(b['id']) - Number(a['id']),
      );
      const start = Number(body(c)['start'] ?? 0);
      const next = start + 50 < all.length ? start + 50 : undefined;
      return legacyOk(
        { items: all.slice(start, start + 50) },
        { total: all.length, ...(next !== undefined ? { next } : {}) },
      );
    })
    .on('crm.item.get', (c) => {
      const item = store.items[etidOf(c)]?.get(Number(body(c)['id']));
      return item ? legacyOk({ item }) : legacyError('NOT_FOUND', 400, 'Item not found');
    })
    .on('crm.item.add', (c) => {
      const id = store.nextId++;
      const etid = etidOf(c);
      const base = etid === 31 ? invoiceItem(id) : etid === 7 ? quoteItem(id) : smartItem(id);
      const item = { ...base, ...(body(c)['fields'] as Record<string, unknown>), id };
      store.items[etid]?.set(id, item);
      return legacyOk({ item });
    })
    .on('crm.item.update', (c) => {
      const map = store.items[etidOf(c)];
      const id = Number(body(c)['id']);
      const cur = map?.get(id);
      if (!map || !cur) return legacyError('NOT_FOUND', 400, 'Item not found');
      const item = {
        ...cur,
        ...(body(c)['fields'] as Record<string, unknown>),
        updatedTime: '2026-09-25T12:00:00+03:00',
      };
      map.set(id, item);
      return legacyOk({ item });
    })
    .on('crm.item.delete', (c) => {
      const map = store.items[etidOf(c)];
      const id = Number(body(c)['id']);
      if (!map?.has(id)) return legacyError('NOT_FOUND', 400, 'Item not found');
      map.delete(id);
      return legacyOk([]);
    })
    .on('crm.item.productrow.list', (c) => {
      const f = (body(c)['filter'] ?? {}) as Record<string, unknown>;
      const rows = store.rows.get(`${String(f['=ownerType'])}:${String(f['=ownerId'])}`) ?? [];
      return legacyOk({ productRows: rows }, { total: rows.length });
    })
    .on('crm.item.productrow.set', (c) => {
      if (store.rowsSetFailure) return store.rowsSetFailure;
      const input = body(c)['productRows'] as Record<string, unknown>[];
      const saved = input.map((r, i) => ({
        id: 1000 + i,
        ownerId: body(c)['ownerId'],
        ownerType: body(c)['ownerType'],
        ...r,
      }));
      store.rows.set(`${String(body(c)['ownerType'])}:${String(body(c)['ownerId'])}`, saved);
      return legacyOk({ productRows: saved });
    })
    // Живой портал: у КП воронок нет — crm.category.list(7) отвечает ENTITY_TYPE_NOT_SUPPORTED.
    .on('crm.category.list', (c) =>
      etidOf(c) === 7
        ? legacyError('ENTITY_TYPE_NOT_SUPPORTED', 400, 'Сущность CRM Предложение не поддерживается')
        : legacyOk({ categories: ITEM_CATEGORIES[etidOf(c)] ?? [] }),
    )
    .on('crm.status.list', (c) => {
      const entityId = ((body(c)['filter'] ?? {}) as Record<string, unknown>)['ENTITY_ID'];
      return legacyOk(typeof entityId === 'string' ? (statuses[entityId] ?? []) : []);
    })
    .on('crm.activity.list', () => legacyOk([], { total: 0 }));
  return store;
}

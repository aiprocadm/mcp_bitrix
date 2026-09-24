/** Мок-схемы и записи лидов, контактов, компаний, справочников (усечённые реальные формы crm.*.fields / crm.status.list). */

const F = (
  type: string,
  title: string,
  extra: Partial<{
    isRequired: boolean;
    isReadOnly: boolean;
    isImmutable: boolean;
    isMultiple: boolean;
    statusType: string;
  }> = {},
) => ({
  type,
  isRequired: extra.isRequired ?? false,
  isReadOnly: extra.isReadOnly ?? false,
  isImmutable: extra.isImmutable ?? false,
  isMultiple: extra.isMultiple ?? false,
  isDynamic: false,
  title,
  ...(extra.statusType ? { statusType: extra.statusType } : {}),
});

export const LEAD_FIELDS = {
  ID: F('integer', 'ID', { isReadOnly: true }),
  TITLE: F('string', 'Название лида', { isRequired: true }),
  NAME: F('string', 'Имя'),
  LAST_NAME: F('string', 'Фамилия'),
  STATUS_ID: F('crm_status', 'Стадия', { statusType: 'STATUS' }),
  SOURCE_ID: F('crm_status', 'Источник', { statusType: 'SOURCE' }),
  ASSIGNED_BY_ID: F('user', 'Ответственный'),
  OPPORTUNITY: F('double', 'Сумма'),
  CURRENCY_ID: F('crm_currency', 'Валюта'),
  PHONE: F('crm_multifield', 'Телефон', { isMultiple: true }),
  EMAIL: F('crm_multifield', 'E-mail', { isMultiple: true }),
  DATE_CREATE: F('datetime', 'Дата создания', { isReadOnly: true }),
  DATE_MODIFY: F('datetime', 'Дата изменения', { isReadOnly: true }),
};

export const CONTACT_FIELDS = {
  ID: F('integer', 'ID', { isReadOnly: true }),
  NAME: F('string', 'Имя'),
  LAST_NAME: F('string', 'Фамилия'),
  SECOND_NAME: F('string', 'Отчество'),
  TYPE_ID: F('crm_status', 'Тип контакта', { statusType: 'CONTACT_TYPE' }),
  ASSIGNED_BY_ID: F('user', 'Ответственный'),
  COMPANY_ID: F('crm_company', 'Компания'),
  PHONE: F('crm_multifield', 'Телефон', { isMultiple: true }),
  EMAIL: F('crm_multifield', 'E-mail', { isMultiple: true }),
  DATE_CREATE: F('datetime', 'Дата создания', { isReadOnly: true }),
  DATE_MODIFY: F('datetime', 'Дата изменения', { isReadOnly: true }),
};

export const COMPANY_FIELDS = {
  ID: F('integer', 'ID', { isReadOnly: true }),
  TITLE: F('string', 'Название компании', { isRequired: true }),
  COMPANY_TYPE: F('crm_status', 'Тип компании', { statusType: 'COMPANY_TYPE' }),
  INDUSTRY: F('crm_status', 'Сфера деятельности', { statusType: 'INDUSTRY' }),
  ASSIGNED_BY_ID: F('user', 'Ответственный'),
  PHONE: F('crm_multifield', 'Телефон', { isMultiple: true }),
  EMAIL: F('crm_multifield', 'E-mail', { isMultiple: true }),
  DATE_CREATE: F('datetime', 'Дата создания', { isReadOnly: true }),
  DATE_MODIFY: F('datetime', 'Дата изменения', { isReadOnly: true }),
};

export function leadRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: String(id),
    TITLE: `[MCP TEST] Лид ${String(id)}`,
    NAME: 'Иван',
    LAST_NAME: `Лидов${String(id)}`,
    STATUS_ID: 'NEW',
    ASSIGNED_BY_ID: '7',
    OPPORTUNITY: '0.00',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-09-24T10:00:00+03:00',
    DATE_MODIFY: '2026-09-24T10:00:00+03:00',
    ...overrides,
  };
}

export function contactRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: String(id),
    NAME: 'Пётр',
    LAST_NAME: `Контактов${String(id)}`,
    SECOND_NAME: '',
    TYPE_ID: 'CLIENT',
    ASSIGNED_BY_ID: '7',
    COMPANY_ID: '0',
    DATE_CREATE: '2026-09-24T10:00:00+03:00',
    DATE_MODIFY: '2026-09-24T10:00:00+03:00',
    ...overrides,
  };
}

export function companyRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: String(id),
    TITLE: `[MCP TEST] Компания ${String(id)}`,
    COMPANY_TYPE: 'CUSTOMER',
    INDUSTRY: 'IT',
    ASSIGNED_BY_ID: '7',
    DATE_CREATE: '2026-09-24T10:00:00+03:00',
    DATE_MODIFY: '2026-09-24T10:00:00+03:00',
    ...overrides,
  };
}

const status = (
  entityId: string,
  statusId: string,
  name: string,
  sort: number,
  extra: Record<string, unknown> = {},
) => ({
  ID: `${entityId}:${statusId}`,
  ENTITY_ID: entityId,
  STATUS_ID: statusId,
  NAME: name,
  NAME_INIT: name,
  SORT: String(sort),
  SYSTEM: 'N',
  ...extra,
});

/** crm.status.list по ENTITY_ID. */
export const STATUS_LISTS: Record<string, Record<string, unknown>[]> = {
  DEAL_STAGE: [
    status('DEAL_STAGE', 'NEW', 'Новая', 10, { SEMANTICS: null, CATEGORY_ID: '0' }),
    status('DEAL_STAGE', 'PREPARATION', 'Подготовка документов', 20, { CATEGORY_ID: '0' }),
    status('DEAL_STAGE', 'WON', 'Сделка успешна', 30, { SEMANTICS: 'S', CATEGORY_ID: '0' }),
    status('DEAL_STAGE', 'LOSE', 'Сделка провалена', 40, { SEMANTICS: 'F', CATEGORY_ID: '0' }),
  ],
  DEAL_STAGE_5: [
    status('DEAL_STAGE_5', 'C5:NEW', 'Новая', 10, { CATEGORY_ID: '5' }),
    status('DEAL_STAGE_5', 'C5:WON', 'Успех', 20, { SEMANTICS: 'S', CATEGORY_ID: '5' }),
  ],
  STATUS: [
    status('STATUS', 'NEW', 'Не обработан', 10),
    status('STATUS', 'IN_PROCESS', 'В работе', 20),
    status('STATUS', 'CONVERTED', 'Качественный лид', 30, { SEMANTICS: 'S' }),
    status('STATUS', 'JUNK', 'Некачественный лид', 40, { SEMANTICS: 'F' }),
  ],
  SOURCE: [status('SOURCE', 'CALL', 'Звонок', 10), status('SOURCE', 'WEB', 'Веб-сайт', 20)],
  CONTACT_TYPE: [
    status('CONTACT_TYPE', 'CLIENT', 'Клиенты', 10),
    status('CONTACT_TYPE', 'PARTNER', 'Партнёры', 20),
  ],
  COMPANY_TYPE: [
    status('COMPANY_TYPE', 'CUSTOMER', 'Клиент', 10),
    status('COMPANY_TYPE', 'SUPPLIER', 'Поставщик', 20),
  ],
  INDUSTRY: [status('INDUSTRY', 'IT', 'Информационные технологии', 10)],
};

/** crm.category.list {entityTypeId:2}. */
export const DEAL_CATEGORIES = {
  categories: [
    { id: 0, name: 'Общая', sort: 100, entityTypeId: 2, isDefault: true },
    { id: 5, name: 'Партнёры', sort: 200, entityTypeId: 2, isDefault: false },
  ],
};

/** crm.status.entity.types. */
export const STATUS_ENTITY_TYPES = [
  { ID: 'STATUS', NAME: 'Стадии лида', ENTITY_TYPE_ID: 1 },
  { ID: 'SOURCE', NAME: 'Источник' },
  { ID: 'DEAL_STAGE', NAME: 'Стадии сделки', ENTITY_TYPE_ID: 2, CATEGORY_ID: 0 },
  { ID: 'DEAL_STAGE_5', NAME: 'Стадии сделки', ENTITY_TYPE_ID: 2, CATEGORY_ID: 5, CATEGORY_NAME: 'Партнёры' },
  { ID: 'CONTACT_TYPE', NAME: 'Тип контакта', ENTITY_TYPE_ID: 3 },
  { ID: 'COMPANY_TYPE', NAME: 'Тип компании', ENTITY_TYPE_ID: 4 },
  { ID: 'INDUSTRY', NAME: 'Сфера деятельности' },
];

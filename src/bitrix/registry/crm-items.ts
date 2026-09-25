/**
 * Группа реестра REST-методов: CRM: универсальный адаптер crm.item.* — смарт-процессы, смарт-счета, удаление записей.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Поля crm.item.* — собственная camelCase-схема метода (не UPPER_CASE классических crm.<entity>.*).
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const U = `${DOCS}/api-reference/crm/universal`;

export const crmItemsMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // --- универсальный адаптер элементов CRM (entityTypeId: смарт-процесс, 31 — новый счёт) ---
  D({
    method: 'crm.item.fields',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${U}/crm-item-fields.html`,
  }),
  D({
    method: 'crm.item.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    // result.items, start/next с фиксированной страницей 50
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${U}/crm-item-list.html`,
  }),
  D({
    method: 'crm.item.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${U}/crm-item-get.html`,
  }),
  D({
    method: 'crm.item.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${U}/crm-item-add.html`,
  }),
  D({
    method: 'crm.item.update',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${U}/crm-item-update.html`,
  }),
  D({
    method: 'crm.item.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${U}/crm-item-delete.html`,
  }),
  // --- типы смарт-процессов: id типа ≠ entityTypeId ---
  D({
    // Требует административного доступа к CRM (страница метода, «Who can execute»).
    method: 'crm.type.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    // result.types, start/next с фиксированной страницей 50
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${U}/user-defined-object-types/crm-type-list.html`,
  }),
  D({
    // В документации — crm.type.getByEntityTypeId; REST регистрирует имена в нижнем регистре, реестр хранит lowercase.
    // Проверка entityTypeId перед чтением/записью элементов: достаточно права чтения смарт-процесса.
    method: 'crm.type.getbyentitytypeid',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${U}/user-defined-object-types/crm-type-get-by-entity-type-id.html`,
  }),
  // --- удаление классических записей (crm_delete_record; этап 14) ---
  D({
    method: 'crm.deal.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-delete.html`,
  }),
  D({
    method: 'crm.lead.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/leads/crm-lead-delete.html`,
  }),
  D({
    method: 'crm.contact.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/contacts/crm-contact-delete.html`,
  }),
  D({
    method: 'crm.company.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/companies/crm-company-delete.html`,
  }),
];

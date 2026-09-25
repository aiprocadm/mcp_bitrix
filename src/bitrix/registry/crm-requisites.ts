/**
 * Группа реестра REST-методов: CRM: реквизиты, адреса, банковские реквизиты, дела (запись).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * crm.activity.add/update помечены в документации как «развитие остановлено» (DEPRECATED), но документированы;
 * для универсального дела используется современный crm.activity.todo.add.
 */
import { D, DOCS, type MethodDescriptor, type OperationKind, type PaginationKind } from './descriptor.js';

const RQ = `${DOCS}/api-reference/crm/requisites`;
const ACT = `${DOCS}/api-reference/crm/timeline/activities`;

const RAW_DENIED = new Set([
  'crm.requisite.list',
  'crm.requisite.get',
  'crm.address.list',
  'crm.requisite.bankdetail.get',
]);

function crm(
  method: string,
  operation: OperationKind,
  pagination: PaginationKind,
  source: string,
): readonly [string, MethodDescriptor] {
  return D({
    method,
    apiVersion: 'legacy',
    operation,
    scope: 'crm',
    pagination,
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    // Raw — только справочники и схемы полей. Сами реквизиты, адреса и банковские данные содержат паспортные
    // и платёжные поля (RQ_IDENT_*, счета) — их отдают только именованные инструменты с фильтрацией (§8.4).
    rawCallable: operation === 'read' && !RAW_DENIED.has(method),
    source,
  });
}

export const crmRequisitesMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // Реквизиты
  crm('crm.requisite.list', 'read', 'offset', `${RQ}/universal/crm-requisite-list.html`),
  crm('crm.requisite.get', 'read', 'none', `${RQ}/universal/crm-requisite-get.html`),
  crm('crm.requisite.fields', 'read', 'none', `${RQ}/universal/crm-requisite-fields.html`),
  crm('crm.requisite.add', 'create', 'none', `${RQ}/universal/crm-requisite-add.html`),
  crm('crm.requisite.update', 'update', 'none', `${RQ}/universal/crm-requisite-update.html`),
  // Шаблоны реквизитов и их поля
  crm('crm.requisite.preset.list', 'read', 'offset', `${RQ}/presets/crm-requisite-preset-list.html`),
  crm(
    'crm.requisite.preset.field.list',
    'read',
    'none',
    `${RQ}/presets/fields/crm-requisite-preset-field-list.html`,
  ),
  // Адреса реквизита (ENTITY_TYPE_ID=8 — реквизит) и справочник типов адресов
  crm('crm.address.list', 'read', 'offset', `${RQ}/addresses/crm-address-list.html`),
  crm('crm.address.add', 'create', 'none', `${RQ}/addresses/crm-address-add.html`),
  crm('crm.address.update', 'update', 'none', `${RQ}/addresses/crm-address-update.html`),
  crm(
    'crm.enum.addresstype',
    'read',
    'none',
    `${DOCS}/api-reference/crm/auxiliary/enum/crm-enum-address-type.html`,
  ),
  // Банковские реквизиты
  crm(
    'crm.requisite.bankdetail.fields',
    'read',
    'none',
    `${RQ}/bank-detail/crm-requisite-bank-detail-fields.html`,
  ),
  crm('crm.requisite.bankdetail.get', 'read', 'none', `${RQ}/bank-detail/crm-requisite-bank-detail-get.html`),
  crm(
    'crm.requisite.bankdetail.add',
    'create',
    'none',
    `${RQ}/bank-detail/crm-requisite-bank-detail-add.html`,
  ),
  // Дела: чтение для сверки, создание (универсальное дело — todo.add; звонок/встреча — activity.add), изменение
  crm('crm.activity.get', 'read', 'none', `${ACT}/activity-base/crm-activity-get.html`),
  crm('crm.activity.todo.add', 'create', 'none', `${ACT}/todo/crm-activity-todo-add.html`),
  crm('crm.activity.add', 'create', 'none', `${ACT}/activity-base/crm-activity-add.html`),
  crm('crm.activity.update', 'update', 'none', `${ACT}/activity-base/crm-activity-update.html`),
];

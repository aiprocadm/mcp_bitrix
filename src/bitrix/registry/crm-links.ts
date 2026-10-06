/**
 * Группа реестра REST-методов: CRM — связи записей (контакты сделки, компании контакта) и запись справочников.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Удаления (*.delete, *.items.delete) намеренно не регистрируются.
 */
import { D, DOCS, type MethodDescriptor, type OperationKind } from './descriptor.js';

const CRM = `${DOCS}/api-reference/crm`;

function crm(method: string, operation: OperationKind, source: string): readonly [string, MethodDescriptor] {
  return D({
    method,
    apiVersion: 'legacy',
    operation,
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    // Raw — только чтение связей и справочника; запись — только именованными инструментами с планом.
    rawCallable: operation === 'read',
    source,
  });
}

export const crmLinksMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // Контакты сделки
  crm('crm.deal.contact.items.get', 'read', `${CRM}/deals/contacts/crm-deal-contact-items-get.html`),
  crm('crm.deal.contact.add', 'create', `${CRM}/deals/contacts/crm-deal-contact-add.html`),
  // Компании контакта
  crm('crm.contact.company.items.get', 'read', `${CRM}/contacts/company/crm-contact-company-items-get.html`),
  crm('crm.contact.company.add', 'create', `${CRM}/contacts/company/crm-contact-company-add.html`),
  // Справочники (стадии, источники, причины): чтение элемента и запись без удаления
  crm('crm.status.get', 'read', `${CRM}/status/crm-status-get.html`),
  crm('crm.status.add', 'create', `${CRM}/status/crm-status-add.html`),
  crm('crm.status.update', 'update', `${CRM}/status/crm-status-update.html`),
];

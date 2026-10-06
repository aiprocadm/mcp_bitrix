/**
 * Группа реестра REST-методов: открытые линии (чтение), генератор документов CRM, универсальные списки (чтение).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`. Удаления не регистрируются.
 *
 * Raw (`bitrix_rest_call`) закрыт для генератора документов и истории открытых линий: живой портал (2026-10-06)
 * в `crm.documentgenerator.template.list` отдаёт поле `downloadMachine` с КОДОМ ВЕБХУКА в адресе, документы — ссылки
 * скачивания, история линий — ссылки на файлы. Эти данные отдают только именованные инструменты с белым списком полей.
 */
import { D, DOCS, type MethodDescriptor, type OperationKind } from './descriptor.js';

function m(
  method: string,
  scope: string,
  operation: OperationKind,
  pagination: 'none' | 'offset',
  rawCallable: boolean,
  source: string,
): readonly [string, MethodDescriptor] {
  return D({
    method,
    apiVersion: 'legacy',
    operation,
    scope,
    pagination,
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable,
    source,
  });
}

const OL = `${DOCS}/api-reference/imopenlines/openlines`;
const DG = `${DOCS}/api-reference/crm/document-generator`;
const LS = `${DOCS}/api-reference/lists`;

export const openlinesDocsListsMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // Открытые линии (scope imopenlines)
  m(
    'imopenlines.config.list.get',
    'imopenlines',
    'read',
    'none',
    true,
    `${OL}/imopenlines-config-list-get.html`,
  ),
  m(
    'imopenlines.crm.chat.get',
    'imopenlines',
    'read',
    'none',
    true,
    `${OL}/chats/imopenlines-crm-chat-get.html`,
  ),
  m(
    'imopenlines.dialog.get',
    'imopenlines',
    'read',
    'none',
    true,
    `${OL}/sessions/imopenlines-dialog-get.html`,
  ),
  m(
    'imopenlines.session.history.get',
    'imopenlines',
    'read',
    'none',
    false,
    `${OL}/sessions/imopenlines-session-history-get.html`,
  ),
  // Генератор документов CRM (scope crm)
  m(
    'crm.documentgenerator.template.list',
    'crm',
    'read',
    'offset',
    false,
    `${DG}/templates/crm-document-generator-template-list.html`,
  ),
  m(
    'crm.documentgenerator.document.list',
    'crm',
    'read',
    'offset',
    false,
    `${DG}/documents/crm-document-generator-document-list.html`,
  ),
  m(
    'crm.documentgenerator.document.get',
    'crm',
    'read',
    'none',
    false,
    `${DG}/documents/crm-document-generator-document-get.html`,
  ),
  m(
    'crm.documentgenerator.document.add',
    'crm',
    'create',
    'none',
    false,
    `${DG}/documents/crm-document-generator-document-add.html`,
  ),
  // Универсальные списки (scope lists)
  m('lists.get', 'lists', 'read', 'offset', true, `${LS}/lists/lists-get.html`),
  m('lists.field.get', 'lists', 'read', 'none', true, `${LS}/fields/lists-field-get.html`),
  m('lists.element.get', 'lists', 'read', 'offset', false, `${LS}/elements/lists-element-get.html`),
];

/**
 * Группа реестра REST-методов: База знаний 2.0 (note.*, REST 3.0).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Все методы — только REST 3.0 (endpoint /rest/api/...), scope `note` (ТЗ §9.14, S22/S23).
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const NOTE = `${DOCS}/api-reference/note`;

export const noteMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // Базы знаний
  D({
    method: 'note.collection.list',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'note',
    // pagination.limit 1..200 + afterCursor {position,id}; ответ result.items + result.nextCursor (объект или null)
    pagination: 'cursor',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${NOTE}/collection/note-collection-list.html`,
  }),
  D({
    method: 'note.collection.get',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'note',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${NOTE}/collection/note-collection-get.html`,
  }),
  D({
    method: 'note.collection.add',
    apiVersion: 'v3',
    operation: 'create',
    scope: 'note',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${NOTE}/collection/note-collection-add.html`,
  }),
  // Документы
  D({
    method: 'note.document.tree.list',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'note',
    // Пагинации нет: всё дерево одной выдачей, внутренний предел TREE_MAX_NODES=5000 (флаг truncated)
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${NOTE}/document/note-document-tree-list.html`,
  }),
  D({
    method: 'note.document.get',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'note',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${NOTE}/document/note-document-get.html`,
  }),
  D({
    method: 'note.document.search.list',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'note',
    // Документировано: только первая страница с hasMore, курсора следующей страницы нет (T37)
    pagination: 'first-page-only',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${NOTE}/document/note-document-search-list.html`,
  }),
  D({
    method: 'note.document.add',
    apiVersion: 'v3',
    operation: 'create',
    scope: 'note',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${NOTE}/document/note-document-add.html`,
  }),
  D({
    method: 'note.document.update',
    apiVersion: 'v3',
    operation: 'update',
    scope: 'note',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${NOTE}/document/note-document-update.html`,
  }),
];

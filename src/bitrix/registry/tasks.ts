/**
 * Группа реестра REST-методов: Задачи: обновление, завершение, удаление, чек-листы, обсуждение.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 *
 * Legacy `tasks.task.get` (scope `task`, /rest/…/tasks.task.get.json, ответ result.task в camelCase) и
 * REST 3.0 `tasks.task.get` (scope `tasks`, /rest/api/…/tasks.task.get, ответ result.item) — разные методы
 * с разными URL и схемами (ТЗ §9.8, T03); ключи реестра различаются префиксом версии.
 * Методы чек-листов и комментариев старого API (task.checklistitem.*, task.commentitem.*) принимают
 * параметры ПОЗИЦИОННО: порядок ключей в теле запроса обязан совпадать с таблицей документации.
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const T = `${DOCS}/api-reference/tasks`;

export const tasksMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // --- задача: изменение, завершение, удаление (legacy, scope task) ---
  D({
    method: 'tasks.task.update',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/tasks-task-update.html`,
  }),
  D({
    method: 'tasks.task.complete',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/status/tasks-task-complete.html`,
  }),
  D({
    method: 'tasks.task.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/tasks-task-delete.html`,
  }),

  // --- REST 3.0 (scope tasks): карточка задачи с requireResult/needsControl/chatId и отправка в чат задачи ---
  D({
    method: 'tasks.task.get',
    apiVersion: 'v3',
    operation: 'read',
    scope: 'tasks',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${T}/tasks-task-get-rest-v3.html`,
  }),
  D({
    method: 'tasks.task.chat.message.send',
    apiVersion: 'v3',
    operation: 'create',
    scope: 'tasks',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/tasks-task-chat-message-send.html`,
  }),

  // --- чек-листы (legacy, scope task; позиционные параметры TASKID, ITEMID, FIELDS/ORDER) ---
  D({
    method: 'task.checklistitem.getlist',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${T}/checklist-item/task-checklist-item-get-list.html`,
  }),
  D({
    method: 'task.checklistitem.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/checklist-item/task-checklist-item-add.html`,
  }),
  D({
    method: 'task.checklistitem.update',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/checklist-item/task-checklist-item-update.html`,
  }),
  D({
    method: 'task.checklistitem.complete',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/checklist-item/task-checklist-item-complete.html`,
  }),
  D({
    method: 'task.checklistitem.renew',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/checklist-item/task-checklist-item-renew.html`,
  }),
  D({
    method: 'task.checklistitem.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/checklist-item/task-checklist-item-delete.html`,
  }),

  // --- комментарии старой карточки (legacy, scope task; позиционные TASKID, ORDER, FILTER / TASKID, FIELDS) ---
  D({
    method: 'task.commentitem.getlist',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/comment-item/task-comment-item-get-list.html`,
  }),
  D({
    method: 'task.commentitem.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${T}/comment-item/task-comment-item-add.html`,
  }),
];

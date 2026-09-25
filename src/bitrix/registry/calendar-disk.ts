/**
 * Группа реестра REST-методов: Календарь (разделы, события, приглашения, занятость) и Диск (хранилища, обход, поиск, удаление).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Уже зарегистрированы в method-registry.ts и переиспользуются: calendar.section.get, calendar.event.get,
 * calendar.event.getbyid, calendar.event.add, disk.storage.getlist, disk.folder.getchildren, disk.folder.get, disk.file.get.
 * disk.file.delete (безвозвратное удаление) намеренно НЕ регистрируется: используется disk.file.markDeleted (корзина).
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

export const calendarDiskMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // --- календарь (S08) ---
  D({
    method: 'calendar.event.update',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-event-update.html`,
  }),
  D({
    method: 'calendar.event.delete',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-event-delete.html`,
  }),
  D({
    method: 'calendar.meeting.status.set',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-meeting-status-set.html`,
  }),
  D({
    method: 'calendar.meeting.status.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-meeting-status-get.html`,
  }),
  D({
    method: 'calendar.accessibility.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    // Возвращает названия чужих событий — наружу только через employee_availability (без названий).
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-accessibility-get.html`,
  }),

  // --- диск (S20) ---
  D({
    method: 'disk.storage.getchildren',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'disk',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/disk/storage/disk-storage-get-children.html`,
  }),
  D({
    method: 'disk.file.markdeleted',
    apiVersion: 'legacy',
    operation: 'delete',
    scope: 'disk',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/disk/file/disk-file-mark-deleted.html`,
  }),
];

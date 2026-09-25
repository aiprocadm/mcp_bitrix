/**
 * Группа реестра REST-методов: Календарь (разделы, события, приглашения, занятость) и Диск (хранилища, обход, поиск, удаление).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 */
import type { MethodDescriptor } from './descriptor.js';

export const calendarDiskMethods: readonly (readonly [string, MethodDescriptor])[] = [];

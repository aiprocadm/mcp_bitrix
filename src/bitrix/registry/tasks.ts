/**
 * Группа реестра REST-методов: Задачи: обновление, завершение, удаление, чек-листы, обсуждение.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 */
import type { MethodDescriptor } from './descriptor.js';

export const tasksMethods: readonly (readonly [string, MethodDescriptor])[] = [];

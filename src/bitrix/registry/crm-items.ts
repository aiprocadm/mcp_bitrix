/**
 * Группа реестра REST-методов: CRM: универсальный адаптер crm.item.* — смарт-процессы, смарт-счета, удаление записей.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 */
import type { MethodDescriptor } from './descriptor.js';

export const crmItemsMethods: readonly (readonly [string, MethodDescriptor])[] = [];

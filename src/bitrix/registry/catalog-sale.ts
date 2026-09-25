/**
 * Группа реестра REST-методов: Каталог, цены, склады и остатки, заказы магазина.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 */
import type { MethodDescriptor } from './descriptor.js';

export const catalogSaleMethods: readonly (readonly [string, MethodDescriptor])[] = [];

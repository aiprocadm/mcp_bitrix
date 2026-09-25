/**
 * Группа реестра REST-методов: Каталог, цены, склады и остатки, заказы магазина.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Складские документы (catalog.document.*), удаление товаров/цен, структура инфоблоков и права
 * сознательно не регистрируются (ТЗ §9.6: изменение структуры каталога запрещено, склад — отложен).
 * Имена в документации в camelCase (getFieldsByFilter, priceType) хранятся в каноническом lowercase:
 * REST Bitrix24 регистрирует методы без учёта регистра, реестр — строго lowercase (см. tasks.task.getfields).
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const read = (method: string, scope: string, path: string, pagination: 'none' | 'offset', raw = true) =>
  D({
    method,
    apiVersion: 'legacy',
    operation: 'read',
    scope,
    pagination,
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: raw,
    source: `${DOCS}/api-reference/${path}.html`,
  });

const write = (method: string, operation: 'create' | 'update', path: string) =>
  D({
    method,
    apiVersion: 'legacy',
    operation,
    scope: 'catalog',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/${path}.html`,
  });

export const catalogSaleMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // Торговые каталоги: result.catalogs, страница 50 (start).
  read('catalog.catalog.list', 'catalog', 'catalog/catalog/catalog-catalog-list', 'offset'),

  // Товары: простой товар, услуга, вариация — отдельные семейства методов с разными обёртками ответа.
  read('catalog.product.list', 'catalog', 'catalog/product/catalog-product-list', 'offset'),
  read('catalog.product.get', 'catalog', 'catalog/product/catalog-product-get', 'none'),
  read(
    'catalog.product.getfieldsbyfilter',
    'catalog',
    'catalog/product/catalog-product-get-fields-by-filter',
    'none',
  ),
  write('catalog.product.add', 'create', 'catalog/product/catalog-product-add'),
  write('catalog.product.update', 'update', 'catalog/product/catalog-product-update'),

  read(
    'catalog.product.service.list',
    'catalog',
    'catalog/product/service/catalog-product-service-list',
    'offset',
  ),
  read(
    'catalog.product.service.get',
    'catalog',
    'catalog/product/service/catalog-product-service-get',
    'none',
  ),
  read(
    'catalog.product.service.getfieldsbyfilter',
    'catalog',
    'catalog/product/service/catalog-product-service-get-fields-by-filter',
    'none',
  ),
  write('catalog.product.service.add', 'create', 'catalog/product/service/catalog-product-service-add'),
  write('catalog.product.service.update', 'update', 'catalog/product/service/catalog-product-service-update'),

  read('catalog.product.offer.list', 'catalog', 'catalog/product/offer/catalog-product-offer-list', 'offset'),
  read('catalog.product.offer.get', 'catalog', 'catalog/product/offer/catalog-product-offer-get', 'none'),
  read(
    'catalog.product.offer.getfieldsbyfilter',
    'catalog',
    'catalog/product/offer/catalog-product-offer-get-fields-by-filter',
    'none',
  ),
  write('catalog.product.offer.add', 'create', 'catalog/product/offer/catalog-product-offer-add'),
  write('catalog.product.offer.update', 'update', 'catalog/product/offer/catalog-product-offer-update'),

  // Цены: одна цена на пару товар+тип цены; add/update — единственные пути записи.
  read('catalog.price.list', 'catalog', 'catalog/price/catalog-price-list', 'offset'),
  write('catalog.price.add', 'create', 'catalog/price/catalog-price-add'),
  write('catalog.price.update', 'update', 'catalog/price/catalog-price-update'),
  read('catalog.pricetype.list', 'catalog', 'catalog/price-type/catalog-price-type-list', 'offset'),
  // Справочник валют, на который ссылаются catalog.price.add/update (поле currency); scope crm.
  read('crm.currency.list', 'crm', 'crm/currency/crm-currency-list', 'none'),

  // Склады и остатки (только чтение).
  read('catalog.store.list', 'catalog', 'catalog/store/catalog-store-list', 'offset'),
  read('catalog.storeproduct.list', 'catalog', 'catalog/store-product/catalog-store-product-list', 'offset'),

  // Заказы магазина: полный ответ содержит персональные данные покупателя → в raw не допускаем.
  read('sale.order.get', 'sale', 'sale/order/sale-order-get', 'none', false),
  read('sale.order.list', 'sale', 'sale/order/sale-order-list', 'offset', false),
  read('sale.basketitem.list', 'sale', 'sale/basket-item/sale-basket-item-list', 'offset'),
];

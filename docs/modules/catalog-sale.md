# Каталог, цены, склады и заказы магазина (ТЗ §9.6)

Модули: `catalog` (каталог, цены, склады), `orders` (заказы магазина, Bitrix24 `sale`).
Включаются через `ENABLED_MODULES=...,catalog,orders`. Запись видна только при `READ_ONLY_MODE=false`.

Каталог, цены, товарные строки CRM, остатки и заказы — разные сущности: изменение карточки не трогает цену
и остатки, цена ставится отдельным инструментом, складские документы и списания не реализованы (отложены ТЗ).
Изменение структуры инфоблока, удаление каталога/товаров/цен и перенастройка прав — не реализуются и в реестр
методов не внесены.

## Инструменты

| Инструмент               | Операция | REST-методы (scope)                                                                                                                | Примечания                                                                                                                                                                    |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_list`           | read     | `catalog.catalog.list` (catalog)                                                                                                   | `result.catalogs`; `kind=variations`, если заполнен `productIblockId`                                                                                                         |
| `catalog_products_list`  | read     | `catalog.product.list` / `catalog.product.service.list` / `catalog.product.offer.list` (catalog)                                   | `iblockId`, `productKind`, `nameContains` (`%name`), `activeOnly`, `sectionId`, P. Минимальный `select` (обязательны `id`, `iblockId`); цены/остатки/закупка не запрашиваются |
| `catalog_product_create` | create   | `catalog.catalog.list`, `*.getFieldsByFilter`, `catalog.product.add` / `.service.add` / `.offer.add`, `*.get` (verify)             | Вид сверяется с каталогом (INVALID_PRODUCT_TYPE); поля — явный перечень + метаданные портала                                                                                  |
| `catalog_product_update` | update   | `*.get`, `*.getFieldsByFilter`, `catalog.product.update` / `.service.update` / `.offer.update`                                     | `productKind` сверяется с фактическим `type` (INVALID_PRODUCT_TYPE); stateHash/expectedStateHash, CONFLICT до плана и в precheck; diff «было → станет»; verify                |
| `catalog_price_set`      | update   | `*.get`, `catalog.priceType.list`, `crm.currency.list` (crm), `catalog.price.list`, `catalog.price.add` или `catalog.price.update` | Режим create/update по `catalog.price.list`; decimal-строка; INVALID_CURRENCY / INVALID_PRICE_TYPE / INVALID_PRECISION; CONFLICT                                              |
| `warehouse_list`         | read     | `catalog.store.list` (catalog)                                                                                                     | `activeOnly` → `filter.active=Y`; телефон/email склада не выводятся                                                                                                           |
| `warehouse_stock_list`   | read     | `catalog.storeproduct.list` (catalog)                                                                                              | `storeIds` → `@storeId`, `productIds` → `@productId`; `amount` и `quantityReserved` как есть, доступность не рассчитывается                                                   |
| `store_order_get`        | read     | `sale.order.get`, при отсутствии состава — `sale.basketitem.list` (sale)                                                           | ПДн покупателя не выводятся; `itemsCompleteness`, `partialReason=PARTIAL_RESULT`                                                                                              |
| `store_orders_list`      | read     | `sale.order.list` (sale)                                                                                                           | `from`/`to` → `>=dateInsert`/`<=dateInsert`, `status` → `statusId`; минимальный `select`                                                                                      |

Все имена методов с camelCase в документации (`getFieldsByFilter`, `priceType`) хранятся в реестре в
каноническом lowercase (`catalog.product.getfieldsbyfilter`, `catalog.pricetype.list`), как `tasks.task.getfields`:
реестр сравнивает имена строго, REST Bitrix24 — без учёта регистра.

## Решения и допущения

- **Decimal-цены.** `amount` принимается только строкой `^(0|[1-9]\d{0,11})(\.\d{1,3})?$`: без знака, экспоненты
  (`1e3`), пробелов, ведущих нулей и запятой; число вместо строки отклоняется схемой. Знаков после точки — не больше
  `DECIMALS` валюты из `crm.currency.list` (RUB/USD — 2, JPY — 0), иначе `INVALID_PRECISION`. Сравнение «было/стало»
  и сверка — по канонической десятичной строке, без float-арифметики. Поле `price` у `catalog.price.add/update`
  документировано как `double`, поэтому передаётся JSON-число; для ≤15 значащих цифр строка → double → JSON
  восстанавливается точно, это проверяется перед отправкой (`toUpstreamNumber`).
- **Валюта** проверяется по `crm.currency.list` — на этот метод ссылается документация `catalog.price.add`
  (поле `currency`). Требует scope `crm` у вебхука; без него `catalog_price_set` вернёт `BITRIX_SCOPE_MISSING`.
- **Тип цены** — по `catalog.priceType.list`. Ответ читается как `result.priceTypes` (раздел «Returned Data»;
  пример JSON на странице без обёртки `result` — расхождение в документации, проверить на реальном портале).
- **Несколько цен одного типа** (диапазоны количества, устаревшая схема) → отказ `PRICE_RANGES_UNSUPPORTED`,
  чтобы не изменить не ту строку.
- **Гонка режима цены.** Precheck перед записью перечитывает цены: если цена появилась/исчезла после чтения,
  запись отменяется `CONFLICT` даже без `expectedStateHash` (иначе «создать» превратилось бы в дубль/ошибку).
- **Поля карточки** — явный перечень документированных полей (`name`, `active`, `code`, `xmlId`, `iblockSectionId`,
  `measure`, тексты анонса/описания, `sort`, `vatId`, `vatIncluded`, даты активности; для товара и вариации ещё
  `barcodeMulti`, `canBuyZero`, `subscribe`, `quantityTrace`, габариты; для вариации `parentId`). Исключены
  закупочная цена, количество, резерв (цены/остатки), картинки (base64), свойства `propertyN`, служебные поля.
  Дополнительно каждое поле сверяется с `*.getFieldsByFilter` портала (`UNKNOWN_FIELD`, `READ_ONLY_FIELD`,
  `REQUIRED_FIELD_MISSING`, `REQUIRED_FIELD_UNSUPPORTED` — если портал требует свойство, которое инструмент не заполняет).
- **Виды позиций.** `product` → `type=1`, `service` → `type=7`, `offer` → `type=4|5` (раздел «Product and Variation
  Relationship» catalog/data-types). Родительские товары с вариациями (`catalog.product.sku.*`, `type=3`) не
  поддерживаются — ТЗ их не требует.
- **stateHash** карточки — канонический хеш `id/iblockId/type` и всех изменяемых полей; для цены — строк цены
  (id, сумма, валюта). Получить можно через `dryRun` (`data.stateHash`).
- **Заказ и ПДн (§8.4).** Не выводятся `propertyValues` (ФИО, телефон, email, адрес), `comments`,
  `userDescription`, адреса/трек-номера/комментарии отгрузок, реквизиты. Выводятся ID покупателя (`userId`),
  CRM-привязки (`clients`: entityTypeId/entityId), оплаты (сумма, оплачено, платёжная система), отгрузки (служба,
  статус, отгружено; системная отгрузка скрыта).
- **Полнота состава заказа.** `basketItems` из `sale.order.get` → `complete`. Если их нет — `sale.basketitem.list`
  по `orderId`, не больше 4 страниц (200 позиций); остаток → `completeness=partial`, `partialReason=PARTIAL_RESULT`
  с числом прочитанных из `total`. Больше 200 позиций в ответе не отдаётся (тоже partial).
- **Даты фильтра заказов** передаются в `sale.order.list` как ISO 8601 (`>=dateInsert`); формат документацией явно
  не описан — проверить на реальном портале.

## Gaps

- Удаление товаров и цен, структура инфоблоков, права, складские документы (`catalog.document.*`) —
  вне ТЗ §9.6 / отложены; методы не зарегистрированы.
- Свойства товара `propertyN`, картинки и множественная привязка к разделам (`IblockSection`) не поддерживаются
  в create/update (явный перечень полей). Альтернатива — интерфейс Bitrix24.
- Коды ошибок каталога вида `200040300010` (нет прав) клиентом не распознаются как `BITRIX_ACCESS_DENIED` и
  приходят как `BITRIX_UPSTREAM_ERROR` с `upstreamCode`. Нужна общая правка `src/bitrix/errors.ts` (не в этой группе).

## Проверено

- Только mock (`tests/integration/catalog-sale.test.ts`, 24 теста): формы ответов и параметры запросов по
  документации, курсор (61 позиция страницами по 20 без пропусков, T20; чужой фильтр — отказ, T21), decimal-цена
  (`"1234.10"` → `1234.1` в JSON без двоичной ошибки; отказ `1e3`, `-5`, `1.1234`, `01.5`, `1,5`, числа, лишних знаков
  для RUB/JPY), INVALID_CURRENCY, INVALID_PRICE_TYPE, INVALID_PRODUCT_TYPE (create и update, цена), выбор add/update
  цены, CONFLICT (до плана и в precheck; смена режима цены), OPERATION_OUTCOME_UNKNOWN без повторной записи,
  полный путь APPROVAL_REQUIRED → approve → запись → replay, частичный состав заказа, отсутствие ПДн в ответе,
  скрытие записи при READ_ONLY_MODE и инструментов при выключенном модуле.
- Реальный портал: **not-run** (все методы). Особенно проверить: приём `price` числом, обёртку `catalog.priceType.list`,
  формат дат фильтра `sale.order.list`, ответ `*.get` на несуществующий ID, `type` у позиций разных видов.

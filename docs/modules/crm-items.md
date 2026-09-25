# Модуль crm-items: универсальный CRM-адаптер `crm.item.*`

Смарт-процессы (ТЗ §9.7), новые смарт-счета (§9.5), маршрутизация `crm_*` для `entityType=smart|invoice` (§9.4, §10.2)
и удаление записей CRM `crm_delete_record` (§9.4, этап 14).

Поля `crm.item.*` — собственная camelCase-схема метода (`title`, `stageId`, `assignedById`, `ufCrm5_…`).
Классический адаптер (`crm.<entity>.*`, UPPER_CASE) не изменён: значения его полей, методы и ответы прежние.
Автоматического «переведения регистра» нет: `TITLE` для smart/invoice — `UNKNOWN_FIELD` с подсказкой про camelCase.

## Инструменты

| Инструмент                  | Модуль         | Операция | Методы Bitrix24                                                                                                                                                                  |
| --------------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smart_process_types_list`  | smartProcesses | read     | `crm.type.list`                                                                                                                                                                  |
| `smart_process_items_list`  | smartProcesses | read     | `crm.type.getByEntityTypeId`, `crm.item.fields`, `crm.item.list`                                                                                                                 |
| `smart_process_item_get`    | smartProcesses | read     | `crm.type.getByEntityTypeId`, `crm.item.get` (+ `crm.item.fields` при `select`)                                                                                                  |
| `smart_process_item_create` | smartProcesses | create   | `crm.type.getByEntityTypeId`, `crm.item.fields`, `crm.category.list`, `crm.status.list`, `crm.item.add`, `crm.item.get`                                                          |
| `smart_process_item_update` | smartProcesses | update   | те же + `crm.item.update`                                                                                                                                                        |
| `invoice_list`              | invoices       | read     | `crm.item.fields`, `crm.item.list` (entityTypeId=31)                                                                                                                             |
| `invoice_create`            | invoices       | create   | `crm.item.fields`, `crm.category.list`, `crm.status.list`, `crm.item.add`, `crm.item.productrow.set` (ownerType=SI), `crm.item.get`, `crm.item.productrow.list`                  |
| `invoice_update`            | invoices       | update   | `crm.item.fields`, `crm.item.get`, `crm.item.update`                                                                                                                             |
| `invoice_stages_list`       | invoices       | read     | `crm.category.list` (entityTypeId=31), `crm.status.list` (`SMART_INVOICE_STAGE_{categoryId}`)                                                                                    |
| `crm_delete_record`         | crm            | delete   | `crm.<entity>.get/.delete` или `crm.item.get/.delete`; impact: `crm.activity.list`, `crm.timeline.comment.list`, `crm.item.productrow.list`, `crm.deal.list`, `crm.contact.list` |

Расширены (entityType += `smart` | `invoice`, `entityTypeId?`): `crm_list_records`, `crm_get_record`,
`crm_create_record`, `crm_update_record`, `crm_fields_get`. Для `smart` `entityTypeId` обязателен
(`VALIDATION_ERROR`, reason `ENTITY_TYPE_ID_REQUIRED`), для классических сущностей запрещён
(`UNEXPECTED_ENTITY_TYPE_ID`), для `invoice` допустим только 31.

`crm_get_record` получил `include?: ('activities'|'comments'|'products')[]` с отдельными лимитами
(дела 10, комментарии 10, товары 20) и собственной `completeness` у каждого блока в `data.related`:

- `activities` — все типы (для классики — `activitiesPage`, для smart/invoice — `crm.activity.list` по `OWNER_TYPE_ID=entityTypeId`);
- `comments` — только классические сущности (`commentsPage`);
- `products` — сделка (`dealRowsPage`, ownerType D), лид (L), smart (`T{hex(entityTypeId)}`), invoice (SI);
  контакт/компания — `UNSUPPORTED_INCLUDE`.
- `requisites` намеренно не включён: `crm.requisite.list` регистрирует другая группа (crm-requisites).

Сбой одного блока не скрывает карточку: блок помечается `completeness=unknown` с кодом ошибки.

## Новые методы реестра (`src/bitrix/registry/crm-items.ts`)

| Метод                        | Операция      | rawCallable | Источник                                                                                                              |
| ---------------------------- | ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `crm.item.fields`            | read          | да          | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-fields.html                                          |
| `crm.item.list`              | read (offset) | да          | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-list.html                                            |
| `crm.item.get`               | read          | да          | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-get.html                                             |
| `crm.item.add`               | create        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-add.html                                             |
| `crm.item.update`            | update        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-update.html                                          |
| `crm.item.delete`            | delete        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/universal/crm-item-delete.html                                          |
| `crm.type.list`              | read (offset) | да          | https://apidocs.bitrix24.ru/api-reference/crm/universal/user-defined-object-types/crm-type-list.html                  |
| `crm.type.getbyentitytypeid` | read          | да          | https://apidocs.bitrix24.ru/api-reference/crm/universal/user-defined-object-types/crm-type-get-by-entity-type-id.html |
| `crm.deal.delete`            | delete        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/deals/crm-deal-delete.html                                              |
| `crm.lead.delete`            | delete        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/leads/crm-lead-delete.html                                              |
| `crm.contact.delete`         | delete        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/contacts/crm-contact-delete.html                                        |
| `crm.company.delete`         | delete        | нет         | https://apidocs.bitrix24.ru/api-reference/crm/companies/crm-company-delete.html                                       |

Scope всех методов — `crm`. `crm.type.getByEntityTypeId` хранится в реестре в нижнем регистре
(как `tasks.task.getfields`): реестр ищет имя точно, без нормализации регистра.
Уже зарегистрированные и переиспользованные: `crm.category.list`, `crm.status.list`, `crm.item.productrow.list/set`,
`crm.activity.list`, `crm.timeline.comment.list`, `crm.<entity>.get/list/fields`.

## Факты из документации и принятые решения

- **Формы ответов**: `crm.item.list` → `result.items` + `total`/`next` (страница всегда 50);
  `crm.item.get/add/update` → `result.item`; `crm.item.delete` → `result: []`; `crm.item.fields` → `result.fields`;
  `crm.type.list` → `result.types`; `crm.type.getByEntityTypeId` → `result.type`; классические `.delete` → `result: true`.
  Иная форма ответа записи → `OPERATION_OUTCOME_UNKNOWN` (без автоповтора).
- **id типа ≠ entityTypeId**. `smart_process_types_list` отдаёт оба поля (`typeId`, `entityTypeId`).
  Все остальные инструменты принимают только `entityTypeId` и проверяют его: системные типы (1, 2, 3, 4, 5, 7, 8, 14, 31)
  отклоняются локально без запроса; иначе — `crm.type.getByEntityTypeId` (кэш 5 минут). Не найден — `VALIDATION_ERROR`,
  reason `NOT_SMART_PROCESS`, с подсказкой не путать id типа и entityTypeId.
  Допущение: для проверки выбран `crm.type.getByEntityTypeId`, а не `crm.type.list`, потому что по документации
  `crm.type.list` доступен только администратору CRM, а `getByEntityTypeId` — любому, у кого есть право чтения смарт-процесса.
  Результат тот же: число принимается, только если это существующий тип смарт-процесса портала.
- **Счёт 31**: `crm.type.*` для 31 не вызывается (§9.5). Старые `crm.invoice.*` не используются.
  Создаётся только карточка: PDF, отправка, ссылка на оплату, фискализация, отметка оплаты не выполняются и не заявляются (это есть в рисках плана).
- **Метаданные перед записью**: `crm.item.fields` (кэш 5 минут, `ctx.capabilities`); неизвестные → `UNKNOWN_FIELD`,
  read-only и `id` → `READ_ONLY_FIELD`, immutable при update → `IMMUTABLE_FIELD`, обязательные при create → `REQUIRED_FIELD_MISSING`.
  Допущение: поля типа `boolean` при проверке обязательности пропускаются — `crm.item.fields` помечает `opened` как
  `isRequired`, а страница `crm.item.add` задаёт ему значение по умолчанию (`Y`). Поля типов `file`, `crm_multifield`,
  `location` через этот адаптер не пишутся (`UNSUPPORTED_FIELD_TYPE`).
- **Стадии (INVALID_STAGE)**: смарт-процесс — `crm.status.list` с `ENTITY_ID=DYNAMIC_{entityTypeId}_STAGE_{categoryId}`,
  счёт — `SMART_INVOICE_STAGE_{categoryId}` (обе формулы со страницы `crm.item.add`). `categoryId` берётся из `fields`,
  иначе из текущего элемента, иначе воронка по умолчанию (`crm.category.list`, `isDefault`). Если у смарт-процесса выключены стадии,
  `stageId` отклоняется.
- **update**: read-before, `stateHash` (все поля, кроме `updatedTime`), `expectedStateHash` → `CONFLICT` до плана и в precheck,
  diff «было → станет» в плане, после записи — перечитывание и сверка каждого скалярного поля.
- **T34 — `invoice_create` с товарами**. Оба шага выполняются внутри одной подтверждённой операции `MutationExecutor`.
  Ошибка `crm.item.productrow.set` после успешного `crm.item.add` не бросается из `perform`: шаг записывается в результат
  (`productRows.status = failed|unknown`, код ошибки), операция завершается `succeeded`, результат с ID счёта хранится
  в ledger в зашифрованном виде. Инструмент отвечает `PARTIAL_SUCCESS` (ID счёта в сообщении и `nextAction`,
  `operationId` в details). Повтор с тем же `approvalId` или тем же `idempotencyKey` возвращает сохранённый результат
  (снова `PARTIAL_SUCCESS` с тем же ID), второй счёт не создаётся. Почему так: если `perform` бросит ошибку, исполнитель
  пометит операцию `failed` и не сохранит результат, и ID счёта из ledger будет потерян.
- **crm_delete_record**: `operation: 'delete'`, `DESTRUCTIVE_ANNOTATIONS`. Инструмент скрыт без `ENABLE_DESTRUCTIVE_TOOLS=true`,
  выполняет его только роль `administrator` (register-tools). Запись читается до плана: `NOT_FOUND` — без плана.
  План: название, стадия, сумма, валюта, ответственный и `impact` — число дел, комментариев таймлайна и товарных позиций,
  а у компании и контакта — связанных сделок (и контактов компании). Если посчитать не удалось, так и пишется:
  «не удалось посчитать». precheck перечитывает запись (`CONFLICT` при изменении), затем вызывается `.delete`.
  verify: повторное чтение должно вернуть `NOT_FOUND`. При повторе с `approvalId` уже удалённая запись не мешает
  вернуть сохранённый результат.

## Gaps и ограничения

| Что                                             | Источник                                          | Наблюдение                                                                                             | Альтернатива / решение                                                                                  |
| ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Комментарии таймлайна smart/invoice в `include` | `crm/timeline/comments/crm-timeline-comment-list` | `ENTITY_TYPE` задокументирован только примерами `deal/lead/contact/company`                            | Для smart/invoice `include.comments` → `UNSUPPORTED_INCLUDE`; добавить после сверки значения на портале |
| Реквизиты в `include`                           | ТЗ §9.4                                           | `crm.requisite.list` регистрирует группа crm-requisites                                                | Не включено в этот срез; добавить после слияния групп                                                   |
| Изменение товаров счёта                         | ТЗ §9.5                                           | `invoice_update` меняет только поля карточки                                                           | Состав товаров счёта после создания — в интерфейсе Bitrix24; отдельный инструмент не заявлен в ТЗ       |
| `crm.type.list` требует прав администратора CRM | страница `crm-type-list` («Who can execute»)      | Без этих прав `smart_process_types_list` вернёт `BITRIX_ACCESS_DENIED`                                 | Проверка `entityTypeId` для элементов этих прав не требует                                              |
| `ErrorDetails` без поля `id`                    | `src/errors/app-error.ts` (allowlist)             | ID счёта при `PARTIAL_SUCCESS` передаётся в `message`/`nextAction` и хранится в ledger (`operationId`) | Можно добавить `id` в allowlist `ErrorDetails` (общий файл, вне группы)                                 |

## Проверки

- Mock (vitest, `tests/integration/crm-items.test.ts`, 26 тестов): типы смарт-процессов (typeId ≠ entityTypeId);
  отказ на id типа, на системных типах и на 31; кэш проверки типа и полей; список с camelCase-фильтром и курсором (60 элементов);
  UPPER_CASE не «переводится»; get/NOT_FOUND; UNKNOWN/READ_ONLY/REQUIRED/IMMUTABLE; INVALID_STAGE (другая воронка,
  выключенные стадии); полный путь create/update: APPROVAL_REQUIRED → approve → запись → replay без второй записи;
  CONFLICT до плана и в precheck; OPERATION_OUTCOME_UNKNOWN; маршрутизация `crm_*` для smart/invoice; include с лимитами;
  стадии счетов; invoice_create с товарами; **T34**; invoice_update; crm_delete_record: скрыт, отказ operator, NOT_FOUND без плана,
  CONFLICT, план с impact, verify NOT_FOUND, replay, удаление smart, исход неизвестен.
- Существующие тесты `crm-deals`/`crm-entities`/`crm-related` зелёные. Проверки на `smart`/`invoice` в них уточнены под новую
  семантику: `smart` без entityTypeId → `ENTITY_TYPE_ID_REQUIRED`, неизвестный тип (`quote`) отклоняется схемой.
- **Реальный портал: not-run.** Формы ответов, коды ошибок (`crm.type.getByEntityTypeId` «0»), `ENTITY_ID` стадий,
  ownerType `T{hex}`, состав каскадного удаления и корзина проверены только по документации и mock.

## Безопасно добавить в raw allowlist (только чтение)

`crm.item.fields`, `crm.item.list`, `crm.item.get`, `crm.type.list`, `crm.type.getbyentitytypeid`.

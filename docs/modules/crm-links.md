# Модуль crm (дополнение 2026-10-06): связи записей, справочники, сводка по всем воронкам, письма

Добавлено по заданию владельца после подключения живого портала. Модуль `crm`, scope вебхука `crm`.
Удаление связей и элементов справочника не реализовано: методов `*.delete` в реестре нет.

## Инструменты

| Инструмент                   | Операция | Методы Bitrix24                                                                                  |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `crm_deal_contacts_list`     | read     | `crm.deal.get`, `crm.deal.contact.items.get`, `crm.contact.list` (ФИО по `@ID`)                  |
| `crm_deal_contact_add`       | create   | `crm.deal.get`, `crm.contact.get`, `crm.deal.contact.items.get`, `crm.deal.contact.add`          |
| `crm_contact_companies_list` | read     | `crm.contact.get`, `crm.contact.company.items.get`, `crm.company.list` (названия по `@ID`)       |
| `crm_contact_company_add`    | create   | `crm.contact.get`, `crm.company.get`, `crm.contact.company.items.get`, `crm.contact.company.add` |
| `crm_status_create`          | create   | `crm.status.entity.types`, `crm.status.list`, `crm.status.add`, `crm.status.get`                 |
| `crm_status_update`          | update   | `crm.status.entity.types`, `crm.status.list`, `crm.status.update`, `crm.status.get`              |
| `crm_pipelines_overview`     | read     | `crm.deal.list` или `crm.lead.list`, `crm.category.list`, `crm.status.list`                      |

Расширен `crm_activities_list`: `kind` (`email` → `TYPE_ID=4`, `call` → 2, `meeting` → 1, `task` → 3) и
`descriptionMaxChars`; при `includeDescription=true` тело письма (`DESCRIPTION_TYPE=3`, HTML) переводится в обычный текст
и обрезается с `DESCRIPTION_TRUNCATED`/`DESCRIPTION_LENGTH`.

## Поведение

- **Связи.** Обе записи читаются до плана (`NOT_FOUND`). Уже привязанная — `CONFLICT` reason `ALREADY_LINKED` до плана,
  а при повторе с `approvalId` — в precheck (повтор после успешной привязки отдаёт сохранённый результат, не ошибку).
  `isPrimary=true` — план показывает, кто перестанет быть основным; без `isPrimary` основной ставится, только если
  основного нет (официальные страницы). `result=false` у `*.add` — «уже привязан», не успех. Сверка — по списку связей.
- **Справочники.** Справочник должен быть в `crm.status.entity.types` (`UNKNOWN_DIRECTORY`). У стадий (`STATUS`,
  `QUOTE_STATUS`, `*STAGE*`) код — латиница/цифры/«-»/«_», пределы 21/22/50; для `DEAL_STAGE_xx` портал добавляет
  префикс `Cxx:` — план показывает итоговый код. `semantics`/`color` у не-стадий — `NOT_A_STAGE_DIRECTORY`. Дубль кода —
  `DUPLICATE_STATUS`. Изменение — по `entityId + statusId`, только `NAME`/`SORT`/`COLOR`, план «было → станет»,
  `NO_CHANGES`, `expectedStateHash` → `CONFLICT`. После записи кэш метаданных портала сбрасывается.
  Методы доступны только администратору CRM.
- **Сводка по всем воронкам.** Один проход `crm.deal.list` (поля ID, CATEGORY_ID, STAGE_ID, OPPORTUNITY, CURRENCY_ID) —
  группировка по воронкам и стадиям, выиграно/проиграно/в работе. Для лидов — стадии `STATUS` и источники `SOURCE`
  с названиями. Пределы `maxRecords`/`MAX_AGGREGATION_SECONDS`, честная неполнота; валюты не складываются.
- **Ошибка с пустым кодом.** `crm.deal.contact.*` на отсутствующую запись отвечают `{"error":"","error_description":"Not found."}`
  (HTTP 400) — теперь это `NOT_FOUND`, а не `BITRIX_UPSTREAM_ERROR` (общая правка `legacy-adapter.ts`).

## Не сделано и почему

- **Товары лида** отдельным инструментом не нужны: `crm_get_record` с `include: ["products"]` уже читает их через
  `crm.item.productrow.list` (`ownerType=L`); `crm.lead.productrows.get` помечен в документации «развитие остановлено».
- **Вложения писем** не отдаются: в списке `FILES` пуст, а ссылки скачивания из `crm.activity.get` содержат токен (§8.4).
- **`event.get`** через вебхук невозможен: официальная страница — только контекст приложения, вебхуку `WRONG_AUTH_TYPE`.
- **Роботы стадий CRM** в REST недоступны (официальная страница `bizproc.workflow.template.list`).

## Проверено

- Живой портал (только чтение, 2026-10-06): формы `crm.deal.contact.items.get`, `crm.contact.company.items.get`,
  ошибка «Not found» с пустым кодом, `crm.item.fields(7)` без `categoryId`, `crm.category.list(7)` →
  `ENTITY_TYPE_NOT_SUPPORTED`, `QUOTE_STATUS`, тела e-mail-дел (HTML, `DESCRIPTION_TYPE=3`).
- `tests/integration/crm-links.test.ts` (17 тестов); мутационная проверка 7 ключевых мест — каждое ловится.
- Не проверено: запись на живом портале (привязки, `crm.status.add/update`, создание КП) — первая запись по подтверждению владельца.

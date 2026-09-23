# Каталог инструментов

Раздел «Реализовано» генерируется командой `npm run schemas:export` из кода; правки вносить в исходники инструментов.
Полный реестр требований — ТЗ §9 (docs/TZ.md); статусы этапов — docs/STATUS.md.

## Реализовано

| Инструмент | Модуль | Операция | readOnly | destructive | idempotent | Нужен Bitrix | Схемы |
|---|---|---|---|---|---|---|---|
| `bitrix_connection_info` | system | admin/diagnostic | true | false | true | да | [json](schemas/bitrix_connection_info.json) |
| `bitrix_server_version` | system | admin/diagnostic | true | false | true | нет | [json](schemas/bitrix_server_version.json) |
| `bitrix_capabilities` | system | admin/diagnostic | true | false | true | да | [json](schemas/bitrix_capabilities.json) |
| `bitrix_rest_call` | system | admin/diagnostic | true | false | true | да | [json](schemas/bitrix_rest_call.json) |
| `operation_status` | system | read | true | false | true | нет | [json](schemas/operation_status.json) |
| `crm_list_records` | crm | read | true | false | true | да | [json](schemas/crm_list_records.json) |
| `crm_get_record` | crm | read | true | false | true | да | [json](schemas/crm_get_record.json) |
| `crm_create_record` | crm | create | false | false | false | да | [json](schemas/crm_create_record.json) |
| `crm_fields_get` | crm | read | true | false | true | да | [json](schemas/crm_fields_get.json) |
| `task_create` | tasks | create | false | false | false | да | [json](schemas/task_create.json) |
| `task_get` | tasks | read | true | false | true | да | [json](schemas/task_get.json) |
| `task_list` | tasks | read | true | false | true | да | [json](schemas/task_list.json) |

## Описания

### `bitrix_connection_info`

Кто подключён к какому порталу Bitrix24 и с какими ограничениями: домен без секрета, способ авторизации, текущий сотрудник, режим записи, выданные scope, включённые модули. Использовать первым, чтобы проверить связь. Секрет вебхука никогда не возвращается.

### `bitrix_server_version`

Версия собственного MCP-сервера, SDK, протокола и список включённых модулей. Использовать, когда нужно проверить, что сервер запущен и какой он версии. Не обращается к Bitrix24.

### `bitrix_capabilities`

Проверяет, какие методы из реестра сервера существуют и доступны на портале (через method.get), какие запрещены политикой сервера и какие ещё не проверены. Использовать, когда инструмент вернул FEATURE_UNAVAILABLE или перед включением модуля. Доступность метода не гарантирует доступ ко всем объектам.

### `bitrix_rest_call`

Контролируемый вызов одного REST-метода Bitrix24 из положительного allowlist (только чтение в MVP). Использовать для диагностики (profile, method.get) и чтения, для которого ещё нет именованного инструмента. Нельзя: batch, произвольные методы/URL, поля auth, запись. Отказ происходит до обращения к порталу.

### `operation_status`

Состояние своей операции записи по operationId: prepared, approved, executing, succeeded, failed, unknown, denied, expired. Использовать после ответа APPROVAL_REQUIRED или OPERATION_OUTCOME_UNKNOWN. Не обращается к Bitrix24 и не выдаёт секреты.

### `crm_list_records`

Страница записей CRM (в MVP — сделки) с фильтром, сортировкой и выбором полей. Использовать, когда нужен список сделок по условию: стадия, ответственный, даты, часть названия. Ключи фильтра — как в Bitrix24: ИМЯ_ПОЛЯ с префиксом (=, %, >, <, >=, <=, !, @, ><), например {">=DATE_CREATE": "2026-09-01", "%TITLE": "договор"}. Поля проверяются по схеме портала (crm_fields_get). Одна страница до 50 записей; продолжение — по cursor из ответа.

### `crm_get_record`

Карточка записи CRM по ID (в MVP — сделка) в рамках доступных полей. Использовать, когда известен ID и нужны поля сделки. Возвращает stateHash для последующих изменений (expectedStateHash). Связанные блоки (дела, комментарии, товары) через include появятся в полной версии; бинарные вложения не скачиваются.

### `crm_create_record`

Создать запись CRM (в MVP — сделку через crm.deal.add). Поля проверяются по схеме портала (crm_fields_get): неизвестные и read-only отклоняются, обязательные должны быть заполнены. Использовать, когда пользователь явно просит создать сделку. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с operationId и планом — запись ещё не сделана; человек подтверждает план в терминале; повторный вызов с теми же параметрами и approvalId создаёт сделку ровно один раз. dryRun=true только показывает план. Могут сработать роботы и уведомления стадии.

### `crm_fields_get`

Схема полей сущности CRM с портала: имя, тип, обязательность, только-чтение, множественность, варианты списков. Использовать перед crm_create_record и при ошибке VALIDATION_ERROR/UNKNOWN_FIELD, чтобы узнать точные имена и обязательные поля (включая пользовательские UF_CRM_*). В MVP поддерживается только entityType=deal.

### `task_create`

Поставить задачу в Bitrix24 (tasks.task.add) на известного сотрудника. Использовать, когда пользователь явно просит создать задачу и известен ID ответственного (не имя). Срок — ISO 8601 с часовым поясом. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с operationId и планом — задача ещё не создана; человек подтверждает план в терминале; повторный вызов с теми же параметрами и approvalId создаёт задачу ровно один раз. dryRun=true только показывает план. Участники получат уведомления.

### `task_get`

Задача Bitrix24 целиком по ID в рамках доступных полей (tasks.task.get). Использовать, когда известен ID задачи и нужны её поля: название, описание, ответственный, срок, статус, участники, привязки. select ограничивает поля (имена — ВЕРХНИЙ_РЕГИСТР, например TITLE, DEADLINE, RESPONSIBLE_ID). Комментарии и чек-листы — отдельные инструменты полной версии.

### `task_list`

Страница задач Bitrix24 (tasks.task.list) по ответственному, статусу, группе и произвольному фильтру. Использовать, когда нужен список задач по условию: «мои задачи в работе», «задачи проекта», «просроченные». Статус: new, pending (ждёт выполнения), inProgress, awaitingControl, completed, deferred. Ключи filter — ИМЕНА_ПОЛЕЙ с префиксами Bitrix (например {"<DEADLINE": "2026-10-01T00:00:00+03:00"}). До 50 задач за вызов; продолжение — по cursor.

## Запланировано (ТЗ §9, не реализовано)

MVP (этап 9): `chat_send_message`, `disk_upload_file`, `calendar_create_event`. CRM-инструменты выше поддерживают только entityType=deal; лиды/контакты/компании/smart — полная версия.

Полная версия (§11): остальные строки таблиц §9.2–§9.14. Каждый инструмент появляется в разделе «Реализовано» только после кода, схем, тестов и документации; заглушки с `success:true` не допускаются.

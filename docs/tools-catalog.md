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

## Запланировано (ТЗ §9, не реализовано)

MVP (этапы 7–9): `crm_list_records`, `crm_get_record`, `crm_create_record`, `task_create`, `task_get`, `task_list`, `chat_send_message`, `disk_upload_file`, `calendar_create_event`.

Полная версия (§11): остальные строки таблиц §9.2–§9.14. Каждый инструмент появляется в разделе «Реализовано» только после кода, схем, тестов и документации; заглушки с `success:true` не допускаются.

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
| `crm_search_records` | crm | read | true | false | true | да | [json](schemas/crm_search_records.json) |
| `crm_create_record` | crm | create | false | false | false | да | [json](schemas/crm_create_record.json) |
| `crm_update_record` | crm | update | false | false | true | да | [json](schemas/crm_update_record.json) |
| `crm_fields_get` | crm | read | true | false | true | да | [json](schemas/crm_fields_get.json) |
| `crm_stages_and_statuses` | crm | read | true | false | true | да | [json](schemas/crm_stages_and_statuses.json) |
| `task_create` | tasks | create | false | false | false | да | [json](schemas/task_create.json) |
| `task_get` | tasks | read | true | false | true | да | [json](schemas/task_get.json) |
| `task_list` | tasks | read | true | false | true | да | [json](schemas/task_list.json) |
| `calendar_create_event` | calendar | create | false | false | false | да | [json](schemas/calendar_create_event.json) |
| `chat_send_message` | chat | create | false | false | false | да | [json](schemas/chat_send_message.json) |
| `disk_upload_file` | disk | upload | false | false | false | да | [json](schemas/disk_upload_file.json) |

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

Страница записей CRM (сделки, лиды, контакты, компании) с фильтром, сортировкой и выбором полей. Использовать, когда нужен список записей по условию: стадия, ответственный, даты, часть названия. Ключи фильтра — как в Bitrix24: ИМЯ_ПОЛЯ с префиксом (=, %, >, <, >=, <=, !, @, ><), например {">=DATE_CREATE": "2026-09-01", "%TITLE": "договор"}. Поля проверяются по схеме портала (crm_fields_get). Одна страница до 50 записей; продолжение — по cursor из ответа. Смарт-процессы (entityType=smart) появятся отдельным срезом.

### `crm_get_record`

Карточка записи CRM (сделка, лид, контакт, компания) по ID в рамках доступных полей. Использовать, когда известен ID и нужны поля записи. Возвращает stateHash для последующих изменений (expectedStateHash в crm_update_record). Связанные блоки (дела, комментарии, товары, реквизиты) через include появятся следующими срезами; бинарные вложения не скачиваются.

### `crm_search_records`

Найти записи CRM по части названия/имени (query), телефону (phone) или email. Использовать, когда пользователь называет клиента словами, а не ID: «найди компанию Ромашка», «есть ли контакт с телефоном…». Возвращает кандидатов с основанием совпадения — выбор среди них делает пользователь. Телефон/email ищутся среди лидов, контактов и компаний (сделки — только по названию). Запрос короче 3 символов отклоняется как слишком широкий.

### `crm_create_record`

Создать запись классического CRM: сделку, лид, контакт или компанию (crm.<entity>.add). Поля проверяются по схеме портала (crm_fields_get): неизвестные и read-only отклоняются, обязательные должны быть заполнены, стадия/статус — по справочнику. Использовать, когда пользователь явно просит создать запись. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с operationId и планом — запись ещё не сделана; человек подтверждает план (CLI или панель); повторный вызов с теми же параметрами и approvalId создаёт запись ровно один раз. dryRun=true только показывает план. Могут сработать роботы и уведомления.

### `crm_update_record`

Изменить поля записи классического CRM (сделка, лид, контакт, компания) через crm.<entity>.update. Использовать, когда пользователь явно просит изменить конкретные поля существующей записи; передавайте только изменяемые поля. Рекомендуется expectedStateHash из crm_get_record: при изменении записи кем-то ещё будет CONFLICT, а не тихая перезапись. Стадия/статус проверяются по справочнику портала. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом (diff «было → станет»); человек подтверждает; повторный вызов с теми же параметрами и approvalId применяет изменение один раз.

### `crm_fields_get`

Схема полей сущности CRM (сделка, лид, контакт, компания) с портала: имя, тип, обязательность, только-чтение, множественность, варианты списков. Использовать перед crm_create_record/crm_update_record и при ошибке VALIDATION_ERROR/UNKNOWN_FIELD, чтобы узнать точные имена и обязательные поля (включая пользовательские UF_CRM_*).

### `crm_stages_and_statuses`

Воронки, стадии и справочники CRM с их ID. Использовать перед созданием/изменением записи, чтобы взять точный STAGE_ID/STATUS_ID или значение справочника (тип контакта, сфера компании, источник). Без аргументов — перечень всех справочников портала; entityType=deal — воронки и стадии (categoryId выбирает воронку, по умолчанию общая); entityType=lead — статусы лида; statusEntityId — конкретный справочник, например SOURCE или DEAL_STAGE_5.

### `task_create`

Поставить задачу в Bitrix24 (tasks.task.add) на известного сотрудника. Использовать, когда пользователь явно просит создать задачу и известен ID ответственного (не имя). Срок — ISO 8601 с часовым поясом. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с operationId и планом — задача ещё не создана; человек подтверждает план в терминале; повторный вызов с теми же параметрами и approvalId создаёт задачу ровно один раз. dryRun=true только показывает план. Участники получат уведомления.

### `task_get`

Задача Bitrix24 целиком по ID в рамках доступных полей (tasks.task.get). Использовать, когда известен ID задачи и нужны её поля: название, описание, ответственный, срок, статус, участники, привязки. select ограничивает поля (имена — ВЕРХНИЙ_РЕГИСТР, например TITLE, DEADLINE, RESPONSIBLE_ID). Комментарии и чек-листы — отдельные инструменты полной версии.

### `task_list`

Страница задач Bitrix24 (tasks.task.list) по ответственному, статусу, группе и произвольному фильтру. Использовать, когда нужен список задач по условию: «мои задачи в работе», «задачи проекта», «просроченные». Статус: new, pending (ждёт выполнения), inProgress, awaitingControl, completed, deferred. Ключи filter — ИМЕНА_ПОЛЕЙ с префиксами Bitrix (например {"<DEADLINE": "2026-10-01T00:00:00+03:00"}). До 50 задач за вызов; продолжение — по cursor.

### `calendar_create_event`

Создать одиночное событие или встречу в календаре Bitrix24 (calendar.event.add). Использовать, когда известны тип и владелец календаря (type=user + ownerId сотрудника, или group/company) и sectionId раздела. Даты — ISO 8601 с явным смещением (2026-10-01T10:00:00+03:00), timezone — IANA-зона (по умолчанию зона портала из конфигурации). allDay=true — даты YYYY-MM-DD. Участники (attendeeIds) получат приглашения. Повторяющиеся события не поддерживаются. Порядок: без approvalId — APPROVAL_REQUIRED с планом; после подтверждения тот же вызов с approvalId создаёт событие ровно один раз.

### `chat_send_message`

Отправить одно сообщение в известный диалог Bitrix24 от имени владельца интеграции (im.message.add). dialogId — числовой ID сотрудника для личного диалога или chat<id> для группового чата; из имён он не выводится. Использовать только когда пользователь явно просит написать в конкретный чат и dialogId известен. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом (диалог, название, полный текст) — сообщение ещё не отправлено; после подтверждения человеком повторный вызов с approvalId отправляет ровно один раз.

### `disk_upload_file`

Загрузить подготовленный файл в папку Диска Bitrix24 (disk.folder.uploadFile). Использовать, когда пользователь просит положить файл в известную папку. Файл готовит человек: `npm run file:stage -- --path <файл в UPLOAD_ROOT>` даёт fileToken; для маленького тестового файла допустим inline base64 (до 256 КиБ). Пути на сервере и URL для скачивания не принимаются. conflictPolicy: error — при совпадении имени отказ; rename — портал добавит суффикс. Порядок: без approvalId — APPROVAL_REQUIRED с планом (папка, имя, размер, sha256); после подтверждения тот же вызов с approvalId загружает ровно один раз. Публичные ссылки не создаются.

## Запланировано (ТЗ §9, не реализовано)

Все 11 инструментов MVP (ТЗ §10.1) реализованы. CRM-инструменты выше поддерживают только entityType=deal; лиды/контакты/компании/smart — полная версия.

Полная версия (§11): остальные строки таблиц §9.2–§9.14. Каждый инструмент появляется в разделе «Реализовано» только после кода, схем, тестов и документации; заглушки с `success:true` не допускаются.

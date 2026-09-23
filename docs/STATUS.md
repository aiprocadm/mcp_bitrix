# Состояние работ по ТЗ «MCP-сервер для Bitrix24»

Точка входа для команды **«продолжай по ТЗ»**. Правила — `CLAUDE.md`. ТЗ — `docs/TZ.md` (план этапов в §22).

## Текущее положение

|                       |                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Дата обновления       | 2026-09-23 (срез 3)                                                                                       |
| Последний влитый срез | срез 2, PR #2 (этапы 1–6); срез 3 (этап 7) — в PR                                                         |
| Текущий этап          | **8. MVP task tools** (`task_create`, `task_get`, `task_list` через `tasks.task.*` legacy, scope `task`)  |
| Следующие             | 8 (task tools), 9 (chat/calendar/disk), 10 (сводные тесты), 11 (README/инструкции), 12 (сервер и ChatGPT) |
| Реальный портал       | не подключался; все проверки — на mock (см. `docs/acceptance-report.md`)                                  |

## Этапы (ТЗ §22)

| №   | Этап                       | Статус       | Где                                                                                                                                       |
| --- | -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Инициализация проекта      | ✅ 23.09     | `package.json`, `docs/adr/0001-stack-and-versions.md`                                                                                     |
| 2   | Конфигурация и логирование | ✅ 23.09     | `src/config/`, `src/logging/`, `src/security/redaction.ts`, `src/storage/`, `npm run setup`                                               |
| 3   | Bitrix API client          | ✅ 23.09     | `src/bitrix/` (webhook provider, legacy/v3 адаптеры, ошибки, лимитер, retry, пагинация с курсорами)                                       |
| 4   | MCP server bootstrap       | ✅ 23.09     | `src/mcp/` (stdio, Streamable HTTP через Fastify-адаптер, реестр, envelope)                                                               |
| 5   | Diagnostic tools           | ✅ 23.09     | `src/tools/system/` — 5 инструментов; `npm run doctor`, `bitrix:profile`, `mcp:smoke`                                                     |
| 6   | Политика записи            | ✅ 23.09     | `src/security/mutation-executor.ts`, `approval-service.ts`, `idempotency.ts`, `src/files/`, `src/cli/approval-review.ts`, `file-stage.ts` |
| 7   | MVP CRM tools              | ✅ 23.09     | `src/tools/crm/`: `crm_list_records`, `crm_get_record`, `crm_create_record`, `crm_fields_get` (entityType=deal)                           |
| 8   | MVP task tools             | ⏳ следующий | `task_create`, `task_get`, `task_list`; `src/tools/tasks/`                                                                                |
| 9   | MVP chat/calendar/disk     | —            | `chat_send_message`, `calendar_create_event`, `disk_upload_file`                                                                          |
| 10  | Тесты (сводно)             | —            | T01…T48 — что уже покрыто, см. ниже                                                                                                       |
| 11  | README и инструкции        | частично     | README, setup, webhook, claude-code написаны; Windows/Desktop/troubleshooting/backup — дополнить                                          |
| 12  | Сервер и ChatGPT           | —            | HTTP production, OAuth MCP, панель, сканер                                                                                                |
| 13  | Полная версия              | —            | §11 ТЗ                                                                                                                                    |
| 14  | Destructive-функции        | —            | §9, последняя очередь                                                                                                                     |

## Что именно сделано (срез 3, этап 7)

- `src/tools/crm/deal-fields.ts` — metadata-validator по `crm.deal.fields` (кэш 5 мин через `capabilities.getCached`): `fields` для записи (неизвестные/read-only/immutable поля отклоняются, обязательные проверяются при создании — T31 с именем и заголовком поля, типы нормализуются: ID→число, Y/N, даты ISO, enumeration по items, множественные — массив), `filter` (префиксы Bitrix `=,%,>,<,>=,<=,!,@,!@,><,!><,!%`, диапазон — ровно два значения, только известные поля, без объектов/формул), `order`, `select`.
- `src/tools/crm/deal-service.ts` — `listDeals` через `paginateLegacy` (курсор привязан к filter/order/select/pageSize), `getDeal` (+ `stateHash` для будущих update), `createDeal` (ответ без ID → `OPERATION_OUTCOME_UNKNOWN`), `compareKeyFields` для сверки §15.3.
- Инструменты: `crm_fields_get` (схема с списком обязательных), `crm_list_records` (страница ≤50, cursor, `upstreamTotal`, `completeness`), `crm_get_record` (карточка + `stateHash`, NOT_FOUND без раскрытия), `crm_create_record` (dryRun → план `local+metadata`; без approvalId → `APPROVAL_REQUIRED` с планом: портал, `crm.deal.add`, все поля, риски про роботов/воронку/стадию/ответственного; с approvalId → одна запись; verify: `crm.deal.get` по ID и сверка TITLE/CATEGORY_ID/STAGE_ID/ASSIGNED_BY_ID/OPPORTUNITY/CURRENCY_ID, расхождения — warnings). В MVP `entityType` только `deal` (литерал в схеме, §10.2).
- Тесты: +20 (139 всего): валидатор (типы, T31, фильтры/инъекции, order/select), интеграция через MCP-клиент (T20/T21 через инструмент, VALIDATION_ERROR до сети, T47 на списке, NOT_FOUND, скрытие create в read-only, dryRun, полный путь APPROVAL_REQUIRED→approve→запись→сверка→T13 replay, робот сменил стадию → warning, ответ без ID → unknown).
- Урок среза: тест диапазонного фильтра поймал дыру — `><` принимал массив из одного значения; теперь ровно два.

## Что именно сделано (срез 2, этап 6)

- `MutationExecutor` (`src/security/mutation-executor.ts`) — единственная точка записи. Порядок: аудит доступен → dryRun (только план) → idempotencyKey обязателен → повтор по ключу (replay / unknown / conflict / тот же план) → без approvalId `APPROVAL_REQUIRED` с operationId и планом → с approvalId сверка principal/portal/tool/argsHash/policyVersion/stateHash/fileHash/ключа, атомарный переход approved→executing, precheck (CONFLICT), perform, verify, результат в ledger (зашифрован). Одновременные вызовы с одним ключом делят одно выполнение (T08). Лимит 10 подготовок/мин на оператора.
- `ApprovalService` — prepare/readPlan/approve/deny/listPending; планы в SQLite зашифрованы (AES-GCM, AAD = operationId), TTL 10 мин.
- Ledger (`storage/operations.ts`): состояния prepared→approved→executing→succeeded/failed/unknown, denied, expired; после рестарта executing→unknown (T16); таблица idempotency с TTL 7 дней.
- Файлы (`src/files/`): `file:stage` только из UPLOAD_ROOT (realpath, без симлинков, без `.env`/ключей/хранилищ), allowlist расширений + проверка сигнатур, лимиты 10 MiB / 256 KiB inline, копия в STAGING_DIR (0600), sha256, TTL 24 ч, сверка хеша перед отправкой (T26); при `UPLOAD_SCAN_REQUIRED=true` загрузка блокируется до интеграции сканера (этап 12).
- CLI: `npm run approval:review -- --id <id>` (план целиком, ввод слова ПОДТВЕРЖДАЮ/ОТКЛОНЯЮ, без `--yes`, отказ без TTY), `--list`; `npm run file:stage -- --path <абс. путь>`.
- Общие схемы записи (`src/schemas/common.ts`): `dryRun`, `idempotencyKey` (обязателен без dryRun), `approvalId`, `expectedStateHash`.
- `ToolContext` получил `mutations` и `files`; MVP-инструменты этапов 7–9 обязаны идти через `ctx.mutations.execute(...)` с `summary` по §15.3.
- Тесты: +29 (119 всего). Покрыты T08, T09, T12, T13, T14, T15, T16, T25, T26, T27, T44-для-записи, отказ CLI без TTY, лимит подготовок.
- Попутно: редактор секретов больше не принимает хеши/даты/UUID за телефоны (ломало вывод CLI); тест T42 сам создаёт ключ шифрования (не зависит от `npm run setup`).

## Что именно сделано (срез 1, этапы 1–5)

- Стек: Node 24.18, TS 5.9, MCP SDK v2 2.0.0 (server/node/fastify/client), Zod 4, Fastify 5, Pino, `node:sqlite`. Причины — ADR-0001.
- Конфигурация: строгая Zod-схема всех переменных `.env.example`, булевы только `true|false` (T02), относительные пути от каталога `.env`, опасные сочетания блокируют старт (T01), секреты регистрируются в редакторе.
- Хранилище: SQLite WAL + миграции; таблицы operations/idempotency/cursors/audit/oauth_tokens/file_manifests/capabilities_cache; AES-256-GCM ключ в `data/secrets/master.key` (0600).
- Клиент Bitrix: единственная точка сети; allowlist host; таймаут/бюджет; retry только чтения (500 мс→8 с, jitter, Retry-After); мутации без повторов, потеря ответа → `OPERATION_OUTCOME_UNKNOWN` (T07); лимитер 1 rps/2 concurrency/очередь 100; ограничение ответа; редиректы запрещены; один refresh при 401.
- Пагинация: серверные курсоры (случайный ключ, TTL, HMAC-привязка к principal/portal/tool/filter, одноразовые, зашифрованное состояние); буферизация остатка upstream-страницы (T20/T21).
- MCP: envelope `{success,data,meta}`/`{success:false,error}` (§14.4), `structuredContent` + text fallback + `isError`; SDK валидирует output; усечение по байтам с `completeness=partial`; политика выдачи применяется ко всем ответам (T47); аудит каждого вызова.
- Инструменты: `bitrix_connection_info`, `bitrix_server_version`, `bitrix_capabilities`, `bitrix_rest_call` (allowlist из `policies/methods.json`, только чтение, T11), `operation_status`.
- Транспорты: stdio (stdout только MCP, T42) и Streamable HTTP (loopback, сессии, `/healthz`, `/readyz`, Host/Origin защита T40).
- CLI: `setup`, `doctor [--offline]`, `bitrix:profile`, `mcp:smoke --transport stdio|http`, `schemas:export`, `check:secrets`.
- Тесты: 90 (unit/contract/integration/security), без сети. Покрыты: T01, T02, T03, T04, T06, T07, T10 (на тестовом write-инструменте), T11, T19, T20, T21, T40, T41 (оба транспорта), T42, T44, T47, частично T17 (refresh-логика клиента).

## Что НЕ сделано / ограничения

- Из 11 MVP-инструментов есть 5 системных + 3 CRM (`crm_list_records`, `crm_get_record`, `crm_create_record`) и вспомогательный `crm_fields_get`; остались `task_*` (этап 8), `chat_send_message`, `disk_upload_file`, `calendar_create_event` (этап 9). Образец write-инструмента — `src/tools/crm/create-record.ts`.
- `crm_get_record` без `include` (дела/комментарии/товары) — полная версия; `crm_search_records`, `crm_update_record` — полная версия.
- Антивирусный сканер staged-файлов не интегрирован: `UPLOAD_SCAN_REQUIRED=true` блокирует загрузку честно (этап 12).
- OAuth (Bitrix и MCP) — конфигурация принимает поля, но режимы `oauth` намеренно блокируются `CONFIG_INVALID` до этапов 12/13.
- REST 3.0 адаптер написан и покрыт unit-тестами, но форму ответов нужно сверить с OpenAPI реального портала (`rest.documentation.openapi`) — пометка `unchecked` в `bitrix_capabilities`.
- Реальный портал не подключался: `doctor` без `--offline`, `bitrix:profile` и `test:live` на живом портале — `not-run`.

## Грабли (чтобы не наступать дважды)

- `npm install` не запускает postinstall esbuild (политика allowScripts) → `tsx` не работает. Решено записью `allowScripts` в `package.json`; при чистой установке выполнять `npm ci` — она её учитывает.
- SDK v2 не экспортирует `package.json` через `exports` — версию читаем файлом (`src/version.ts`).
- `dist/` нужно пересобирать перед `mcp:smoke --transport stdio`: smoke предпочитает `dist/index.js`, если он есть.
- Политика выдачи сопоставляет имена полей **с учётом регистра**: шаблон `^AUTH` для Bitrix-полей не должен вырезать наше `authMode`.
- `fetch` в Node не даёт подменить заголовок `Host` — тест DNS-rebinding идёт через `node:http`.
- `fastify.close()` виснет на открытых SSE-соединениях — перед закрытием `server.closeAllConnections()`.
- Vitest: `console.log` в тестах не показывается в кратком выводе; для отладки писать в файл.
- Guard worktree в этой среде отклоняет сложные bash-команды с `cd`/heredoc/переменными в путях/конвейерами — файлы писать инструментом Write, команды разбивать, пути писать буквально.
- Прямая проверка «CLI не принимает ввод через pipe» из bash невозможна (guard) — она живёт тестом `tests/security/approval-cli-no-tty.test.ts`, который сам запускает CLI.
- `data/` не в git: тесты, запускающие настоящий процесс, обязаны сами создавать ключ (`ensureMasterKey(..., {create:true})`), иначе на чистой копии `CONFIG_INVALID`.
- Редактор секретов применяется и к выводу CLI (`out()`): слишком широкий шаблон «телефона» ломал хеши и даты. Любой новый шаблон проверять на sha256/ISO-дате/UUID.
- После squash-слияния PR ветка worktree расходится с `main` — новый срез начинать в новом worktree от `origin/main`, старый не трогать из-под guard.

## Открытые вопросы владельцу (не блокируют код)

Список ТЗ §3.3: адрес портала, тариф/REST, машина запуска, сотрудник-владелец вебхука, тестовые объекты (воронка/стадия, ответственный, чат, папка Диска, календарь). До ответа записи не включать.

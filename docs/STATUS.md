# Состояние работ по ТЗ «MCP-сервер для Bitrix24»

Точка входа для команды **«продолжай по ТЗ»**. Правила — `CLAUDE.md`. ТЗ — `docs/TZ.md` (план этапов в §22).

## Текущее положение

|                       |                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Дата обновления       | 2026-09-24 (срез 7)                                                                                                                                                                                                                                   |
| Последний влитый срез | срез 6, PR #6 (этапы 1–10); срез 7 (этап 11) — в PR                                                                                                                                                                                                   |
| Текущий этап          | **12. Сервер и ChatGPT**: HTTP production (`MCP_AUTH_MODE=oauth`, JWT/JWKS по `MCP_AUTH_*`, allowlist субъектов, роли), reverse proxy, панель подтверждений /admin, web-upload, сканер staged-файлов, remote smoke; ChatGPT — только после публикации |
| Следующие             | 13 (полная версия §11), 14 (destructive)                                                                                                                                                                                                              |
| Реальный портал       | не подключался; все проверки — на mock (см. `docs/acceptance-report.md`)                                                                                                                                                                              |

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
| 8   | MVP task tools             | ✅ 23.09     | `src/tools/tasks/`: `task_create`, `task_get`, `task_list` (legacy `tasks.task.*`, схема из `tasks.task.getfields`)                       |
| 9   | MVP chat/calendar/disk     | ✅ 23.09     | `src/tools/chat/send-message.ts`, `src/tools/calendar/create-event.ts` (+ `time.ts`), `src/tools/disk/upload-file.ts`                     |
| 10  | Тесты (сводно)             | ✅ 23.09     | `docs/acceptance-report.md` — полная таблица T01–T48 и §20.1–20.3; `npm run test:live` (`src/live/scenario.ts`); T23, T43, HTTP-курсор    |
| 11  | README и инструкции        | ✅ 24.09     | все документы §12: + `claude-desktop`, `chatgpt`, `deployment`, `operations`, `bitrix-oauth`; `npm run backup` (T45); compose усилен      |
| 12  | Сервер и ChatGPT           | ⏳ следующий | HTTP production + OAuth MCP, панель, web-upload, сканер, remote smoke; ChatGPT blocked до публикации                                      |
| 13  | Полная версия              | —            | §11 ТЗ                                                                                                                                    |
| 14  | Destructive-функции        | —            | §9, последняя очередь                                                                                                                     |

## Что именно сделано (срез 7, этап 11)

- Резервная копия (§8.6, §17.7, T45): `src/ops/backup.ts` + `npm run backup` (`src/cli/backup.ts`). Снимок SQLite через `VACUUM INTO` (согласован независимо от WAL) + три файла политик в одном JSON, зашифрованном AES-256-GCM ключом из `SECRETS_KEY_FILE` (AAD `bitrix24-mcp-backup:1`, файл `0600`, поверх существующего не пишем). Ключ и `.env` в копию НЕ входят намеренно. `--restore <файл> --to <новая папка>`: расшифровка, sha256 базы, запись только в новую папку, база открывается read-only и считаются незавершённые операции (prepared/approved/executing/unknown) — они не исполняются. Тесты `tests/unit/backup.test.ts` (3): roundtrip с pending операцией, чужой ключ/мусор/существующая папка/повтор `--out` — отказ, без базы — ошибка. CLI прогнан вживую на mock-профиле.
- Документы §12 все на месте: `docs/claude-desktop.md` (§18.1), `docs/chatgpt.md` (§18.4–18.5, честно `blocked` до этапа 12 + алгоритм проверки в аккаунте + таблица обходных вариантов), `docs/deployment.md` (§17.6, только loopback + SSH-туннель до этапа 12, заготовка nginx), `docs/operations.md` (копии/восстановление, обновление/откат, ротация вебхука и реакция на утечку по §17.7, retention, мониторинг), `docs/bitrix-oauth.md` (§6.2 — не реализовано, план этапа 13). README: команда `backup`, ссылки на новые документы; `docs/troubleshooting.md`: +5 строк (test:live, backup, compose).
- `compose.yaml` усилен: `user: mcp`, `read_only`, `tmpfs /tmp`, `cap_drop ALL`, `no-new-privileges`, healthcheck без curl, ротация логов. **Найденный дефект**: прежний профиль задавал `MCP_HOST=0.0.0.0` при `MCP_AUTH_MODE=local` — конфигурация это отвергает (`CONFIG_INVALID`), контейнер бы не стартовал. Решение до этапа 12: `network_mode: host` + `MCP_HOST=127.0.0.1`, порт наружу не публикуется, владелец — через SSH-туннель.
- Живая проверка compose на этом сервере (Docker есть): найдены и починены ещё два дефекта — (а) `ENTRYPOINT ["node","dist/index.js"]` превращал `docker compose run … node dist/cli/setup.js` в запуск сервера с чужими аргументами (`CONFIG_INVALID`/`INTERNAL_ERROR`), теперь только полный `CMD`; (б) рабочие политики искались рядом с `.env` в папке `config`, смонтированной только для чтения, — теперь `*_POLICY_FILE` указывают в том `mcp-data`, а `setup` берёт примеры из `/app/policies`, если рядом с `.env` их нет. Порядок в инструкции исправлен: `setup` и `doctor` одноразовым контейнером ДО `up -d` (без ключа сервер не стартует и уходит в перезапуск). `MCP_PORT` в compose настраиваемый (3000 на хосте бывает занят). Не проверено: реальный портал из контейнера, проход документации новичком.
- Тесты: +3 (180).

## Что именно сделано (срез 6, этап 10)

- `docs/acceptance-report.md` переписан целиком: §20.1 по каждому критерию со средой и доказательством, §20.2/§20.3, полная таблица T01–T48 (passed/mock/not-run/blocked/n/a — без пустых строк).
- Живой сценарий §10.3: `src/live/scenario.ts` + `npm run test:live` (`src/cli/live-smoke.ts`). Только при `LIVE_TESTS_ENABLED=true`; `--read-only` (connection info, profile через raw, capabilities методов MVP с пометкой blocked, 5 сделок, одна сделка, 5 задач); `--write --prepare` (пять планов с `LIVE_TEST_PREFIX`, operationId в JSON-отчёт `data/live-smoke-report.json`); `--write --execute` (те же аргументы с approvalId, затем повтор ключа → replay). Удаления нет. Сценарий проверен на mock (`tests/integration/live-smoke.test.ts`): без флага отказ, без подтверждения — blocked и ни одного write, после подтверждения — 5 объектов по одному разу.
- `doctor`: список MVP-методов расширен до всех 21 метода, которые вызывают 11 инструментов (включая `tasks.task.getfields`, `im.dialog.get`, `disk.folder.get`, `calendar.section.get`, `calendar.event.getbyid`).
- Тесты: +7 (177): T23 (инструкция в TITLE — данные, лишних вызовов нет), T43 (`ENABLED_MODULES=system,crm` отключает только чужие инструменты), HTTP: курсор списка сделок между двумя сессиями одного оператора, live-smoke на mock.
- Итог этапа: блокирующих дефектов на mock не найдено; все пункты реальной интеграции остаются `not-run` до портала заказчика.

## Что именно сделано (срез 5, этап 9)

- `chat_send_message` (`src/tools/chat/send-message.ts`): `dialogId` только `\d+` или `chat\d+`; план из `im.dialog.get` (тип, название, участники) + полный текст; `im.message.add` от владельца вебхука; verify — `im.dialog.messages.get` (LIMIT 20), не найдено/недоступно → `verified=false`.
- `calendar_create_event` (`src/tools/calendar/create-event.ts`, `time.ts`): ISO с явным смещением + IANA-зона (по умолчанию `DEFAULT_TIMEZONE`, проверка по `Intl.supportedValuesOf`), `to > from`, ≤31 дня, `allDay` → YYYY-MM-DD/`skip_time=Y`; `sectionId` сверяется с `calendar.section.get`; в Bitrix идут `from_ts/to_ts`, `timezone_from/to`, `is_meeting/attendees/host`; verify — `calendar.event.getbyid`: название, даты «DD.MM.YYYY HH:MM:SS» в TZ_FROM → момент (DST учтён), участники.
- `disk_upload_file` (`src/tools/disk/upload-file.ts`): ровно один источник — `fileToken` (staging) или inline base64; `disk.folder.get` + проверка имени через `disk.folder.getchildren` (`error`/`rename`); аргументы хеша — по содержимому (`fileSha256`, `fileSize`), `fileHash` в подтверждении; `readVerified` перед отправкой (T26); `disk.folder.uploadfile` (`fileContent`, `generateUniqueName`); verify — `disk.file.get` по размеру; наружу только `DETAIL_URL`; precheck на появившееся имя.
- Каталог: 15 инструментов; все 11 MVP из §10.1 есть.
- Тесты: +16 (170). Покрыты: T28 полностью (DST, all-day), T26 на Диске, отказ до плана по dialogId/датам/зоне/папке/имени/расширению, полные пути с replay для всех трёх, скрытие в read-only.
- Открытые сверки на живом портале: приём `from_ts/to_ts` в `calendar.event.add` (документированы, но не проверены), формат дат `getbyid`, поле `user_counter` в `im.dialog.get`, форма ответа `disk.folder.uploadFile`.

## Что именно сделано (срез 4, этап 8)

- Реестр: `tasks.task.getfields` (legacy, scope `task`; в документации имя `getFields`, REST регистрирует в нижнем регистре — сверить `bitrix_capabilities` на живом портале).
- `src/tools/tasks/task-fields.ts` — валидатор по `tasks.task.getfields` (`primary`→read-only, `required`, `values`→enum; серверные поля CREATED_DATE/STATUS_CHANGED_* и т. п. запрещены к записи), дата-время только с явной зоной (`TIMEZONE_REQUIRED`), статусы `new/pending/inProgress/awaitingControl/completed/deferred` ↔ коды 1–6, привязки CRM `D_/L_/C_/CO_<id>`.
- `src/tools/tasks/task-service.ts` — `listTasks` (курсоры; `result.tasks[]` camelCase, `next/total` сверху), `getTask` (`result.task`), `createTask` (без `task.id` → `OPERATION_OUTCOME_UNKNOWN`), `compareTask` (ответственный + срок как момент времени + название), `taskBrief`.
- Инструменты: `task_list` (responsibleId/createdBy/groupId/status + filter/order/select в UPPER_CASE; в ответе `statusName`), `task_get` (brief + полная задача), `task_create` (title, responsibleId, description, deadline с зоной и не в прошлом, groupId, auditorIds, accompliceIds, crmBindings, customFields UF_*; план: `tasks.task.add`, зона портала, поля, риски про уведомления/группу/CRM; verify: `tasks.task.get` по ID с select и сверка).
- Тесты: +15 (154 всего): валидатор (getfields, запись, T28 зона, фильтры, привязки, сверка), интеграция через MCP-клиент (list 50→3 страницы с UPPER_CASE в запросе и camelCase в ответе, отказ до портала, get/NOT_FOUND, скрытие create в read-only, VALIDATION_ERROR до плана, dryRun, полный путь с replay, подмена ответственного → verified=false, ответ без id → unknown).
- Грабля legacy `tasks.task.*`: запрос — `RESPONSIBLE_ID`, ответ — `responsibleId`; мок и валидатор это учитывают, при первом живом подключении сверить форму `tasks.task.get` (поле `task`).

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

- Все 11 MVP-инструментов §10.1 реализованы (плюс `crm_fields_get`, `task_list` и т. п. — 15 в каталоге). Ни один не проверен на реальном портале. Образцы write-инструментов — `src/tools/crm/create-record.ts`, `src/tools/tasks/task-create.ts`, `src/tools/disk/upload-file.ts`.
- Живой smoke-сценарий §10.3 написан (`npm run test:live`), на портале не запускался — need портал заказчика.
- `task_get` без `include` (чек-листы/комментарии), `task_update`/`task_complete`/`task_delete` — полная версия.
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
- `MCP_HOST=0.0.0.0` при `MCP_AUTH_MODE=local` отвергается конфигурацией — compose-профиль до этапа 12 живёт на `network_mode: host` с `127.0.0.1`; проверять `docker compose config` и реальный старт, а не только YAML. Docker на сервере доступен без sudo — compose гонять вживую (`MCP_PORT=3123`, порт 3000 хоста занят), одноразовые команды — `docker compose run --rm <service> node dist/cli/<cli>.js`, ENTRYPOINT в Dockerfile не ставить.
- После squash-слияния PR ветка worktree расходится с `main` — новый срез начинать в новом worktree от `origin/main`, старый не трогать из-под guard.

## Открытые вопросы владельцу (не блокируют код)

Список ТЗ §3.3: адрес портала, тариф/REST, машина запуска, сотрудник-владелец вебхука, тестовые объекты (воронка/стадия, ответственный, чат, папка Диска, календарь). До ответа записи не включать.

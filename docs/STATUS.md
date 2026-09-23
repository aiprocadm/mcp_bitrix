# Состояние работ по ТЗ «MCP-сервер для Bitrix24»

Точка входа для команды **«продолжай по ТЗ»**. Правила — `CLAUDE.md`. ТЗ — `docs/TZ.md` (план этапов в §22).

## Текущее положение

|                       |                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Дата обновления       | 2026-09-23                                                                                                               |
| Последний влитый срез | — (первый PR открыт, см. ниже)                                                                                           |
| Текущий этап          | **6. Политика записи** (MutationExecutor, approval CLI, idempotency ledger, файловый staging)                            |
| Следующие             | 7 (CRM tools), 8 (task tools), 9 (chat/calendar/disk), 10 (сводные тесты), 11 (README/инструкции), 12 (сервер и ChatGPT) |
| Реальный портал       | не подключался; все проверки — на mock (см. `docs/acceptance-report.md`)                                                 |

## Этапы (ТЗ §22)

| №   | Этап                       | Статус       | Где                                                                                                                         |
| --- | -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Инициализация проекта      | ✅ 23.09     | `package.json`, `docs/adr/0001-stack-and-versions.md`                                                                       |
| 2   | Конфигурация и логирование | ✅ 23.09     | `src/config/`, `src/logging/`, `src/security/redaction.ts`, `src/storage/`, `npm run setup`                                 |
| 3   | Bitrix API client          | ✅ 23.09     | `src/bitrix/` (webhook provider, legacy/v3 адаптеры, ошибки, лимитер, retry, пагинация с курсорами)                         |
| 4   | MCP server bootstrap       | ✅ 23.09     | `src/mcp/` (stdio, Streamable HTTP через Fastify-адаптер, реестр, envelope)                                                 |
| 5   | Diagnostic tools           | ✅ 23.09     | `src/tools/system/` — 5 инструментов; `npm run doctor`, `bitrix:profile`, `mcp:smoke`                                       |
| 6   | Политика записи            | ⏳ следующий | `src/security/mutation-executor.ts`, `approval-service.ts`, `idempotency.ts`, `src/cli/approval-review.ts`, `file-stage.ts` |
| 7   | MVP CRM tools              | —            | `crm_list_records`, `crm_get_record`, `crm_create_record` (entityType=deal)                                                 |
| 8   | MVP task tools             | —            | `task_create`, `task_get`, `task_list`                                                                                      |
| 9   | MVP chat/calendar/disk     | —            | `chat_send_message`, `calendar_create_event`, `disk_upload_file`                                                            |
| 10  | Тесты (сводно)             | —            | T01…T48 — что уже покрыто, см. ниже                                                                                         |
| 11  | README и инструкции        | частично     | README, setup, webhook, claude-code написаны; Windows/Desktop/troubleshooting/backup — дополнить                            |
| 12  | Сервер и ChatGPT           | —            | HTTP production, OAuth MCP, панель, сканер                                                                                  |
| 13  | Полная версия              | —            | §11 ТЗ                                                                                                                      |
| 14  | Destructive-функции        | —            | §9, последняя очередь                                                                                                       |

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

- Ни одной записи в Bitrix пока нет: подтверждения (§8.2), idempotency ledger и staging файлов — этап 6.
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
- Guard worktree в этой среде отклоняет сложные bash-команды с `cd`/heredoc/переменными в путях — файлы писать инструментом Write, команды разбивать.

## Открытые вопросы владельцу (не блокируют код)

Список ТЗ §3.3: адрес портала, тариф/REST, машина запуска, сотрудник-владелец вебхука, тестовые объекты (воронка/стадия, ответственный, чат, папка Диска, календарь). До ответа записи не включать.

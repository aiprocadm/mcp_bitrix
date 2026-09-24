# Отчёт проверки (ТЗ §20)

Обновлено: 2026-09-23, срез 6 (этапы 1–10). Среда: Linux x64, Node 24.18.0, без доступа к реальному порталу.

Статусы: `passed` — проверено в этой среде; `mock` — проверено на имитации Bitrix24 с реальной формой ответов
(портал не участвовал); `not-run` — не выполнялось; `blocked` — невозможно без внешнего условия
(портал заказчика, HTTPS-домен, аккаунт ChatGPT); `n/a` — не относится к текущему объёму (полная версия).

Как воспроизвести: `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run check:secrets`,
затем `npm run mcp:smoke -- --transport stdio --config tests/fixtures/mock.env` и `-- --transport http`.
На портале заказчика: `npm run doctor`, затем `npm run test:live -- --read-only`, затем `--write --prepare` →
`approval:review` по каждому плану → `--write --execute` (см. `docs/setup-linux.md`).

## Приёмка MVP (§20.1)

| Критерий                      | Статус  | Среда                      | Доказательство                                                                                                                                                                   |
| ----------------------------- | ------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Чистая установка и запуск     | passed  | Linux, Node 24.18          | `npm ci`, `lint`, `typecheck`, `test` (177), `build`, `prettier --check` — код 0                                                                                                 |
| MCP-клиент видит tools        | passed  | stdio, HTTP, InMemory      | `mcp:smoke` оба транспорта; `tests/integration/mcp-inmemory.test.ts`, `http.test.ts` (две сессии, курсор), `security/stdout-purity.test.ts`                                      |
| Connection info корректен     | mock    | InMemory                   | `bitrix_connection_info`: origin без секрета, пользователь из `profile`, scope; секрет/e-mail/телефон отсутствуют в ответе                                                       |
| Raw REST работает безопасно   | mock    | InMemory                   | `profile` проходит; `crm.deal.add`, `batch`, casing, path, `auth` в params, метод вне allowlist — отказ до сети (T11, 0 вызовов fetch)                                           |
| CRM read/create               | mock    | InMemory, HTTP             | `crm-deals.test.ts`: список 50→3 страницы, карточка, `NOT_FOUND`, одна подтверждённая сделка со сверкой по `crm.deal.get`; `http.test.ts`: список с курсором по HTTP             |
| Задачи read/create            | mock    | InMemory                   | `tasks.test.ts`: список по ответственному/статусу, задача по ID, одна подтверждённая задача со сверкой ответственного и срока                                                    |
| Сообщение                     | mock    | InMemory                   | `chat-calendar-disk.test.ts`: план с полным текстом и названием чата, один `im.message.add`, чтение обратно; недоступное чтение → `verified=false`                               |
| Файл                          | mock    | InMemory                   | там же: один `disk.folder.uploadfile` (inline и fileToken), размер сверен, `DOWNLOAD_URL` не выдаётся, конфликт имени, T26                                                       |
| Календарь                     | mock    | InMemory                   | там же: `from_ts/to_ts` + зона, участники в плане, сверка дат из формата Bitrix (DST), all-day                                                                                   |
| Подтверждения                 | mock    | InMemory, CLI              | `security/approvals.test.ts` (T08, T09, T12–T16), `approval-cli-no-tty.test.ts`; на всех пяти MVP-записях — `live-smoke.test.ts` (prepare → blocked без подтверждения → execute) |
| Дедупликация                  | mock    | InMemory                   | T13 replay без второй записи на каждом из пяти write-инструментов (`live-smoke.test.ts` «повтор ключа»), T09 конфликт тела                                                       |
| Ошибки понятны                | mock    | unit                       | `adapters.test.ts`: auth/scope/access/rate/validation различаются; `client.test.ts`: timeout, unknown outcome                                                                    |
| Секреты защищены              | passed  | Git, stdout/stderr, ответы | `check:secrets` (0 находок), редактор (T19), T42, `describeConfig`, планы и результаты в SQLite зашифрованы                                                                      |
| Документация пригодна новичку | not-run | —                          | README, setup Linux/Windows, webhook, Claude Code, troubleshooting, live-smoke написаны; проход новичком на реальном портале не выполнялся                                       |

Итог по §20.1: качество кода и mock-тесты — принимаются; все пункты реальной интеграции — `not-run`, нужен портал заказчика.

## Удалённый этап (§20.2) — этап 12, не начат

| Требование                                                  | Статус                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| HTTPS, OAuth-вход MCP, отказ посторонним, audience/identity | not-run (конфигурация `MCP_AUTH_MODE=oauth` намеренно даёт CONFIG_INVALID) |
| Изоляция состояния сессий                                   | passed для loopback (T40: чужой Host 403, чужая сессия 404/400)            |
| Панель подтверждений, remote MCP smoke, ChatGPT             | blocked (домен, HTTPS, аккаунт)                                            |

## Полная версия (§20.3) — этап 13, не начата

Реализованы 15 инструментов (11 MVP + `crm_fields_get`, `task_list`, `bitrix_server_version`, `bitrix_capabilities`, `operation_status`). Остальные строки §9 — `n/a` для текущего объёма, заглушек нет.

## Тест-кейсы §19.2 — полная таблица

| ID  | Сценарий (кратко)                       | Статус            | Где / почему                                                                                                |
| --- | --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| T01 | нет URL / origin не совпадает           | passed            | `unit/config.test.ts`                                                                                       |
| T02 | строка `false` в булевом                | passed            | `unit/config.test.ts`                                                                                       |
| T03 | legacy и v3 одно имя                    | passed            | `unit/adapters.test.ts`                                                                                     |
| T04 | HTTP 200 с error                        | passed            | `integration/client.test.ts`, `adapters.test.ts`                                                            |
| T05 | scope vs access denied                  | mock              | `adapters.test.ts` (коды различаются); live — not-run                                                       |
| T06 | 429/503 → успех с retry                 | passed            | `client.test.ts`                                                                                            |
| T07 | потеря ответа после create              | passed            | `client.test.ts`, `security/approvals.test.ts`                                                              |
| T08 | два вызова с одним ключом               | passed            | `security/approvals.test.ts`                                                                                |
| T09 | тот же ключ, другое тело                | passed            | там же                                                                                                      |
| T10 | write в read-only напрямую              | passed            | `security/read-only-and-policy.test.ts`, все MVP-записи скрыты (`crm-deals`, `tasks`, `chat-calendar-disk`) |
| T11 | raw write/batch/casing/path             | passed            | `integration/mcp-inmemory.test.ts`                                                                          |
| T12 | `confirm:true` без операции             | passed            | `security/approvals.test.ts`                                                                                |
| T13 | повтор approval после успеха            | passed            | там же + `live-smoke.test.ts`                                                                               |
| T14 | чужой principal/изменённые args         | passed            | там же                                                                                                      |
| T15 | объект изменился после подготовки       | passed            | там же (precheck) + Диск (`chat-calendar-disk.test.ts`)                                                     |
| T16 | рестарт при executing                   | passed            | там же                                                                                                      |
| T17 | OAuth refresh                           | частично          | «один refresh» в клиенте (`client.test.ts`); OAuth-провайдер — этап 13                                      |
| T18 | подмена install endpoint                | n/a               | OAuth Bitrix — этап 13                                                                                      |
| T19 | секреты в ошибках                       | passed            | `unit/redaction.test.ts`, T42                                                                               |
| T20 | 50 upstream, pageSize 20                | passed            | `integration/pagination.test.ts`, `crm-deals`, `tasks`, `http`                                              |
| T21 | чужой/истёкший курсор                   | passed            | `pagination.test.ts`, `crm-deals.test.ts`                                                                   |
| T22 | большой ответ / длинная статья          | passed (усечение) | `contract/tool-registry.test.ts` (`enforceResponseLimit`); фрагменты статей — KB, n/a                       |
| T23 | инструкции в данных CRM                 | passed            | `security/data-not-instructions.test.ts`                                                                    |
| T24 | неоднозначное имя сотрудника            | n/a               | `employee_search` — полная версия; MVP принимает только ID                                                  |
| T25 | `.env`, traversal, symlink, URL         | passed            | `security/files.test.ts`; SSRF — `client.test.ts` (allowlist host, redirect)                                |
| T26 | подмена staged-файла                    | passed            | `security/files.test.ts`, `chat-calendar-disk.test.ts`                                                      |
| T27 | base64/размер/сканер                    | passed            | `security/files.test.ts`                                                                                    |
| T28 | календарь: интервал, зона, DST, all-day | passed            | `unit/calendar-time.test.ts`, `chat-calendar-disk.test.ts`                                                  |
| T29 | новая карточка задач                    | n/a               | комментарии задач — полная версия                                                                           |
| T30 | задача требует результат                | n/a               | `task_complete` — полная версия                                                                             |
| T31 | обязательное UF-поле CRM                | passed            | `unit/deal-fields.test.ts`, `crm-deals.test.ts`; live — not-run                                             |
| T32 | замена товаров пустым списком           | n/a               | полная версия                                                                                               |
| T33 | агрегация по воронке                    | n/a               | полная версия                                                                                               |
| T34 | счёт без товаров                        | n/a               | полная версия                                                                                               |
| T35 | комментарии ленты                       | n/a               | полная версия                                                                                               |
| T36 | статья KB draft                         | n/a               | полная версия                                                                                               |
| T37 | KB2 search без cursor                   | n/a               | полная версия                                                                                               |
| T38 | KB2 конфликт редактирования             | n/a               | полная версия                                                                                               |
| T39 | HTTP без/с просроченным токеном         | not-run           | этап 12 (OAuth MCP)                                                                                         |
| T40 | чужой Origin/Host, чужая сессия         | passed            | `integration/http.test.ts`                                                                                  |
| T41 | initialize/list/call stdio и HTTP       | passed            | `mcp-inmemory`, `http`, `stdout-purity`, `mcp:smoke`                                                        |
| T42 | debug-текст в stdout                    | passed            | `security/stdout-purity.test.ts`                                                                            |
| T43 | неподдерживаемый модуль                 | passed            | `security/data-not-instructions.test.ts` (ENABLED_MODULES)                                                  |
| T44 | аудит недоступен                        | passed            | `unit/retry-limiter-crypto.test.ts`, `security/approvals.test.ts`                                           |
| T45 | restore зашифрованной копии             | not-run           | ручной; ключ и БД разделены (`docs/operations.md` — этап 11)                                                |
| T46 | 11 MVP tools на портале                 | not-run           | `npm run test:live` готов; сценарий проверен на mock (`live-smoke.test.ts`)                                 |
| T47 | output policy на named и raw            | passed            | `mcp-inmemory.test.ts`, `crm-deals.test.ts`                                                                 |
| T48 | отзыв доступа / смена секрета           | not-run           | этап 12 (revoke)                                                                                            |

## Что нельзя принять по этому срезу

Все пункты реальной интеграции: связь с порталом, права, тариф, доступность модулей, форма живых ответов
(`tasks.task.*` camelCase, `calendar.event.add` с `from_ts/to_ts`, `im.dialog.get`, `disk.folder.uploadFile`).
Для них нужен портал заказчика: `npm run doctor` → `npm run test:live -- --read-only` → согласованные записи.

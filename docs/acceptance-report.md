# Отчёт проверки (ТЗ §20)

Обновлено: 2026-09-23, срез 5 (этапы 1–9). Среда: Linux x64, Node 24.18.0, без доступа к реальному порталу.

Статусы: `passed` — проверено; `mock` — проверено на имитации Bitrix24 с реальной формой ответов;
`not-run` — не выполнялось; `blocked` — невозможно без внешнего условия; `n/a` — не относится к срезу.

## Приёмка MVP (§20.1)

| Критерий                      | Статус        | Доказательство                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Чистая установка и запуск     | passed        | `npm ci`, `lint`, `typecheck`, `test` (170), `build` — код 0                                                                                                                                                                                                                                      |
| MCP-клиент видит tools        | passed        | `npm run mcp:smoke -- --transport stdio` и `--transport http`: 5 инструментов, `tools/call` успешен; тесты `mcp-inmemory`, `http`, `stdout-purity`                                                                                                                                                |
| Connection info корректен     | mock          | `bitrix_connection_info` возвращает origin без секрета, пользователя из `profile`, scope; секрет/e-mail/телефон отсутствуют в ответе (тест)                                                                                                                                                       |
| Raw REST работает безопасно   | mock + passed | `profile` проходит; `crm.deal.add`, `batch`, casing, path, `auth` в params, метод вне allowlist — отказ до сети (тест T11, 0 вызовов fetch)                                                                                                                                                       |
| CRM read/create               | mock          | `tests/integration/crm-deals.test.ts`: список (50→3 страницы по cursor), карточка по ID, `NOT_FOUND`, одна подтверждённая сделка с проверкой по `crm.deal.get` и сверкой ключевых полей; поля/фильтры по схеме портала; на реальном портале — not-run                                             |
| Задачи read/create            | mock          | `tests/integration/tasks.test.ts`: список по ответственному/статусу (50→3 страницы), задача по ID, `NOT_FOUND`, одна подтверждённая задача со сверкой ответственного и срока по `tasks.task.get`; на реальном портале — not-run                                                                   |
| Сообщение / Файл / Календарь  | mock          | `tests/integration/chat-calendar-disk.test.ts`: одно сообщение в известный чат с полным текстом в плане и чтением обратно; один файл (inline и fileToken) с проверкой размера и без DOWNLOAD_URL; одно событие с датами/зоной/участниками и сверкой формата Bitrix; на реальном портале — not-run |
| Подтверждения                 | mock          | отсутствующее/чужое/повторное/устаревшее/отклонённое approval не создаёт write — `tests/security/approvals.test.ts` на тестовом инструменте; CLI без TTY отказывает — `approval-cli-no-tty.test.ts`; на реальных MVP-инструментах — после этапов 7–9                                              |
| Дедупликация                  | mock          | повтор одного idempotencyKey возвращает сохранённый результат (T13), другое тело — IDEMPOTENCY_CONFLICT (T09), одновременные вызовы — один write (T08)                                                                                                                                            |
| Ошибки понятны                | mock          | таблица §14.5 покрыта unit-тестами: auth/scope/access/rate/validation/unknown outcome различаются                                                                                                                                                                                                 |
| Секреты защищены              | passed        | `check:secrets` (0 находок), редактор (T19), stdout/stderr без секрета (T42), `describeConfig` без секретов                                                                                                                                                                                       |
| Документация пригодна новичку | частично      | README, setup-linux/windows, bitrix-webhook, claude-code, troubleshooting написаны; проверка «путь новичка» на реальном портале — not-run                                                                                                                                                         |

## Тест-кейсы §19.2, покрытые в срезе 1

| ID         | Уровень          | Статус   | Где                                                                                                                                                  |
| ---------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01        | unit             | passed   | `tests/unit/config.test.ts`                                                                                                                          |
| T02        | unit             | passed   | там же                                                                                                                                               |
| T03        | unit             | passed   | `tests/unit/adapters.test.ts`                                                                                                                        |
| T04        | integration      | passed   | `tests/integration/client.test.ts`, `adapters.test.ts`                                                                                               |
| T06        | integration      | passed   | `client.test.ts` (429 → 503 → 200, Retry-After)                                                                                                      |
| T07        | integration      | passed   | `client.test.ts` (одна отправка, OPERATION_OUTCOME_UNKNOWN)                                                                                          |
| T10        | security         | passed   | `tests/security/read-only-and-policy.test.ts` (на тестовом write-инструменте)                                                                        |
| T11        | security         | passed   | `tests/integration/mcp-inmemory.test.ts`                                                                                                             |
| T17        | integration      | частично | логика «один refresh» в клиенте; OAuth-провайдер — этап 13                                                                                           |
| T19        | unit/security    | passed   | `tests/unit/redaction.test.ts`, T42                                                                                                                  |
| T20        | integration      | passed   | `tests/integration/pagination.test.ts`                                                                                                               |
| T21        | security         | passed   | там же                                                                                                                                               |
| T40        | security         | passed   | `tests/integration/http.test.ts` (Host-guard 403, сессии)                                                                                            |
| T41        | integration      | passed   | InMemory + HTTP тесты, smoke stdio/http                                                                                                              |
| T42        | contract         | passed   | `tests/security/stdout-purity.test.ts`                                                                                                               |
| T44        | integration      | passed   | `tests/unit/retry-limiter-crypto.test.ts`                                                                                                            |
| T47        | security         | passed   | `mcp-inmemory.test.ts` (output policy на raw)                                                                                                        |
| T08        | integration      | passed   | `tests/security/approvals.test.ts` (один upstream write на два вызова)                                                                               |
| T09        | integration      | passed   | там же (IDEMPOTENCY_CONFLICT)                                                                                                                        |
| T12        | security         | passed   | там же (approvalId без операции, лишний `confirm`)                                                                                                   |
| T13        | integration      | passed   | там же (replay без второго write)                                                                                                                    |
| T14        | security         | passed   | там же (другие аргументы/ключ/principal → отказ)                                                                                                     |
| T15        | integration      | passed   | там же (precheck → CONFLICT, старое approval мертво)                                                                                                 |
| T16        | integration      | passed   | там же (executing → unknown после рестарта)                                                                                                          |
| T25        | security         | passed   | `tests/security/files.test.ts` (traversal, симлинки, `.env`)                                                                                         |
| T26        | integration      | passed   | там же (подмена staged-файла)                                                                                                                        |
| T27        | security         | passed   | там же (base64, размер, сканер недоступен)                                                                                                           |
| T31        | contract         | passed   | `tests/unit/deal-fields.test.ts`, `crm-deals.test.ts` (обязательное UF-поле); live — not-run                                                         |
| T28        | unit/integration | passed   | `tests/unit/calendar-time.test.ts`, `chat-calendar-disk.test.ts`: обратный интервал, зона обязательна, DST (Берлин лето/зима), all-day → skip_time=Y |
| T26 (Диск) | integration      | passed   | `chat-calendar-disk.test.ts`: подмена staged-файла после подтверждения → UNSAFE_FILE, загрузки нет, операция failed                                  |
| T24        | unit             | n/a      | разрешение имён сотрудников — `employee_search` (полная версия)                                                                                      |
| Остальные  | —                | not-run  | по этапам 7–14                                                                                                                                       |

## Что нельзя принять по этому срезу

Все пункты реальной интеграции: связь с порталом, права, тариф, доступность модулей. Для них нужен
`npm run doctor` без `--offline` и `npm run bitrix:profile` на портале заказчика.

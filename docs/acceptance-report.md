# Отчёт проверки (ТЗ §20)

Обновлено: 2026-09-23, срез 1 (этапы 1–5). Среда: Linux x64, Node 24.18.0, без доступа к реальному порталу.

Статусы: `passed` — проверено; `mock` — проверено на имитации Bitrix24 с реальной формой ответов;
`not-run` — не выполнялось; `blocked` — невозможно без внешнего условия; `n/a` — не относится к срезу.

## Приёмка MVP (§20.1)

| Критерий                      | Статус        | Доказательство                                                                                                                                     |
| ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Чистая установка и запуск     | passed        | `npm ci`, `lint`, `typecheck`, `test` (90), `build` — код 0                                                                                        |
| MCP-клиент видит tools        | passed        | `npm run mcp:smoke -- --transport stdio` и `--transport http`: 5 инструментов, `tools/call` успешен; тесты `mcp-inmemory`, `http`, `stdout-purity` |
| Connection info корректен     | mock          | `bitrix_connection_info` возвращает origin без секрета, пользователя из `profile`, scope; секрет/e-mail/телефон отсутствуют в ответе (тест)        |
| Raw REST работает безопасно   | mock + passed | `profile` проходит; `crm.deal.add`, `batch`, casing, path, `auth` в params, метод вне allowlist — отказ до сети (тест T11, 0 вызовов fetch)        |
| CRM read/create               | not-run       | этапы 7                                                                                                                                            |
| Задачи read/create            | not-run       | этап 8                                                                                                                                             |
| Сообщение / Файл / Календарь  | not-run       | этап 9                                                                                                                                             |
| Подтверждения                 | not-run       | этап 6; сейчас любая запись блокируется `READ_ONLY_MODE` (тест T10)                                                                                |
| Дедупликация                  | not-run       | этап 6                                                                                                                                             |
| Ошибки понятны                | mock          | таблица §14.5 покрыта unit-тестами: auth/scope/access/rate/validation/unknown outcome различаются                                                  |
| Секреты защищены              | passed        | `check:secrets` (0 находок), редактор (T19), stdout/stderr без секрета (T42), `describeConfig` без секретов                                        |
| Документация пригодна новичку | частично      | README, setup-linux/windows, bitrix-webhook, claude-code, troubleshooting написаны; проверка «путь новичка» на реальном портале — not-run          |

## Тест-кейсы §19.2, покрытые в срезе 1

| ID        | Уровень       | Статус   | Где                                                                           |
| --------- | ------------- | -------- | ----------------------------------------------------------------------------- |
| T01       | unit          | passed   | `tests/unit/config.test.ts`                                                   |
| T02       | unit          | passed   | там же                                                                        |
| T03       | unit          | passed   | `tests/unit/adapters.test.ts`                                                 |
| T04       | integration   | passed   | `tests/integration/client.test.ts`, `adapters.test.ts`                        |
| T06       | integration   | passed   | `client.test.ts` (429 → 503 → 200, Retry-After)                               |
| T07       | integration   | passed   | `client.test.ts` (одна отправка, OPERATION_OUTCOME_UNKNOWN)                   |
| T10       | security      | passed   | `tests/security/read-only-and-policy.test.ts` (на тестовом write-инструменте) |
| T11       | security      | passed   | `tests/integration/mcp-inmemory.test.ts`                                      |
| T17       | integration   | частично | логика «один refresh» в клиенте; OAuth-провайдер — этап 13                    |
| T19       | unit/security | passed   | `tests/unit/redaction.test.ts`, T42                                           |
| T20       | integration   | passed   | `tests/integration/pagination.test.ts`                                        |
| T21       | security      | passed   | там же                                                                        |
| T40       | security      | passed   | `tests/integration/http.test.ts` (Host-guard 403, сессии)                     |
| T41       | integration   | passed   | InMemory + HTTP тесты, smoke stdio/http                                       |
| T42       | contract      | passed   | `tests/security/stdout-purity.test.ts`                                        |
| T44       | integration   | passed   | `tests/unit/retry-limiter-crypto.test.ts`                                     |
| T47       | security      | passed   | `mcp-inmemory.test.ts` (output policy на raw)                                 |
| Остальные | —             | not-run  | по этапам 6–14                                                                |

## Что нельзя принять по этому срезу

Все пункты реальной интеграции: связь с порталом, права, тариф, доступность модулей. Для них нужен
`npm run doctor` без `--offline` и `npm run bitrix:profile` на портале заказчика.

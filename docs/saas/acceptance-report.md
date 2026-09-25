# Отчёт приёмки SaaS-версии (ТЗ §18, этап S10)

Дата: 2026-09-25. Ветка: `claude/sharp-einstein-454lyr`.

Правило отчёта (Б§20, SaaS-ТЗ §17): mock ≠ реальный портал ≠ реальный платёж. Статусы:

- `passed` — проверено тем способом, который требует критерий;
- `passed (mock)` — проверено автотестом с настоящими PostgreSQL/Redis, но Bitrix24 или ЮKassa в нём подменены;
- `not-run` — проверка возможна, но не выполнялась;
- `blocked` — для проверки нужна среда, которой нет.

Реальных сред пока нет: домена и хостинга, тестового портала Bitrix24 с приложением в кабинете разработчика,
тестового магазина ЮKassa, SMTP (ТЗ §20: действуют допущения).

## Критерии §18

| Критерий                               | Статус                            | Доказательство / что нужно                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Онбординг без технических знаний       | blocked                           | Код сценария §4.1 есть: установка → кабинет → подключение, инструкции в `/app/connect`. Нужен пилотный клиент на реальном портале; инструкции для клиентов MCP текстовые, названия пунктов меню не сверены с живыми интерфейсами                                                                                 |
| Claude и ChatGPT подключаются по OAuth | passed (mock) / blocked           | `tests/integration/saas-runtime.test.ts`: DCR + PKCE + вход через Bitrix24 → токен → `initialize`, `tools/list`, чтение, подтверждённая запись ровно один раз. Реальные Claude и ChatGPT не подключались: нужен публичный https-стенд                                                                            |
| Права Bitrix24 соблюдаются             | passed (mock) / blocked           | Каждый пользователь ходит в портал своим OAuth-токеном и только на хост своего портала (`saas-runtime`, S01). Проверка «два сотрудника с разными правами видят разное» возможна только на реальном портале                                                                                                       |
| Изоляция                               | passed (mock)                     | S01 `tests/security/tenant-isolation.test.ts`, S02 `tests/integration/storage-contract.test.ts` (настоящий PostgreSQL, RLS, роль без BYPASSRLS), S12 `tests/integration/s5-cabinet.test.ts`, два арендатора в `saas-runtime`. Ручная попытка на стенде — not-run                                                 |
| Оплата и продление                     | passed (mock) / blocked           | S10, S11 `tests/integration/s6s7-billing.test.ts` против mock API ЮKassa (формат по официальному SDK). Тестовый магазин не подключён; письма клиенту не отправляются — SMTP-адаптера нет, уведомления пишутся в журнал                                                                                           |
| Удаление приложения/данных             | passed (mock) / blocked           | S04 `tests/integration/s3-bitrix-app.test.ts`, S13 `s5-cabinet`, удаление приложения и задача `retention.data_deletion` через 30 дней в `saas-runtime`. На реальном тестовом портале — blocked                                                                                                                   |
| Эксплуатация                           | passed (частично) / not-run       | S15 и S16 на настоящем Redis (`tests/integration/s8-redis.test.ts`), лидер worker по аренде в Redis (`saas-runtime`). Два `web` + `worker` в `deploy/saas/compose.yaml`, выкат без простоя, нагрузка §13 и восстановление бэкапа PG (`deploy/saas/pg-restore-check.sh`) — not-run: в среде разработки нет Docker |
| Режим single не сломан                 | passed                            | S14: весь набор тестов базового ТЗ зелёный (67 файлов, 702 теста), `npm run mcp:smoke -- --transport stdio` проходит                                                                                                                                                                                             |
| Юридические документы                  | passed (шаблоны готовы) / not-run | `docs/saas/legal/*`: оферта с поручением на обработку ПДн, политика, согласие, условия автосписания, SLA. Юристом не проверены                                                                                                                                                                                   |

## Тест-кейсы §17

| ID  | Статус        | Где                                                                                   |
| --- | ------------- | ------------------------------------------------------------------------------------- |
| S01 | passed (mock) | `tests/security/tenant-isolation.test.ts`                                             |
| S02 | passed        | `tests/integration/storage-contract.test.ts` (настоящий PostgreSQL 16)                |
| S03 | passed (mock) | `tests/integration/s3-bitrix-app.test.ts`, `s8-redis.test.ts`                         |
| S04 | passed (mock) | `tests/integration/s3-bitrix-app.test.ts`                                             |
| S05 | passed (mock) | `tests/integration/s4-oauth.test.ts`                                                  |
| S06 | passed        | `tests/integration/s4-oauth.test.ts`                                                  |
| S07 | passed (mock) | `tests/integration/s4-oauth.test.ts`, `saas-runtime.test.ts`                          |
| S08 | passed (mock) | `tests/integration/s6s7-billing.test.ts`, `saas-runtime.test.ts`                      |
| S09 | passed (mock) | инструмент вне тарифа скрыт в `tools/list`; в открытой сессии — `FEATURE_UNAVAILABLE` |
| S10 | passed (mock) | `tests/integration/s6s7-billing.test.ts`                                              |
| S11 | passed (mock) | переходы §10.2 проверены; «письма отправлены» — нет (SMTP не реализован)              |
| S12 | passed (mock) | `tests/integration/s5-cabinet.test.ts`                                                |
| S13 | passed (mock) | `tests/integration/s5-cabinet.test.ts`, `saas-runtime.test.ts`                        |
| S14 | passed        | весь набор тестов                                                                     |
| S15 | passed        | `tests/integration/s8-redis.test.ts` (настоящий Redis 7, три лимитера)                |
| S16 | passed        | `tests/integration/s8-redis.test.ts`, `s6s7-billing.test.ts`                          |
| S17 | passed (mock) | `tests/integration/s3-bitrix-app.test.ts`                                             |

## Что сделать владельцу для живой приёмки

1. Домен и хостинг в РФ, https; развернуть `deploy/saas` (`docs/saas/operations.md`, `docs/saas/runtime.md`).
2. Кабинет разработчика Bitrix24: локальное или тиражное приложение с адресами `/b24/install`, `/b24/events`,
   `/b24/oauth/callback`, `/app` (`docs/saas/marketplace.md`); тестовый портал.
3. Тестовый магазин ЮKassa (shopId, секретный ключ, адрес уведомлений `/billing/hooks/yookassa`).
4. Учётная запись владельца: `npm run owner -- create --email …`.
5. Пройти критерии выше и заменить статусы `blocked`/`not-run` результатами.

## Известные пробелы кода

- Письма (SMTP): уведомления биллинга и об удалении данных только пишутся в журнал.
- Встроенная страница приложения внутри Bitrix24 (iframe) не сделана; кабинет открывается отдельно.
- MCP-сессии хранятся в памяти экземпляра (nginx закрепляет сессию по `Mcp-Session-Id`); `tools/list_changed` при
  смене тарифа не отправляется.
- Лимиты входящих запросов на арендатора и общий не реализованы (есть лимитер исходящих к порталу).
- Счёт юрлицу — HTML-страница, не PDF.

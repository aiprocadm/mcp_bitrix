# Состояние работ: SaaS-версия по подписке

Точка входа для команды **«продолжай по ТЗ»** (порядок — `CLAUDE.md` и `.claude/skills/continue-tz/SKILL.md`).
ТЗ — `docs/saas/TZ-SaaS.md` (этапы §19). Базовое ТЗ `docs/TZ.md` выполнено, его статус — `docs/STATUS.md`.

## Текущее положение

|                 |                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Дата обновления | 2026-09-25                                                                                                                                                                                                                                                                                             |
| Текущий этап    | **S2 — PostgreSQL, RLS, конвертное шифрование** (ТЗ §6, D6, D7)                                                                                                                                                                                                                                        |
| Следующий шаг   | S2, срез 1: адаптер `SqlDb` для PostgreSQL (пакет `pg`, `?`→`$n`, `withTenant` = транзакция + `set_config('app.tenant_id')`), миграции PG с RLS и ролью без BYPASSRLS, тестовый PostgreSQL (initdb во временном каталоге; без бинарников — явный skip), контрактные тесты хранилищ на SQLite и PG, S02 |
| Открытый PR     | нет (проверить перед началом: открытые PR в `aiprocadm/mcp_bitrix`)                                                                                                                                                                                                                                    |
| Реальные среды  | портал Bitrix24, магазин ЮKassa, домен, хостинг — не подключены (§20 ТЗ: действуют допущения)                                                                                                                                                                                                          |

## Этапы (ТЗ §19)

| Этап | Содержание                                        | Статус      | Где / доказательство                                                                                                                                                                         |
| ---- | ------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | ТЗ, статус, правила продолжения, SessionStart-хук | ✅ 25.09    | `docs/saas/TZ-SaaS.md`, `docs/saas/STATUS.md`, `CLAUDE.md`, `.claude/skills/continue-tz/`, `.claude/hooks/`                                                                                  |
| S1   | Контекст арендатора в ядре (SQLite)               | ✅ 25.09    | `src/app/container.ts`, `src/app/tenant-registry.ts`, `src/storage/sql.ts`, `sqlite-db.ts`, миграция 3; тесты `deployment-mode`, `tenant-scope`, `tenant-isolation` (S01), `tenant-registry` |
| S2   | PostgreSQL, RLS, конвертное шифрование            | ⏭ следующий | —                                                                                                                                                                                            |
| S3   | Тиражное приложение Bitrix24, OAuth пользователей | —           | —                                                                                                                                                                                            |
| S4   | Сервер авторизации MCP                            | —           | —                                                                                                                                                                                            |
| S5   | Кабинет клиента                                   | —           | —                                                                                                                                                                                            |
| S6   | Тарифы, квоты, учёт                               | —           | —                                                                                                                                                                                            |
| S7   | Биллинг (ЮKassa)                                  | —           | —                                                                                                                                                                                            |
| S8   | Эксплуатация, масштабирование                     | —           | —                                                                                                                                                                                            |
| S9   | Панель владельца, юр. шаблоны, Маркет             | —           | —                                                                                                                                                                                            |
| S10  | Пилот и приёмка                                   | —           | —                                                                                                                                                                                            |

## План этапа S2 (срезы)

1. Адаптер PostgreSQL `SqlDb` (`pg`): перевод `?`→`$n`, пул, `transaction`, `withTenant` (транзакция + `set_config('app.tenant_id', …, true)`), `ping`, `schemaVersion`.
2. Миграции PostgreSQL: таблицы ядра (`operations`, `idempotency`, `cursors`, `audit`, `file_manifests`) с `tenant_id` и RLS; роль приложения без `BYPASSRLS`; служебная роль worker.
3. Тестовый PostgreSQL: `initdb` во временном каталоге под непривилегированным пользователем (в CI — сервис); контрактные тесты хранилищ на обоих диалектах; S02 (запрос без/с чужим `app.tenant_id` → 0 строк).
4. Конвертное шифрование (D7): таблица `tenant_keys` (DEK под KEK), `SecretBox` арендатора; криптоудаление.
5. Схема и репозитории control plane SaaS (§6.2): `tenants`, `tenant_users`, `bitrix_tokens`, `mcp_clients`, `mcp_grants`/`mcp_refresh_tokens`, `plans`, `subscriptions`, `payments`, `invoices`, `usage_counters`, `tenant_settings`, `support_actions` — основа для S3–S9.

## Сделано

### S1, срезы 2–4 (2026-09-25): асинхронные хранилища с арендатором, реестр контекстов, S01

- `src/storage/sql.ts` — асинхронный `SqlDb` (один SQL для SQLite и PostgreSQL: `?`, `ON CONFLICT`, `withTenant`); `SqliteSqlDb` — адаптер поверх node:sqlite с защитой от попадания запросов в чужую транзакцию.
- Миграция 3 (SQLite): `tenant_id` в `operations`, `idempotency` (уникальный индекс с арендатором), `cursors`, `audit`, `file_manifests`; существующие строки — `local`.
- Хранилища асинхронные и привязаны к арендатору: `OperationsStore(db, tenantId)`, `CursorStore(…, tenantId)`, `FileStaging.forTenant(id)`, `AuditLog.record({tenantId})`; `ApprovalService`/`MutationExecutor`/CLI/панель/тесты переведены на `await`. `OperationsStore.denyAllPending(principal)` — для отзыва доступа (§7.4).
- Кэш capabilities/полей CRM — `MemoryTtlCache` процесса (LRU+TTL, ключ с `portalKey`); таблица `capabilities_cache` больше не используется.
- `TenantScope.ready` — обслуживание при старте (T16 executing→unknown, истёкшие планы/курсоры/файлы/аудит); сервер и CLI ждут его до работы.
- `assembleApp(platform, scope)`; `TenantScopeRegistry` (LRU+TTL 60 с, общая сборка, инвалидация по арендатору/пользователю); `ToolContext.tenant`.
- Тесты: +7 (482): `integration/tenant-isolation.test.ts` (S01: операции, подтверждения, approvalId, idempotency, курсоры, fileToken, аудит), `unit/tenant-registry.test.ts`; весь прежний набор зелёный (S14).

### S1, срез 1 (2026-09-25): режим развёртывания, Platform + TenantScope

- `DEPLOYMENT_MODE=single|saas` (+ `PUBLIC_BASE_URL`, `REDIS_URL`, `PROCESS_ROLE`); проверки §15: saas требует https-origin без пути, `MCP_TRANSPORT=http`, PostgreSQL в `DATABASE_URL`, Redis, отсутствие вебхука; single не принимает PostgreSQL. Пароли PostgreSQL/Redis регистрируются в редакторе и не печатаются (`describeConfig` в saas не выводит путь БД).
- `createApp` = `createPlatform` (общее: политики, ключ, БД, аудит, файлы, панель, output policy, лимит входящих, fetch) + `createTenantScope` (провайдер Bitrix24, свой лимитер и клиент портала, capabilities, курсоры, операции, подтверждения, MutationExecutor, принципал, инструменты). `AppContainer` = оба + `platform`/`scope`: весь существующий код не менялся.
- `TenantSpec.allowedHosts`: у арендатора свой список хостов (защита от SSRF): клиент арендатора A не может обратиться к порталу B даже при ошибочном провайдере.
- `createApp` в режиме saas честно отказывает (`CONFIG_INVALID`, поле `DEPLOYMENT_MODE`) — компоненты появляются по этапам.
- Тесты: +14 (475): `unit/deployment-mode.test.ts`, `integration/tenant-scope.test.ts`; весь прежний набор зелёный (S14).
- Не проверено: реальные PostgreSQL/Redis не подключаются (только разбор адресов); это этапы S2/S8.

### Срез S0 (2026-09-25)

- ТЗ SaaS-версии: решения D1–D15, архитектура, данные, авторизация, биллинг, кабинет, безопасность, 152-ФЗ, тесты S01–S17, этапы S0–S10.
- Правила «продолжай по ТЗ» для любой сессии: `CLAUDE.md` + навык `.claude/skills/continue-tz/SKILL.md`.
- SessionStart-хук облачных сессий: `npm ci` при изменении `package-lock.json`, иначе мгновенный выход.

## Решения, принятые по ходу (дополняют §3 ТЗ)

Формат: дата, этап, решение, почему, где в коде.

- 2026-09-25, S1.1: `PUBLIC_BASE_URL` допускает `http://` только для loopback (как `MCP_PUBLIC_URL` базового ТЗ) — для локальной разработки SaaS; внешний адрес — только https. `src/config/env.ts` `parseDeployment`.
- 2026-09-25, S1.1: файловое хранилище, панель `/admin` и output policy пока в `Platform` (общие); привязка файлов и политики к арендатору — срезы S1.2 и S5. `src/app/container.ts`.

## Грабли

Общие грабли проекта — в `docs/STATUS.md` (раздел «Грабли»): они действуют и здесь.

## Вопросы владельцу

См. ТЗ §20 — не блокируют работу, до ответа действуют допущения.

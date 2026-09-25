# Состояние работ: SaaS-версия по подписке

Точка входа для команды **«продолжай по ТЗ»** (порядок — `CLAUDE.md` и `.claude/skills/continue-tz/SKILL.md`).
ТЗ — `docs/saas/TZ-SaaS.md` (этапы §19). Базовое ТЗ `docs/TZ.md` выполнено, его статус — `docs/STATUS.md`.

## Текущее положение

|                 |                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Дата обновления | 2026-09-25                                                                                                                                                                         |
| Текущий этап    | **Сборка режима saas** готова (`docs/saas/runtime.md`); волна 2: S5 (кабинет `/app`) и S9 (панель `/owner`) подключаются через `extraRoutes`                                       |
| Следующий шаг   | S5: кабинет `/app` поверх `SaasRuntime` (вход через Bitrix24 — `cabinetCallback`, подтверждения по `approvalUrl` — `tenantApprovals`, история, администрирование, загрузка файлов) |
| Открытый PR     | нет (проверить перед началом: открытые PR в `aiprocadm/mcp_bitrix`)                                                                                                                |
| Реальные среды  | портал Bitrix24, магазин ЮKassa, домен, хостинг — не подключены (§20 ТЗ: действуют допущения)                                                                                      |

## Этапы (ТЗ §19)

| Этап | Содержание                                        | Статус   | Где / доказательство                                                                                                                                                                                                      |
| ---- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | ТЗ, статус, правила продолжения, SessionStart-хук | ✅ 25.09 | `docs/saas/TZ-SaaS.md`, `docs/saas/STATUS.md`, `CLAUDE.md`, `.claude/skills/continue-tz/`, `.claude/hooks/`                                                                                                               |
| S1   | Контекст арендатора в ядре (SQLite)               | ✅ 25.09 | `src/app/container.ts`, `src/app/tenant-registry.ts`, `src/storage/sql.ts`, `sqlite-db.ts`, миграция 3; тесты `deployment-mode`, `tenant-scope`, `tenant-isolation` (S01), `tenant-registry`                              |
| S2   | PostgreSQL, RLS, конвертное шифрование            | ✅ 25.09 | `src/storage/postgres-db.ts`, `pg-migrations.ts` (+ `pg-migrations/*` по этапам), `src/saas/keyring.ts`, `coordination.ts`, `repos/tenants.ts`, `repos/plans.ts`; тесты `storage-contract` (SQLite+PG, S02), `saas-repos` |
| S3   | Тиражное приложение Bitrix24, OAuth пользователей | —        | —                                                                                                                                                                                                                         |
| S4   | Сервер авторизации MCP                            | —        | —                                                                                                                                                                                                                         |
| S5   | Кабинет клиента                                   | —        | —                                                                                                                                                                                                                         |
| S6   | Тарифы, квоты, учёт                               | —        | —                                                                                                                                                                                                                         |
| S7   | Биллинг (ЮKassa)                                  | —        | —                                                                                                                                                                                                                         |
| S8   | Эксплуатация, масштабирование                     | —        | —                                                                                                                                                                                                                         |
| S9   | Панель владельца, юр. шаблоны, Маркет             | —        | —                                                                                                                                                                                                                         |
| S10  | Пилот и приёмка                                   | —        | —                                                                                                                                                                                                                         |

## План этапов S3–S9 (интерфейсы для параллельной работы)

Общие основы (готовы): `SqlDb`/`PostgresSqlDb` (RLS через `withTenant`), `TenantKeyRing` (DEK арендатора),
`Coordination` (`InMemoryCoordination`; Redis — S8), репозитории `TenantsRepo`, `TenantUsersRepo`, `TenantSettingsRepo`,
`PlansRepo`, `SubscriptionsRepo`, схема control plane (миграция PG 2). Новые миграции PostgreSQL — только в файле своего
этапа `src/storage/pg-migrations/<этап>.ts` и только в его диапазоне номеров (S3: 30–39, S4: 40–49, S5/S9: 50–59,
S6/S7: 60–79, S8: 80–89).

- **S3** `src/saas/bitrix/*`: OAuth тиражного приложения (обмен code, refresh single-flight, хранение под DEK в `bitrix_tokens`), `BitrixOAuthUserProvider` (реализует `BitrixAuthProvider`), обработчики установки и `OnAppUninstall` (проверка `application_token`), `app.info`.
- **S4** `src/saas/oauth/*`: сервер авторизации MCP (RFC 8414/9728/7591/8707, PKCE S256, коды, JWT, ротация refresh, отзыв, поколения), вход через Bitrix24 (использует S3), согласие.
- **S6/S7** `src/saas/billing/*`: квоты и учёт (`QUOTA_EXCEEDED`, лимиты на пользователя), `PaymentProvider` + ЮKassa, жизненный цикл подписки §10.2, счета юрлицам, задачи worker.
- **S8** `src/saas/ops/*`: `RedisCoordination`, общий лимитер портала (S15), worker с лидером, метрики, compose-профиль SaaS, бэкапы PG.
- **Сборка режима saas** (после волны 1): `createSaasApp` — платформа на PostgreSQL, `TenantScopeRegistry`, диспетчер по токену, регистрация инструментов по тарифу.
- **S5/S9** (волна 2): кабинет `/app`, подтверждения по `approvalUrl`, панель владельца `/owner`, юридические шаблоны, материалы Маркета.

## Сделано

### Сборка режима saas (2026-09-25)

- `createSaasRuntime` (`src/saas/runtime.ts`): PostgreSQL (RLS), KEK → `TenantKeyRing`, `RedisCoordination`, репозитории и тарифы, S3 (приложение Bitrix24, вход — `BitrixLoginGatewayAdapter` для S4), S4 (AS, verifier), S6/S7 (учёт, тарифы, подписки, ЮKassa), метрики, Platform на PostgreSQL, `TenantScopeRegistry` с инвалидацией по `tenant-invalidate`/`saas:access-revoked`/`billing:entitlements`; контекст пользователя — его OAuth-токены Bitrix24, общий лимитер портала, только хост портала, DEK арендатора.
- Хуки диспетчера (`DispatchHooks`, в single не используются): tools/list по тарифу, `EntitlementService.check`, учёт вызова только при обращении к Bitrix24, учёт записи (`MutationExecutor.onFinished`), метрики, `approvalUrl` + код сверки в `APPROVAL_REQUIRED`.
- HTTP `buildSaasHttpApp` (`src/saas/http.ts`): `/mcp` под токеном сервиса, маршруты AS и метаданные, `/b24/*`, `/billing/hooks/yookassa` (адрес — через `TRUSTED_PROXIES`), `/healthz`, `/readyz`, `/metrics` (loopback или `METRICS_TOKEN`); `extraRoutes` для `/app` и `/owner`.
- `src/index.ts`: `DEPLOYMENT_MODE=saas` → web или worker (`src/saas/main.ts`, задачи `src/saas/worker-tasks.ts`, включая `bitrix.token_refresh`); удаление приложения останавливает биллинг (`stopForUninstall`) и отзывает refresh-токены сервиса.
- Конфигурация: `OAUTH_*`, `WORKER_*`, `REDIS_NAMESPACE`, `TRUSTED_PROXIES`, `METRICS_TOKEN_FILE`; в saas `READ_ONLY_MODE` по умолчанию `false`, модули — все; `MCP_AUTH_MODE=oauth` и `/admin` в saas запрещены.
- Тесты: +31 (`integration/saas-runtime` на настоящих PostgreSQL и Redis, `unit/saas-runtime-units`); весь прежний набор зелёный (S14). Не проверено: реальный портал, реальные MCP-клиенты, магазин ЮKassa, docker compose — см. `docs/saas/runtime.md`.

### S2 (2026-09-25): PostgreSQL, RLS, конвертное шифрование, control plane

- `PostgresSqlDb` (`pg` 8.23): пул, `?`→`$n`, транзакции, `withTenant` = транзакция + `set_config('app.tenant_id')`; миграции под advisory-блокировкой; отказ старта под ролью superuser/BYPASSRLS (`assertRlsEnforced`).
- Схема PG: ядро (миграция 1) и control plane (миграция 2: `tenants`, `tenant_users`, `bitrix_tokens`, `tenant_settings`, `mcp_clients`, `mcp_auth_codes`, `mcp_refresh_tokens`, `mcp_consents`, `plans`, `subscriptions`, `payments`, `invoices`, `usage_counters`, `cabinet_sessions`, `owner_users`, `support_actions`); RLS (ENABLE+FORCE) на 9 таблицах данных арендатора. Миграции этапов — в `pg-migrations/<этап>.ts` с непересекающимися номерами.
- SQLite: миграция 4 — первичный ключ `idempotency` с арендатором (контрактный тест нашёл конфликт одинакового ключа у разных арендаторов).
- `TenantKeyRing` (D7): DEK арендатора под KEK, AAD с id арендатора, криптоудаление. `Coordination` + `InMemoryCoordination` (блокировки, счётчики, окно лимита, pub/sub).
- Репозитории: `TenantsRepo` (установка/переустановка, пробный период один раз, статусы), `TenantUsersRepo` (RLS, поколение токенов при отключении), `TenantSettingsRepo`, `PlansRepo` (тарифы §9.1 как данные, проверка), `SubscriptionsRepo`.
- Тесты на **настоящем PostgreSQL 16** (временный кластер `initdb`, роль без привилегий): контракт хранилищ одинаков для SQLite и PG; S02 (без контекста и в чужом контексте — 0 строк, WITH CHECK, суперпользователь не пускается); control plane. +17 (499).
- Не проверено: управляемый PostgreSQL провайдера, TLS до БД, нагрузка (S8).

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
- 2026-09-25, S2: тарифы, подписки, платежи, клиенты OAuth и учёт — в каталоге без RLS (нужны до выбора арендатора и владельцу; данных порталов нет); данные арендатора — под RLS. `src/storage/pg-migrations.ts`.
- 2026-09-25, S2: кэш capabilities — в памяти процесса (промах = повторный `method.get`), а не в БД. `src/storage/memory-cache.ts`.
- 2026-09-25, S1.1: файловое хранилище, панель `/admin` и output policy пока в `Platform` (общие); привязка файлов и политики к арендатору — срезы S1.2 и S5. `src/app/container.ts`.

## Грабли

Общие грабли проекта — в `docs/STATUS.md` (раздел «Грабли»): они действуют и здесь.

## Вопросы владельцу

См. ТЗ §20 — не блокируют работу, до ответа действуют допущения.

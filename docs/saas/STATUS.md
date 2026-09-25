# Состояние работ: SaaS-версия по подписке

Точка входа для команды **«продолжай по ТЗ»** (порядок — `CLAUDE.md` и `.claude/skills/continue-tz/SKILL.md`).
ТЗ — `docs/saas/TZ-SaaS.md` (этапы §19). Базовое ТЗ `docs/TZ.md` выполнено, его статус — `docs/STATUS.md`.

## Текущее положение

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Дата обновления | 2026-09-25                                                                                                                                                                                                                                                                                                                                                                                                        |
| Текущий этап    | **S10 — пилот и приёмка**: код этапов S1–S9 и сборка режима saas готовы и проверены на mock + настоящих PostgreSQL/Redis                                                                                                                                                                                                                                                                                          |
| Следующий шаг   | Владельцу: подключить реальные среды (домен + хостинг, тестовый портал Bitrix24 и приложение в кабинете разработчика, тестовый магазин ЮKassa, SMTP) — затем по `docs/saas/acceptance-report.md` пройти живые проверки. Код: рассылка писем (SMTP-адаптер для `BillingNotifier`/`CabinetNotifier`), встроенная страница приложения в Bitrix24 (iframe), MCP-сессии в Redis, `tools/list_changed` при смене тарифа |
| Открытый PR     | ветка `claude/sharp-einstein-454lyr` (S1–S9 + сборка), PR создаёт владелец — проверить перед началом                                                                                                                                                                                                                                                                                                              |
| Реальные среды  | портал Bitrix24, магазин ЮKassa, домен, хостинг — не подключены (§20 ТЗ: действуют допущения)                                                                                                                                                                                                                                                                                                                     |

## Этапы (ТЗ §19)

| Этап | Содержание                                        | Статус                            | Где / доказательство                                                                                                                                                                                                      |
| ---- | ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | ТЗ, статус, правила продолжения, SessionStart-хук | ✅ 25.09                          | `docs/saas/TZ-SaaS.md`, `docs/saas/STATUS.md`, `CLAUDE.md`, `.claude/skills/continue-tz/`, `.claude/hooks/`                                                                                                               |
| S1   | Контекст арендатора в ядре (SQLite)               | ✅ 25.09                          | `src/app/container.ts`, `src/app/tenant-registry.ts`, `src/storage/sql.ts`, `sqlite-db.ts`, миграция 3; тесты `deployment-mode`, `tenant-scope`, `tenant-isolation` (S01), `tenant-registry`                              |
| S2   | PostgreSQL, RLS, конвертное шифрование            | ✅ 25.09                          | `src/storage/postgres-db.ts`, `pg-migrations.ts` (+ `pg-migrations/*` по этапам), `src/saas/keyring.ts`, `coordination.ts`, `repos/tenants.ts`, `repos/plans.ts`; тесты `storage-contract` (SQLite+PG, S02), `saas-repos` |
| S3   | Тиражное приложение Bitrix24, OAuth пользователей | ✅ 25.09 (mock)                   | `src/saas/bitrix/*`, миграция 30, `docs/saas/s3-bitrix-app.md`; тесты S03, S04, S17 на mock                                                                                                                               |
| S4   | Сервер авторизации MCP                            | ✅ 25.09 (mock)                   | `src/saas/oauth/*`, миграция 40, `docs/saas/s4-oauth.md`; тесты S05–S07                                                                                                                                                   |
| S5   | Кабинет клиента                                   | ✅ 25.09 (mock)                   | `src/saas/cabinet/*`, `src/saas/tenant-deletion.ts`, миграция 50, `docs/saas/s5-cabinet.md`; тесты S12, S13                                                                                                               |
| S6   | Тарифы, квоты, учёт                               | ✅ 25.09 (mock)                   | `src/saas/billing/{entitlements,usage-meter}.ts`, `docs/saas/s6-s7-billing.md`; тесты S08, S09, S16                                                                                                                       |
| S7   | Биллинг (ЮKassa)                                  | ✅ 25.09 (mock ЮKassa)            | `src/saas/billing/*`, миграция 60; тесты S10, S11 на mock; тестовый магазин — не подключён                                                                                                                                |
| S8   | Эксплуатация, масштабирование                     | ✅ 25.09 (частично)               | `src/saas/ops/*`, `deploy/saas/*`, `docs/saas/s8-operations.md`; Redis-лимитер S15 на настоящем Redis; compose и нагрузка — не запускались                                                                                |
| S9   | Панель владельца, юр. шаблоны, Маркет             | ✅ 25.09 (шаблоны — юристу)       | `src/saas/owner/*`, `src/cli/owner.ts`, миграция 55, `docs/saas/legal/*`, `docs/saas/marketplace.md`, `docs/saas/s9-owner.md`                                                                                             |
| S10  | Пилот и приёмка                                   | ⏳ blocked (нужны реальные среды) | `docs/saas/acceptance-report.md` — критерии §18 с честными статусами                                                                                                                                                      |

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

### Объединение волны 2 (2026-09-25)

- `src/saas/web.ts`: кабинет `/app` и панель `/owner` подключаются к `buildSaasHttpApp` по умолчанию (`saasWebHttpOptions`), обратный вызов Bitrix24 с `state` кабинета → кабинет; зависимости — из `SaasRuntime` (тот же `ApprovalService`, что исполняет вызовы MCP).
- Код сверки подтверждения — один источник (`src/saas/cabinet/approval-link.ts`): до объединения код в чате и на странице кабинета различались.
- `request.ip` учитывает `X-Forwarded-For` только от `TRUSTED_PROXIES` (лимиты входа кабинета и панели за nginx); разбор KEK общий (`parseKek` в `keyring.ts`) — секреты TOTP из CLI расшифровываются веб-процессом (`runtime.ownerSecrets`).
- Задача worker `retention.data_deletion` (§6.3): через 30 дней после удаления приложения или остановки подписки — `TenantDataDeletion` (криптоудаление DEK, удаление строк).
- Весь набор: 67 файлов, 702 теста; e2e `integration/saas-runtime` поднимает web с кабинетом и панелью.

### S9 (2026-09-25): панель владельца `/owner`, юридические шаблоны, материалы Маркета

- `registerOwnerPanel(app, deps)` (`src/saas/owner/`): арендаторы (домен, тариф, статусы, учёт, коды ошибок из аудита через `withTenant`), карточка арендатора, платежи и счета, тарифы, объявления кабинета, метрики, журнал. Действия: продление пробного периода, блокировка/разблокировка с причиной (отзыв через `revokeTenant` S4), отметка оплаты счёта и возврат (`SubscriptionService` S7), правка тарифов, объявления — каждое пишет `support_actions`. Роли `service_owner`/`support`. Данных порталов и токенов в панели нет (D15).
- Вход: email + пароль (scrypt) + TOTP RFC 6238 (`node:crypto`, ±1 шаг, защита от повтора), блокировка после 5 неудач на 15 мин, лимиты по IP/учётной записи через `Coordination`; cookie `HttpOnly; Secure; SameSite=Strict`, CSRF + Origin, CSP `default-src 'self'; frame-ancestors 'none'` без inline.
- CLI `npm run owner -- create|reset-password|reset-totp|disable|enable|list`; секрет TOTP — один раз и только в stderr-терминал. Миграция PG 55 (`pg-migrations/s9.ts`): поля входа `owner_users`, `owner_sessions`, `announcements`.
- Шаблоны `docs/saas/legal/` (оферта с поручением по ч.3 ст.6 152-ФЗ, политика ПДн, согласие, условия автосписания, SLA) — **юристом не проверены**. `docs/saas/marketplace.md` — чек-лист и черновики карточки по зеркалу документации `market/*` (регион RU не проверен; конфликты: on-premise, журнал ответов 3 дня, полный scope `user`).
- Тесты +25: `unit/s9-totp` (векторы RFC 4226/6238/4648), `integration/s9-owner-panel` (настоящий PostgreSQL, AS S4, биллинг S7 с mock ЮKassa, CLI в псевдотерминале).
- Не проверено: реальный браузер и аутентификатор, стенд за nginx, Redis-лимиты входа, тестовый магазин ЮKassa, юрист, модерация Маркета.

### S5 (2026-09-25): кабинет клиента `/app`

- `src/saas/cabinet/*`: `createCabinet`/`registerCabinet(app, deps)` (самостоятельный модуль; сборка режима saas передаёт `CabinetDeps` и маршрут `GET /b24/oauth/callback` для `isCabinetState(state)` → `cabinet.replyBitrixCallback`). Страницы: начало (подписка, использование), подключение (адрес MCP, инструкции Claude Desktop/Code/claude.ai/ChatGPT, «Проверить подключение» по аудиту), подтверждения по `approvalUrl` (план целиком, код сверки `approvalShortCode`), история, файлы для `disk_upload_file`, администрирование арендатора (пользователи/роли/отключение с отзывом, модули, политика подтверждений, лимит в сутки, output policy), оплата (страница провайдера, смена тарифа, отмена/возобновление, счёт юрлицу), удаление всех данных.
- Безопасность: CSP `default-src 'self'` без JS, cookie `__Host-…; HttpOnly; Secure; SameSite=Lax`, CSRF + Origin, лимиты входа/решений, одноразовый state входа с привязкой к браузеру, одинаковый 404 для чужих/несуществующих операций (S12), повышенный риск (удаление/`destructiveHint`) — слово ПОДТВЕРЖДАЮ + вход не старше 15 минут; политика `admin_for_high_risk`.
- `src/saas/tenant-deletion.ts` — `TenantDataDeletion` (S13): отзыв, криптоудаление DEK, удаление строк (RLS и каталог), файлы; платежи/счета сохраняются; запись в `support_actions`.
- Миграция PG 50: `cabinet_sessions` под RLS (+ внешние ключи с каскадом), `cabinet_login_states`. Ядро: `OperationsStore.listRecent`, `AuditLog.lastSuccessAt`, `FileStaging.purgeAll`.
- Тесты: +22 (`integration/s5-cabinet` на настоящем PostgreSQL — 14, `unit/s5-cabinet-units` — 8).
- Не проверено: реальный портал и браузер, реальные клиенты Claude/ChatGPT, реальный платёж; письмо о удалении — через `CabinetNotifier` сборки (SMTP нет); встроенная страница приложения в Bitrix24 (iframe) — не сделана.

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

- 2026-09-25, сборка: инструменты вне тарифа регистрируются отключёнными (как T10 single); при смене тарифа посреди сессии — `FEATURE_UNAVAILABLE`. `src/saas/dispatch-hooks.ts`.
- 2026-09-25, сборка: обслуживание операций при сборке контекста в saas выключено — делает worker `retention.cleanup` (иначе экземпляры мешают друг другу). `src/saas/worker-tasks.ts`.
- 2026-09-25, сборка: `/metrics` — только loopback без прокси или `Bearer METRICS_TOKEN`, иначе 404. `src/saas/http.ts`.
- 2026-09-25, S5: при политике `admin_for_high_risk` операции повышенного риска подтверждает только администратор арендатора. `src/saas/cabinet/`.
- 2026-09-25, S3/S4: длина `state` входа через Bitrix24 до 1024 (запечатанное состояние AS длиннее 256) — проверить на реальном портале. `src/saas/bitrix/login-service.ts`.

- 2026-09-25, S1.1: `PUBLIC_BASE_URL` допускает `http://` только для loopback (как `MCP_PUBLIC_URL` базового ТЗ) — для локальной разработки SaaS; внешний адрес — только https. `src/config/env.ts` `parseDeployment`.
- 2026-09-25, S2: тарифы, подписки, платежи, клиенты OAuth и учёт — в каталоге без RLS (нужны до выбора арендатора и владельцу; данных порталов нет); данные арендатора — под RLS. `src/storage/pg-migrations.ts`.
- 2026-09-25, S2: кэш capabilities — в памяти процесса (промах = повторный `method.get`), а не в БД. `src/storage/memory-cache.ts`.
- 2026-09-25, S1.1: файловое хранилище, панель `/admin` и output policy пока в `Platform` (общие); привязка файлов и политики к арендатору — срезы S1.2 и S5. `src/app/container.ts`.

## Грабли

Общие грабли проекта — в `docs/STATUS.md` (раздел «Грабли»): они действуют и здесь.

## Вопросы владельцу

См. ТЗ §20 — не блокируют работу, до ответа действуют допущения.

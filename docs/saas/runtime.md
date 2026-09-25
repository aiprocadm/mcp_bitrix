# Сборка режима saas: процесс, маршруты, переменные, worker

SaaS-ТЗ §5.1–5.2, §7, §8, §9, §10, §11.2, §12, §13, §15, §17. Код: `src/saas/runtime.ts` (сборка процесса),
`src/saas/http.ts` (HTTP), `src/saas/dispatch-hooks.ts` (тариф/учёт/метрики/approvalUrl в диспетчере),
`src/saas/worker-tasks.ts` (задачи worker), `src/saas/main.ts` (запуск web/worker), `src/index.ts`
(`DEPLOYMENT_MODE=saas` → `startSaas`). Тесты: `tests/integration/saas-runtime.test.ts` (настоящие PostgreSQL 16 и
redis-server, имитации облака Bitrix24 и API ЮKassa), `tests/unit/saas-runtime-units.test.ts`.

## Что собирается (`createSaasRuntime(config, opts?)`)

| Часть               | Как                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL          | `PostgresSqlDb.open({ requireRls: true })` — роль без SUPERUSER/BYPASSRLS, миграции под advisory-блокировкой; `PlansRepo.seedDefaults()`                                                            |
| Ключи               | KEK из `KEK_FILE` (64 hex / base64 / 32 байта) → `TenantKeyRing`; из KEK через HKDF — ключ псевдонимов аудита и ключ платформы. Секреты из файлов регистрируются в редакторе логов                  |
| Координация         | `RedisCoordination(REDIS_URL, REDIS_NAMESPACE, REDIS_COMMAND_TIMEOUT_MS)`; тесты могут передать `InMemoryCoordination`                                                                              |
| Platform            | та же структура, что в single, но `db` — PostgreSQL, `sqlite` нет, `/admin` отключён (обращение — `FEATURE_UNAVAILABLE`)                                                                            |
| S3 Bitrix24         | `BitrixOAuthClient`, `BitrixTokenStore`, `BitrixOAuthProviderFactory`, `BitrixInstallService`, `BitrixEventsService`, `BitrixLoginService`, `BitrixAppStatusService`                                |
| S4 AS               | `SigningKeyStore.open`, `AuthorizationServer` (вход — `BitrixLoginGatewayAdapter` поверх `BitrixLoginService`), `SaasTokenVerifier`                                                                 |
| S6/S7               | `UsageMeter`, `EntitlementService`, `SubscriptionService` (+ `YooKassaProvider`, если задан `YOOKASSA_SHOP_ID`); уведомления биллинга по умолчанию — только журнал (письма — отдельный этап)        |
| Лимитер портала     | `ClusterPortalLimiter` на `portalKeyForMember(member_id)` — общий для всех пользователей арендатора и (через Redis) для всех экземпляров; обёртка отмечает «вызов дошёл до Bitrix24»                |
| Реестр контекстов   | `TenantScopeRegistry` (TTL 60 с); сброс по `tenant-invalidate` (S3), `saas:access-revoked` (S4); `billing:entitlements` сбрасывает снимки тарифа (`entitlements.listen`)                            |
| Контекст арендатора | `createTenantScope(platform, { auth: provider пользователя, allowedHosts: только хост портала, limiter портала, secretBox: DEK арендатора, maintenance: false, onMutationFinished → учёт записи })` |

Принципал операций и подтверждений в saas — `tenant_users.id` (соглашение S4 `revokeUser`). Роль сессии — роль
пользователя в сервисе, суженная scope токена (`mcp:read` → `reader`).

Обслуживание при сборке контекста (T16 executing → unknown) в saas **выключено**: контекст пересобирается на
запрос и на нескольких экземплярах, и чужое выполняющееся действие нельзя объявлять unknown. Эту работу делает
worker (`retention.cleanup`: executing старше 15 минут → unknown).

### Поля `SaasRuntime` для кабинета (/app) и панели владельца (/owner)

`db`, `keyring`, `coordination`, `registry`, `repos` (`tenants`, `users`, `tenantSettings`, `plans`,
`subscriptions`), `bitrix` (`login` — вход в кабинет через Bitrix24, `urls`, `tokens`, `appStatus.lastStatus`),
`oauth.server` (`revokeUser`, `revokeTenant`, `consents`), `billing` (`entitlements`, `usage` — `report`/`ownerReport`,
`subscriptions` — checkout/cancel/changePlan/invoices/refund), `fileStaging.forTenant(id)`, `audit`, `metrics`,
`tenantApprovals(tenantId)` → `{ operations, approvals, portalKey }` (подтверждение плана:
`approvals.approve(operationId, tenantUserId, portalKey)`), `scopeFor(tenantId, userId)`, `onInvalidate(listener)`.
Ссылка и код сверки — `approvalUrl()` и `approvalShortCode()` из `src/saas/dispatch-hooks.ts`.

## Путь вызова инструмента (хуки диспетчера)

`src/mcp/register-tools.ts` получил необязательные `DispatchHooks` (в single не передаются — путь прежний):

1. лимит входящих → `gate` (как в single) → `beforeHandler`: `EntitlementService.check` — `SUBSCRIPTION_INACTIVE`,
   `FEATURE_UNAVAILABLE` (`NOT_IN_PLAN`/`MODULE_DISABLED`/`DESTRUCTIVE_NOT_IN_PLAN`), `QUOTA_EXCEEDED`; диагностика
   всегда доступна;
2. схема → handler внутри `around`: счётчик обращений к Bitrix24 на вызов (AsyncLocalStorage + слот лимитера);
   если был хотя бы один запрос — `usage.recordCall` (ошибки валидации и отказы политики не считаются, D11);
3. `APPROVAL_REQUIRED` → `approvalUrl = ${PUBLIC_BASE_URL}/app/approvals/<operationId>`, `approvalCode`, `nextAction`
   про кабинет; метрика `mcp_tool_calls_total{tool,outcome}`, `mcp_tool_duration_seconds`;
4. запись `succeeded`/`unknown` → `usage.recordWrite` (наблюдатель `MutationExecutor.onFinished`).

`tools/list` сессии строится по снимку тарифа на момент `initialize`: инструменты вне тарифа/выключенного модуля
регистрируются отключёнными (как скрытые инструменты single, T10) — их нет в списке, а прямой вызов SDK отклоняет
(`InvalidParams: Tool … disabled`). Если тариф сменился посреди сессии, вызов видимого инструмента получает
`FEATURE_UNAVAILABLE`/`NOT_IN_PLAN` от `check` (S09). Новая сессия видит новый список.

## HTTP (`buildSaasHttpApp(runtime, opts?)`)

| Маршрут                                                                           | Что делает                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST/GET/DELETE /mcp`                                                            | Streamable HTTP; каждый запрос — `SaasTokenVerifier` (401/403 + `WWW-Authenticate` с `resource_metadata`); токен в query → 400; Origin — allowlist |
| `GET /.well-known/oauth-authorization-server`, `…/oauth-protected-resource[/mcp]` | метаданные RFC 8414 / RFC 9728 (CORS `*`)                                                                                                          |
| `GET /oauth/jwks`, `POST /oauth/register` (JSON), `GET /oauth/authorize`          | S4                                                                                                                                                 |
| `POST /oauth/login`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke` (форма)    | S4; повтор параметра формы → массив → `invalid_request`                                                                                            |
| `GET /b24/oauth/callback`                                                         | `state` сервера авторизации (`mcpas.`) → `bitrixCallback`; иначе `opts.cabinetCallback` (вход в кабинет), без него — 404 со страницей              |
| `POST /b24/events`                                                                | тело как есть → `runtime.handleBitrixEvent` → 200 / `handlerHttpStatus` (403 подделка, 400 формат)                                                 |
| `POST` и `GET /b24/install`                                                       | мастер установки: `prepareInstall(parseLaunchParams)` → страница с BX24.js и `BX24.installFinish()`; `frame-ancestors` — только домен портала      |
| `POST /billing/hooks/yookassa` (и `/billing/hooks`)                               | `handleNotification(body, адрес клиента)`; не принято → 400                                                                                        |
| `GET /healthz`                                                                    | процесс жив                                                                                                                                        |
| `GET /readyz`                                                                     | `SELECT 1` PostgreSQL и `PING` Redis → 200/503 (без версий и деталей)                                                                              |
| `GET /metrics`                                                                    | Prometheus; только loopback **без** заголовков прокси или `Authorization: Bearer <METRICS_TOKEN>`; иначе 404                                       |

- **Сессии MCP** привязаны к (арендатор, пользователь, роль): сессия другого пользователя/арендатора — 404, как
  несуществующая (§12 п.2). Отзыв пользователя, удаление приложения, сброс контекста → сессии закрываются, клиент
  получает 404 и открывает новую (со свежим токеном). Если токены Bitrix24 пользователя недействительны при
  открытии сессии — 401 `invalid_token`: MCP-клиент повторяет вход через сервер авторизации, вход обновляет токены.
- **Адрес клиента**: адрес соединения; если соединение от `TRUSTED_PROXIES` — самый правый адрес X-Forwarded-For
  вне доверенных. Используется для списка адресов ЮKassa и лимита регистраций DCR.
- **Заголовки**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (если
  маршрут не задал CSP сам), HSTS при https. Host — только домен `PUBLIC_BASE_URL`, `MCP_ALLOWED_HOSTS` и loopback
  (проверки здоровья в контейнере).
- **Лимиты тела**: 1 МиБ по умолчанию (`opts.bodyLimit`), 64 КиБ для `/oauth/*`, `/b24/*`, `/billing/hooks`.
- **Кабинет и панель владельца**: `opts.extraRoutes(app)` вызывается в отдельном контексте Fastify (свои хуки и
  парсеры). Парсер `application/x-www-form-urlencoded` маршрутов этого файла инкапсулирован и в `extraRoutes` не
  виден — кабинет регистрирует свой. `opts.cabinetCallback` — обработчик возврата из Bitrix24 для входа в кабинет.

## Удаление приложения (§4 сценарий 6)

`handleBitrixEvent` после `ONAPPUNINSTALL` (S3: арендатор `uninstalled`, токены Bitrix24 удалены, поколения +1,
неисполненные операции `denied`) дополнительно: `revokeTenant` (refresh-токены сервиса), `stopForUninstall`
(подписка в работе → `canceled` с отметкой остановки — отсчёт 30 дней хранения; сохранённый способ оплаты стёрт —
автосписаний нет; `renewDue` её больше не трогает), сброс контекстов и закрытие сессий. Повтор события
идемпотентен. Остаток оплаченного периода автоматически не возвращается (возврат — владелец, `refund`). При
переустановке пробный период не повторяется (§9.1): нужна оплата в кабинете.

## Worker (`PROCESS_ROLE=worker`)

Лидер по аренде в Redis (`WorkerRunner`, S8), служебный HTTP на `MCP_HOST:MCP_PORT`: `/healthz`, `/readyz`
(с полем `leader`), `/metrics` (те же правила доступа). Задачи (`WORKER_TASKS`, `WORKER_TASK_INTERVALS`):

| Задача                 | Интервал по умолчанию | Что делает                                                                                                      |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `usage.flush`          | 60 с                  | счётчики Redis → PostgreSQL (web тоже сбрасывает свои раз в минуту и при остановке)                             |
| `billing.renewals`     | 5 мин                 | `renewDue()` (метрики продлений) и `reconcilePending()`                                                         |
| `bitrix.app_info`      | сутки                 | `checkAppStatus` каждого `active`/`suspended` арендатора                                                        |
| `retention.cleanup`    | час                   | истёкшие планы и idempotency, executing старше 15 мин → unknown, курсоры, файлы staging, аудит старше 90 дней   |
| `oauth.dcr_cleanup`    | сутки                 | `AuthorizationServer.runMaintenance()` — клиенты без использования, коды, refresh, ротация ключа                |
| `bitrix.token_refresh` | сутки                 | refresh-токен Bitrix24 старше 150 дней (живёт 180) → обновление тем же single-flight; отказ → `reauth_required` |

Проактивное обновление **access**-токенов (1 час) worker не делает: провайдер обновляет их сам при запросе
(< 60 с до истечения — фоном, по `expired_token` — синхронно).

## Переменные окружения (дополнительно к S1–S8)

| Переменная                                    | Смысл                                                                                     | Секрет |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `OAUTH_SIGNING_ALG`, `OAUTH_*_TTL_SEC`, …     | параметры сервера авторизации (`docs/saas/s4-oauth.md`), разбираются в `deployment.oauth` | нет    |
| `REDIS_NAMESPACE`, `REDIS_COMMAND_TIMEOUT_MS` | S8, в `deployment.ops`                                                                    | нет    |
| `WORKER_*`, `PORTAL_LIMIT_FALLBACK_RPS`       | S8, в `deployment.ops` (`readOpsSettings`; ошибка → `CONFIG_INVALID` по полю)             | нет    |
| `TRUSTED_PROXIES`                             | IP/CIDR прокси, которым доверяется X-Forwarded-For                                        | нет    |
| `METRICS_TOKEN_FILE`                          | файл с Bearer-токеном `/metrics` (≥ 16 символов)                                          | да     |
| `READ_ONLY_MODE`                              | в saas по умолчанию `false` — аварийный выключатель (§15)                                 | нет    |
| `ENABLED_MODULES`                             | в saas по умолчанию все модули (сужают тариф и администратор арендатора)                  | нет    |

В saas запрещены: `MCP_AUTH_MODE=oauth` (сервис сам — сервер авторизации), `ADMIN_PANEL_ENABLED=true`
(подтверждения — в кабинете). `SELLER_*` обязательны (без реквизитов биллинг не собирается, S7).

## Проверено / не проверено

- **Проверено** (`tests/integration/saas-runtime.test.ts`, настоящие PostgreSQL 16 и redis-server, HTTP через
  настоящий Fastify, MCP-клиент SDK): установка событием → арендатор с пробным периодом; поддельное
  `ONAPPUNINSTALL` → 403; DCR + authorize (PKCE S256, resource) → вход через Bitrix24 (обмен кода на сервере
  авторизации Bitrix24, `profile`) → согласие → токен; initialize и tools/list по тарифу; чтение доходит до портала
  токеном пользователя и только на его хост; учёт вызова (ошибка валидации не считается) и сброс в PostgreSQL;
  запись → `APPROVAL_REQUIRED` + `approvalUrl`; подтверждение → запись ровно один раз, учёт записи; изоляция двух
  арендаторов (сессия, operationId, подтверждения, хост портала); модуль вне тарифа (скрыт / `FEATURE_UNAVAILABLE`);
  `QUOTA_EXCEEDED` при работающей диагностике; отзыв пользователя → 401 и `denied`; уведомление ЮKassa только через
  доверенный прокси; удаление приложения → доступ и биллинг остановлены, повтор идемпотентен; задачи worker;
  процесс worker (`startSaas`) берёт лидерство, `/readyz`, `/metrics`; `/metrics` снаружи — 404, Host — allowlist.
- **Не проверено**: реальный портал Bitrix24 и `oauth.bitrix.info` (установка, мастер с BX24.js во фрейме, доставка
  событий, длина `state` до ~600 символов в `/oauth/authorize/` Bitrix24 — в S3 лимит поднят с 256 до 1024 под
  состояние сервера авторизации, реальный предел Bitrix24 не известен); реальные Claude/ChatGPT; тестовый/боевой
  магазин ЮKassa; docker compose (том `appdata`, секреты `b24_client_secret`, `yookassa_secret_key`,
  `metrics_token` добавлены, но не запускались); нагрузка §13.
- **Не сделано в этом срезе**: письма (`BillingNotifier` — только журнал), криптоудаление данных арендатора через
  30 дней (`dataDeletionDue` — событие без исполнителя, S9), лимиты входящих на арендатора и глобальный (§9.3 п.4;
  сейчас — на пользователя в процессе), MCP-сессии в Redis (сессии живут в памяти экземпляра — nginx закрепляет их
  по `Mcp-Session-Id`), уведомление `tools/list_changed` при смене тарифа.

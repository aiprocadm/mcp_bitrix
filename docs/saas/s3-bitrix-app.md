# S3: тиражное приложение Bitrix24 и OAuth-токены пользователей

SaaS-ТЗ §7.2–7.4, §8, решения D1–D4, D7; тесты S03, S04, S17. Код — `src/saas/bitrix/`, миграция PG 30
(`src/storage/pg-migrations/s3.ts`), методы реестра — `src/bitrix/registry/saas-app.ts`.

Все внешние контракты — по официальной документации Bitrix24 (зеркало репозитория документации apidocs,
ссылки — в комментариях к коду): `settings/oauth/{index,auto-renewal,error-codes,simple-way}.md`,
`settings/app-installation/mass-market-apps/{installation-callback,installation-master}.md`,
`api-reference/common/events/{on-app-install,on-app-uninstall,on-app-update}.md`,
`api-reference/events/{event-bind,event-get,safe-event-handlers}.md`, `api-reference/common/system/app-info.md`,
`api-reference/common/users/profile.md`, `api-reference/rest-v3.md`.

## Компоненты

| Файл                 | Что делает                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`        | `BitrixAppSettings` (client_id, client_secret, адрес сервера авторизации, `PUBLIC_BASE_URL`), проверка, публичные адреса обработчиков (`/b24/events`, `/b24/install`, `/b24/oauth/callback`, `/app`)                                                      |
| `oauth-client.ts`    | `BitrixOAuthClient` — единственный сетевой файл модуля: `GET <oauth>/oauth/token/` (обмен `code`, обновление). Внедряемый fetch, allowlist хоста, таймаут 10 с, без перенаправлений, лимит ответа 64 КБ; URL (в нём секрет) и тексты ошибок не логируются |
| `token-store.ts`     | `BitrixTokenStore` — `bitrix_tokens` под RLS; access/refresh — `SecretBox` арендатора (DEK), AAD `bitrix-token:<tenant>:<user>`; `generation` +1 при каждой новой паре; условная запись `saveRefreshed(…, expectedGeneration)`                            |
| `user-provider.ts`   | `BitrixOAuthUserProvider implements BitrixAuthProvider` и `BitrixOAuthProviderFactory`                                                                                                                                                                    |
| `portal.ts`          | Вызовы REST портала через `BitrixClient` (`PortalClientFactory`), `profile`, `event.get`→`event.bind`                                                                                                                                                     |
| `event-payload.ts`   | Разбор тела события (форма PHP `auth[member_id]=…` или JSON) и параметров запуска мастера; `handlerHttpStatus(err)`                                                                                                                                       |
| `install-service.ts` | `BitrixInstallService`: `ONAPPINSTALL`, мастер установки (`prepareInstall`), `ONAPPUPDATE`                                                                                                                                                                |
| `events-service.ts`  | `BitrixEventsService.handle(body)` — диспетчер событий; `ONAPPUNINSTALL`                                                                                                                                                                                  |
| `login-service.ts`   | `BitrixLoginService` — вход сотрудника через Bitrix24 (для S4): адрес авторизации только для установленного портала, обмен кода                                                                                                                           |
| `app-status.ts`      | `BitrixAppStatusService.checkAppStatus(tenantId)` — `app.info` для worker (раз в сутки), таблица `tenant_app_status`                                                                                                                                      |
| `invalidation.ts`    | Канал `tenant-invalidate` в `Coordination`: `<tenantId>` или `<tenantId>:<userId>`                                                                                                                                                                        |

## Установка: выбранный документированный путь

Арендатор создаётся **только событием `ONAPPINSTALL`**: в нём и токены установившего, и `application_token` для
проверки всех последующих событий. Событие приходит:

- приложению без интерфейса — на «Event installation handler URL» (installation callback), сразу после установки;
- приложению с интерфейсом (наш случай: страница приложения = кабинет, §8) — после `BX24.installFinish()` на
  обработчик, который мастер установки подписал через `event.bind` («The handler for this event can be set in the
  installation script», `on-app-install.md`). Это делает `prepareInstall(parseLaunchParams(POST мастера))`:
  подписка на `ONAPPINSTALL`, `ONAPPUNINSTALL`, `ONAPPUPDATE` → страница мастера вызывает `BX24.installFinish()`.

Подлинность `ONAPPINSTALL`:

1. Если арендатор уже работает (`active`/`suspended`) — `sha256(application_token)` сравнивается с сохранённым в
   постоянное время; несовпадение → 403 без сетевых запросов (`safe-event-handlers.md`).
2. Пара токенов проверяется **на сервере авторизации** (обновление по `refresh_token` с нашим `client_secret`):
   документация требует «a working access token confirms the authenticity», но `client_endpoint` из запроса пишет
   отправитель — обращаться по нему нельзя (SSRF, подмена портала). Сервер авторизации возвращает доверенные
   `member_id`, `client_endpoint`, `user_id`; `member_id` должен совпасть с заявленным, иначе 403.
3. `profile` по доверенному адресу → Bitrix `ID`, имя, `ADMIN`.

Дальше: `TenantsRepo.upsertInstalled` (appTokenHash = sha256), установщик → `administrator`, его токены → `bitrix_tokens`,
`event.get`→`event.bind` на `ONAPPUNINSTALL`/`ONAPPUPDATE` (без дублей), пробный период `trial` — только если
`claimTrial` удался (один раз на `member_id`, §9.1). Ошибка подписки на события не отменяет установку, а попадает в
`warnings` результата (показать в кабинете).

`ONAPPUPDATE` приносит новый `application_token`: принимается, только если пара подтверждена сервером авторизации и её
владелец — администратор портала (`profile.ADMIN`); затем переподписка (обработчики удаляются при обновлении версии —
`event-bind.md`). `ONAPPUSERREADY` и прочие события: проверяется подпись, содержимое игнорируется (D3 — системный
пользователь приложения не используется).

## Удаление приложения (`ONAPPUNINSTALL`, S04)

Токенов в событии нет, поэтому сверка `application_token` — единственная проверка. Неизвестный `member_id`, нет токена,
несовпадение → `ACCESS_DENIED` (403), ничего не меняется. Верное событие — **одной транзакцией** `withTenant`: арендатор
`uninstalled`, все `bitrix_tokens` арендатора удалены, `token_generation + 1` всем пользователям (выданные MCP-токены
сервиса отклоняются — S4), операции `prepared`/`approved` → `denied`; затем `publish('tenant-invalidate', tenantId)`.
`data.CLEAN = 1` возвращается как `cleanRequested` — удаление данных по регламенту §6.3/§14 делает S9/worker.

## Токены пользователя и обновление (S03, S17)

- `getAuth('legacy')` → `https://<портал>/rest/` + `{auth: access_token}`; `getAuth('v3')` → `https://<портал>/rest/api/`
  - `{auth}` (`rest-v3.md`: «For applications, pass the authorization token in the auth field in the request body»).
- `portalKey` = sha256(`bitrix24-member:<member_id>`)[:16] — одинаков для всех пользователей арендатора;
  `identityUserId` = Bitrix ID пользователя; `allowedHosts` = только хост портала (для `BitrixClient`).
- Проактивно: если access живёт < 60 с, `getAuth` запускает фоновое обновление, `ensureFresh()` его дожидается.
- `tryRefresh()` (BitrixClient вызывает один раз при `BITRIX_AUTH_FAILED`): блокировка `Coordination.withLock`
  на `bitrix-token-refresh:<tenant>:<user>` → чтение пары из БД → если поколение уже сменилось и токен свеж, берётся
  готовая пара без запроса (refresh_token одноразовый) → иначе запрос на сервер авторизации → `saveRefreshed` с
  проверкой поколения. S03: два экземпляра → один запрос `refresh_token`, оба получают одну и ту же новую пару.
- Отказ `invalid_grant` / `PAYMENT_REQUIRED` → токены удалены, пользователь `reauth_required` (поколение +1), сброс
  кэша контекста, `BITRIX_AUTH_FAILED` c `reason` (`OAUTH_invalid_grant`, `OAUTH_PAYMENT_REQUIRED`) и `nextAction` со
  ссылкой на кабинет; провайдер запоминает отказ и дальше отвечает им **без сетевых запросов**; другие экземпляры
  получают `REAUTH_REQUIRED` при открытии провайдера (S17). `invalid_client`/`invalid_request` — ошибка конфигурации
  сервиса: токены пользователя не трогаются. Сбой сети/5xx — `BITRIX_UPSTREAM_ERROR` (retryable), без `reauth`.
- Повторный вход сотрудника (`BitrixLoginService.completeLogin`) сохраняет новую пару и возвращает статус `active`.

## Сборка режима saas (что подключить)

```ts
const settings = validateBitrixAppSettings({ clientId, clientSecret, oauthServerUrl, publicBaseUrl });
const urls = bitrixAppUrls(settings);
const oauth = new BitrixOAuthClient({ settings, fetch, logger });
const tokens = new BitrixTokenStore(db, keyRing);
const portal: PortalClientFactory = (auth, hosts) => new BitrixClient({ auth, allowedHosts: hosts, fetch, limiter, logger, … });
const providers = new BitrixOAuthProviderFactory({ tenants, users, tokens, oauth, coordination, logger, urls });
// TenantScope: const auth = await providers.open(tenantId, userId); createTenantScope(platform, { auth, allowedHosts: auth.allowedHosts, … })
const install = new BitrixInstallService({ tenants, users, plans, subscriptions, tokens, oauth, portal, coordination, logger, urls });
const events = new BitrixEventsService({ db, tenants, install, coordination, logger });
// POST /b24/events  → events.handle(rawBody)            → 200 {status:'ok'} | handlerHttpStatus(err)
// POST /b24/install → install.prepareInstall(parseLaunchParams(rawBody)) → страница с BX24.installFinish()
// worker (раз в сутки): new BitrixAppStatusService({ … }).checkAppStatus(tenantId)
// подписка: coordination.subscribe('tenant-invalidate', m => { const {tenantId, userId} = parseInvalidateMessage(m); registry.invalidate(tenantId, userId) })
```

## Переменные окружения

| Переменная                   | Смысл                                                                | Секрет |
| ---------------------------- | -------------------------------------------------------------------- | ------ |
| `B24_APP_CLIENT_ID`          | Код приложения (кабинет разработчика / форма локального)             | нет    |
| `B24_APP_CLIENT_SECRET_FILE` | Файл с `client_secret` (права 0600)                                  | да     |
| `B24_OAUTH_SERVER_URL`       | Origin сервера авторизации, по умолчанию `https://oauth.bitrix.info` | нет    |
| `PUBLIC_BASE_URL`            | Уже есть (S1): адреса `/b24/*` и кабинета                            | нет    |

## Что не проверено

- Всё выше проверено на **имитации** сервера авторизации и REST портала (формы ответов по документации) и на
  настоящем PostgreSQL 16. Установка на реальный портал, реальный `oauth.bitrix.info`, доставка событий Bitrix24 и
  кодировка их тел — **не проверены** (нужен тестовый портал и зарегистрированное приложение, §20 ТЗ).
- Адрес сервера авторизации для российских порталов: в зеркале документации указан только `oauth.bitrix.info`
  (ответы дают `server_endpoint`); если для облака .ru используется другой хост, он задаётся `B24_OAUTH_SERVER_URL`.
- Повтор доставки `ONAPPINSTALL` после того, как первая обработка уже обновила пару, будет отклонён сервером
  авторизации (refresh одноразовый) — первая обработка при этом уже сохранила арендатора.

# S4: сервер авторизации MCP

Код — `src/saas/oauth/*`, миграция PostgreSQL — `src/storage/pg-migrations/s4.ts` (40), тесты —
`tests/integration/s4-oauth.test.ts` (настоящий PostgreSQL), `tests/unit/s4-oauth-units.test.ts`.
ТЗ: SaaS-ТЗ D4, D5, §7.1, §7.2, §7.4, тесты S05–S07.

## Источник требований

Спецификация MCP, самая новая датированная версия **2026-07-28**
(`docs/specification/2026-07-28/basic/authorization/{index,authorization-server-discovery,client-registration,security-considerations}.mdx`
и `docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx` официального репозитория
modelcontextprotocol/modelcontextprotocol). Что из неё взято:

| Требование спецификации                                                                                   | Где                                                                        |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| RFC 9728: `authorization_servers`, `resource`, `scopes_supported` (без `offline_access`)                  | `AuthorizationServer.protectedResourceMetadata()`                          |
| RFC 8414: метаданные AS, `code_challenge_methods_supported: ["S256"]`                                     | `authorizationServerMetadata()`                                            |
| RFC 9207: `iss` в каждом ответе авторизации + `authorization_response_iss_parameter_supported`            | `redirect()` в `server.ts`                                                 |
| Client ID Metadata Documents (SHOULD) + `client_id_metadata_document_supported`                           | `clients.ts` (`ClientResolver`), `cimd-fetch.ts`                           |
| DCR RFC 7591 (MAY, «deprecated», для совместимости)                                                       | `register()`                                                               |
| PKCE S256 обязателен, plain отклоняется                                                                   | `authorize()`, `exchangeCode()`                                            |
| RFC 8707 `resource` в authorize и token, аудитория токена = ресурс                                        | `authorize()`, `exchangeCode()`, `SaasTokenVerifier`                       |
| Точное совпадение redirect_uri; только https или localhost                                                | `redirect-uri.ts`                                                          |
| Ротация refresh для публичных клиентов                                                                    | `RefreshTokensRepo.rotate`                                                 |
| 401 для неверного/просроченного токена, 403 `insufficient_scope`, `resource_metadata`                     | `verifier.ts` (`SaasTokenVerifier`, `requireScope`, `saasWwwAuthenticate`) |
| Экран согласия: имя клиента, права, хост redirect_uri, CSRF, запрет фреймов, предупреждение для localhost | `pages.ts`, `bitrixCallback()`, `consent()`                                |
| SSRF при загрузке документа клиента                                                                       | `cimd-fetch.ts`                                                            |

## Маршруты (подключает сборка режима saas)

Обработчики — чистые функции `OAuthRequest → OAuthResponse` (`status`, `headers`, `setCookies`, `body`), без
привязки к Fastify. Список — `OAUTH_ROUTES`.

| Маршрут                                                                                       | Обработчик                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /.well-known/oauth-authorization-server`                                                 | `asMetadataResponse()`                           |
| `GET /.well-known/oauth-protected-resource/mcp` и `GET /.well-known/oauth-protected-resource` | `resourceMetadataResponse()`                     |
| `GET /oauth/jwks`                                                                             | `jwksResponse()`                                 |
| `POST /oauth/register` (JSON)                                                                 | `register(req)` — `req.ip` обязателен для лимита |
| `GET /oauth/authorize`                                                                        | `authorize(req)`                                 |
| `POST /oauth/login` (форма)                                                                   | `login(req)`                                     |
| обратный вызов Bitrix24 (redirect приложения S3), если `isAuthServerState(query.state)`       | `bitrixCallback(req)`                            |
| `POST /oauth/consent` (форма)                                                                 | `consent(req)`                                   |
| `POST /oauth/token` (форма)                                                                   | `token(req)`                                     |
| `POST /oauth/revoke` (форма)                                                                  | `revoke(req)`                                    |

`req.query`/`req.body` — разобранные параметры (повтор параметра — массив → `invalid_request`),
`req.headers.cookie`, `req.headers.authorization` (Basic для конфиденциальных клиентов).

## Поток

1. `GET /oauth/authorize`: клиент (DCR или CIMD) и redirect_uri проверяются **до** любого перенаправления (иначе —
   страница ошибки, без редиректа). Затем `response_type=code`, PKCE S256, `resource` = `${PUBLIC_BASE_URL}/mcp`,
   `scope` ⊆ {`mcp:read`, `mcp:write`} (пусто — оба; `offline_access` принимается и не хранится). Ошибки — редирект
   с `error`, `state`, `iss`. Ответ — страница «адрес портала» и cookie привязки к браузеру
   (`__Host-mcp_as_bind`, HttpOnly, Secure, SameSite=Lax, 10 минут).
2. `POST /oauth/login`: CSRF (HMAC от cookie и состояния), портал должен быть установлен (`TenantsRepo.getByDomain`)
   → `BitrixLoginGateway.startLogin(portal, "mcpas.<запечатанное состояние>")` → 303 на Bitrix24.
3. Обратный вызов Bitrix24: состояние и cookie сверяются, `completeLogin(query)` → личность; арендатор из ответа
   Bitrix24 должен совпасть с выбранным порталом; пользователь создаётся/обновляется (`upsertFromBitrix`, роль по
   умолчанию из настроек арендатора); `disabled` → `access_denied`; `reauth_required` → `active` (вход только что
   состоялся). Есть сохранённое согласие на эту пару пользователь–клиент со всеми запрошенными правами — сразу код;
   иначе — экран согласия.
4. `POST /oauth/consent`: CSRF, согласие сохраняется (`mcp_consents`, под RLS), код (SHA-256 в БД, одноразовый,
   TTL ≤ 60 с) → 303 на redirect_uri с `code`, `state`, `iss`.
5. `POST /oauth/token`: `authorization_code` (code, redirect_uri, code_verifier, resource обязательны; код гасится
   до проверок; повтор кода — отзыв refresh, выданного по нему) или `refresh_token` (ротация; сужение scope
   допускается; `resource` необязателен, но если есть — должен совпасть).

Состояние между шагами — запечатанное AES-256-GCM (`StateSealer`: назначение в AAD, срок 10 минут, ключ — `state.key`
в каталоге ключей), без хранения в БД; работает на нескольких экземплярах без липких сессий.

## Токены

- **Access token** — JWT (заголовок `typ: at+jwt`, RFC 9068), 10 минут, ES256 (или EdDSA/Ed25519). Claims: `iss` =
  `PUBLIC_BASE_URL`, `aud` = `${PUBLIC_BASE_URL}/mcp`, `sub` = `tenant_users.id`, `tid`, `scope`, `gen` =
  `token_generation` пользователя, `jti`, `client_id`, `iat`, `exp`.
- **Refresh token** — непрозрачный (`mcpr_…`, 256 бит), в БД SHA-256, 30 дней от последней ротации, семья
  (`family_id`). Повтор ротированного → вся семья отозвана (S06). Привязан к клиенту: чужой клиент получает
  `invalid_grant` без порчи токена владельца.
- **Ключи подписи** — `OAUTH_SIGNING_KEYS_DIR/jwt-<kid>.json` (0600, kid = отпечаток RFC 7638). Ротация: вручную
  `SigningKeyStore.rotate()` или автоматически по возрасту (30 дней, `runMaintenance`/при подписи); прежний ключ
  остаётся в JWKS на срок access token + 60 с, затем файл удаляется. Неизвестный kid → перечитывание каталога
  (другой экземпляр мог выпустить ключ).

## Проверка токена на MCP-запросе

`SaasTokenVerifier.verify(authorizationHeader)` → `{ tenantId, userId, bitrixUserId, role, scopes, clientId,
expiresAt, jti }` или `McpAuthError` (тот же класс, что в `src/auth/mcp-auth.ts`: `status` 400/401/403, `code`).
Порядок: Bearer → подпись/`typ`/`iss`/`aud`/`exp` → отзыв по `jti` (Coordination) → арендатор `active` →
пользователь `active` → `gen` равен текущему поколению (иначе 401 — §7.4, S07). Роль: `mcp:write` → роль
пользователя в сервисе; только `mcp:read` → `reader`. Для 401/403 — заголовок
`saasWwwAuthenticate(settings, err, requiredScopes)`; недостаток прав у конкретного инструмента — `requireScope`.
`src/auth/mcp-auth.ts` не менялся (режим single/oauth работает как прежде).

## Отзыв (§7.4)

- `revokeUser(tenantId, userId)`: все refresh пользователя, `bumpGeneration` (выданные access отклоняются сразу),
  операции `prepared/approved` пользователя → `denied` (соглашение: `principal_id` операций в saas =
  `tenant_users.id`), сообщение в канал `REVOCATION_CHANNEL` (`{"tenantId","userId"}`) для сброса
  `TenantScopeRegistry` на всех экземплярах.
- `revokeTenant(tenantId)`: то же для всех пользователей портала (одной транзакцией под RLS).
- `POST /oauth/revoke` (RFC 7009): refresh — вся семья; access — `jti` в Coordination до истечения токена.

## Хранилища (миграция 40)

`mcp_clients` (+ `kind` dcr/cimd, `metadata_json`, `secret_hash`, `metadata_expires_at`), `mcp_auth_codes`
(+ `family_id`, `token_generation`), `mcp_refresh_tokens` (+ `token_generation`), `mcp_consents`; каскадное удаление
кодов, refresh и согласий вместе с клиентом и арендатором (ссылочные действия PostgreSQL выполняются без RLS —
проверено тестом удаления клиента). Задача worker — `AuthorizationServer.runMaintenance()`: клиенты без
использования 30 дней, истёкшие коды и refresh, ротация ключа по возрасту.

## Настройки (`OAuthServerSettings`, `resolveOAuthSettings`)

| Переменная окружения (предложение)        | Поле                                                         | По умолчанию | Секрет                                                             |
| ----------------------------------------- | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------ |
| `PUBLIC_BASE_URL`                         | `publicBaseUrl`                                              | —            | нет                                                                |
| `OAUTH_SIGNING_KEYS_DIR`                  | `signingKeysDir`                                             | —            | **да** (каталог с закрытыми ключами, 0700; общий том для всех web) |
| `OAUTH_SIGNING_ALG`                       | `signingAlg` (`ES256`/`EdDSA`)                               | ES256        | нет                                                                |
| `OAUTH_ACCESS_TOKEN_TTL_SEC`              | `accessTokenTtlSec`                                          | 600          | нет                                                                |
| `OAUTH_REFRESH_TOKEN_TTL_SEC`             | `refreshTokenTtlSec`                                         | 2 592 000    | нет                                                                |
| `OAUTH_CODE_TTL_SEC`                      | `authCodeTtlSec` (≤ 60)                                      | 60           | нет                                                                |
| `OAUTH_AUTH_REQUEST_TTL_SEC`              | `authRequestTtlSec`                                          | 600          | нет                                                                |
| `OAUTH_KEY_ROTATION_SEC`                  | `signingKeyRotationSec`                                      | 2 592 000    | нет                                                                |
| `OAUTH_DCR_LIMIT`, `OAUTH_DCR_WINDOW_SEC` | `registrationRateLimit`                                      | 10 за 3600 с | нет                                                                |
| `OAUTH_CLIENT_RETENTION_DAYS`             | `unusedClientRetentionDays`                                  | 30           | нет                                                                |
| `OAUTH_CIMD_ENABLED`                      | `cimd.enabled`                                               | true         | нет                                                                |
| `OAUTH_CIMD_ALLOWED_HOSTS`                | `cimd.allowedHosts` (через запятую; пусто — любой публичный) | пусто        | нет                                                                |

## Проверено / не проверено

- Проверено на **настоящем PostgreSQL 16** (временный кластер, роль без BYPASSRLS) и mock-входе Bitrix24
  (`FakeBitrixLoginGateway`): S05 (полный поток и негативы), S06, S07, изоляция клиентов и арендаторов, JWKS и
  ротация, метаданные, CIMD (с подменённым fetch), конфиденциальный клиент, loopback, отзыв RFC 7009, лимит DCR,
  удаление неиспользуемых клиентов.
- **Не проверено**: реальный вход через Bitrix24 (реализация `BitrixLoginGateway` — этап S3), реальные подключения
  Claude и ChatGPT к стенду (условие перехода S4 — live), загрузка настоящего документа CIMD по сети,
  многоэкземплярная ротация ключей на общем томе, HTTP-маршруты (подключает сборка режима saas).

## Известные ограничения

- Черновик draft-ietf-oauth-client-id-metadata-document-00 в локальном зеркале отсутствует; правила формы
  `client_id` (https, путь, без query/fragment/точечных сегментов) и запрет секретов для CIMD реализованы по пересказу
  в спецификации MCP и по памяти о черновике — сверить при доступе к datatracker.
- OAuth 2.1 draft-13 §8.4.2 (любой порт для loopback IP) — по памяти текста черновика; в зеркале только ссылка.
  Для `localhost` порт сравнивается точно.
- DNS rebinding между проверкой адреса и соединением `fetch` при загрузке CIMD не исключён полностью (нужен
  собственный dispatcher с фиксированным адресом — пакет `undici`, в зависимостях нет).
- Отзыв access token по `jti` хранится в Coordination: в `InMemoryCoordination` — только в пределах процесса,
  в кластере — после Redis (S8). Отзыв по поколению (`revokeUser`) от этого не зависит — он в PostgreSQL.
- Лимит — только на регистрацию DCR; лимиты на `/oauth/authorize` и `/oauth/token` — общим лимитером S8.

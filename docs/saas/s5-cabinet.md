# S5: кабинет клиента `/app`

Этап S5 SaaS-ТЗ (§11.1, §11.2, §4 сценарии 1–3 и 7, §12 п.2 и п.5, §14). Код — `src/saas/cabinet/*`,
удаление данных арендатора — `src/saas/tenant-deletion.ts`, миграция PostgreSQL 50 — `src/storage/pg-migrations/s5s9.ts`.

## Подключение в сборке режима saas

Кабинет — самостоятельный модуль. Сборка (`src/saas/runtime.ts` / `src/saas/http.ts`) делает три вещи:

```ts
import { createCabinet, isCabinetState, approvalUrl, approvalShortCode } from './cabinet/index.js';

const cabinet = createCabinet(deps); // CabinetDeps — src/saas/cabinet/types.ts
cabinet.register(app); // маршруты /app/* (свой плагин: формы, multipart, заголовки)
// GET /b24/oauth/callback: state кабинета → кабинет, иначе → сервер авторизации MCP (isAuthServerState)
if (isCabinetState(query.state)) return cabinet.replyBitrixCallback(req, reply);
// APPROVAL_REQUIRED в saas: details + approvalUrl(publicBaseUrl, operationId), approvalShortCode(operationId)
```

`registerCabinet(app, deps)` = `createCabinet(deps)` + `register(app)`, возвращает тот же объект `Cabinet`.
Для неFastify-маршрута есть `cabinet.handleBitrixCallback({ query, cookie, ip })` → `{ status, headers, setCookies, body }`.

### CabinetDeps

| Поле                                                                                    | Откуда в сборке                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicBaseUrl`                                                                         | `PUBLIC_BASE_URL` (https; http — только loopback). Cookie `__Host-…; Secure`, если https                                                                                               |
| `db`, `keys`                                                                            | `PostgresSqlDb`, `TenantKeyRing`                                                                                                                                                       |
| `tenants`, `users`, `settings`, `plans`, `subscriptions`                                | репозитории S2                                                                                                                                                                         |
| `login`                                                                                 | `BitrixLoginService` (S3): `authorizeUrl`, `completeLogin`                                                                                                                             |
| `scopeFor(tenantId, userId)`                                                            | `TenantScope` пользователя (или объект с `tenantId`, `operations`, `approvals`, `files`, `principal.id`, `auth.portalKey`) — **тот же** ApprovalService/ключ планов, что исполняет MCP |
| `audit`                                                                                 | `AuditLog` платформы (записи кабинета — `tool = 'cabinet'`; «Проверить подключение» их не учитывает)                                                                                   |
| `usage?`, `billing?`                                                                    | `UsageMeter`, `SubscriptionService` (S6/S7); без них блоки честно сообщают «не настроено»                                                                                              |
| `revokeUser`, `revokeTenant`                                                            | `AuthorizationServer.revokeUser/revokeTenant` (S4)                                                                                                                                     |
| `deleteTenantData?` / `fileStaging?`                                                    | своя функция удаления или staging процесса (тогда кабинет использует `TenantDataDeletion`)                                                                                             |
| `files`                                                                                 | `maxUploadBytes`, `uploadTtlSeconds`, `scanRequired` из конфигурации                                                                                                                   |
| `coordination`, `logger`, `notifier?`, `loginPerMinute?`, `decisionsPerMinute?`, `now?` | Coordination (сброс кэшей по каналам `tenant-invalidate`, `billing:entitlements`), логгер, письма, лимиты (10/30 в минуту), часы для тестов                                            |

## Страницы

| Путь                                       | Что                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /app/login`, `POST /app/logout`  | Вход через Bitrix24 (адрес портала; подсказка — cookie сервера авторизации `mcp_as_portal` или `?portal=`/`?DOMAIN=`), выход                      |
| `GET /app`                                 | Подписка (тариф, статус, период, баннеры past_due/suspended), использование за месяц (портал/вы/лимит), число ожидающих подтверждений             |
| `GET /app/connect`                         | Адрес `…/mcp`, инструкции Claude Desktop, Claude Code (`claude mcp add --transport http bitrix24 …`), claude.ai, ChatGPT; «Проверить подключение» |
| `GET /app/approvals`, `/app/approvals/:id` | Ожидающие планы; план целиком (как `approval:review`), код сверки, «Подтверждаю»/«Отклоняю»                                                       |
| `GET /app/history`                         | Последние 100 операций пользователя: время, инструмент, объект, статус, код ошибки — без плана и тел ответов                                      |
| `GET/POST /app/files`                      | Загрузка файла для `disk_upload_file` → `fileToken` (сканер обязателен при `UPLOAD_SCAN_REQUIRED`)                                                |
| `/app/admin*`                              | Только роль administrator: пользователи и роли, отключение, модули, политика подтверждений, лимит в сутки, роль по умолчанию, output policy       |
| `/app/admin/billing*`                      | Оплата картой/СБП (страница провайдера, согласие на автосписание — галочка), смена тарифа, отмена/возобновление, счёт юрлицу                      |
| `/app/admin/delete`                        | Удаление всех данных портала в сервисе                                                                                                            |

## Безопасность

- Серверный рендер без JavaScript; CSP `default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'`
  (стили — `/app/static/cabinet.css`); на страницах входа и оплаты `form-action 'self' https:` (перенаправление на портал
  Bitrix24 / страницу провайдера). `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Сессия: cookie `__Host-mcp_cab=<tenantId>.<секрет>; Path=/; HttpOnly; SameSite=Lax; Secure`, 8 ч. В БД (`cabinet_sessions`,
  под RLS с миграции 50) — SHA-256 секрета и хеш CSRF-токена; поиск в контексте арендатора из cookie. Каждый запрос
  проверяет: арендатор не удалён/не деинсталлирован, пользователь `active` (отключённый теряет сессию сразу).
- Вход: одноразовый `state` (`cab.` + 256 бит), в `cabinet_login_states` — хеши state и cookie привязки браузера
  `__Host-mcp_cab_bind`, срок 10 минут; состояние сгорает при любой попытке. Портал для перенаправления — только из
  установок (SSRF §12 п.4), портал ответа должен совпасть с указанным.
- Каждый POST: CSRF-токен сессии + Origin (иначе Sec-Fetch-Site/Referer). Лимиты: вход — 10/мин на адрес (и отдельно
  обратный вызов), решения — 30/мин на пользователя.
- Подтверждения: чужая/несуществующая/некорректная операция — **одинаковый** ответ 404; без входа — одинаковое
  перенаправление на вход для любого id (S12, §12 п.2). Решение — через `ApprovalService.approve/deny` контекста
  пользователя (проверки статуса и срока — там же; хеш плана сверяет `MutationExecutor` при повторе вызова).
- Повышенный риск = `operationKind = delete` или инструмент с `destructiveHint` (массовые замены:
  `crm_deal_products_replace`, `company_employee_departments_set` и др.): слово `ПОДТВЕРЖДАЮ` + вход не старше 15 минут.
  Политика `admin_for_high_risk`: такие операции подтверждает администратор арендатора (автор — нет); администратору они
  видны в списке. Обычные записи — только сам автор с ролью operator и выше.
- Отключение пользователя: статус `disabled` (поколение токенов +1), `revokeUser` (refresh-токены отозваны, неисполненные
  операции `denied`), сессии кабинета удалены, сброс кэшей. Себя отключить и последнего администратора понизить нельзя;
  включение проверяет места тарифа.

## Удаление всех данных (§14, S13)

Администратор, вход не старше 15 минут, слово `ПОДТВЕРЖДАЮ`. `TenantDataDeletion.deleteAll`:
отзыв доступа (`revokeTenant`) → статус `deleted` → файлы staging → криптоудаление DEK + подписка `canceled` с очисткой
зашифрованных полей → удаление строк каталога (`mcp_auth_codes`, `mcp_refresh_tokens`, `usage_counters`,
`usage_tool_counters`, `tenant_app_status`) и данных под RLS (`cabinet_sessions`, `bitrix_tokens`, `mcp_consents`,
`idempotency`, `operations`, `cursors`, `file_manifests`, `audit`, `tenant_settings`, `tenant_users`) → запись в
`support_actions`. Сохраняются: `payments`, `invoices` (бухучёт), строка `tenants` (member_id — пробный период один раз).

## Проверено / не проверено

- Проверено (настоящий PostgreSQL 16, имитация облака Bitrix24 по документации, настоящие S3/S4/S7-сервисы, тестовый
  магазин — имитация ЮKassa): `tests/integration/s5-cabinet.test.ts` (14), `tests/unit/s5-cabinet-units.test.ts` (8).
- Не проверено: реальный портал Bitrix24 и реальный браузер (поведение SameSite=Lax при возврате с портала — по
  спецификации cookie, не вживую), реальные клиенты Claude/ChatGPT по инструкциям страницы «Подключение», реальный
  платёж. Письмо-подтверждение удаления — только через `CabinetNotifier` сборки (SMTP в проекте ещё нет).
- Не сделано в S5: встроенная страница приложения внутри Bitrix24 (iframe с проверкой подписи запуска,
  `frame-ancestors` для портала) — сейчас кабинет запрещает встраивание; картинки в инструкциях (текст);
  PDF счёта (HTML-страница счёта; PDF — у владельца); счётчики Redis (Coordination) после удаления данных истекают по TTL.

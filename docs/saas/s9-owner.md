# S9: панель владельца `/owner`, юридические шаблоны, материалы Маркета

SaaS-ТЗ §11.3, §4 (роли `service_owner`/`support`), §6.2 (`support_actions`), §12 п.5, §14, §19 (S9), D15.
Код — `src/saas/owner/*`, CLI — `src/cli/owner.ts`, миграция PG 55 (`src/storage/pg-migrations/s9.ts`),
тесты — `tests/unit/s9-totp.test.ts`, `tests/integration/s9-owner-panel.test.ts`.
Документы — `docs/saas/legal/*` (шаблоны, **требуют проверки юристом**), `docs/saas/marketplace.md`.

## Что умеет панель

| Страница               | Содержимое                                                                                                                                  | Действия (роль)                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/owner/tenants`       | Домен, статус арендатора, тариф, статус подписки, конец периода, активные пользователи, вызовы/записи за месяц, коды ошибок за 7 дней       | фильтр по статусу и домену, страницы по 50                                                                  |
| `/owner/tenants/:id`   | Метаданные, подписка (без способа оплаты — только «сохранён/нет»), пользователи по статусам, учёт, ошибки 7/30 дней, платежи, счета, журнал | продлить пробный период (support, owner); заблокировать с причиной и вводом домена / разблокировать (owner) |
| `/owner/payments`      | Счета юрлицам (сначала неоплаченные), последние платежи всех арендаторов                                                                    | отметить оплату счёта, возврат (owner)                                                                      |
| `/owner/plans`         | Тарифы (цены, лимиты, модули, флаги)                                                                                                        | правка и создание тарифа с основанием (owner)                                                               |
| `/owner/announcements` | Объявления для кабинета (всем или одному арендатору), срок показа                                                                           | опубликовать, снять (owner)                                                                                 |
| `/owner/metrics`       | Арендаторы/подписки по статусам, ежемесячная выручка, платежи за 30 дней, неоплаченные счета, учёт месяца, счётчики процесса (S8)           | —                                                                                                           |
| `/owner/journal`       | `support_actions` — кто, что, у какого арендатора, основание, подробности                                                                   | —                                                                                                           |

Каждое действие пишет `support_actions` (в той же транзакции, что и изменение): `trial.extend`, `tenant.block`
(с числом отозванных refresh-токенов и аннулированных операций), `tenant.unblock`, `invoice.mark_paid`,
`payment.refund` (оба — внутри `SubscriptionService`), `payment.refund_failed` (код ошибки, без текста провайдера),
`plan.create`/`plan.update` (было/стало), `announcement.create`/`announcement.deactivate`, `owner.login`/`owner.logout`.

**Чего в панели нет (D15):** токенов Bitrix24 и MCP, планов и результатов операций, целей и аргументов из аудита
(только коды ошибок из закрытого набора `ERROR_CODES`, прочее → `other`), контакта для чека, идентификатора способа
оплаты, данных порталов и сотрудников (кроме числа пользователей по статусам). Имперсонации нет. Реквизиты покупателя
счёта — только наименование и ИНН (юрлицо; документ бухучёта).

## Доступ к данным (RLS)

Роль БД та же, что у сервиса (без `BYPASSRLS`). Каталог (`tenants`, `subscriptions`, `plans`, `payments`, `invoices`,
`usage_counters`, `support_actions`, `owner_*`, `announcements`) — без RLS, как решено в S2. Таблицы арендатора
(`tenant_users`, `audit`) читаются только через `db.withTenant(id)` — по одному арендатору, как в репозиториях.

## Вход и сессии

- Отдельная учётная запись (не Bitrix24, не токен MCP): email + пароль + TOTP. Пароль — scrypt (N=16384, r=8, p=1,
  соль 16 байт, асинхронно), не короче 14 символов; неизвестный email тоже «считает» хеш.
- TOTP — RFC 6238 на `node:crypto` (`src/saas/owner/totp.ts`): HMAC-SHA1, 6 цифр, шаг 30 с, окно ±1 шаг; секрет 160 бит,
  хранится под ключом `HKDF-SHA256(KEK, info="mcp-owner-totp-v1")` с AAD `owner-totp:<email>` (`ownerSecretsBox`).
- Повтор кода: принимается только шаг, строго больший `owner_users.last_totp_step`, условным `UPDATE … WHERE
last_totp_step < ?` (гонка двух запросов с одним кодом тоже отклоняется).
- Блокировка: 5 неудач подряд → вход закрыт на 15 минут (`owner_users.locked_until`, переживает перезапуск).
  Лимит попыток через `Coordination.allow` (общий для экземпляров): 20 на IP и 10 на учётную запись за 15 минут
  (настраивается `loginLimits`). Ответ при блокировке и лимите одинаковый (429), неверные данные — одинаковый 401 без
  указания, что именно неверно.
- Сессия: cookie `mcp_owner` = 32 случайных байта, `HttpOnly; Secure; SameSite=Strict; Path=/owner`; в БД — SHA-256
  (`owner_sessions`), CSRF-токен на сессию; абсолютный срок 8 ч, бездействие 30 мин; смена пароля/TOTP и отключение
  закрывают все сессии.
- Каждый POST: сессия + Origin = `publicOrigin` (иначе `Sec-Fetch-Site: same-origin`, иначе Referer) + CSRF.
- Заголовки: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none';
object-src 'none'` (стили — `/owner/static/owner.css`, ни inline-стилей, ни JavaScript), `X-Frame-Options: DENY`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`, COOP/CORP, `Permissions-Policy`.
- Блокировка арендатора требует ввести его домен (защита от случайного нажатия).

## Подключение (сборка режима saas)

Панель не трогает `src/saas/runtime.ts`/`http.ts` — сборка вызывает:

```ts
import { registerOwnerPanel, ownerSecretsBox } from './owner/index.js';

registerOwnerPanel(app, {
  db, // PostgresSqlDb (роль без BYPASSRLS)
  ownerSecrets: ownerSecretsBox(kekBytes), // те же 32 байта KEK, что и в TenantKeyRing
  tenants, // TenantsRepo
  plans, // PlansRepo
  subscriptions, // SubscriptionsRepo
  billing, // SubscriptionService (markInvoicePaid, refund)
  coordination, // Redis/InMemory: лимиты входа, 'billing:entitlements', 'tenant-invalidate'
  revokeTenant: (id) => authorizationServer.revokeTenant(id), // §7.4
  entitlements, // необязательно: сброс кэша этого экземпляра сразу
  metrics: saasMetrics.registry, // необязательно: страница «Метрики»
  logger,
  publicOrigin: config.deployment.publicBaseUrl, // проверка Origin
});
```

Интерфейс `OwnerPanelDeps` — `src/saas/owner/panel.ts`. Разборщик `application/x-www-form-urlencoded`
регистрируется внутри области `/owner` (разборщик родителя, если есть, в области заменяется). За nginx нужен
`trustProxy`, чтобы `req.ip` был адресом клиента (лимит по IP).

Кабинет (`/app`, S5) показывает объявления: `Announcements.activeFor(db, tenantId, nowIso)`
(`src/saas/owner/announcements.ts`) — действующие общие и адресные, сначала `critical`.

Статус арендатора `suspended` означает блокировку владельцем (биллинг меняет статус **подписки**, а не арендатора);
`SaasTokenVerifier` отклоняет токены неактивного арендатора сразу, `revokeTenant` отзывает refresh и операции, события
`tenant-invalidate` и `billing:entitlements` сбрасывают кэши экземпляров. Разблокировка старые токены не возвращает
(поколение уже увеличено) — сотрудники подключают клиентов заново.

## CLI учётных записей

```bash
npm run owner -- create --email owner@example.ru [--role service_owner|support] --config .env
npm run owner -- reset-password --email owner@example.ru
npm run owner -- reset-totp --email owner@example.ru
npm run owner -- disable --email … | enable --email …
npm run owner -- list
```

Только `DEPLOYMENT_MODE=saas`: PostgreSQL из `DATABASE_URL` (миграции применяются), KEK из `KEK_FILE`
(`readKekFile`: 64 hex-символа или ровно 32 байта). Пароль — скрытый ввод дважды в терминале или первая строка stdin.
Секрет TOTP (Base32) и `otpauth://`-URI печатаются **один раз и только в stderr-терминал**: если stderr
перенаправлен, `create`/`reset-totp` отказывают до изменения БД. В stdout и логи секреты не попадают.

## Миграция PG 55 (`s9-owner-panel`)

`owner_users` + `failed_attempts`, `locked_until`, `last_totp_step`, `last_login_at`, `disabled`; `owner_sessions`;
`announcements`; индекс `support_actions(created_at)`. Таблицы `owner_users` и `support_actions` были в миграции 2.
Номера 56–59 свободны.

## Тесты

- `tests/unit/s9-totp.test.ts` (10): HOTP RFC 4226 прил. D; TOTP RFC 6238 прил. B (SHA-1/256/512, 8 цифр, все 6 моментов
  времени); окно ±1 и вне окна; Base32 RFC 4648 §10; формат otpauth.
- `tests/integration/s9-owner-panel.test.ts` (15, **настоящий PostgreSQL 16**, реальный `AuthorizationServer` S4,
  `SubscriptionService` S7 с mock HTTP ЮKassa, Fastify по HTTP): заголовки и CSP; вход — неверный пароль, неверный
  код, неизвестный email, повтор кода и код предыдущего шага, чужой Origin; блокировка после 5 неудач и снятие через 15
  минут; лимит по IP; CSRF/Origin/без cookie — 403/401 без изменений; журнал каждого действия; блокировка отзывает
  access/refresh/операции; роль support; страницы без токенов, секретов, способа оплаты, целей аудита, контакта чека;
  XSS в объявлении экранируется; выход и истечение по бездействию; хранение секрета TOTP и scrypt; CLI: `list`,
  отказ `create` без терминала, `create` в псевдотерминале (`script`) печатает URI один раз и создаёт запись.

## Не проверено

- Реальный браузер (Chrome/Firefox): поведение `Secure`-cookie на `http://localhost`, отображение CSS; только HTTP-тесты.
- Реальные приложения-аутентификаторы (Google Authenticator, Яндекс Ключ и др.) — только эталонные векторы RFC.
- Боевой стенд за nginx (`trustProxy`, реальные IP), Redis-координация лимитов входа (тесты — `InMemoryCoordination`).
- Возврат через тестовый магазин ЮKassa — только mock HTTP в форме SDK.
- Юридические шаблоны юристом не проверены; публикация в Маркете не выполнялась (материалы — `marketplace.md`).

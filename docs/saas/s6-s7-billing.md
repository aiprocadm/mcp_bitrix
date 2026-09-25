# S6/S7: тарифы, квоты, учёт использования, биллинг (ЮKassa)

ТЗ: `docs/saas/TZ-SaaS.md` §9, §10, D8–D11; тесты S08, S09, S10, S11, S16. Код — `src/saas/billing/`,
миграция PostgreSQL 60 — `src/storage/pg-migrations/s6s7.ts`.

## Состав

| Файл                      | Что делает                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `entitlements.ts`         | `EntitlementService.check` перед каждым tools/call; `planHiddenReason`/`visibleModules` для регистрации инструментов |
| `usage-meter.ts`          | `UsageMeter`: учёт вызовов и записей через `Coordination`, сброс в PostgreSQL, отчёты кабинета и владельца           |
| `payment-provider.ts`     | Интерфейс `PaymentProvider` (D9)                                                                                     |
| `yookassa.ts`             | `YooKassaProvider` — единственный сетевой файл модуля                                                                |
| `subscription-service.ts` | Жизненный цикл подписки §10.2, уведомления, продления (worker), смена тарифа, счета юрлицам, возвраты                |
| `billing-store.ts`        | SQL платежей/подписок/счетов на одном `SqlExecutor` (одна транзакция на изменение)                                   |
| `notifier.ts`             | Интерфейс `BillingNotifier` (письма и баннеры кабинета — другие этапы)                                               |
| `errors.ts`, `money.ts`   | Ошибки с `reason`; копейки, доплата, календарные месяцы                                                              |
| `settings.ts`             | `BillingSettings` и `billingSettingsFromDeployment(config.deployment)`                                               |

## Проверки перед вызовом инструмента (§9.3, §10.2)

Порядок в `EntitlementService.check({ tenantId, userId, tool: { name, module, operation } })`:

1. Диагностика (`bitrix_connection_info`, `bitrix_server_version`, `operation_status`) — всегда.
2. Подписка: `trialing` (до конца пробного периода), `active`, `past_due` (льготный период), `canceled` (до конца
   оплаченного периода) — работают; иначе `SUBSCRIPTION_INACTIVE` (`reason: SUBSCRIPTION_INACTIVE`, `nextAction` —
   `<кабинет>/billing`).
3. Модуль вне тарифа — `FEATURE_UNAVAILABLE` / `NOT_IN_PLAN`; выключен администратором (`tenant_settings.modules`,
   пустой список = все модули тарифа) — `FEATURE_UNAVAILABLE` / `MODULE_DISABLED`.
4. Удаление при тарифе без удалений — `FEATURE_UNAVAILABLE` / `DESTRUCTIVE_NOT_IN_PLAN`.
5. Месячная квота вызовов (и записей для инструментов записи) — `QUOTA_EXCEEDED` / `MONTHLY_CALLS` | `MONTHLY_WRITES`,
   `expiresAt` — начало следующего месяца.
6. Дневной лимит пользователя — `QUOTA_EXCEEDED` / `USER_DAILY_LIMIT`.

Регистрация инструментов по тарифу: `planHiddenReason(def, await entitlements.load(tenantId))` — скрыть инструмент
в `tools/list`, прямой вызов всё равно отклоняет `check` (S09). Снимок кэшируется на экземпляр (15 с) и сбрасывается
событием `billing:entitlements` в `Coordination` при любой смене подписки (`EntitlementService.listen`).

Проверка квоты и учёт — два шага (check, затем record после обращения к Bitrix24): при параллельных вызовах
возможно превышение квоты на число одновременных вызовов. Это осознанно: резерв квоты до вызова считал бы и
вызовы, не дошедшие до Bitrix24 (D11).

## Учёт использования (§9.2, S16)

- Вызов/запись учитывает диспетчер: `usage.recordCall(...)` — если вызов дошёл до Bitrix24; `usage.recordWrite(...)` —
  операция `succeeded`/`unknown`. Месяц — календарный UTC (`YYYY-MM`), сутки — UTC.
- Счётчики «к сбросу» (`usage:p:*`) забираются `Coordination.drain` и одной транзакцией прибавляются к
  `usage_counters` (месяц и день по пользователю) и `usage_tool_counters` (месяц по инструменту). Забранное больше не
  считается — двойного счёта нет. Падение процесса теряет не больше интервала сброса (60 с); ошибка БД возвращает
  счётчики в `Coordination`.
- Счётчики квот (`usage:q:*`, `usage:d:*`) не сбрасываются; при первом обращении в периоде (или после потери
  Redis/процесса) засеваются из PostgreSQL под блокировкой.
- `usage.start(settings.usageFlushIntervalMs)` в web и worker; `usage.stop()` при остановке — последний сброс.
- Уведомления 80% и 100% квоты — `BillingNotifier.quotaThreshold`, ровно один раз за период (атомарный счётчик).
- Кабинет: `usage.report(tenantId, 'YYYY-MM')` (по пользователям, инструментам, дням, с оговоркой «данные с задержкой
  до 1 минуты»); владелец: `usage.ownerReport('YYYY-MM')`.

**Требование к `RedisCoordination` (S8):** `drain` должен забирать каждый ключ атомарно (`GETDEL`), иначе появится
двойной счёт.

## Платежи ЮKassa (§10.1)

Источник — официальный SDK `yoomoney/yookassa-sdk-python` (пути файлов — в шапке `yookassa.ts`) и
https://yookassa.ru/developers/api.

- `POST /v3/payments`, `GET /v3/payments/{id}`, `POST /v3/refunds`; Basic `shopId:secretKey`; `Idempotence-Key` у
  каждого POST. Повтор при HTTP 202/5xx/сетевой ошибке — с тем же ключом (API вернёт тот же объект).
- Суммы — строкой `"990.00"` из копеек (`kopecksToAmount`), ответы разбираются строкой (`amountToKopecks`).
- Первая оплата: `confirmation: { type: "redirect", return_url }`, `save_payment_method` — только при явном согласии
  (галочка в кабинете). Продление: `payment_method_id` сохранённого способа, без подтверждения.
- Чек 54-ФЗ: `receipt.customer.email|phone` (контакт из формы оплаты, хранится под DEK арендатора),
  `receipt.items[0]` — «Доступ к сервису MCP для Bitrix24, тариф «X», период ДД.ММ.ГГГГ–ДД.ММ.ГГГГ», `quantity "1.00"`,
  `vat_code`, `payment_mode`, `payment_subject: service`; `receipt.tax_system_code`. Продавец в чеке — магазин ЮKassa
  (в модели Receipt SDK полей продавца нет); `SELLER_NAME`/`SELLER_INN` — для счетов юрлицам.
- Хост API — только `api.yookassa.ru` по https (иначе `CONFIG_INVALID` при сборке). Прямого `fetch` нет —
  внедряемый `FetchLike`.

### Уведомления (`POST /billing/hooks` → `SubscriptionService.handleNotification(body, sourceIp)`)

1. `sourceIp` должен входить в список адресов ЮKassa (`YOOKASSA_NETWORKS` из `security_helper.py` SDK), иначе
   `{ accepted: false, reason: 'UNTRUSTED_SOURCE' }` (HTTP-слой отвечает 400/403). `sourceIp` берётся из соединения
   или из заголовка, выставленного **доверенным** nginx, — не из произвольного `X-Forwarded-For` клиента.
2. Статус из тела не используется: всегда `getPayment` через API.
3. Неизвестный платёж — запись в журнал, `{ accepted: true, outcome: 'unknown_payment' }`.
4. Применение идемпотентно: строка платежа (`FOR UPDATE`) и подписка меняются в одной транзакции; повтор —
   `duplicate`. Сумма/валюта из API сверяются с созданным платежом.

Возврат из оплаты: `syncPayment(tenantId, paymentId)`; сверка «зависших» платежей worker'ом — `reconcilePending()`.

## Жизненный цикл (§10.2, S11)

- `checkout(tenantId, { planCode, contact, savePaymentMethod })` → `confirmationUrl`. Оплата делает подписку
  `active`: период продлевается от конца действующего/льготного периода, иначе начинается сейчас.
- Worker: `renewDue(now)` (раз в несколько минут, под блокировкой лидера S8): пробный период истёк → `suspended`;
  отменённая подписка по концу периода → `canceled`; продление сохранённым способом (ключ идемпотентности
  `ren:<арендатор>:<конец периода>:<попытка>`); неуспех → `past_due`, попытки в дни 0, 3, 6 от конца периода, после
  7 дней льготы → `suspended`; нет сохранённого способа → сразу `past_due` без попыток. `suspended`/`canceled`
  дольше 30 дней → `BillingNotifier.dataDeletionDue` (один раз; удаляет не биллинг).
- `cancel`/`resume`; `changePlan`: повышение (дороже, тот же период) — сразу с доплатой
  `prorateKopecks(разница, остаток, длина периода)` (BigInt, половина вверх) сохранённым способом или через
  страницу оплаты; понижение и смена длительности — `pending_plan_code` с начала следующего периода, с
  предупреждениями (лишние пользователи, модули, удаления).
- Счета юрлицам: `issueInvoice(tenantId, planCode, buyer)` (номер `MCP-ГГГГ-NNNNNN` из последовательности, ИНН/КПП
  проверяются); `markInvoicePaid(id, { actor, reason })` — владелец, запись в `support_actions`, активация подписки.
  PDF счёта — кабинет (S5). Реквизиты покупателя хранятся открыто в `invoices.buyer_json`: платёжные документы
  хранятся 5 лет отдельно от данных портала и переживают криптоудаление (§6.3).
- `refund(paymentId, amount, { actor, reason })` — только владелец, с журналом.

## Миграция 60

`subscriptions.receipt_contact_encrypted`, `subscriptions.deletion_requested_at`, `payments.period_anchor`,
`payments.refunded_kopecks`, `payments.processed_at`, таблица `usage_tool_counters`, последовательность
`invoice_number_seq`, индексы для worker.

## Не проверено

- Тестовый и боевой магазин ЮKassa (реальные платежи, сохранение карты, чеки через ОФД) — только mock HTTP в форме
  моделей SDK. Приёмка — этап S10.
- Список IP ЮKassa взят из SDK (2022); перед запуском сверить с https://yookassa.ru/developers/using-api/webhooks.
- Коды `vat_code`/`tax_system_code` для реквизитов продавца — сверить с таблицами ЮKassa при заполнении SELLER_*.
- Письма (реализация `BillingNotifier`), HTTP-маршрут `/billing/hooks`, вызовы из диспетчера и worker — сборка
  режима saas.

# SaaS: эксплуатация (черновик этапа S2, дополняется на S8)

## PostgreSQL

Сервис подключается **отдельной ролью без SUPERUSER и BYPASSRLS**: суперпользователь обходит Row Level Security даже
при `FORCE ROW LEVEL SECURITY`, и изоляция арендаторов перестала бы работать. Сервис проверяет это при старте и
отказывается запускаться (`CONFIG_INVALID`, поле `DATABASE_URL`).

```sql
-- под администратором кластера
CREATE ROLE mcp_app LOGIN PASSWORD '<пароль>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE mcp OWNER mcp_app;
```

`DATABASE_URL=postgres://mcp_app:<пароль>@<хост>:5432/mcp` (при внешнем хосте — `?sslmode=verify-full`).
Миграции применяются при старте под advisory-блокировкой; несколько экземпляров стартуют безопасно.
Таблицы данных арендатора (`operations`, `idempotency`, `cursors`, `audit`, `file_manifests`, `tenant_users`,
`bitrix_tokens`, `mcp_consents`, `tenant_settings`) — под RLS по `app.tenant_id`; каталог (`tenants`, тарифы,
подписки, платежи, клиенты OAuth, учёт) — без RLS и без данных порталов.

## Ключи

- **KEK** (главный ключ, 32 байта) — файл с правами `0600` вне каталога БД и вне бэкапов PostgreSQL (или KMS).
  Без KEK данные арендаторов (токены Bitrix24, планы операций) нечитаемы — храните его резервную копию отдельно.
- **DEK** арендатора — в `tenants.dek_encrypted` под KEK. Удаление данных арендатора = удаление DEK (криптоудаление).

## Тесты с PostgreSQL

`npm test` поднимает временный кластер PostgreSQL (`initdb` во временном каталоге), если установлены бинарники
PostgreSQL; иначе SaaS-тесты помечаются как пропущенные. Внешний сервер: `TEST_POSTGRES_ADMIN_URL=postgres://<админ>@<хост>/postgres`
— тест создаёт отдельную базу и непривилегированную роль.

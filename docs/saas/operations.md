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

## Кластер: Redis, worker, метрики (этап S8)

Подробности и проверки — `docs/saas/s8-operations.md`; файлы развёртывания — `deploy/saas/`.

- **Состав**: nginx (HTTPS, HSTS) → `web1`, `web2` → PostgreSQL 16 и Redis 7 во внутренней сети; `worker` ×1.
  Запуск: `cd deploy/saas && cp saas.env.example saas.env && chmod 600 saas.env`, файлы секретов в `./secrets`
  (`kek`, `pg_superuser_password`, `pg_app_password`, `pg_backup_password`, `redis_password`, права 600),
  сертификаты в `./certs`, затем `docker compose up -d --build`.
- **Redis** — с паролем (из файла секрета, не в аргументах процесса) и AOF (`appendfsync everysec`): счётчики учёта
  переживают рестарт Redis. `REDIS_URL` — секрет. Без Redis лимитер портала работает на запасном локальном лимите,
  блокировки и учёт недоступны — алерт `McpRedisErrors`.
- **worker** — один активный в кластере по аренде в Redis; второй экземпляр ждёт и подхватывает при остановке лидера.
  Остановка — SIGTERM: задачи получают abort, аренда снимается (`stop_grace_period` 40 с).
- **Выкат без простоя**: миграции expand → migrate → contract; `docker compose up -d --no-deps web1`, дождаться healthy,
  затем `web2`, затем `worker`. Откат — предыдущий образ + совместимая схема.
- **Метрики** — `GET /metrics` на каждом экземпляре только во внутренней сети (nginx наружу не публикует); правила
  алертов — `deploy/saas/prometheus-alerts.example.yml`.

## Бэкапы PostgreSQL (SaaS)

- Ежедневно `deploy/saas/pg-backup.sh` (cron): роль `mcp_backup` (только чтение + BYPASSRLS — иначе pg_dump не выгрузит
  таблицы с FORCE RLS), подключение через переменные libpq и `PGPASSFILE`, шифрование **age** публичным ключом
  (закрытый ключ — офлайн у владельца) или openssl, хранение 14 дней.
- **KEK в копию не входит** и хранится отдельно; без KEK восстановленная база даёт метаданные, но не токены и планы.
- Ежемесячно `deploy/saas/pg-restore-check.sh <копия>` на отдельном сервере: восстановление во временную базу, сверка
  числа строк с файлом `.counts`, удаление временной базы. Результат записывается в журнал эксплуатации.

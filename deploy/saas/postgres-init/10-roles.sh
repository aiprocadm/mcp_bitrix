#!/bin/sh
# Инициализация PostgreSQL для SaaS (SaaS-ТЗ §6.1, docs/saas/operations.md): выполняется образом postgres ОДИН раз —
# при создании пустого тома (каталог /docker-entrypoint-initdb.d). Пароли — из файлов секретов compose, не из аргументов.
#  - mcp_app    — роль сервиса: БЕЗ SUPERUSER и BYPASSRLS (иначе RLS не изолирует арендаторов; сервис такую роль
#                 и не примет — assertRlsEnforced), владелец базы mcp; миграции применяет сам сервис.
#  - mcp_backup — роль резервного копирования: только чтение (pg_read_all_data) + BYPASSRLS. BYPASSRLS нужен pg_dump:
#                 при FORCE ROW LEVEL SECURITY выгрузка без него падает («query would be affected by row-level security
#                 policy»). Роль не используется сервисом, её пароль хранится только на хосте бэкапа.
set -eu

# Имена и файлы переопределяются только для проверки скрипта на временном кластере (tests/integration/s8-backup).
APP_ROLE="${MCP_APP_ROLE:-mcp_app}"
BACKUP_ROLE="${MCP_BACKUP_ROLE:-mcp_backup}"
DB_NAME="${MCP_DB_NAME:-mcp}"
APP_PASSWORD_FILE="${PG_APP_PASSWORD_FILE:-/run/secrets/pg_app_password}"
BACKUP_PASSWORD_FILE="${PG_BACKUP_PASSWORD_FILE:-/run/secrets/pg_backup_password}"
test -s "$APP_PASSWORD_FILE" && test -s "$BACKUP_PASSWORD_FILE"

# Пароли читает сам psql (\set из `cat`): они не попадают в аргументы процессов.

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v app_role="$APP_ROLE" -v backup_role="$BACKUP_ROLE" -v db="$DB_NAME" \
  -v app_pw_file="$APP_PASSWORD_FILE" -v backup_pw_file="$BACKUP_PASSWORD_FILE" <<'SQL'
\set app_pw `head -n1 :'app_pw_file' | tr -d '\r\n'`
\set backup_pw `head -n1 :'backup_pw_file' | tr -d '\r\n'`
CREATE ROLE :"app_role" LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE :"db" OWNER :"app_role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"app_role";

CREATE ROLE :"backup_role" LOGIN PASSWORD :'backup_pw' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE :"db" TO :"backup_role";
GRANT pg_read_all_data TO :"backup_role";
SQL

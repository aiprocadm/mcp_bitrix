#!/usr/bin/env bash
# Проверка восстановления копии PostgreSQL (SaaS-ТЗ §13: ежемесячно; Б-тест T45 для кластера).
# Восстанавливает копию во ВРЕМЕННУЮ базу (живая база не затрагивается), сверяет число строк по таблицам с файлом
# .counts, снятым при копировании, проверяет наличие схемы миграций и удаляет временную базу.
#
#   pg-restore-check.sh <файл mcp-….dump.age|.enc>
#
# Подключение к серверу проверки — переменные libpq (PGHOST, PGPORT, PGUSER с правом CREATEDB, PGPASSFILE);
# это может быть отдельный сервер. Расшифровка: BACKUP_AGE_IDENTITY_FILE (закрытый ключ age — приносится на время
# проверки и удаляется) или BACKUP_PASSPHRASE_FILE (openssl). KEK для проверки не нужен и не используется.
# RESTORE_CHECK_STRICT=1 — расхождение числа строк = ошибка (для копий, снятых при остановленной записи; на живой
# базе счётчики снимаются чуть раньше выгрузки и могут отличаться на единицы). KEEP_RESTORED_DB=1 — не удалять базу.
# Код выхода 0 — копия восстановлена и сверена; вывод — только имена таблиц и числа (без данных).
set -euo pipefail
umask 077

die() {
  echo "pg-restore-check: $*" >&2
  exit 1
}

FILE="${1:-}"
[[ -n "$FILE" && -f "$FILE" ]] || die "укажите файл копии"
command -v pg_restore >/dev/null || die "нет pg_restore"

# Целостность файла
if [[ -f "$FILE.sha256" ]]; then
  (cd "$(dirname "$FILE")" && sha256sum --quiet -c "$(basename "$FILE").sha256") || die "контрольная сумма не совпала"
else
  echo "pg-restore-check: нет файла .sha256 — целостность не проверена" >&2
fi

case "$FILE" in
  *.age)
    command -v age >/dev/null || die "нет age"
    : "${BACKUP_AGE_IDENTITY_FILE:?укажите BACKUP_AGE_IDENTITY_FILE}"
    decrypt() { age --decrypt -i "$BACKUP_AGE_IDENTITY_FILE" "$FILE"; }
    ;;
  *.enc)
    command -v openssl >/dev/null || die "нет openssl"
    : "${BACKUP_PASSPHRASE_FILE:?укажите BACKUP_PASSPHRASE_FILE}"
    decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$FILE"; }
    ;;
  *) die "неизвестное расширение копии (ожидается .age или .enc)" ;;
esac

DB="mcp_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [[ "${KEEP_RESTORED_DB:-0}" != "1" ]]; then
    psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

decrypt >"$WORK/dump" || die "не удалось расшифровать копию"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"$DB\"" >/dev/null
# Без владельцев и прав: проверка содержимого, роли сервера проверки могут отличаться от боевых.
pg_restore --exit-on-error --no-owner --no-privileges -d "$DB" "$WORK/dump"

MIGR="$(psql -X -At -d "$DB" -c 'SELECT count(*) FROM public.schema_migrations')" || die "нет таблицы schema_migrations"
[[ "$MIGR" -gt 0 ]] || die "таблица schema_migrations пуста"
echo "pg-restore-check: миграций в копии: $MIGR"

COUNTS="${FILE%.dump.*}.counts"
MISMATCH=0
if [[ -f "$COUNTS" ]]; then
  while read -r table expected; do
    [[ -n "$table" ]] || continue
    actual="$(psql -X -At -d "$DB" -v t="$table" <<<'SELECT count(*) FROM public.:"t";')" || actual="нет таблицы"
    if [[ "$actual" == "$expected" ]]; then
      echo "  $table: $actual"
    else
      echo "  $table: ожидалось $expected, восстановлено $actual" >&2
      MISMATCH=1
    fi
  done <"$COUNTS"
else
  echo "pg-restore-check: нет файла .counts — сверка числа строк пропущена" >&2
fi

if [[ "$MISMATCH" == "1" && "${RESTORE_CHECK_STRICT:-0}" == "1" ]]; then
  die "число строк не совпало"
fi
echo "pg-restore-check: восстановление проверено ($DB)"

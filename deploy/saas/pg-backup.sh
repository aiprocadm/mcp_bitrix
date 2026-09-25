#!/usr/bin/env bash
# Шифрованная резервная копия PostgreSQL SaaS (SaaS-ТЗ §13: ежедневно, шифрованные, хранение 14 дней; KEK отдельно).
#
# Подключение — стандартные переменные libpq (PGHOST, PGPORT, PGUSER=mcp_backup, PGDATABASE=mcp, PGPASSFILE):
# пароль не передаётся в аргументах и не печатается. Роль mcp_backup — только чтение + BYPASSRLS (см.
# postgres-init/10-roles.sh): без BYPASSRLS pg_dump не выгрузит таблицы с FORCE ROW LEVEL SECURITY.
#
# Шифрование (выбор BACKUP_ENCRYPTION):
#   age     (рекомендуется) — BACKUP_AGE_RECIPIENTS_FILE: ПУБЛИЧНЫЕ ключи получателей. На сервере нет ничего, чем копию
#            можно расшифровать; закрытый ключ (identity) хранится офлайн у владельца. Шифр аутентифицирован.
#   openssl — BACKUP_PASSPHRASE_FILE: AES-256-CBC + PBKDF2 (openssl enc). Не аутентифицирован: целостность проверяется
#            по файлу .sha256 (защищает от порчи, не от подмены) — используйте, только если age недоступен.
# KEK (KEK_FILE) в копию не входит: его в БД нет (в БД только DEK под KEK); скрипт дополнительно отказывается писать
# копии в каталог, где лежит KEK. Без KEK восстановленная база даёт метаданные, но не токены/планы арендаторов.
#
# Результат: $BACKUP_DIR/mcp-<UTC-время>.dump.<age|enc> + .sha256 + .counts (число строк по таблицам — без данных,
# для проверки восстановления pg-restore-check.sh). Копии старше BACKUP_RETENTION_DAYS (14) удаляются.
# Cron (ежедневно в 03:17): 17 3 * * * /opt/mcp/deploy/saas/pg-backup.sh >>/var/log/mcp-backup.log 2>&1
set -euo pipefail
umask 077

: "${BACKUP_DIR:?укажите BACKUP_DIR}"
BACKUP_ENCRYPTION="${BACKUP_ENCRYPTION:-age}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

die() {
  echo "pg-backup: $*" >&2
  exit 1
}

command -v pg_dump >/dev/null || die "нет pg_dump"
command -v psql >/dev/null || die "нет psql"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR_REAL="$(cd "$BACKUP_DIR" && pwd -P)"

if [[ -n "${KEK_FILE:-}" && -e "$KEK_FILE" ]]; then
  KEK_DIR_REAL="$(cd "$(dirname "$KEK_FILE")" && pwd -P)"
  case "$KEK_DIR_REAL/" in
    "$BACKUP_DIR_REAL"/*) die "KEK лежит внутри BACKUP_DIR — ключ попал бы в копии; храните его отдельно" ;;
  esac
fi

case "$BACKUP_ENCRYPTION" in
  age)
    command -v age >/dev/null || die "нет age (или BACKUP_ENCRYPTION=openssl)"
    : "${BACKUP_AGE_RECIPIENTS_FILE:?укажите BACKUP_AGE_RECIPIENTS_FILE (публичные ключи age)}"
    [[ -s "$BACKUP_AGE_RECIPIENTS_FILE" ]] || die "файл получателей age пуст"
    EXT=age
    encrypt() { age --encrypt -R "$BACKUP_AGE_RECIPIENTS_FILE"; }
    ;;
  openssl)
    command -v openssl >/dev/null || die "нет openssl"
    : "${BACKUP_PASSPHRASE_FILE:?укажите BACKUP_PASSPHRASE_FILE}"
    [[ -s "$BACKUP_PASSPHRASE_FILE" ]] || die "файл пароля пуст"
    EXT=enc
    encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE"; }
    ;;
  *) die "BACKUP_ENCRYPTION: age или openssl" ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$BACKUP_DIR_REAL/mcp-$STAMP"
TMP="$BASE.dump.$EXT.partial"
trap 'rm -f "$TMP" "$BASE.counts.partial"' EXIT

# Число строк по таблицам схемы public (метаданные, без содержимого) — для сверки при проверке восстановления.
psql -X -v ON_ERROR_STOP=1 -At -F ' ' >"$BASE.counts.partial" <<'SQL'
SELECT format('SELECT %L, count(*) FROM public.%I;', tablename, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
SQL

# Формат custom (сжатый, выборочное восстановление pg_restore); владельцы и права восстанавливаются отдельно.
pg_dump --format=custom --no-password --quote-all-identifiers | encrypt >"$TMP"
[[ -s "$TMP" ]] || die "пустая копия"
mv "$TMP" "$BASE.dump.$EXT"
mv "$BASE.counts.partial" "$BASE.counts"
(cd "$BACKUP_DIR_REAL" && sha256sum "mcp-$STAMP.dump.$EXT" >"mcp-$STAMP.dump.$EXT.sha256")

# Хранение: удаляем старые копии (и их .sha256/.counts).
find "$BACKUP_DIR_REAL" -maxdepth 1 -type f -name 'mcp-*' -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "pg-backup: готово: $BASE.dump.$EXT"

# Чтение и скачивание файлов портала (2026-10-07, 2026-10-08)

| Инструмент            | Модуль | Методы Bitrix24                                        |
| --------------------- | ------ | ------------------------------------------------------ |
| `disk_file_read`      | disk   | `disk.file.get` + скачивание `DOWNLOAD_URL` сервером   |
| `crm_activity_files`  | crm    | `crm.activity.get` (`FILES`), `disk.file.get`          |
| `disk_file_download`  | disk   | `disk.file.get` + скачивание `DOWNLOAD_URL` сервером   |
| `chat_files_download` | chat   | `im.dialog.messages.get`, `disk.file.get` + скачивание |

- Форматы: txt, csv, tsv, md, json, xml, log, html/htm, pdf (текстовый слой, по страницам), docx (абзацы), xlsx
  (листы, ячейки через табуляцию, до 5000 строк на лист). Другие — `UNSUPPORTED_FILE_TYPE` до скачивания.
- Длинный текст — частями: `offset`, `maxChars` (до 100 000), ответ даёт `nextOffset`.
- Живой портал: `FILES` дела — `[{id, url}]`, где `id` — ID файла Диска (`disk.file.get` его читает), `url` —
  `crm_show_file.php` (не используется). `DOWNLOAD_URL` — `https://<портал>/rest/<user>/<код вебхука>/download/?…`,
  отдаётся сразу (200, без перенаправлений).
- Безопасность и зависимости — `docs/adr/0002-file-text-extraction.md`.

## Проверено

- Живой портал: вложения письма (xlsx и pdf), docx с Диска; ни в одном ответе нет кода вебхука
  и ссылок скачивания.
- `tests/unit/extract-text.test.ts`, `tests/integration/file-read.test.ts` (13 тестов): форматы, cp1251, части,
  zip-бомба, чужой host, перенаправление, размер. Мутационная проверка 6 мест — каждое ловится.
- Не поддерживается: сканы (OCR), doc/xls старых форматов, вложения в полях-файлах карточек (b_file, не Диск).

## Скачивание на диск сервера (2026-10-08)

- Включается только в `single`: `DOWNLOAD_DIR` (пусто — `FEATURE_UNAVAILABLE`, `reason: DOWNLOAD_DIR_NOT_SET`), в
  `saas` — ошибка конфигурации. Предел одного файла — `MAX_DOWNLOAD_BYTES` (по умолчанию 50 МБ, до 100 МБ).
- `folder` — подпапка внутри `DOWNLOAD_DIR`: до 3 частей из букв, цифр, пробела и `. _ ( ) -`, без `..`; после создания
  путь сверяется через `realpath` (символическая ссылка наружу → `VALIDATION_ERROR`). Файлы — права 600, папки — 700.
- Имя: `disk_file_download` — `<ID>_<имя>`, `chat_files_download` — `<дата>_<ID>_<имя>`; имя очищается от путей и
  спецсимволов. Существующий файл не перезаписывается (`exists`); запись через временный `.part` и переименование.
- `chat_files_download` идёт от новых сообщений к старым, за вызов — до `maxFiles` новых файлов и `maxSeconds` секунд;
  при `complete=false` повтор с `beforeMessageId=nextBeforeMessageId`. Уже скачанные пропускаются без обращения к
  порталу. Файл больше предела — `too_large`, удалённый или недоступный — `failed` с кодом; пакет не прерывается.
  Опись `_список-файлов.csv` (UTF-8 с BOM, `;`, защита от формул): дата, кто прислал, имя, имя на диске, размер, ID.
- Живой портал: ID файлов из `im.dialog.messages.get` (`files[].id`) — ID Диска, `disk.file.get` их отдаёт участнику
  диалога.
- Проверено: `tests/integration/file-download.test.ts`, `tests/unit/download-store.test.ts`; мутации проверки
  `realpath`, числа частей папки — ловятся.

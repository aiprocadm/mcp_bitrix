# База знаний 2.0 (`note.*`, REST 3.0) — ТЗ §9.14

Модуль `knowledgeBase` (включается в `ENABLED_MODULES`). Все методы — **только REST 3.0**
(endpoint `/rest/api/{user}/{secret}/{method}`), scope вебхука **`note`**. Это отдельный API, не
`landing.*` (классическая база знаний) и не выдуманные `wiki.*`.

## Инструменты

| Инструмент             | Операция | Методы Bitrix24                                                 | Примечание                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kb2_bases_list`       | read     | `note.collection.list`                                          | `pageSize`, `cursor?`. Native cursor `{position,id}` из `result.nextCursor` хранится на сервере (зашифрованно, привязан к principal/инструменту/pageSize); модель видит только ключ                                                                                                                                                                                                                         |
| `kb2_base_get`         | read     | `note.collection.get`                                           | `collectionId` → `result.item`                                                                                                                                                                                                                                                                                                                                                                              |
| `kb2_base_create`      | create   | `note.collection.add`                                           | `title` → `fields.name`, `position?` → `fields.position`; W                                                                                                                                                                                                                                                                                                                                                 |
| `kb2_documents_list`   | read     | `note.document.tree.list`                                       | `collectionId`, `parentId?`, `pageSize`, `cursor?`. У метода нет пагинации: дерево (до `TREE_MAX_NODES=5000`) читается целиком, отдаётся плоским списком (`documentId, parentId, title, position, depth, childCount`) страницами по сохранённому снимку; `truncated=true` у портала → `completeness=partial`                                                                                                |
| `kb2_document_get`     | read     | `note.document.get`                                             | `documentId`, `maxChars?` (500..50000, по умолчанию 20000), `contentCursor?`. Markdown + `contentHash` (sha256 полного текста UTF-8, он же `stateHash`). Длинный текст — кусками: `CONTENT_TRUNCATED` в warnings, `completeness=partial`, `contentCursor` на снимок полного текста (TTL = `CURSOR_TTL_SECONDS`, одноразовый, привязан к documentId). Кусок дополнительно ужимается под `MAX_RESPONSE_BYTES` |
| `kb2_documents_search` | read     | `note.document.search.list`                                     | `query` 3–200 символов, `pageSize` 1–50. **Только первая страница** (T37): `hasMore`, `coverage=first-page-only`, `nextCursor=null` всегда; при `hasMore=true` — `completeness=partial`, `PARTIAL_RESULT` и предложение сузить запрос. Параметра `cursor` у инструмента нет. `snippet` (HTML с `<b>`) приводится к простому тексту                                                                          |
| `kb2_document_create`  | create   | `note.collection.get`, `note.document.get`, `note.document.add` | `collectionId`, `title` ≤255, `parentId?`, `markdown?` ≤ 256 KiB; W. До плана: база существует, родитель читается `note.document.get` и должен быть в той же базе → иначе `VALIDATION_ERROR` с `reason=INVALID_PARENT` (без плана). Upstream `NOTE_INVALID_PARENT` тоже даёт `INVALID_PARENT`                                                                                                               |
| `kb2_document_update`  | update   | `note.document.get` + `note.document.update`                    | `documentId`, `mode: append\|replace`, `markdown` ≤ 256 KiB, `title?`, `overwrite=false`, W + `expectedStateHash` (= `contentHash`; обязателен для `append` и для `overwrite=true`)                                                                                                                                                                                                                         |

Все записи — через `MutationExecutor`: план (`APPROVAL_REQUIRED`) → подтверждение человеком
(`npm run approval:review`) → повтор с `approvalId` → одна запись → сверка повторным чтением → replay
по тому же ключу без второго вызова. Ответ записи без `result.item` → `OPERATION_OUTCOME_UNKNOWN`, без повтора.

## Совместное редактирование и `overwrite` (T38)

- `append` = чтение Markdown → сверка `contentHash` с `expectedStateHash` → добавление текста (через пустую строку) → `note.document.update`.
- Перед записью (precheck) документ перечитывается; изменившийся хеш → `CONFLICT` с `reason=COLLABORATIVE_EDIT_CONFLICT`.
- `note.document.update` всегда вызывается с явным `overwrite` из аргументов (по умолчанию `false`). Ответ
  `NOTE_DOCUMENT_HAS_UNSAVED_CHANGES` (документированная ошибка при открытом редакторе) → `CONFLICT`
  (`COLLABORATIVE_EDIT_CONFLICT`, `upstreamCode` сохраняется), операция `failed`, **повтора с `overwrite=true` нет**.
- `overwrite=true` — часть подтверждаемых аргументов (входит в хеш), значит нужен новый ключ, новый план и новое
  подтверждение; в плане первым риском стоит «ПРИНУДИТЕЛЬНО ЗАТРЁТ НЕСОХРАНЁННЫЕ ПРАВКИ совместного редактора».
- Честно: наш mutex/ledger защищает только собственные операции и **не блокирует редактор Bitrix24**; у API нет
  атомарного CAS. Повторное чтение перед записью сужает окно гонки, но не исключает конкурирующую правку. Это
  указано в рисках каждого плана update.
- `stateHash` = sha256 только текста Markdown (по заданию `expectedStateHash = contentHash`); изменение одного
  названия документа конфликтом не считается.

## Ограничения и допущения

- Предел входного Markdown — 256 KiB (наш); документированный предел портала — 1 048 576 байт. Для `append`
  итог (текущий + добавляемый) проверяется на 1 MiB до плана и в precheck (`reason=MARKDOWN_TOO_LARGE`).
- План показывает текст целиком до 16 000 символов; длиннее — начало, конец, размер и sha256 (иначе ответ
  `APPROVAL_REQUIRED` превысил бы `MAX_RESPONSE_BYTES` и потерял `operationId`). Подтверждение всё равно привязано
  к хешу полного текста аргументов.
- Сверка после записи сравнивает sha256 отправленного и перечитанного текста; если портал нормализует Markdown,
  `verified=false` с предупреждением (запись при этом выполнена).
- `BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION` приходит с HTTP 400 (обзор REST 3.0), а общий
  `mapUpstreamError` ищет `NOT_FOUND` с подчёркиванием; в сервисе модуля такой код приводится к `NOT_FOUND`.
- Документы с прямым доступом без базы (`collectionId=null`) читаются `kb2_document_get`/поиском; создать
  их этим сервером нельзя (`note.document.add` требует `collectionId`).
- Не реализовано (нет в §9.14): архивирование/удаление (`note.*.archive/delete`), файлы (`note.file.*`),
  переименование базы (`note.collection.update`), схемы полей (`note.*.field.*`).

## Источники (локальное зеркало apidocs, en)

- https://apidocs.bitrix24.ru/api-reference/note/collection/note-collection-list.html
- https://apidocs.bitrix24.ru/api-reference/note/collection/note-collection-get.html
- https://apidocs.bitrix24.ru/api-reference/note/collection/note-collection-add.html
- https://apidocs.bitrix24.ru/api-reference/note/document/note-document-tree-list.html
- https://apidocs.bitrix24.ru/api-reference/note/document/note-document-get.html
- https://apidocs.bitrix24.ru/api-reference/note/document/note-document-search-list.html
- https://apidocs.bitrix24.ru/api-reference/note/document/note-document-add.html
- https://apidocs.bitrix24.ru/api-reference/note/document/note-document-update.html
- https://apidocs.bitrix24.ru/api-reference/rest-v3.html

## Проверки

- mock (`tests/integration/kb2.test.ts`, `tests/helpers/mock-note.ts`, ответы в форме v3): чтения и параметры
  запросов, native cursor, отказ курсора с чужой привязкой, снимок дерева, усечение текста и продолжение
  `contentCursor`, T37, T38, INVALID_PARENT (до плана и от портала), approve/replay для create/update,
  CONFLICT по хешу до плана и в precheck, outcome unknown, лимит 256 KiB, длинный текст в плане.
- Реальный портал: **not-run** (формы ответов взяты из документации, на живом Bitrix24 не сверялись;
  в частности HTTP-статус `NOTE_DOCUMENT_HAS_UNSAVED_CHANGES` и поведение `truncated` не наблюдались).

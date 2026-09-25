# Модуль «Задачи» — полная версия (ТЗ §9.8)

Модуль конфигурации: `tasks` (`ENABLED_MODULES`). MVP-инструменты `task_create`, `task_get`, `task_list` описаны в каталоге;
здесь — инструменты этапа 13/14. Все записи идут через `MutationExecutor`: план → `APPROVAL_REQUIRED` → подтверждение
человеком (`npm run approval:review`) → повтор с `approvalId` → одна запись → сверка. Повтор после успеха возвращает
сохранённый результат (`replayed=true`) без второй записи.

## Инструменты

| Инструмент                    | Операция         | REST-методы                                                                                                                                                | Scope           |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `task_update`                 | update           | `tasks.task.getfields`, `tasks.task.get`, `tasks.task.update`                                                                                              | task            |
| `task_complete`               | update           | `tasks.task.get` (legacy), `tasks.task.get` (REST 3.0), `tasks.task.complete`                                                                              | task, tasks     |
| `task_delete`                 | delete (этап 14) | `tasks.task.get`, `tasks.task.list` (подзадачи), `task.checklistitem.getlist`, `tasks.task.delete`                                                         | task            |
| `task_checklist_get`          | read             | `tasks.task.get`, `task.checklistitem.getlist`                                                                                                             | task            |
| `task_checklist_add`          | create           | `task.checklistitem.getlist`, `task.checklistitem.add`                                                                                                     | task            |
| `task_checklist_update`       | update           | `task.checklistitem.getlist`, `task.checklistitem.update`                                                                                                  | task            |
| `task_checklist_set_complete` | update           | `task.checklistitem.getlist`, `task.checklistitem.complete` / `task.checklistitem.renew`                                                                   | task            |
| `task_checklist_delete`       | delete (этап 14) | `task.checklistitem.getlist`, `task.checklistitem.delete`                                                                                                  | task            |
| `task_comment_add`            | create           | `tasks.task.get`; новая карточка — `tasks.task.chat.message.send` (REST 3.0) + `im.dialog.messages.get` (поиск messageId); старая — `task.commentitem.add` | task, tasks, im |
| `task_comments_list`          | read             | `tasks.task.get`; новая карточка — `im.dialog.messages.get`; старая — `task.commentitem.getlist`                                                           | task, im        |

`task_get` дополнен полем `stateHash` (только при чтении без `select`) — его передают как `expectedStateHash`
в `task_update` / `task_complete` / `task_delete`.

## Новые записи реестра (`src/bitrix/registry/tasks.ts`)

Источник — официальные страницы (`https://apidocs.bitrix24.ru/api-reference/tasks/...`), сверено с локальным зеркалом b24restdocs:

- legacy: `tasks.task.update` (tasks-task-update), `tasks.task.complete` (status/tasks-task-complete), `tasks.task.delete` (tasks-task-delete);
- v3: `tasks.task.get` (tasks-task-get-rest-v3, scope `tasks`, ответ `result.item`), `tasks.task.chat.message.send` (tasks-task-chat-message-send, ответ `result.result=true`);
- legacy чек-листы: `task.checklistitem.getlist | add | update | complete | renew | delete` (checklist-item/*);
- legacy комментарии: `task.commentitem.getlist | add` (comment-item/*).

Legacy и REST 3.0 `tasks.task.get` — разные ключи реестра (`legacy:` / `v3:`), разные URL (`/rest/…/tasks.task.get.json`
и `/rest/api/…/tasks.task.get`) и формы ответа (`result.task` camelCase и `result.item`). Покрыто тестом T03.

Безопасно для raw allowlist (только чтение, без персональных данных сверх необходимого): `v3:tasks.task.get`,
`legacy:task.checklistitem.getlist` (rawCallable=true). `task.commentitem.getlist` намеренно `rawCallable=false`:
ответ содержит `AUTHOR_EMAIL` и ссылки на скачивание вложений.

## Ключевые решения и допущения

- **task_update**: `patch` — только поля из `tasks.task.getfields` (UPPER_CASE), серверные поля запрещены, типы проверяются
  (`validateTaskFieldsForWrite(..., 'update')`: обязательные поля не требуются, но очистить их нельзя). `STATUS` не принимается
  (`USE_DEDICATED_TOOL`): завершение только через `task_complete`, иначе обходилась бы проверка результата. До плана:
  чтение задачи, `stateHash` (набор стандартных полей + `changedDate`), `CONFLICT` по `expectedStateHash`,
  `action.edit=false` → `BITRIX_ACCESS_DENIED` (`ACTION_NOT_ALLOWED`), «нечего менять» → `NO_CHANGES`. После записи —
  перечитать и сверить каждое поле (даты — как моменты времени, массивы — как множества).
- **task_complete (T30)**: требование результата берётся из документированных полей REST 3.0 `requireResult` /
  `containsResults` / `needsControl` (fields-rest-v3). `requireResult=true` и `containsResults=false` → `VALIDATION_ERROR`
  с `reason=RESULT_REQUIRED` до плана и повторно в precheck перед записью. Если REST 3.0 недоступен (нет scope `tasks`,
  метод не найден), план честно пишет «требование результата не проверено», `validationLevel=local`. После завершения
  задача перечитывается; ответ содержит фактический `status`, `completed` (только при 5), `awaitingControl` (при 4,
  контроль постановщика) и предупреждение «НЕ завершена», если статус не 5.
- **task_delete / task_checklist_delete**: видны только при `ENABLE_DESTRUCTIVE_TOOLS=true` и роли `administrator`
  (register-tools). План: название, ответственный, статус и impact (подзадачи по `PARENT_ID`, пункты чек-листов, число
  комментариев, чат новой карточки / вложенные подпункты). Verify: повторное чтение → `NOT_FOUND` (задача) или
  отсутствие в `getlist` (пункт). Повтор подтверждённого удаления после успеха работает (объекта уже нет — replay).
- **Чек-листы**: методы старого API принимают параметры позиционно (документация: «Pass parameters in the request according
  to the order in the table»; при нарушении `complete/renew` возвращают `false`). Тела строятся только `checklistParams`
  в порядке `TASKID → ITEMID → FIELDS` / `TASKID → ORDER`; fixture-тесты проверяют порядок ключей. `complete/renew/update`
  не проверяют принадлежность пункта задаче — сервер проверяет по `getlist` (чужой пункт → `NOT_FOUND` до плана).
  Несуществующий `parentId` в `add` отклоняется (`PARENT_NOT_FOUND`), т.к. портал молча создал бы новый чек-лист.
  `getlist` не пагинируется на стороне Bitrix — сервер отдаёт дерево страницами по непрозрачному курсору.
- **Обсуждение (T29)**: backend выбирается по документированному признаку — `chatId` в legacy `tasks.task.get`
  (tasks-new: «CHAT_ID … returned by default»). Новая карточка: чтение `im.dialog.messages.get` с `DIALOG_ID=chat<chatId>`,
  курсор по `LAST_ID`, без отметки о прочтении; отправка — `tasks.task.chat.message.send` (REST 3.0). Старая карточка:
  `task.commentitem.getlist` (курсор по `<ID`) / `task.commentitem.add`. Backend входит в подтверждаемые аргументы:
  смена backend после подтверждения → `APPROVAL_MISMATCH`, отправки в оба канала нет. Если у задачи есть чат, но REST 3.0
  недоступен, используется `task.commentitem.add` (миграционная таблица tasks-new: в новой карточке «Works»), это явно
  указано в плане. Ошибка отправки выбранным backend (например, `FEATURE_UNAVAILABLE`) возвращается как есть, без
  переключения на другой канал.
- Выдача минимальна: из комментариев убраны `AUTHOR_EMAIL` и ссылки вложений (только `filesCount`), из участников
  пунктов — имена и аватары (только `id`/`type`). Тексты задач и чатов — внешние данные.

## Отклонения от ТЗ и нужные изменения общих файлов

- Кодов `RESULT_REQUIRED` и `CHAT_ACCESS_DENIED` нет в `ERROR_CODES` (`src/errors/app-error.ts`, общий файл). Сейчас:
  `VALIDATION_ERROR` + `details.reason='RESULT_REQUIRED'` и `BITRIX_ACCESS_DENIED` + `details.reason='CHAT_ACCESS_DENIED'`.
  Если владелец решит ввести отдельные коды — добавить их в `ERROR_CODES` и заменить код в `task-update.ts` / `task-comments.ts`.
- `tasks.task.chat.message.send` по документации не возвращает ID сообщения. `messageId` ищется чтением последних
  20 сообщений чата (совпадение текста, не системное); если не найдено — `messageId=null`, `verified=false`.
- `tests/integration/mcp-inmemory.test.ts` содержит жёсткий список read-инструментов; в него добавлены
  `task_checklist_get` и `task_comments_list`.

## Gaps

- Приёмка результата постановщиком (`tasks.task.approve` / `disapprove`) и добавление результата
  (`tasks.task.result.*`) в §9.8 не входят и не реализованы; при статусе «Ждёт контроля» инструмент сообщает об этом.
- Поведение `tasks.task.get` после удаления на реальном портале (код ошибки) не подтверждено: verify считает успехом только
  `NOT_FOUND`, иначе `verified=false` с предупреждением.

## Проверка

- Mock (`tests/integration/tasks-full.test.ts`, 26 тестов; `tests/helpers/mock-tasks.ts` — портал с позиционным разбором
  тел старого API): полный путь approve/replay для всех записей, CONFLICT до плана и в precheck, OUTCOME_UNKNOWN,
  T30 (RESULT_REQUIRED до плана и в precheck; «Ждёт контроля» без ложного «завершена»), T29 (chatId → im, отправка v3,
  без дубля в старый комментарий, CHAT_ACCESS_DENIED), чек-листы с порядком параметров, delete скрыт/не-админ.
- Реальный портал: **not-run** (в т.ч. REST 3.0 `/rest/api/`, новая карточка задач `tasks 25.700.0+`).

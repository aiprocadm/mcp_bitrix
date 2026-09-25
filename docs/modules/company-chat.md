# Группа company-chat: сотрудники и оргструктура, чаты, телефония, рабочие группы

Этап 13 (и delete этапа 14) ТЗ: §9.2 (модуль `company`), §9.9 (модули `chat`, `telephony`), §9.11 (модуль `groups`).
Проверено **только на mock** (`tests/integration/company.test.ts`, `chat-full.test.ts`, `groups-telephony.test.ts`).
На реальном портале: **not-run**.

## Инструменты

| Инструмент                         | Модуль    | Операция                                                | REST-методы                                                                          | Подтверждение                                                             |
| ---------------------------------- | --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `employee_search`                  | company   | read                                                    | `user.search` (+ `department.get` для названий отделов)                              | нет                                                                       |
| `company_departments_list`         | company   | read                                                    | `department.get` (+ `user.get` для имён руководителей)                               | нет                                                                       |
| `company_department_create`        | company   | create                                                  | `department.get`, `user.get` → `department.add`                                      | да                                                                        |
| `company_department_update`        | company   | update                                                  | `department.get`, `user.get` → `department.update`                                   | да                                                                        |
| `company_department_delete`        | company   | delete (этап 14)                                        | `department.get`, `user.get` → `department.delete`                                   | да; виден только при `ENABLE_DESTRUCTIVE_TOOLS=true` и роли administrator |
| `company_employee_departments_set` | company   | update (DESTRUCTIVE annotations: полная замена состава) | `method.get` (probe), `user.get`, `department.get` → `user.update` (`UF_DEPARTMENT`) | да                                                                        |
| `chat_recent_list`                 | chat      | read                                                    | `im.recent.list`, `im.counters.get`                                                  | нет                                                                       |
| `chat_messages_get`                | chat      | read                                                    | `im.dialog.messages.get`                                                             | нет                                                                       |
| `telephony_calls_list`             | telephony | read                                                    | `voximplant.statistic.get`                                                           | нет                                                                       |
| `workgroups_list`                  | groups    | read                                                    | `sonet_group.get`                                                                    | нет                                                                       |
| `workgroup_members_list`           | groups    | read                                                    | `sonet_group.user.get` (+ `user.get` для имён)                                       | нет                                                                       |

Существующий `chat_send_message` не изменялся.

## Новые методы реестра (`src/bitrix/registry/company-chat.ts`)

| Метод                      | Операция | Scope       | Пагинация                       | raw                                  | Источник                                                    |
| -------------------------- | -------- | ----------- | ------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `department.get`           | read     | department  | offset (`START`)                | да                                   | api-reference/departments/department-get                    |
| `department.add`           | create   | department  | —                               | нет                                  | api-reference/departments/department-add                    |
| `department.update`        | update   | department  | —                               | нет                                  | api-reference/departments/department-update                 |
| `department.delete`        | delete   | department  | —                               | нет                                  | api-reference/departments/department-delete                 |
| `user.update`              | update   | user        | —                               | нет                                  | api-reference/user/user-update                              |
| `im.counters.get`          | read     | im          | —                               | да                                   | api-reference/chats/im-counters-get                         |
| `voximplant.statistic.get` | read     | telephony   | offset                          | нет (в ответе ссылки на записи/логи) | api-reference/telephony/voximplant/voximplant-statistic-get |
| `sonet_group.get`          | read     | sonet_group | offset                          | да                                   | api-reference/sonet-group/sonet-group-get                   |
| `sonet_group.user.get`     | read     | sonet_group | нет (весь состав одним ответом) | да                                   | api-reference/sonet-group/members/sonet-group-user-get      |

Переиспользованы без изменений: `user.search`, `user.get`, `im.recent.list`, `im.dialog.messages.get`, `method.get`.

## Правила и допущения

- **Минимум персональных данных (§8.4).** `user.search`/`user.get` вызываются с явным `select`
  (ID, ACTIVE, NAME, LAST_NAME, SECOND_NAME, WORK_POSITION, UF_DEPARTMENT, USER_TYPE): email, телефоны, даты рождения
  даже не запрашиваются. Из `im.*` не выдаются контакты собеседников, аватары и ссылки на файлы (`urlShow/urlDownload`).
- **T24.** `employee_search` возвращает всех кандидатов; при нескольких — `ambiguous=true`, `selectionRequired=true`,
  полные однофамильцы — в `sameNameGroups`. Автоматического выбора нет; это не ошибка поиска.
- **Коды ТЗ внутри классов §14.5.** Список кодов сервера фиксирован, поэтому коды §9 передаются в `details.reason`:
  `VALIDATION_ERROR` + `INVALID_PARENT` / `INVALID_HEAD` / `HIERARCHY_CYCLE` / `HIERARCHY_CHECK_INCOMPLETE` /
  `DEPARTMENT_NOT_EMPTY` / `ROOT_DEPARTMENT` / `INVALID_DEPARTMENT` / `NO_CHANGES`; `BITRIX_ACCESS_DENIED` +
  `CHAT_ACCESS_DENIED` / `GROUP_ACCESS_DENIED`; `FEATURE_UNAVAILABLE` + `TELEPHONY_UNAVAILABLE` / `METHOD_UNAVAILABLE`.
- **department.add требует PARENT** (страница метода), а второй корень портал не допускает. Если `parentId` не передан,
  берётся единственный корневой отдел (найденный полным чтением `department.get`, до 6 страниц), в плане
  `parentDefaulted=true` и отдельный риск. Если корень не определяется однозначно — `INVALID_PARENT`.
- **HIERARCHY_CYCLE.** Обход предков нового родителя через `department.get` (по `PARENT`) до корня; встретили сам отдел — цикл.
  Глубже 50 уровней или обрыв цепочки — отказ `HIERARCHY_CHECK_INCOMPLETE` (не догадка). Проверка повторяется в precheck.
- **UF_HEAD.** В таблице полей ответа `department.get` поле не описано, но документировано как фильтр/сортировка и как
  поле `department.*` (обзор методов). Если портал его не вернул, `headId=null`, а сверка руководителя после записи
  помечается предупреждением «не сверен».
- **DEPARTMENT_NOT_EMPTY.** До плана и повторно в precheck: подотделы (`department.get` по `PARENT`) и привязанные
  пользователи (`user.get` по `UF_DEPARTMENT` без фильтра активности — уволенные тоже блокируют). Неявного переноса нет.
  Корневой отдел не удаляется. После удаления сверка: отдел больше не читается.
- **Повтор удаления.** Если отдел уже удалён, а вызов пришёл с `approvalId`, результат отдаёт исполнитель (replay);
  неисполненная операция в этом случае отклоняется precheck (CONFLICT), записи нет.
- **company_employee_departments_set.** До плана — `method.get` через `ctx.capabilities.probe`: явное «метод отсутствует /
  недоступен» → `FEATURE_UNAVAILABLE`; ошибка или непроверенность probe — риск в плане, решает портал. Пустой список отделов
  запрещён схемой. Риск, если сотрудник — руководитель покидаемого отдела (руководство не передаётся автоматически).
- **stateHash.** Отдел: `{id, name, sort, parentId, headId}`; сотрудник: `{id, departmentIds}`. Отдаётся в
  `company_departments_list`, в dryRun и в плане; после записи — новый хеш.
- **chat_recent_list.** Документация `im.recent.list` описывает `OFFSET`/`LIMIT` (до 200) и `result.hasMore`, поэтому
  реализован серверный курсор (OFFSET += LIMIT). Документация предупреждает о повторах диалогов на стыке страниц: внутри
  страницы повторы убираются, между страницами — предупреждение. Открытые линии по умолчанию пропускаются
  (`SKIP_OPENLINES=Y`, меньше повторов). Счётчики `im.counters.get` — только на первой странице, best-effort.
- **chat_messages_get.** `LAST_ID` (старее) / `FIRST_ID` (новее), `LIMIT` ≤ 50. Портал может вернуть больше `LIMIT`
  при непрочитанных — страница режется до `pageSize` ближе к якорю, курсор строится от последнего выданного ID, поэтому
  пропусков нет. `hasMore` — эвристика по заполненности страницы (следующая может оказаться пустой; предупреждение).
  Никаких вызовов `im.dialog.read`/mark-as-read. `dialogId`: число, `chat<id>` или `sg<id>` (страница метода);
  из ФИО не конструируется. `ACCESS_ERROR` → `CHAT_ACCESS_DENIED` с пояснением, что права администратора не открывают
  чужую переписку. Тексты — внешние данные (описание инструмента); длинные обрезаются до 4000 символов с флагом.
- **telephony_calls_list.** Явный allowlist полей; `CALL_RECORD_URL`, `RECORD_FILE_ID`, `CALL_LOG`, `TRANSCRIPT_*`,
  `COMMENT`, стоимость не выдаются; есть только `hasRecording`. Номер абонента маскируется (`***4567`), полностью —
  при `includePhoneNumbers=true` с предупреждением. Отсутствующий метод/модуль → `FEATURE_UNAVAILABLE`
  (`TELEPHONY_UNAVAILABLE`). Полнота внешней АТС не гарантируется (предупреждение в каждом ответе).
- **workgroups_list.** `PROJECT` не входит в документированные поля фильтра `sonet_group.get`, поэтому `projectOnly`
  применяется локально (не более 4 upstream-страниц за вызов, продолжение по курсору; `total` в этом режиме `null`).
  `activeOnly` → `ACTIVE=Y` и `CLOSED=N` (документированные фильтры). `IS_ADMIN` не передаётся — видимость по правам.
- **workgroup_members_list.** `sonet_group.user.get` возвращает весь состав одним ответом; страницы режутся на сервере MCP.
  По документации «группа не найдена или закрыта» приходит HTTP 400 без кода — отдаётся `GROUP_ACCESS_DENIED`
  (отличить отсутствие от закрытости нельзя).
- **Scope рабочих групп.** Страница `sonet_group.get` ссылается на scope «sonet», но справочник scope
  (api-reference/scopes/permissions) уточняет: для рабочих групп выдаётся `sonet_group`. В реестре — `sonet_group`.

## Gaps и расхождения

- `im.recent.list` в базовом реестре (`method-registry.ts`) описан с `pagination: 'first-page-only'`, хотя актуальная
  страница метода документирует `OFFSET`/`LIMIT`/`hasMore`. Запись не менялась (правило группы); реализация
  использует документированную пагинацию. Нужна правка базовой записи на `offset` владельцем общего файла.
- Команды, матричные связи, заместители новой оргструктуры (`humanresources.*`, REST 3.0) не реализованы —
  ТЗ §9.2 ограничивает объём отделами, руководителями и членством; `department.delete` в REST 3.0 аналога не имеет.
- Снятие руководителя отдела (очистка `UF_HEAD`) не поддержано: способ очистки поля не документирован.
- Записи разговоров, расшифровки и скачивание аудио — выключены по ТЗ §9.9 (не реализуются).
- Полная история чата открытых линий без участия (`imopenlines.session.history.get`) — вне объёма.

## Что проверено

Mock-интеграционные тесты (30): T24, INVALID_PARENT/INVALID_HEAD до плана, HIERARCHY_CYCLE (подотдел, сам себя),
ROOT_DEPARTMENT, NO_CHANGES, CONFLICT до плана и в precheck (операция → failed, записи нет), полный путь
APPROVAL_REQUIRED → approve → одна запись → сверка → replay без второго вызова (create/update/delete/employee set),
OPERATION_OUTCOME_UNKNOWN без повторной записи, DEPARTMENT_NOT_EMPTY до плана и при гонке после подтверждения,
delete скрыт без `ENABLE_DESTRUCTIVE_TOOLS` и запрещён operator, FEATURE_UNAVAILABLE по method.get, diff отделов,
курсоры (T20-класс) для user.search, im.recent.list, im.dialog.messages.get, voximplant.statistic.get, sonet_group.get,
отсутствие `im.dialog.read`, отсутствие ссылок на записи/файлы и контактов в ответах, CHAT_ACCESS_DENIED, GROUP_ACCESS_DENIED.

Не проверено на реальном портале (not-run): фактическая форма `UF_HEAD` в `department.get`, поведение `user.search`
с `ACTIVE`/`UF_DEPARTMENT` вместе с `FIND`, реальные повторы `im.recent.list`, коды ошибок телефонии без модуля.

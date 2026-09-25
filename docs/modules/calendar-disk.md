# Модуль «Календарь и Диск» (ТЗ §9.3, §9.12; этапы 13–14)

Статус: реализовано и проверено **только на mock** (`tests/integration/calendar-full.test.ts`,
`tests/integration/disk-full.test.ts`). На реальном портале **not-run**.

## Инструменты

| Инструмент                    | Операция | Методы Bitrix24                                                                                    | Видимость                                            |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `calendar_list`               | read     | `calendar.section.get`                                                                             | всегда (модуль `calendar`)                           |
| `calendar_list_events`        | read     | `calendar.event.get` (+ `profile` для статуса «моё участие», если ID владельца вебхука неизвестен) | всегда                                               |
| `calendar_update_event`       | update   | `calendar.event.getbyid` → `calendar.event.update` → `calendar.event.getbyid`                      | запись включена                                      |
| `calendar_delete_event`       | delete   | `calendar.event.getbyid` → `calendar.event.delete` → `calendar.event.getbyid`                      | `ENABLE_DESTRUCTIVE_TOOLS=true` + роль administrator |
| `calendar_respond_invitation` | update   | `calendar.event.getbyid` → `calendar.meeting.status.set` → `calendar.meeting.status.get`           | запись включена                                      |
| `employee_availability`       | read     | `calendar.accessibility.get`                                                                       | всегда                                               |
| `disk_storages_list`          | read     | `disk.storage.getList`                                                                             | всегда (модуль `disk`)                               |
| `disk_children_list`          | read     | `disk.storage.getChildren` / `disk.folder.getChildren`                                             | всегда                                               |
| `disk_search_files`           | read     | ограниченный обход `disk.storage.getChildren` + `disk.folder.getChildren`                          | всегда                                               |
| `disk_delete_file`            | delete   | `disk.file.get` → `disk.file.markDeleted` → `disk.file.get`                                        | `ENABLE_DESTRUCTIVE_TOOLS=true` + роль administrator |

Scope: `calendar`, `disk`. Все записи идут через `MutationExecutor`: план → `APPROVAL_REQUIRED` →
подтверждение человеком (`npm run approval:review`) → повтор с `approvalId` → одна запись → сверка.

## Новые записи реестра методов (`src/bitrix/registry/calendar-disk.ts`)

| Метод                         | Операция | rawCallable                         | Источник                                                                                           |
| ----------------------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `calendar.event.update`       | update   | нет                                 | https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-event-update.html       |
| `calendar.event.delete`       | delete   | нет                                 | https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-event-delete.html       |
| `calendar.meeting.status.set` | update   | нет                                 | https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-meeting-status-set.html |
| `calendar.meeting.status.get` | read     | да                                  | https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-meeting-status-get.html |
| `calendar.accessibility.get`  | read     | нет (отдаёт названия чужих событий) | https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-accessibility-get.html  |
| `disk.storage.getchildren`    | read     | да                                  | https://apidocs.bitrix24.ru/api-reference/disk/storage/disk-storage-get-children.html              |
| `disk.file.markdeleted`       | delete   | нет                                 | https://apidocs.bitrix24.ru/api-reference/disk/file/disk-file-mark-deleted.html                    |

Переиспользованы без изменений: `calendar.section.get`, `calendar.event.get`, `calendar.event.getbyid`,
`calendar.event.add`, `disk.storage.getlist`, `disk.folder.getchildren`, `disk.folder.get`, `disk.file.get`, `profile`.

## Решения и допущения

### Календарь

- **Тип «company»** передаётся в Bitrix как `company_calendar` с `ownerId=0` — так в документации
  `calendar.section.get`/`calendar.event.get`/`update`/`add`. Эта же правка внесена в существующий
  `calendar_create_event` (раньше уходило `type=company`, не документированное значение).
- **Даты (T28).** Вход: обе даты `YYYY-MM-DD` (включительно, в зоне `timezone`) либо обе ISO с явным смещением;
  дата-время без зоны → `TIMEZONE_REQUIRED`; `to ≤ from` → `INVALID_DATE_RANGE`; неизвестная зона → `INVALID_TIMEZONE`.
  Моменты берутся из `DATE_FROM_TS_UTC`/`DATE_TO_TS_UTC` (формат `DATE_FROM` зависит от языка портала — в документации
  пример `12/11/2024 05:59:00 pm`). Вывод — ISO со смещением, вычисленным на конкретный момент (DST учитывается;
  тест на сутки перехода Europe/Berlin — 25 часов). События на весь день выдаются датой.
- **calendar_list_events.** `calendar.event.get` пагинации не имеет — отдаёт весь период. Bitrix получает даты с запасом
  ±1 сутки, точный отбор по моменту делает сервер. Результат сортируется и кладётся **снимком** в серверный курсор
  (шифрованное состояние, привязано к principal/portal/tool/параметрам, одноразовое, с TTL); страницы по `pageSize`
  выдаются из снимка без повторных запросов. Период ≤ 93 дней, снимок ≤ 1000 событий (сверх — `partial` + предупреждение).
- **Повторяющиеся события.** Признак — непустой `RRULE`. Без `recurrenceScope` update/delete → `RECURRENCE_SCOPE_REQUIRED`.
  `calendar.event.update` документирует `recurrence_mode=this|next|all` и `current_date_from` — поддержаны
  (`occurrenceDate` обязателен для this/next; ответ-объект `recEventId` сверяется как новое событие).
  `calendar.event.delete` принимает только `id` — поддержан лишь `recurrenceScope=all` (вся серия, риск в плане);
  this/next → `RECURRENCE_SCOPE_UNSUPPORTED`.
- **Участники.** `patch.attendeeIds` — новый полный список; в плане `added`/`removed`, риски об уведомлениях.
  Организатор всегда остаётся в `attendees`. `host` передаётся только если меняет не организатор (как требует документация).
- **stateHash события**: название, моменты, зоны, весь день, раздел, описание, место, доступность, важность, приватность,
  RRULE/EXDATE, организатор, состав участников (без их ответов), VERSION. CONFLICT до плана и в precheck (при `expectedStateHash`).
- **calendar_respond_invitation.** Документированы статусы `Y`/`N`/`Q`; `Q` — «не ответил», это не ответ. Поэтому
  `accepted→Y`, `declined→N`, `tentative` → `INVALID_STATUS`. Ответ только от текущей Bitrix-личности
  (ID владельца вебхука из конфигурации, иначе `profile`): если его нет в `ATTENDEE_LIST` → `ACCESS_DENIED/NOT_AN_ATTENDEE`;
  организатор → `ORGANIZER_CANNOT_RESPOND`. Сверка через `calendar.meeting.status.get`.
- **employee_availability.** Интервалы `busy|absent|tentative` (ACCESSIBILITY `quest` → tentative; `free` не занимает время),
  обрезанные по периоду; `free` — дополнение только при полных данных. Нет ключа пользователя в ответе, пустой ответ `[]`
  или событие без распознанного времени → `completeness=unknown` и **без** `free`. Названия чужих событий не выдаются.
  Предупреждение: это календарь, не присутствие и не загрузка задачами. Период ≤ 62 дней, до 50 пользователей.

### Диск

- **Секретные ссылки.** `DOWNLOAD_URL` (содержит `auth`/`token`) отбрасывается при нормализации и не попадает ни в ответ,
  ни в состояние курсора. `DETAIL_URL` выдаётся только если это `https` на хост портала без query/fragment/userinfo.
- **disk_search_files.** Обход в ширину от корня хранилища или папки; фильтр имени (подстрока, без регистра, NFC) применяется
  к результатам, **не** к папкам обхода и **не** передаётся в Bitrix. Очередь, смещение в текущей папке, найденные-но-не-выданные
  и счётчики — в серверном курсоре (привязка к пользователю и параметрам). За вызов ≤ 10 upstream-страниц.
  `maxDepth ≤ 5` (пропущенные по глубине папки → `partial` + счётчик), `maxVisited ≤ 500` просмотренных объектов
  (→ `coverage.reason=SCAN_LIMIT_REACHED`, `partial`, продолжения нет). `recursive=false` — только сама область.
- **disk_delete_file.** По документации `disk.file.delete` удаляет **безвозвратно**, `disk.file.markDeleted` — в корзину
  с восстановлением (`disk.file.restore`). Выбран безопасный документированный вариант `markDeleted`; это указано в плане
  (`mode: trash`, риск «Безвозвратное удаление не выполняется»). `disk.file.delete` в реестр не добавлен.
  stateHash: имя, размер, `GLOBAL_CONTENT_VERSION`, `UPDATE_TIME`, папка, `DELETED_TYPE`. Уже в корзине → `ALREADY_IN_TRASH`.
  Сверка: `disk.file.get` показывает `DELETED_TYPE≠0` (или NOT_FOUND).
- **Повтор удаления** (оба delete-инструмента): если объект уже удалён и передан `approvalId`, инструмент не отказывает
  NOT_FOUND, а отдаёт управление исполнителю, который возвращает сохранённый результат (`replayed=true`) без новой записи.

## Gaps

| Что                                                                   | Источник                               | Наблюдение                                                         | Альтернатива / решение                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| «Под вопросом» (tentative) в ответе на приглашение                    | calendar-meeting-status-set            | Документированы только `Y`, `N`, `Q`                               | `INVALID_STATUS`; можно поставить `accessibility=quest` своему событию через update                                         |
| Удаление одного вхождения повторяющегося события                      | calendar-event-delete                  | Только параметр `id`                                               | Отказ `RECURRENCE_SCOPE_UNSUPPORTED`; вхождение можно изменить через update (`this`)                                        |
| Поведение `calendar.event.delete` для серии                           | calendar-event-delete                  | Не описано явно                                                    | В плане риск «будет удалена вся серия»; сверка перечитыванием                                                               |
| Форма `calendar.event.getbyid` для удалённого/несуществующего события | calendar-event-get-by-id               | Не описана                                                         | Пустой/не-объектный result, `DELETED=Y` и NOT_FOUND трактуются как «нет события»                                            |
| `DATE_TO_TS_UTC` у событий на весь день                               | calendar_event_fields                  | Семантика не описана                                               | Для all-day используется дата из `DATE_FROM`/`DATE_TO` (DD.MM.YYYY, MM/DD/YYYY, YYYY-MM-DD), затем TS                       |
| `disk.file.search` (индексный поиск)                                  | disk-file-search                       | Метод документирован (≥3 символов, по индексу, включая содержимое) | Не используется: ТЗ требует ограниченный обход с явным coverage; кандидат на отдельный инструмент после проверки на портале |
| `calendar.section.get` > 50 календарей                                | calendar-section-get (комментарий SDK) | Возможна одна страница из 50                                       | При 50 разделах `completeness=unknown` + предупреждение                                                                     |

## Проверено (mock)

- calendar: разделы и права, company→company_calendar; список событий — отбор по моменту, all-day датой, повторяемость,
  постраничная выдача из снимка без повторного запроса; T21 (курсор другого пользователя/выборки); T28 (обратный интервал,
  равные границы, без зоны, смешанный формат, слишком длинный период, неизвестная зона, DST Europe/Berlin).
- update: diff дат и участников, риски, полный путь approve → запись → сверка → replay; CONFLICT до плана и в precheck;
  RECURRENCE_SCOPE_REQUIRED, this без occurrenceDate, this для неповторяющегося; `this` → новое событие; allDay;
  чужой календарь; NOT_FOUND; host для не-организатора; OPERATION_OUTCOME_UNKNOWN без повтора.
- delete: скрыт без флага, ACCESS_DENIED оператору, impact с участниками, серия, RECURRENCE_SCOPE_UNSUPPORTED, approve/replay, CONFLICT.
- respond: принять за себя со сверкой; чужое участие, организатор, tentative, неизвестный статус.
- availability: busy/absent/free, all-day, completeness unknown, пустой ответ, лимиты, отсутствие названий событий.
- disk: хранилища и фильтр, корень/папка с продолжением по cursor, DOWNLOAD_URL и чужие ссылки не утекают ни в один ответ,
  поиск нерекурсивный/рекурсивный с продолжением, maxDepth, SCAN_LIMIT_REACHED, T21; delete — скрыт/не-админ,
  план с impact, approve → markDeleted → сверка → replay, ALREADY_IN_TRASH, CONFLICT (новая версия) до плана и в precheck,
  NOT_FOUND, OPERATION_OUTCOME_UNKNOWN.

## Не проверено (реальный портал: not-run)

Фактические формы ответов портала (особенно даты all-day, ответ `calendar.event.update` для серий, `getbyid` удалённого
события, наличие `DATE_*_TS_UTC` в `calendar.accessibility.get` на конкретной редакции), права не-организатора на изменение
встречи, уведомления участникам, поведение корзины Диска и срок её хранения.

# CRM: реквизиты, адреса, банковские реквизиты, запись дел (ТЗ §9.4)

Модуль `crm`. Все записи идут через MutationExecutor: проверки и чтения до плана → `APPROVAL_REQUIRED`
с планом → подтверждение человеком (`npm run approval:review -- --id <operationId>`) → повтор с `approvalId`
→ одна запись → сверка повторным чтением. Изменение реквизитов — повышенный риск (ТЗ §8.2): это
указывается первым риском в каждом плане записи реквизита/адреса/счёта.

## Инструменты

| Инструмент                   | Операция | Методы Bitrix24                                                                                                                                                           | Особенности                                                                                                        |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `crm_requisites_list`        | read     | `crm.requisite.list`; с `includeAddresses` — `crm.address.list`, `crm.enum.addresstype`                                                                                   | Фильтр `ENTITY_TYPE_ID` (3 — контакт, 4 — компания) + `ENTITY_ID`; страницы по курсору; ограниченный профиль полей |
| `crm_requisite_presets_list` | read     | `crm.requisite.preset.list`; с `includeFields` — `crm.requisite.preset.field.list`                                                                                        | Фильтр `countryId`, `activeOnly`; поля шаблона — не более 10 шаблонов на страницу                                  |
| `crm_requisite_create`       | create   | `crm.requisite.preset.list` → `crm.requisite.fields` → `crm.requisite.preset.field.list` → `crm.<company\|contact>.get` → `crm.requisite.add`; сверка `crm.requisite.get` | `INVALID_PRESET` до плана; поля по метаданным и составу шаблона; владелец должен существовать                      |
| `crm_requisite_update`       | update   | `crm.requisite.fields`, `crm.requisite.get`, `crm.requisite.preset.*` → `crm.requisite.update`; сверка `crm.requisite.get`                                                | diff «было → станет», `stateHash`/`expectedStateHash`, CONFLICT до плана и в precheck                              |
| `crm_requisite_address_set`  | update   | `crm.enum.addresstype`, `crm.requisite.get`, `crm.address.list` → `crm.address.add` **или** `crm.address.update`; сверка `crm.address.list`                               | Режим create/update в плане; `INVALID_ADDRESS_TYPE`; адрес привязан к реквизиту (`ENTITY_TYPE_ID=8`)               |
| `crm_bank_account_add`       | create   | `crm.requisite.bankdetail.fields`, `crm.requisite.get`, `crm.requisite.preset.list` → `crm.requisite.bankdetail.add`; сверка `crm.requisite.bankdetail.get`               | `INVALID_BANK_DETAILS`: форматы РФ (БИК 9 цифр, р/с и к/с 20 цифр), IBAN (mod 97), SWIFT                           |
| `crm_activity_create`        | create   | `todo` → `crm.activity.todo.add`; `call`/`meeting` → `crm.activity.add`; сверка `crm.activity.get`                                                                        | Явный allowlist провайдеров; иначе `UNSUPPORTED_PROVIDER`                                                          |
| `crm_activity_update`        | update   | `crm.activity.get` → `crm.activity.update`; сверка `crm.activity.get`                                                                                                     | Ограниченный перечень полей; diff, `stateHash`, CONFLICT                                                           |

Специальные причины отказа передаются как `VALIDATION_ERROR` с `details.reason`: `INVALID_PRESET`,
`INVALID_ADDRESS_TYPE`, `INVALID_BANK_DETAILS`, `UNSUPPORTED_PROVIDER`, `FIELD_NOT_IN_PRESET`,
`FIELD_NOT_ALLOWED`, `UNKNOWN_FIELD`, `IMMUTABLE_FIELD`, `EMPTY_ADDRESS`, `NO_CHANGES`.

## Методы реестра (src/bitrix/registry/crm-requisites.ts), scope `crm`

Чтение (raw-допустимые): `crm.requisite.list`, `crm.requisite.get`, `crm.requisite.fields`,
`crm.requisite.preset.list`, `crm.requisite.preset.field.list`, `crm.address.list`, `crm.enum.addresstype`,
`crm.requisite.bankdetail.fields`, `crm.requisite.bankdetail.get`, `crm.activity.get`.

Запись (только именованные инструменты): `crm.requisite.add`, `crm.requisite.update`, `crm.address.add`,
`crm.address.update`, `crm.requisite.bankdetail.add`, `crm.activity.todo.add`, `crm.activity.add`,
`crm.activity.update`.

Источники — страницы `https://apidocs.bitrix24.ru/api-reference/crm/requisites/...`,
`.../crm/auxiliary/enum/crm-enum-address-type.html`, `.../crm/timeline/activities/...` (ссылки в `source`
каждой записи реестра). Сверка выполнялась по локальному зеркалу документации (github bitrix24/b24restdocs).

## Решения и допущения

- **Привязка адреса.** По документации `crm.address.*` адрес компании/контакта хранится у реквизита:
  `ENTITY_TYPE_ID=8` (реквизит), `ENTITY_ID` = ID реквизита. ID компании в `ENTITY_ID` не подставляется.
  У адреса нет собственного ID: он определяется тройкой `TYPE_ID + ENTITY_TYPE_ID + ENTITY_ID`, поэтому режим
  выбирается по `crm.address.list` с фильтром по этой тройке.
- **Режим create/update связан с подтверждением.** Режим хранится в `target` плана; если к моменту выполнения
  адрес этого типа появился или исчез, precheck даёт `CONFLICT` и запись не выполняется.
- **Частичное изменение адреса.** Документация: `crm.address.update` очищает не переданные текстовые поля.
  Инструмент сам переносит текущие значения полей, которых нет в `addressFields`; пустая строка `""` явно очищает
  поле (это отражается в плане и рисках). Для нового адреса нужно хотя бы одно непустое поле (иначе
  `crm.address.add` вернёт `true`, не создав адрес — предупреждение документации).
- **Поля реквизита.** Проверяются по `crm.requisite.fields` (неизвестные, read-only, immutable отклоняются) и по
  составу шаблона `crm.requisite.preset.field.list`: поле `RQ_*` вне шаблона отклоняется (`FIELD_NOT_IN_PRESET`),
  так как по документации оно сохранится, но не будет видно пользователю. `ENTITY_TYPE_ID/ENTITY_ID/PRESET_ID/NAME`
  задаются отдельными параметрами.
- **Персональные данные (§8.4).** Паспортные и персональные номера (`RQ_IDENT_*`, `RQ_PESEL`, `RQ_CPF`,
  `RQ_DRFO`) не запрашиваются, не выдаются и не записываются. Список по умолчанию отдаёт только
  идентификацию организации (название, ИНН/КПП/ОГРН/ОГРНИП, руководитель, бухгалтер).
- **Страна РФ.** `COUNTRY_ID=1` (CODE `RU`) — по примеру ответа `crm.requisite.preset.countries`; для этой страны
  проверяются форматы БИК/счетов. Пустые поля не проверяются. `COUNTRY_ID` банковского реквизита берётся из
  шаблона реквизита.
- **Дела: allowlist провайдеров.** `todo` — универсальное дело через современный `crm.activity.todo.add`
  (обязателен `deadline`, коммуникации не нужны); `call` (TYPE_ID=2, ровно одна коммуникация с телефоном,
  `DIRECTION`) и `meeting` (TYPE_ID=1, 1–10 участников) — через `crm.activity.add`, который в документации помечен
  DEPRECATED (развитие остановлено, метод документирован и работает). Письма, задачи, SMS, открытые линии и
  конфигурируемые дела приложений — `UNSUPPORTED_PROVIDER`.
- **Изменение дела.** Поля: `SUBJECT`, `DESCRIPTION`, `COMPLETED`, `START_TIME`, `END_TIME`, `RESPONSIBLE_ID`,
  `PRIORITY`. `DEADLINE` не принимается: по документации он не задаётся напрямую (берётся из START_TIME/END_TIME).
  Для универсальных дел (`CRM_TODO`) документация рекомендует `crm.activity.todo.update`; используется
  `crm.activity.update` по ТЗ, это указано в рисках плана.
- **Ответы записи.** `crm.requisite.update`, `crm.address.add/update`, `crm.activity.update` — `true`;
  `crm.requisite.add`, `crm.requisite.bankdetail.add`, `crm.activity.add` — число; `crm.activity.todo.add` — `{id}`.
  Иной ответ → `OPERATION_OUTCOME_UNKNOWN`, без автоматического повтора.

## Gaps и ограничения

- **Несуществующий реквизит.** По документации `crm.requisite.get/update` на отсутствующий ID отвечает ошибкой с
  пустым кодом и текстом «The Requisite with ID … is not found». Сервер не раскрывает текст ошибки портала,
  поэтому клиент видит `BITRIX_UPSTREAM_ERROR` (HTTP 400), а не `NOT_FOUND`. План при этом не создаётся.
- **Удаление** реквизитов/адресов/счетов не реализовано (не входит в §9.4 для этой группы).
- **Банковские реквизиты:** только добавление (`crm_bank_account_add`), как в таблице §9.4.
- `crm.activity.update` для частичного изменения: в таблице документации `OWNER_ID`, `TYPE_ID`, `COMMUNICATIONS`,
  `RESPONSIBLE_ID` отмечены обязательными; инструмент передаёт только изменяемые поля. На реальном портале
  не проверено — если портал потребует полный набор, это проявится ошибкой до записи.

## Что проверено

- **mock** (`tests/integration/crm-requisites.test.ts`, 24 теста): формы ответов по документации, фильтры и
  параметры запросов, курсор (60 реквизитов страницами по 20), профиль полей без паспортных данных,
  `INVALID_PRESET` до плана, `FIELD_NOT_IN_PRESET`/`UNKNOWN_FIELD`/`IMMUTABLE_FIELD`/`FIELD_NOT_ALLOWED`,
  выбор create/update адреса и сохранение непереданных полей, `INVALID_ADDRESS_TYPE`, `INVALID_BANK_DETAILS`
  (РФ, IBAN), `UNSUPPORTED_PROVIDER` (создание и изменение), полный путь approve → выполнение → replay без
  второй записи для всех шести инструментов записи, `CONFLICT` до плана и в precheck (реквизит, адрес, дело),
  `OPERATION_OUTCOME_UNKNOWN` без повторной записи, скрытие инструментов записи в read-only.
- **Реальный портал: not-run.** Права, фактические формы ответов, поведение `crm.activity.update` с частичным
  набором полей и `crm.activity.add` для встреч на конкретном портале не проверены.

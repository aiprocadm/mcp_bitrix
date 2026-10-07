# Дела по всему порталу, расшифровка звонков, бизнес-процессы (2026-10-07)

По заданию помощника портала после выдачи вебхуку всех scope. Только чтение.

| Модуль `ENABLED_MODULES` | Scope     | Инструменты                                                             |
| ------------------------ | --------- | ----------------------------------------------------------------------- |
| `crm`                    | `crm`     | `crm_activities_search`, `crm_activity_bindings`, `crm_call_transcript` |
| `bizproc`                | `bizproc` | `bizproc_templates_list`, `bizproc_workflows_list`                      |

## Дела

- `crm_activities_search` — `crm.activity.list` по всему порталу: `kind` (email → `TYPE_ID=4`, call → 2, meeting → 1,
  task → 3, todo → `PROVIDER_ID=CRM_TODO`) или точный `providerId`; `direction` (1/2); период по `dateField`
  (CREATED, START_TIME, DEADLINE, LAST_UPDATED); `%SUBJECT`; ответственный; выполнено; `boundTo` → фильтр `BINDINGS`
  (дело находится по любой привязке, а не только по владельцу — официальная страница метода). Тело письма — как в
  `crm_activities_list` (HTML → текст, обрезка). `COMMUNICATIONS` и `FILES` не запрашиваются.
- `crm_activity_bindings` — `crm.activity.binding.list`: все записи, к которым привязано дело.
- `crm_call_transcript` — `crm.activity.call.getTranscript` (в реестре строчными: `gettranscript`, живой портал принимает):
  текст расшифровки, сделанной ИИ Битрикс24, с пределом длины; нет расшифровки → `available=false`.

## Бизнес-процессы

- `bizproc_templates_list` — шаблоны дизайнера: название, тип записи, запуск (manual / onCreate / onUpdate /
  onCreateAndUpdate); `includeActions` — плоский список действий (тип и название шага). Константы, параметры и свойства
  шагов не выдаются (raw закрыт: `TEMPLATE`/`CONSTANTS` могут содержать секреты).
- `bizproc_workflows_list` — запущенные процессы (`bizproc.workflow.instances`) по записи (`DOCUMENT_ID=DEAL_N`) или типу
  (`ENTITY`): шаблон, кто и когда запустил (`startedBy=0` — автоматически), завис ли (блокировка старше 5 минут).
  Шаблон, которого нет в списке шаблонов, — `isStageAutomation=true`: это роботы стадий.

## Что невозможно через вебхук (проверено на живом портале)

- Настройки роботов стадий и триггеров: `bizproc.robot.list` и `crm.automation.trigger.list` отвечают
  «Application context required»; `bizproc.workflow.template.list` роботов не отдаёт (шаблоны 1 и 7 из запусков в нём отсутствуют).
- Подписка на события (`event.bind`) — только приложение. Уведомления о новых письмах/звонках — опросом по расписанию.
- Ссылка на запись разговора (`CALL_RECORD_URL`) не выдаётся: в ней доступ к файлу (§8.4); текст — через расшифровку.

## Проверено

- Живой портал (чтение): 11 шаблонов дизайнера, 170 запущенных процессов (сделки — шаблон 7, лиды — 1, компании — 995),
  `crm.activity.binding.list`, расшифровка у 4 из 15 звонков за октябрь (строчное имя метода работает), писем в CRM с 06.10 — 0
  (интеграция почтового ящика с CRM на портале выключена).
- `tests/integration/activities-bizproc.test.ts` — 8 тестов; мутационная проверка 5 мест — каждое ловится.

# bitrix24-mcp-server

MCP-сервер для Bitrix24: строго проверенные инструменты (tools) поверх Bitrix24 REST API.
Подключается к Claude Code и Claude Desktop локально (stdio), к серверу — через Streamable HTTP.

Простыми словами: это «переводчик» между ИИ-помощником и вашим Битрикс24. Помощник просит
«покажи сделки», сервер проверяет, можно ли это, спрашивает у Битрикс24 и отдаёт ответ.
Ничего в Битрикс24 не меняется без вашего подтверждения.

Техническое задание: `docs/TZ.md`. Состояние работ: `docs/STATUS.md`. Каталог инструментов: `docs/tools-catalog.md`.

## Что уже работает (срез 1: этапы 1–5 ТЗ)

- Конфигурация через `.env` со строгой проверкой; секреты не печатаются никогда.
- Единый клиент Bitrix24: таймауты, лимиты частоты, безопасные повторы только для чтения, курсоры пагинации.
- Два транспорта одного ядра: `stdio` и Streamable HTTP (loopback).
- Пять диагностических инструментов: `bitrix_connection_info`, `bitrix_server_version`, `bitrix_capabilities`, `bitrix_rest_call` (только чтение по allowlist), `operation_status`.
- CRM для сделок (этап 7): `crm_fields_get` (схема полей портала), `crm_list_records` (фильтр/сортировка/страницы), `crm_get_record` (карточка по ID), `crm_create_record` (создание с подтверждением человеком и сверкой результата). Поля и фильтры проверяются по схеме портала до обращения к Bitrix24.
- Задачи (этап 8): `task_list` (по ответственному, статусу, группе и фильтру Bitrix24), `task_get` (задача по ID), `task_create` (постановка задачи на известного сотрудника с подтверждением человеком и сверкой ответственного и срока). Срок принимается только с явным часовым поясом.
- Чат, календарь, Диск (этап 9): `chat_send_message` (одно сообщение в известный чат с полным текстом в плане), `calendar_create_event` (одиночное событие с датами, часовым поясом и участниками), `disk_upload_file` (файл, подготовленный через `npm run file:stage` или маленький inline, с хешем в плане). Это последние три инструмента MVP из ТЗ §10.1.
- Режим только чтения по умолчанию (`READ_ONLY_MODE=true`).
- Контур записи (этап 6): любая запись сначала возвращает `APPROVAL_REQUIRED` с `operationId`, человек смотрит план и подтверждает в терминале (`npm run approval:review`), затем тот же вызов с `approvalId` выполняется ровно один раз. Повтор с тем же `idempotencyKey` дубль не создаёт. Такие инструменты: `crm_create_record`, `task_create`, `chat_send_message`, `calendar_create_event`, `disk_upload_file`.

## Требования

- Node.js 24.x (см. `.nvmrc`). Проверка: `node --version`.
- Портал Bitrix24 с доступом к REST и правом создать входящий вебхук (`docs/bitrix-webhook.md`).

## Быстрый старт (Linux / macOS)

```bash
npm ci
cp .env.example .env
chmod 600 .env
nano .env            # заполните BITRIX_PORTAL_URL и BITRIX_WEBHOOK_BASE_URL
npm run setup        # политики, каталоги данных, ключ шифрования
npm run doctor       # проверка конфигурации и связи (без изменений в портале)
npm run bitrix:profile
npm run build
```

Windows (PowerShell): `Copy-Item .env.example .env`, затем `notepad .env`, остальные команды те же. Подробнее: `docs/setup-windows.md`, `docs/setup-linux.md`.

## Подключение к Claude Code

```bash
claude mcp add --transport stdio --scope local bitrix24 -- node /полный/путь/dist/index.js --transport stdio --config /полный/путь/.env
claude mcp list
```

Затем в Claude Code: `/mcp` и вызов `bitrix_connection_info`. Подробнее: `docs/claude-code.md`, `docs/claude-desktop.md`. Сервер на VPS и ограничения ChatGPT: `docs/deployment.md`, `docs/chatgpt.md`. Эксплуатация и резервные копии: `docs/operations.md`.

## Команды

| Команда                                                                              | Что делает                                                                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:http`                                                   | Запуск из исходников: stdio / loopback HTTP                                                                     |
| `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`                     | Проверки и сборка                                                                                               |
| `npm run test:security`                                                              | Только негативные сценарии безопасности                                                                         |
| `npm run setup`                                                                      | Первичная настройка: политики, каталоги, ключ                                                                   |
| `npm run doctor [-- --offline]`                                                      | Диагностика; `--offline` — без обращения к порталу                                                              |
| `npm run bitrix:profile`                                                             | Один безопасный запрос `profile`                                                                                |
| `npm run mcp:smoke -- --transport stdio\|http`                                       | Проверка через официальный MCP-клиент                                                                           |
| `npm run schemas:export`                                                             | JSON Schema инструментов → `docs/schemas/`, каталог → `docs/tools-catalog.md`                                   |
| `npm run approval:review -- --id <operationId>` / `-- --list`                        | Просмотр плана записи и решение человека (только в терминале, без `--yes`)                                      |
| `npm run file:stage -- --path <абс. путь в UPLOAD_ROOT>`                             | Подготовка файла к загрузке на Диск: проверка, копия, `fileToken`                                               |
| `npm run test:live -- --read-only` / `-- --write --prepare` / `-- --write --execute` | Живая проверка портала по §10.3 (только при `LIVE_TESTS_ENABLED=true`); записи — в две фазы через подтверждение |
| `npm run check:secrets`                                                              | Поиск секретов в отслеживаемых файлах                                                                           |
| `npm start` / `npm run start:stdio` / `npm run start:http`                           | Production-запуск из `dist/`                                                                                    |

Любая команда принимает `--config <путь к .env>`; без него берётся `./.env` или `CONFIG_PATH`.

## Безопасность (кратко)

- Секрет вебхука живёт только в `.env` на вашей машине. В Git, логи, stdout и ответы инструментов он не попадает (есть автоматический сканер и редактор).
- Прямой REST-вызов (`bitrix_rest_call`) — только методы из `policies/methods.json`, только чтение. `batch`, произвольные URL и запись отклоняются до обращения к порталу.
- Данные из Битрикс24 — это данные, а не команды: сервер не выполняет инструкции из текста сделок и чатов.
- Полная модель — ТЗ §8.

## Структура

```
src/config      конфигурация, политики      src/bitrix   клиент, адаптеры, реестр методов
src/security    редактирование, шифрование  src/mcp      сервер, транспорты, envelope
src/storage     SQLite, миграции, ledger     src/tools    инструменты по модулям
src/cli         setup/doctor/profile/smoke   tests        unit/contract/integration/security
docs            ТЗ, статус, ADR, схемы       policies     примеры политик
```

## Лицензия

Частный проект заказчика. Не для публикации.

# bitrix24-mcp-server

MCP-сервер для Bitrix24: строго проверенные инструменты (tools) поверх Bitrix24 REST API.
Подключается к Claude Code и Claude Desktop локально (stdio), к серверу — через Streamable HTTP.

Простыми словами: это «переводчик» между ИИ-помощником и вашим Битрикс24. Помощник просит
«покажи сделки», сервер проверяет, можно ли это, спрашивает у Битрикс24 и отдаёт ответ.
Ничего в Битрикс24 не меняется без вашего подтверждения.

Техническое задание: `docs/TZ.md`. Состояние работ: `docs/STATUS.md`. Каталог инструментов: `docs/tools-catalog.md`.

## Что уже работает (этапы 1–14 ТЗ)

Реализованы все 105 инструментов реестра ТЗ §9; полный список со схемами — `docs/tools-catalog.md`, модули и их ограничения — `docs/modules/*.md`. Всё проверено на имитации Bitrix24; на реальном портале — после подключения (`docs/acceptance-report.md`).

- Конфигурация через `.env` со строгой проверкой; секреты не печатаются никогда. Режим только чтения по умолчанию (`READ_ONLY_MODE=true`).
- Единый клиент Bitrix24 (legacy REST и REST 3.0): таймауты, лимиты частоты, безопасные повторы только для чтения, серверные курсоры пагинации.
- Два транспорта одного ядра: `stdio` и Streamable HTTP (loopback или удалённо с OAuth-защитой), панель подтверждений `/admin`.
- Диагностика: `bitrix_connection_info`, `bitrix_server_version`, `bitrix_capabilities`, `bitrix_rest_call` (только чтение по allowlist), `operation_status`.
- Модули (включаются `ENABLED_MODULES`):
  - `crm` — сделки, лиды, контакты, компании, стадии, поиск, история, дела, таймлайн, товары сделки, сводка воронки, реквизиты, адреса, банковские реквизиты;
  - `smartProcesses`, `invoices` — смарт-процессы и смарт-счета через `crm.item.*`;
  - `tasks` — задачи, завершение с проверкой результата, чек-листы, обсуждение старой и новой карточки;
  - `calendar` — календари, события, приглашения, занятость; `disk` — хранилища, папки, ограниченный поиск, загрузка;
  - `company` — поиск сотрудников, отделы; `chat` — чаты и сообщения; `telephony` — история звонков; `groups` — рабочие группы;
  - `catalog`, `orders` — каталог, цены, склады, остатки, заказы магазина;
  - `feed` — лента новостей; `knowledgeBase` — классическая база знаний (landing) и база знаний 2.0 (`note.*`).
- Контур записи: любая запись сначала возвращает `APPROVAL_REQUIRED` с `operationId` и планом, человек подтверждает в терминале (`npm run approval:review`) или в панели, затем тот же вызов с `approvalId` выполняется ровно один раз. Повтор с тем же `idempotencyKey` дубль не создаёт.
- Удаления (6 инструментов) скрыты, пока не включены `ENABLE_DESTRUCTIVE_TOOLS=true`, и доступны только роли administrator.

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
| `MCP_SMOKE_TOKEN=... npm run mcp:smoke -- --transport http --url https://…/mcp`      | Удалённый smoke опубликованного сервера с bearer-токеном (токен только из переменной окружения)                 |
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

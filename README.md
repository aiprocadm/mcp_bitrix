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
- Режим только чтения по умолчанию (`READ_ONLY_MODE=true`).
- Контур записи (этап 6): любая запись сначала возвращает `APPROVAL_REQUIRED` с `operationId`, человек смотрит план и подтверждает в терминале (`npm run approval:review`), затем тот же вызов с `approvalId` выполняется ровно один раз. Повтор с тем же `idempotencyKey` дубль не создаёт. Именованные инструменты записи появятся на этапах 7–9.

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

Затем в Claude Code: `/mcp` и вызов `bitrix_connection_info`. Подробнее: `docs/claude-code.md`, `docs/claude-desktop.md`.

## Команды

| Команда                                                          | Что делает                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:http`                               | Запуск из исходников: stdio / loopback HTTP                                   |
| `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | Проверки и сборка                                                             |
| `npm run test:security`                                          | Только негативные сценарии безопасности                                       |
| `npm run setup`                                                  | Первичная настройка: политики, каталоги, ключ                                 |
| `npm run doctor [-- --offline]`                                  | Диагностика; `--offline` — без обращения к порталу                            |
| `npm run bitrix:profile`                                         | Один безопасный запрос `profile`                                              |
| `npm run mcp:smoke -- --transport stdio\|http`                   | Проверка через официальный MCP-клиент                                         |
| `npm run schemas:export`                                         | JSON Schema инструментов → `docs/schemas/`, каталог → `docs/tools-catalog.md` |
| `npm run approval:review -- --id <operationId>` / `-- --list`    | Просмотр плана записи и решение человека (только в терминале, без `--yes`)    |
| `npm run file:stage -- --path <абс. путь в UPLOAD_ROOT>`         | Подготовка файла к загрузке на Диск: проверка, копия, `fileToken`             |
| `npm run check:secrets`                                          | Поиск секретов в отслеживаемых файлах                                         |
| `npm start` / `npm run start:stdio` / `npm run start:http`       | Production-запуск из `dist/`                                                  |

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

# ADR-0001. Технологический стек и зафиксированные версии

Статус: принято. Дата: 2026-09-23. Основание: ТЗ §5, §16 п.4.

## Решение

| Компонент     | Выбор                                                                     | Версия в lockfile        | Примечание                                                                                             |
| ------------- | ------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Runtime       | Node.js                                                                   | 24.18.0 (`.nvmrc`)       | Проверенная на сервере разработки; `engines.node >= 24`                                                |
| Язык          | TypeScript, strict, ESM, `NodeNext`                                       | 5.9.3                    | См. «Почему не TypeScript 7»                                                                           |
| MCP SDK       | `@modelcontextprotocol/server`, `/node`, `/fastify`; `/client` для тестов | 2.0.0 (все четыре)       | Стабильная ветка v2, спецификация MCP 2026-07-28. Пакет v1 `@modelcontextprotocol/sdk` не используется |
| Валидация     | Zod 4 + `z.toJSONSchema`                                                  | 4.6.5                    | Единый источник input/output схем инструментов                                                         |
| HTTP к Bitrix | встроенный `fetch` Node (Undici)                                          | —                        | Внедряется в `BitrixClient` как зависимость; тесты подменяют его без сети                              |
| HTTP-сервер   | Fastify + `createMcpFastifyApp`                                           | 5.12.5                   | Официальный адаптер; транспорт вручную не пишем                                                        |
| Логи          | Pino в stderr                                                             | 10.3.1                   | В stdio stdout принадлежит протоколу MCP                                                               |
| Состояние     | SQLite через встроенный `node:sqlite` (`DatabaseSync`), WAL               | —                        | См. «Почему node:sqlite»                                                                               |
| Тесты         | Vitest                                                                    | 5.0.1                    | Мок Bitrix — подменённый `fetch`, реальный MCP client через `InMemoryTransport`                        |
| Качество      | ESLint + typescript-eslint, Prettier                                      | 10.11.0 / 8.70.1 / 3.9.9 | `strictTypeChecked`                                                                                    |
| Конфигурация  | `.env` через `dotenv.parse` + Zod-схема                                   | dotenv 18.0.3            | Путь к `.env` передаётся `--config`/`CONFIG_PATH`                                                      |

Дата проверки npm-реестра: 2026-09-23. Проверка выполнялась установкой пакетов и чтением опубликованных `.d.mts`, а также пробным прогоном `initialize → tools/list → tools/call` через `InMemoryTransport`.

## Почему не TypeScript 7

На дату проверки `typescript@latest` = 7.0.2 (нативный компилятор). Экосистема линтера (`typescript-eslint` 8.70) и `tsx` проверены с веткой 5.x; риск несовместимости правил `strictTypeChecked` с 7.x не оправдан для инфраструктурного проекта. Переход на 7.x — отдельный ADR после проверки lint/typecheck/build.

## Почему node:sqlite, а не better-sqlite3

- `node:sqlite` встроен в Node 24, не требует нативной сборки — это снимает главную «граблю» первого развёртывания на Windows (ТЗ §17.1) и в Docker.
- Даёт синхронный API, `PRAGMA journal_mode=WAL`, транзакции — достаточно для атомарных подтверждений и ledger (ТЗ §4.4).
- Ограничение: один процесс, один экземпляр — совпадает с допущением ТЗ §3.1 «Развёртывание». При переходе на несколько экземпляров нужен PostgreSQL и общая очередь (ТЗ §3.1), и это в любом случае замена слоя `storage/`.

## Почему подменяемый `fetch`, а не Undici MockAgent

Глобальный `fetch` Node использует встроенную копию Undici; `MockAgent` из npm-пакета `undici` другой версии не перехватывает её надёжно. Внедрение `fetch` в `BitrixClient` даёт детерминированные тесты (HTTP 200 с ошибкой в теле, 429 с `Retry-After`, таймаут, обрыв после отправки) без сети и без зависимости от версий.

## Последствия

- Все имена пакетов SDK и их импорты — только v2 (`@modelcontextprotocol/server`, `.../server/stdio`, `@modelcontextprotocol/node`, `@modelcontextprotocol/fastify`).
- `docs/compatibility.md` ведёт таблицу проверенных версий Node/SDK/клиентов; обновляется при каждом `npm update`.

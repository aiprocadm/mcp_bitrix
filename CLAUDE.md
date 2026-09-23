# Правила работы над mcp_bitrix для Claude Code

## «Продолжай по ТЗ» — что это значит

1. Открой `docs/STATUS.md`. Там: какой этап ТЗ (§22 в `docs/TZ.md`) текущий, что сделано, что дальше, известные грабли.
2. Проверь, нет ли открытого PR предыдущего среза (`gh pr list --state open`). Если есть и не влит — продолжай в его ветке или дождись решения владельца; новый срез поверх невлитого не начинай.
3. Прочитай раздел ТЗ текущего этапа целиком (не по памяти).
4. Работай в worktree (`.claude/worktrees/<имя>`), ветка от `origin/main`.
5. Сделай этап (или его законченный срез), обнови `docs/STATUS.md`, `docs/acceptance-report.md` и `docs/tools-catalog.md` (последний — через `npm run schemas:export`).
6. Перед PR обязательно: `npm run lint && npm run typecheck && npm test && npm run build && npm run check:secrets && npm run mcp:smoke -- --transport stdio --config tests/fixtures/mock.env`.
7. Коммит + push + PR. В описании PR: этап, что проверено, что не проверено (mock vs реальный портал).

## Непреложные правила (из ТЗ §16)

- Не заменять реальную реализацию заглушками с `success:true`.
- Никаких флагов автоподтверждения записей «для удобства модели».
- Секреты (webhook URL, токены, `.env`, SQLite, ключ) не попадают в Git, логи, stdout, ответы инструментов.
- Прямой `fetch` только в `src/bitrix/client.ts`; инструменты ходят через `ctx.bitrix`.
- Новый REST-метод — только по официальной странице apidocs.bitrix24.ru: запись в `src/bitrix/method-registry.ts` с полем `source`.
- В stdio-режиме stdout принадлежит MCP: любой вывод — в stderr через логгер.
- Отчёт о проверках честный: mock-тест ≠ реальный портал; `not-run`/`blocked` пишем так и есть.
- Владельцу вопросов не задавать без крайней необходимости: допущения — раздел 3 ТЗ.

## Быстрые команды

```bash
npm ci
npm run setup --  --config tests/fixtures/mock.env   # тестовый профиль без портала
npm run doctor -- --config tests/fixtures/mock.env --offline
npm test
npm run mcp:smoke -- --transport stdio --config tests/fixtures/mock.env
```

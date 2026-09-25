# Правила работы над mcp_bitrix для Claude Code

## «Продолжай по ТЗ» — что это значит

Подробный порядок — навык `.claude/skills/continue-tz/SKILL.md` (вызывается по фразе). Кратко:

1. **Активное ТЗ — SaaS-версия по подписке**: `docs/saas/TZ-SaaS.md`, статус — `docs/saas/STATUS.md` (текущий этап S0–S10, следующий шаг, план этапа). Базовое ТЗ `docs/TZ.md` (этапы 1–14) выполнено; его статус `docs/STATUS.md`; оно остаётся источником требований безопасности и контракта инструментов (в SaaS-ТЗ — ссылки «Б§…»).
2. Проверь, нет ли открытого невлитого PR предыдущего среза (в облачной сессии — GitHub MCP, `gh` нет). Если есть — продолжай в его ветке; новый срез поверх невлитого не начинай.
3. Прочитай раздел ТЗ текущего этапа целиком (не по памяти) и сверь статус с кодом.
4. Ветка: заданная средой рабочая ветка (если её PR уже влит — пересоздать от `origin/main`), иначе worktree `.claude/worktrees/<имя>` от `origin/main`.
5. Сделай законченный срез этапа; режим `single` не ломать. Обнови файл статуса активного ТЗ (обязательно «Следующий шаг» — конкретный следующий срез), `docs/tools-catalog.md` через `npm run schemas:export`, если менялись инструменты.
6. Перед PR обязательно: `npm run lint && npx prettier --check . && npm run typecheck && npm test && npm run build && npm run check:secrets && npm run mcp:smoke -- --transport stdio --config tests/fixtures/mock.env`.
7. Коммит + push + PR. В описании PR: этап/срез, что проверено, что не проверено (mock vs реальный портал vs реальный платёж).

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

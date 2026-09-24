# Развёртывание на VPS (ТЗ §17.6)

Честное состояние на 2026-09-24: сервер умеет HTTP только на loopback (`MCP_AUTH_MODE=local`).
Внешний интерфейс без OAuth-защиты MCP запрещён конфигурацией (`CONFIG_INVALID`), а OAuth-защита — этап 12.
Поэтому сегодня VPS-профиль пригоден для: (а) одного владельца через SSH-туннель к `127.0.0.1:3000`,
(б) подготовки инфраструктуры под этап 12. Публичный `https://mcp.example/mcp` появится после этапа 12.

## Шаги

1. VPS с SSH-доступом; Docker Engine и Compose ставятся по официальной инструкции вашей ОС, без `curl | bash`.
2. Скопируйте проект (git clone), создайте `config/.env` из `.env.example`, права `600`. Секреты — только в этом файле, не в образе.
   Пути (`DATA_DIR`, `DATABASE_URL`, `*_POLICY_FILE`, `MCP_HOST`) в `config/.env` писать не нужно: их задаёт `compose.yaml`
   и они главнее файла.
3. Соберите образ и выполните первичную настройку **до** запуска сервера — без ключа шифрования сервер не стартует
   (`ensureMasterKey(..., {create:false})`), а `restart: unless-stopped` превратит это в бесконечный перезапуск:

```bash
docker compose build
docker compose run --rm bitrix24-mcp node dist/cli/setup.js --config /app/config/.env
docker compose run --rm bitrix24-mcp node dist/cli/doctor.js --config /app/config/.env
```

`setup` создаёт в томе `mcp-data` ключ (`secrets/master.key`), каталоги и рабочие политики `policies/*.json`
из примеров образа. Повторный запуск ничего не перезаписывает.

4. Запустите и проверьте:

```bash
docker compose up -d
docker compose ps            # колонка STATUS должна стать healthy
docker compose logs --tail=100 bitrix24-mcp
curl --fail http://127.0.0.1:3000/healthz
```

Если порт 3000 на хосте занят: `MCP_PORT=3123 docker compose up -d` (healthcheck подстроится сам). 5. Подключение владельца до этапа 12 — только через туннель: `ssh -N -L 3000:127.0.0.1:3000 user@vps`, затем
`claude mcp add --transport http bitrix24 http://127.0.0.1:3000/mcp` на своей машине. 6. Проверено 2026-09-24 на Linux-хосте с Docker: образ собирается, `setup`/`doctor --offline` в одноразовом контейнере
проходят, сервер стартует на host-сети и становится `healthy`. С реальным порталом не проверялось.

## Что даёт `compose.yaml`

- Непривилегированный пользователь `mcp`, `read_only` корневая ФС, `tmpfs` для `/tmp`, `cap_drop: ALL`,
  `no-new-privileges`; писать можно только в том `mcp-data` (SQLite, ключ, staging, копии).
- `network_mode: host` и `MCP_HOST=127.0.0.1`: сервер слушает только loopback хоста, порт не публикуется; наружу — только через reverse proxy и только после этапа 12 (`MCP_AUTH_MODE=oauth`). Внешний интерфейс при `local` запрещён самой конфигурацией — это и есть причина host-сети до этапа 12.
- `restart: unless-stopped`, healthcheck по `/healthz`, graceful shutdown по SIGTERM.
- Один экземпляр: второй контейнер на той же базе запрещён (нет общей блокировки и лимитера — ТЗ §3.1).

## Reverse proxy (заготовка для этапа 12)

nginx перед сервером должен: терминировать TLS, проксировать `POST/GET/DELETE /mcp` с `proxy_buffering off`
(SSE), передавать `Host` и `Origin` без изменений, ограничивать размер тела (`client_max_body_size 16m`),
не открывать `/readyz` наружу. Конфигурация будет добавлена вместе с OAuth на этапе 12; до этого блок `server`
с `location /mcp` не публикуйте.

## Резервные копии на VPS

`docker compose exec bitrix24-mcp node dist/cli/backup.js --config /app/config/.env --out /app/data/backups/mcp-$(date +%F).enc`
и копирование папки `backups` из тома наружу (`docker cp`). Ключ `/app/data/secrets/master.key` копируйте
отдельно и храните не рядом с копиями. Подробнее — `docs/operations.md`.

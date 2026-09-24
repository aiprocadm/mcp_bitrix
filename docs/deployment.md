# Развёртывание на VPS (ТЗ §17.6)

Состояние на 2026-09-24 (этап 12, срезы 8–9): сервер умеет работать за HTTPS reverse proxy с OAuth-защитой MCP
(`MCP_AUTH_MODE=oauth`, спецификация MCP Authorization — источник S25 в ТЗ), панелью владельца `/admin`
(подтверждения и web-upload, `ADMIN_PANEL_ENABLED=true`) и антивирусным сканером staged-файлов (ClamAV,
`UPLOAD_SCAN_REQUIRED=true`). Проверено на mock-конфиге, тестовом издателе токенов и фальшивом clamd;
**с реальным доменом, реальным authorization server, реальным ClamAV и реальным порталом не проверялось**
(`not-run`, см. `docs/acceptance-report.md`).

## Как устроена защита (что вы получаете)

- Сервер — OAuth 2.1 **resource server**: токены выпускает ваш authorization server (AS), а сервер на **каждом** запросе
  к `/mcp` и `/readyz` проверяет подпись (JWKS издателя), `iss`, `aud` (= `MCP_PUBLIC_URL`), срок, `sub` в allowlist
  (`MCP_AUTH_ALLOWED_SUBJECTS`) и scope (`read`, `write`, `admin`).
- Роль сессии = минимум из роли в `policies/access.json` (`principals.<sub>.role`, по умолчанию `reader`) и роли по scope
  (`read`→reader, `write`→operator, `admin`→administrator). Роль `reader` не видит инструменты записи.
- Без токена — `401` с `WWW-Authenticate: Bearer resource_metadata="https://<домен>/.well-known/oauth-protected-resource/mcp", scope="read"`;
  просроченный/чужой токен — `401 invalid_token`; чужой `sub` — `403 access_denied`; без scope — `403 insufficient_scope`;
  токен в строке запроса — `400`. Сессия MCP привязана к субъекту: чужой токен к чужой сессии — `403`.
- Документ RFC 9728 отдаётся на `/.well-known/oauth-protected-resource` (и с суффиксом пути): `resource`,
  `authorization_servers`, `scopes_supported` — по нему клиенты (Claude Code, ChatGPT) находят ваш AS.
- Браузерные `Origin` — только из `MCP_ALLOWED_ORIGINS` (или origin публичного адреса); серверные клиенты Origin не шлют.
- Входящие read-вызовы: `MCP_INBOUND_READ_PER_MINUTE` (60/мин на субъект), write-подготовки — 10/мин (ТЗ §8.6).

## Требования к authorization server

Сервер не содержит своего AS (ТЗ §18.3: «предпочесть готовый поддерживаемый provider»). Подойдёт любой OIDC/OAuth 2.1
провайдер (например, Keycloak, Authentik, Auth0, Okta), который:

1. выпускает **JWT** access tokens, подписанные асимметричным ключом (RS256/ES256/PS256/EdDSA) и публикует JWKS;
2. ставит `aud` = канонический адрес сервера (`MCP_PUBLIC_URL` без завершающего `/`, RFC 8707 `resource`) —
   клиенты MCP передают `resource` в запросах авторизации и токена, AS должен его учитывать;
3. кладёт scope в `scope` (строка через пробел) или `scp` (массив) и знает scope `read`, `write`, `admin`;
4. поддерживает PKCE и регистрацию клиентов так, как умеет ваш MCP-клиент: Client ID Metadata Documents или
   Dynamic Client Registration (RFC 7591) для Claude Code/ChatGPT, либо заранее созданный клиент;
5. даёт стабильный `sub` для каждого разрешённого сотрудника — именно эти значения идут в `MCP_AUTH_ALLOWED_SUBJECTS`.

Токены Bitrix24 и его OAuth **не** участвуют: это другой контур (ТЗ §4.2).

## Шаги

1. VPS с SSH-доступом; Docker Engine и Compose ставятся по официальной инструкции вашей ОС, без `curl | bash`.
2. Домен → A/AAAA-запись на VPS; nginx + сертификат (certbot). Скопируйте `deploy/nginx/mcp.conf.example`
   в `/etc/nginx/sites-available/mcp.conf`, замените домен, `nginx -t && systemctl reload nginx`.
   Наружу открыты только 80/443; порт 3000 приложения слушает `127.0.0.1` и не публикуется.
3. Скопируйте проект (git clone), создайте `config/.env` из `examples/remote.env.example`, заполните
   `MCP_PUBLIC_URL`, `MCP_AUTH_ISSUER`, `MCP_AUTH_JWKS_URI`, `MCP_AUTH_ALLOWED_SUBJECTS`, вебхук Bitrix24; права `600`.
   Пути (`DATA_DIR`, `DATABASE_URL`, `*_POLICY_FILE`, `MCP_HOST`) задаёт `compose.yaml`, они главнее файла.
4. Соберите образ и выполните первичную настройку **до** запуска сервера — без ключа шифрования сервер не стартует
   (`restart: unless-stopped` превратил бы это в бесконечный перезапуск):

```bash
docker compose build
docker compose run --rm bitrix24-mcp node dist/cli/setup.js --config /app/config/.env
docker compose run --rm bitrix24-mcp node dist/cli/doctor.js --config /app/config/.env
```

`setup` создаёт в томе `mcp-data` ключ (`secrets/master.key`), каталоги и рабочие политики `policies/*.json`
из примеров образа. Добавьте в `policies/access.json` тома субъектов с ролями (по умолчанию все — `reader`).

5. Запустите и проверьте с самого сервера:

```bash
docker compose up -d
docker compose ps            # STATUS: healthy
docker compose logs --tail=100 bitrix24-mcp
curl --fail http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz          # 401 + WWW-Authenticate — так и должно быть
```

Если порт 3000 на хосте занят: `MCP_PORT=3123 docker compose up -d` и поправьте `proxy_pass` в nginx.

6. Проверьте снаружи (ТЗ §17.6 п.7): TLS, отказ без токена, метаданные, затем удалённый smoke с настоящим токеном
   от вашего AS (токен — через переменную окружения, не аргумент командной строки):

```bash
curl -i https://mcp.example.com/mcp -X POST -H 'content-type: application/json' -d '{}'   # ожидается 401 + WWW-Authenticate
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp                  # JSON с authorization_servers
MCP_SMOKE_TOKEN='<access token>' npm run mcp:smoke -- --transport http --url https://mcp.example.com/mcp
```

7. Панель владельца и сканер (нужны для записей и файлов из удалённых клиентов):

```bash
# ClamAV рядом с сервером (порт 3310 только на loopback хоста); в config/.env: UPLOAD_SCAN_REQUIRED=true, UPLOAD_SCANNER_URL=clamd://127.0.0.1:3310
docker run -d --name clamav --restart unless-stopped --network host clamav/clamav:stable
# в config/.env: ADMIN_PANEL_ENABLED=true; пользователь панели (пароль вводится скрыто, в терминале):
docker compose run --rm -it bitrix24-mcp node dist/cli/admin-user.js --config /app/config/.env --name boss --principal owner
docker compose restart bitrix24-mcp && docker compose run --rm bitrix24-mcp node dist/cli/doctor.js --config /app/config/.env
```

Затем `https://mcp.example.com/admin/login` (nginx-пример уже проксирует `/admin`). Подробнее — `docs/operations.md`.

8. Подключите клиента: `docs/claude-code.md` (раздел «Удалённое подключение»), `docs/chatgpt.md`.
   Сначала read-only, затем одно подтверждённое тестовое изменение через панель (`docs/operations.md`).

## Что даёт `compose.yaml`

- Непривилегированный пользователь `mcp`, `read_only` корневая ФС, `tmpfs` для `/tmp`, `cap_drop: ALL`,
  `no-new-privileges`; писать можно только в том `mcp-data` (SQLite, ключ, staging, копии).
- `network_mode: host` и `MCP_HOST=127.0.0.1`: сервер слушает только loopback хоста; наружу — только через nginx.
  Внешний интерфейс при `MCP_AUTH_MODE=local` запрещён самой конфигурацией.
- `restart: unless-stopped`, healthcheck по `/healthz`, graceful shutdown по SIGTERM.
- Один экземпляр: второй контейнер на той же базе запрещён (нет общей блокировки и лимитера — ТЗ §3.1).

## Проверено / не проверено

- Проверено 2026-09-24 на Linux-хосте с Docker: образ, `setup`/`doctor` одноразовым контейнером, старт на host-сети,
  `healthy`, `initialize` через `/mcp` (режим `local`). OAuth-режим — автотестами с локальным издателем (JWKS по HTTP
  на loopback), включая 401/403, привязку сессии, Origin и метаданные (`tests/security/mcp-oauth.test.ts`).
- Панель `/admin` и сканер — автотестами (`tests/security/admin-panel.test.ts`, `tests/unit/scanner.test.ts` с фальшивым
  clamd) и живой проверкой на loopback: вход, план оператора, отказ без CSRF, подтверждение словом, web-upload → fileToken.
- Не проверено: реальный домен и TLS, реальный AS (Keycloak и др.), регистрация клиента Claude Code/ChatGPT,
  реальный ClamAV, реальный портал. Эти пункты в отчёте приёмки — `not-run`.

## Резервные копии на VPS

`docker compose exec bitrix24-mcp node dist/cli/backup.js --config /app/config/.env --out /app/data/backups/mcp-$(date +%F).enc`
и копирование папки `backups` из тома наружу (`docker cp`). Ключ `/app/data/secrets/master.key` копируйте
отдельно и храните не рядом с копиями. Подробнее — `docs/operations.md`.

# Подключение к Claude Code (ТЗ §18.2)

## Локально по stdio

После `npm run build`:

```bash
# Linux / macOS
claude mcp add --transport stdio --scope local bitrix24 -- node /opt/bitrix24-mcp-server/dist/index.js --transport stdio --config /opt/bitrix24-mcp-server/.env
```

```powershell
# Windows
claude mcp add --transport stdio --scope local bitrix24 -- node "C:\Projects\bitrix24-mcp-server\dist\index.js" --transport stdio --config "C:\Projects\bitrix24-mcp-server\.env"
```

Пути — абсолютные и реальные. В конфигурации хранится путь к `.env`, а не сам секрет.
`--scope local` действует в текущем проекте Claude Code; для личной общей настройки — `--scope user`.

Проверка:

```bash
claude mcp list
claude mcp get bitrix24
```

В Claude Code: `/mcp` → сервер `bitrix24` подключён → попросите вызвать `bitrix_connection_info`.
Ожидается домен портала без секрета, текущий сотрудник, режим `readOnlyMode: true`.

## Если инструментов не видно

- `npm run mcp:smoke -- --transport stdio` — проверка сервера официальным клиентом без Claude Code.
- Убедитесь, что `dist/` пересобран после обновления (`npm run build`).
- Логи сервера идут в stderr; Claude Code показывает их в `/mcp` → сервер → логи.
- `node` не найден в PATH клиента → укажите абсолютный путь к `node` вместо `node`.

## Удалённое подключение (HTTP, ТЗ §18.3)

Нужен опубликованный сервер (`docs/deployment.md`: HTTPS + `MCP_AUTH_MODE=oauth`). Тогда:

```bash
claude mcp add --transport http --scope user bitrix24-remote https://mcp.example.com/mcp
claude mcp list
```

Далее `/mcp` → `bitrix24-remote` → вход. Claude Code получит `401` с `WWW-Authenticate`, прочитает
`/.well-known/oauth-protected-resource/mcp`, найдёт ваш authorization server и откроет браузер для входа.
Client ID/secret Bitrix24 в эти поля не вставляйте — это другая OAuth-связь. Если ваш AS требует заранее
зарегистрированного клиента, зарегистрируйте callback Claude Code по актуальной документации Claude Code
и сообщите client ID пользователям.

Состояние: реальное удалённое подключение Claude Code не выполнялось (`not-run`) — нужен домен и AS заказчика.

Локально для разработки HTTP-транспорт по-прежнему работает на loopback без токена:

```bash
npm run dev:http
curl --fail http://127.0.0.1:3000/healthz
```

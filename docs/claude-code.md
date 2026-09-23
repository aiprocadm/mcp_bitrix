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

## Удалённое подключение (HTTP)

Появится на этапе 12 (HTTPS + OAuth-защита MCP). До этого HTTP-транспорт работает только на loopback для разработки:

```bash
npm run dev:http
curl --fail http://127.0.0.1:3000/healthz
```

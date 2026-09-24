# Подключение к Claude Desktop (ТЗ §18.1)

Claude Desktop запускает наш сервер как локальный процесс по stdio. Нужны: собранный проект (`npm run build`),
заполненный `.env`, пройденный `npm run doctor`.

1. В Claude Desktop откройте настройки разработчика и редактирование конфигурации MCP (название пункта зависит от версии;
   если пункта нет — сверьтесь с официальной инструкцией вашей версии, не гадайте).
2. Перед правкой сохраните копию файла конфигурации. Добавьте наш сервер в `mcpServers`, не удаляя другие записи.

Windows, если проект лежит в `C:\Projects\bitrix24-mcp-server` (файл `examples/claude-desktop.json`):

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Projects\\bitrix24-mcp-server\\dist\\index.js",
        "--transport",
        "stdio",
        "--config",
        "C:\\Projects\\bitrix24-mcp-server\\.env"
      ]
    }
  }
}
```

Linux/macOS:

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "/usr/bin/node",
      "args": [
        "/opt/bitrix24-mcp-server/dist/index.js",
        "--transport",
        "stdio",
        "--config",
        "/opt/bitrix24-mcp-server/.env"
      ]
    }
  }
}
```

3. Пути — абсолютные и реальные (`where node` / `which node`). В JSON хранится путь к `.env`, а не секрет.
4. Полностью закройте и заново запустите Claude Desktop.
5. В новом чате проверьте список инструментов и попросите вызвать `bitrix_connection_info`: ожидаются домен портала
   без секрета и текущий сотрудник.

Ограничения: мобильное приложение Claude локальный процесс не запускает; для телефона нужен удалённый сервер (этап 12).
Если инструментов не видно — `npm run mcp:smoke -- --transport stdio` из папки проекта покажет, запускается ли сервер,
а логи процесса Desktop показывает в своих настройках разработчика.

# Первое развёртывание на Windows (ТЗ §17.1)

Откройте PowerShell в папке проекта.

```powershell
node --version      # ожидается 24.x; иначе установите Node.js с https://nodejs.org/ и перезапустите терминал
npm --version
npm ci
Copy-Item .env.example .env
notepad .env        # впишите BITRIX_PORTAL_URL и BITRIX_WEBHOOK_BASE_URL, сохраните
npm run setup
npm run doctor
npm run bitrix:profile
npm run build
```

`Copy-Item` — только при первом запуске. Нативной сборки не требуется: SQLite встроен в Node.js 24.

Ограничьте доступ к `.env` и папке `data\` своей учётной записью (свойства → безопасность).

Дальше — `docs/claude-code.md` (пример команды для Windows там есть).

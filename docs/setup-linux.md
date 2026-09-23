# Первое развёртывание на Linux (ТЗ §17.2)

```bash
node --version      # ожидается 24.x (см. .nvmrc); при отсутствии — nvm install 24
npm --version
npm ci
cp .env.example .env
chmod 600 .env
nano .env           # BITRIX_PORTAL_URL, BITRIX_WEBHOOK_BASE_URL; сохранить Ctrl+O, Enter; выйти Ctrl+X
npm run setup
npm run doctor
npm run bitrix:profile
npm run build
```

Ожидаемый результат: зависимости установлены, политики и ключ созданы в `policies/` и `data/secrets/` (права 700/600),
`doctor` показывает домен без секрета и текущего сотрудника, `dist/` собран.

Повторно `cp .env.example .env` не выполнять — затрёт настроенный файл.

Дальше — `docs/claude-code.md`.

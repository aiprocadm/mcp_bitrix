# S8: эксплуатация и масштабирование

Этап S8 SaaS-ТЗ (§5.1, §13, тесты S15, S16 — часть координации). Код — `src/saas/ops/`, деплой — `deploy/saas/`.
Общая инструкция для администратора — `docs/saas/operations.md`.

## Состав

| Компонент                   | Файл                                              | Что делает                                                                                           |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Клиент Redis                | `src/saas/ops/redis-client.ts`                    | RESP2/RESP3 поверх `node:net`/`node:tls`, AUTH/HELLO/SELECT, таймауты, переподключение, EVALSHA      |
| `RedisCoordination`         | `src/saas/ops/redis-coordination.ts`              | `Coordination` (блокировки, счётчики, drain, окно лимита, pub/sub) + `LeaseStore` (аренда лидера)    |
| `ClusterPortalLimiter`      | `src/saas/ops/cluster-limiter.ts`                 | `PortalLimiter`: частота к порталу суммарно по кластеру (S15), очередь/параллельность — на экземпляр |
| `WorkerRunner`              | `src/saas/ops/worker.ts`                          | Лидер worker, расписание `WorkerTask`, изоляция ошибок, метрики, SIGTERM                             |
| Метрики                     | `src/saas/ops/metrics.ts`                         | Счётчики/датчики/гистограммы, текст Prometheus 0.0.4, `createSaasMetrics`, `BillingMetrics`          |
| Настройки                   | `src/saas/ops/settings.ts`                        | `readOpsSettings(env)`, имена задач worker, `selectTasks`                                            |
| Compose, nginx, env, алерты | `deploy/saas/*`                                   | web ×2, worker, PostgreSQL 16, Redis 7 (пароль, AOF), nginx HTTPS; правила алертов Prometheus        |
| Бэкап и проверка            | `deploy/saas/pg-backup.sh`, `pg-restore-check.sh` | pg_dump → age/openssl, хранение 14 дней; восстановление во временную базу со сверкой строк           |

## Решения

- **Клиент Redis без npm-пакета** (запрет новых зависимостей): один файл, протокол по спецификации RESP
  (https://redis.io/docs/latest/develop/reference/protocol-spec/). Отправленные команды при обрыве **не повторяются**
  (INCRBY/EVAL не идемпотентны — повтор дал бы двойной счёт, S16); неотправленные ждут соединения в очереди.
  Просроченная отправленная команда разрывает соединение — иначе поздний ответ сдвинул бы очередь ответов.
- **Блокировка**: `SET key token NX PX ttl`, снятие/продление — Lua «только своим токеном»; ожидание — экспоненциальная
  пауза с джиттером в пределах `waitMs`. Блокировка не продлевается сама: `fn` дольше `ttlMs` теряет эксклюзивность
  (выбирайте `ttlMs` с запасом; для долгих работ — аренда `LeaseStore` с продлением, как у worker).
- **Окно лимита — скользящее (ZSET + Lua)**, а не фиксированное INCR+PEXPIRE: фиксированное окно на границе пропускает
  до 2×limit за окно, а лимит Bitrix24 на портал нарушать нельзя. Время — из Redis (`TIME`), часы экземпляров не
  сравниваются. Память — не больше `limit` элементов на ключ.
- **drain** — SCAN по префиксу + GETDEL каждого ключа: параллельный INCRBY попадает либо в забранное значение, либо в
  новый ключ; потерь и двойного счёта нет (проверено тестом при параллельных incr двух клиентов).
- **Лимитер портала при недоступном Redis** переходит на локальный запасной лимит (`PORTAL_LIMIT_FALLBACK_RPS`,
  по умолчанию rps/2): сервис продолжает работать, суммарное превышение в аварии ограничено; метрика
  `mcp_redis_errors_total{where="portal_limiter"}` и алерт `McpRedisErrors`.
- **Worker**: аренда `worker:leader` (TTL 15 с, продление каждые 5 с). Продление вернуло false или не удаётся дольше
  срока аренды → отказ от лидерства, всем задачам abort. Возможно короткое пересечение старого и нового лидера
  (задача, не реагирующая на `signal`), поэтому задачи обязаны быть идемпотентными.
- **Бэкап**: отдельная роль `mcp_backup` (только чтение + BYPASSRLS) — pg_dump под ролью сервиса падает на таблицах с
  `FORCE ROW LEVEL SECURITY` (проверено тестом). Шифрование по умолчанию — age с публичным ключом (на сервере нечем
  расшифровать); openssl — запасной вариант без аутентификации шифра. KEK в копию не входит; скрипт отказывается писать
  копии в каталог, где лежит KEK.
- **nginx**: MCP-сессии Streamable HTTP пока в памяти экземпляра, поэтому запросы с `Mcp-Session-Id` закрепляются за
  экземпляром (`hash $http_mcp_session_id consistent`); остальное — по кругу.

## Публичные интерфейсы (для других этапов)

```ts
// src/saas/ops/redis-coordination.ts
new RedisCoordination({ url, namespace?: 'mcp:', commandTimeoutMs?, connectTimeoutMs?, protocol?: 2 | 3, tls? })
  // Coordination + LeaseStore + acquireSlot(key, limit, windowMs): Promise<{ ok; retryAfterMs }> + ping()
interface LeaseStore { tryAcquire(key, ttlMs): Promise<string|null>; renew(key, token, ttlMs): Promise<boolean>; release(key, token): Promise<void> }

// src/saas/ops/cluster-limiter.ts — передать как TenantSpec.limiter
new ClusterPortalLimiter({ store: coordination, portalKey: tenantId, requestsPerSecond, maxConcurrency, maxQueueSize,
  fallbackRequestsPerSecond?, metrics?, onStoreError? }) // implements PortalLimiter

// src/saas/ops/worker.ts
interface WorkerTask { name; intervalMs; initialDelayMs?; timeoutMs?; run(signal: AbortSignal): Promise<void> }
const w = new WorkerRunner({ lease: coordination, tasks, settings?, logger?, metrics?, instanceId? });
w.start(); w.bindSignals(async () => { await coordination.close(); await db.close(); }); // SIGTERM/SIGINT

// src/saas/ops/metrics.ts
const metrics = createSaasMetrics();                 // один на процесс
metrics.toolCall(tool, 'ok' | ErrorCode, seconds);   // ядро вызова инструмента
metrics.httpResponse(route, status);
metrics.billing.renewal('succeeded'|'failed'|'skipped'); metrics.billing.payment(status, amountKopecks);
renderPrometheus(metrics.registry) // → { contentType, body } для GET /metrics (только внутренняя сеть)
```

## Переменные окружения

| Переменная                  | Смысл                                                          | Секрет |
| --------------------------- | -------------------------------------------------------------- | ------ |
| `REDIS_URL`                 | `redis://[user:pass@]host:port/db`, `rediss://` — TLS          | да     |
| `REDIS_NAMESPACE`           | префикс ключей и каналов (`mcp:`)                              | нет    |
| `REDIS_COMMAND_TIMEOUT_MS`  | таймаут команды (3000)                                         | нет    |
| `WORKER_LEASE_TTL_MS`       | срок аренды лидера (15000)                                     | нет    |
| `WORKER_RENEW_INTERVAL_MS`  | период продления (5000, меньше TTL)                            | нет    |
| `WORKER_SHUTDOWN_GRACE_MS`  | ожидание задач при SIGTERM (25000; меньше `stop_grace_period`) | нет    |
| `WORKER_TASKS`              | включённые задачи через запятую (пусто — все)                  | нет    |
| `WORKER_TASK_INTERVALS`     | `usage.flush=60000,billing.renewals=3600000`                   | нет    |
| `PORTAL_LIMIT_FALLBACK_RPS` | запасной лимит портала на экземпляр без Redis                  | нет    |

Имена задач: `usage.flush` (S6), `billing.renewals` (S7), `bitrix.app_info` (S3), `retention.cleanup` (§6.3),
`oauth.dcr_cleanup` (S4).

## Проверки

- На **настоящем redis-server 7** (`tests/integration/s8-redis.test.ts`, временный экземпляр на случайном порту):
  эксклюзивность блокировки между двумя клиентами и single-flight (основа S03), чужой токен, TTL, `fn` дольше TTL;
  incr/drain без потерь при параллельных incr (основа S16); `allow` суммарно для двух клиентов; **S15** — три экземпляра
  `ClusterPortalLimiter` не превышают частоту; очередь/отмена; pub/sub; переподключение после рестарта Redis (команды
  и подписки); пароль (requirepass), пароль не попадает в ошибки; таймаут команды; лидерство worker (работает один,
  второй подхватывает после остановки лидера), потеря аренды, SIGTERM.
- На **настоящем PostgreSQL 16** (`tests/integration/s8-backup.test.ts`): init-скрипт ролей, сервис стартует под
  ролью без SUPERUSER/BYPASSRLS, роль сервиса не может выгрузить таблицы с RLS, бэкап age и openssl, восстановление во
  временную базу со строгой сверкой строк, обнаружение порчи файла, отказ при KEK внутри каталога копий.
- Статически (`tests/unit/s8-deploy.test.ts`): YAML compose и алертов (PyYAML), инварианты (наружу только nginx,
  PostgreSQL/Redis во внутренней сети, секреты файлами, пароль Redis не в аргументах), `bash -n` скриптов.

## Не проверено (честно)

- **docker compose не запускался** (Docker в среде нет): сборка образа, healthcheck-и, сети, init-скрипт внутри образа
  postgres, конфиг Redis из секрета, nginx (`nginx -t`) — проверить на стенде по чек-листу ниже.
- Процессная роль `worker` подключена сборкой режима saas (`src/saas/main.ts`, `docs/saas/runtime.md`); запуск в compose не проверялся.
- Нагрузочный тест §13 (50 вызовов/с, 200 арендаторов) и выкат без простоя на живом стенде — не выполнены.
- `rediss://` (TLS) — код есть, с настоящим TLS-Redis не проверен; управляемый Redis/PostgreSQL провайдера — не проверены.
- Алерты — не проверены `promtool`/живым Prometheus.

## Чек-лист стенда

1. `docker compose config` без ошибок; `docker compose up -d --build`; все сервисы `healthy`.
2. `docker compose exec nginx nginx -t`; HTTPS-ответ `/healthz`; `/metrics` снаружи — 404.
3. `docker compose exec postgres psql -U postgres -c '\du'`: `mcp_app` без Superuser/Bypass RLS.
4. Остановить `worker` — алерт `McpWorkerNoLeader`; запустить второй worker (`docker compose run worker`) — работает один.
5. Выкат без простоя: `up -d --no-deps web1` → healthy → `web2`; во время выката — непрерывные вызовы `tools/call`.
6. `pg-backup.sh` по cron; раз в месяц `pg-restore-check.sh` на отдельном сервере; результат — в журнал эксплуатации.

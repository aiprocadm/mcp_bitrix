/**
 * Сборка приложения из конфигурации (SaaS-ТЗ §5.1–5.3, §16).
 *  - Platform — общее на процесс: конфигурация, логгер, политики, ключ, БД, аудит, файлы, панель, лимит входящих.
 *  - TenantScope — всё, что зависит от портала: провайдер авторизации Bitrix24, лимитер и клиент портала,
 *    capabilities, курсоры, операции, подтверждения, MutationExecutor, принципал, набор инструментов.
 * В режиме single собирается ровно один TenantScope (арендатор `local`) — поведение как в базовом ТЗ.
 * AppContainer = Platform + TenantScope единственного арендатора (совместимость со всем существующим кодом).
 */
import { WebhookAuthProvider } from '../auth/webhook-provider.js';
import type { BitrixAuthProvider } from '../auth/bitrix-auth-provider.js';
import { resolveLocalPrincipal, type Principal } from '../auth/principal.js';
import { CAPABILITIES_TTL_MS, CapabilityService } from '../bitrix/capabilities.js';
import { BitrixClient, type FetchLike } from '../bitrix/client.js';
import { CursorStore } from '../bitrix/pagination.js';
import { RateLimiter, type PortalLimiter } from '../bitrix/rate-limiter.js';
import type { AppConfig } from '../config/env.js';
import { loadPolicies, type Policies } from '../config/policy.js';
import { AppError } from '../errors/app-error.js';
import { AuditLog } from '../logging/audit.js';
import { createLogger, type AppLogger } from '../logging/logger.js';
import { createScanner, type FileScanner } from '../files/scanner.js';
import { FileStaging } from '../files/staging.js';
import { AdminAccounts } from '../http/admin-auth.js';
import { InboundLimiter } from '../security/inbound-limiter.js';
import { ApprovalService } from '../security/approval-service.js';
import { ensureMasterKey, SecretBox } from '../security/crypto.js';
import { MutationExecutor } from '../security/mutation-executor.js';
import { OutputPolicyEngine } from '../security/output-policy.js';
import { Database } from '../storage/database.js';
import { MemoryTtlCache } from '../storage/memory-cache.js';
import type { SqlDb } from '../storage/sql.js';
import { SqliteSqlDb } from '../storage/sqlite-db.js';
import { OperationsStore } from '../storage/operations.js';
import { allTools } from '../tools/index.js';
import type { ToolDefinition } from '../tools/types.js';

export const LOCAL_TENANT_ID = 'local';

/** Общие сервисы процесса: не зависят от портала и арендатора. */
export interface Platform {
  readonly config: AppConfig;
  readonly policies: Policies;
  readonly logger: AppLogger;
  /** Асинхронное SQL-хранилище (SQLite в single, PostgreSQL в saas). */
  readonly db: SqlDb;
  /** Синхронный SQLite режима single (панель /admin, doctor, бэкап); в saas отсутствует. */
  readonly sqlite: Database | undefined;
  readonly secretBox: SecretBox;
  readonly audit: AuditLog;
  /** Staging файлов без привязки к арендатору; арендатору выдаётся fileStaging.forTenant(id). */
  readonly fileStaging: FileStaging;
  /** Кэш метаданных порталов (capabilities, поля CRM) в памяти процесса. */
  readonly metadataCache: MemoryTtlCache;
  /** Учётные записи и сессии панели /admin. */
  readonly admin: AdminAccounts;
  readonly outputPolicy: OutputPolicyEngine;
  /** Лимит входящих read-вызовов на оператора (ТЗ §8.6). */
  readonly inboundLimiter: InboundLimiter;
  /** Внешний fetch (в тестах — мок); используется клиентами Bitrix24 всех арендаторов. */
  readonly fetch: FetchLike;
  close(): void;
}

/** Контекст одного арендатора (портала): создаётся на арендатора, в single — один на процесс. */
export interface TenantScope {
  readonly tenantId: string;
  readonly auth: BitrixAuthProvider;
  readonly limiter: PortalLimiter;
  readonly bitrix: BitrixClient;
  readonly capabilities: CapabilityService;
  readonly cursors: CursorStore;
  readonly operations: OperationsStore;
  readonly approvals: ApprovalService;
  readonly mutations: MutationExecutor;
  readonly principal: Principal;
  /** Файлы арендатора: fileToken и манифесты видны только внутри него. */
  readonly files: FileStaging;
  readonly tools: readonly ToolDefinition[];
  /** Обслуживание при старте арендатора (T16: executing → unknown, истёкшие планы/курсоры/файлы). */
  readonly ready: Promise<void>;
}

export interface AppContainer extends Platform, TenantScope {
  readonly platform: Platform;
  readonly scope: TenantScope;
}

export interface CreateAppOptions {
  fetch?: FetchLike;
  logger?: AppLogger;
  /** Для тестов: БД в памяти вместо файла. */
  inMemoryDatabase?: boolean;
  /** Для тестов: ключ шифрования вместо файла. */
  masterKey?: Buffer;
  /** Для тестов: сканер файлов вместо clamd по UPLOAD_SCANNER_URL. */
  scanner?: FileScanner;
}

/** Общие сервисы процесса. Не требует связи с Bitrix24. */
export function createPlatform(config: AppConfig, opts: CreateAppOptions = {}): Platform {
  const logger = opts.logger ?? createLogger({ level: config.logging.level, name: config.server.name });
  const policies = loadPolicies({
    methods: config.policy.methodPolicyFile,
    access: config.policy.accessPolicyFile,
    output: config.policy.outputPolicyFile,
  });
  const key = opts.masterKey ?? ensureMasterKey(config.storage.secretsKeyFile, { create: false }).key;
  const secretBox = new SecretBox(key);
  const sqlite = Database.open(opts.inMemoryDatabase ? ':memory:' : config.storage.databasePath);
  const db = new SqliteSqlDb(sqlite);
  const audit = new AuditLog(db, key, logger, config.logging.auditEnabled, config.logging.auditRetentionDays);
  const fileStaging = new FileStaging(
    db,
    {
      uploadRoot: config.storage.uploadRoot,
      stagingDir: config.storage.stagingDir,
      maxUploadBytes: config.files.maxUploadBytes,
      maxInlineFileBytes: config.files.maxInlineFileBytes,
      ttlSeconds: config.files.uploadTtlSeconds,
      scanRequired: config.files.scanRequired,
      scanner: opts.scanner ?? createScanner(config.files.scannerUrl),
    },
    logger,
    'local',
  );
  const admin = new AdminAccounts(sqlite, (id) => policies.access.principals[id]?.role);
  admin.cleanupExpired();
  return {
    config,
    policies,
    logger,
    db,
    sqlite,
    secretBox,
    audit,
    fileStaging,
    metadataCache: new MemoryTtlCache(CAPABILITIES_TTL_MS),
    admin,
    outputPolicy: new OutputPolicyEngine(policies.output),
    inboundLimiter: new InboundLimiter(config.server.inboundReadPerMinute),
    fetch: opts.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    close() {
      sqlite.close();
    },
  };
}

export interface TenantSpec {
  readonly tenantId: string;
  readonly auth: BitrixAuthProvider;
  readonly principal: Principal;
  /**
   * Разрешённые хосты Bitrix24 этого арендатора (защита от SSRF, Б§8.6). По умолчанию — из конфигурации (single).
   * В SaaS у каждого арендатора свой портал: только его хост.
   */
  readonly allowedHosts?: readonly string[];
  /** Лимитер портала; по умолчанию — лимитер процесса. В SaaS — общий для кластера (S8, S15). */
  readonly limiter?: PortalLimiter;
}

/** Контекст арендатора поверх общей платформы: свой клиент и лимитер портала, свои сервисы записи. */
export function createTenantScope(platform: Platform, spec: TenantSpec): TenantScope {
  const { config, db, secretBox, audit, logger, policies } = platform;
  const limiter =
    spec.limiter ??
    new RateLimiter({
      requestsPerSecond: config.bitrix.requestsPerSecond,
      maxConcurrency: config.bitrix.maxConcurrency,
      maxQueueSize: config.bitrix.maxQueueSize,
    });
  const bitrix = new BitrixClient({
    auth: spec.auth,
    fetch: platform.fetch,
    limiter,
    logger,
    allowedHosts: spec.allowedHosts ?? config.bitrix.allowedHosts,
    timeoutMs: config.bitrix.timeoutMs,
    uploadTimeoutMs: config.bitrix.uploadTimeoutMs,
    maxUpstreamResponseBytes: config.bitrix.maxUpstreamResponseBytes,
    maxReadRetries: config.bitrix.maxReadRetries,
  });
  const capabilities = new CapabilityService(platform.metadataCache, bitrix);
  const cursors = new CursorStore(db, secretBox, config.limits.cursorTtlSeconds, spec.tenantId);
  const operations = new OperationsStore(db, spec.tenantId);
  const files = platform.fileStaging.forTenant(spec.tenantId);
  const ready = (async () => {
    const recovered = await operations.recoverAfterRestart();
    if (recovered > 0)
      logger.warn({ recovered }, 'operations in executing state marked unknown after restart');
    await operations.expireStale();
    await cursors.cleanupExpired();
    await files.cleanupExpired();
    await audit.cleanup(spec.tenantId);
  })();
  // Ошибка обслуживания не должна стать необработанным отказом; ожидающий ready её получит.
  ready.catch((e: unknown) => {
    logger.error({ reason: e instanceof Error ? e.name : 'unknown' }, 'tenant maintenance failed');
  });
  const approvals = new ApprovalService(
    operations,
    secretBox,
    config.limits.approvalTtlSeconds,
    policies.version,
  );
  const mutations = new MutationExecutor(operations, approvals, secretBox, audit, logger, {
    idempotencyTtlHours: config.limits.idempotencyTtlHours,
    policyVersion: policies.version,
    confirmAllWrites: config.policy.confirmAllWrites,
    maxPreparationsPerMinute: 10,
  });
  return {
    tenantId: spec.tenantId,
    auth: spec.auth,
    limiter,
    bitrix,
    capabilities,
    cursors,
    operations,
    approvals,
    mutations,
    principal: spec.principal,
    files,
    ready,
    tools: allTools().filter((t) => config.policy.enabledModules.has(t.module)),
  };
}

/** Контейнер вызова: платформа + контекст арендатора (single — единственный; saas — на запрос). */
export function assembleApp(platform: Platform, scope: TenantScope): AppContainer {
  return { ...platform, ...scope, platform, scope, close: () => platform.close() };
}

/** Режим single: платформа + единственный арендатор `local` с вебхуком из конфигурации. */
export function createApp(config: AppConfig, opts: CreateAppOptions = {}): AppContainer {
  if (config.deployment.mode !== 'single') {
    throw new AppError(
      'CONFIG_INVALID',
      'DEPLOYMENT_MODE=saas ещё не собирается: компоненты SaaS появляются по этапам S1–S4 (docs/saas/STATUS.md)',
      { field: 'DEPLOYMENT_MODE', nextAction: 'Для работы сейчас используйте DEPLOYMENT_MODE=single' },
    );
  }
  if (!config.bitrix.webhook) {
    throw new AppError(
      'CONFIG_INVALID',
      'BITRIX_WEBHOOK_BASE_URL не задан: без связи с Bitrix24 сервер не запускается',
      {
        field: 'BITRIX_WEBHOOK_BASE_URL',
        nextAction: 'Заполните .env по docs/bitrix-webhook.md и выполните npm run doctor',
      },
    );
  }
  const platform = createPlatform(config, opts);
  try {
    const principal = resolveLocalPrincipal(config.server.principalId, platform.policies.access);
    const scope = createTenantScope(platform, {
      tenantId: LOCAL_TENANT_ID,
      auth: new WebhookAuthProvider(config.bitrix.webhook),
      principal,
    });
    return assembleApp(platform, scope);
  } catch (e) {
    platform.close();
    throw e;
  }
}

/**
 * Сборка приложения из конфигурации: один экземпляр каждого сервиса на процесс.
 * Порядок: логгер → политики → ключ → БД → аудит → auth → лимитер → клиент → сервисы → инструменты.
 */
import { WebhookAuthProvider } from '../auth/webhook-provider.js';
import type { BitrixAuthProvider } from '../auth/bitrix-auth-provider.js';
import { resolveLocalPrincipal, type Principal } from '../auth/principal.js';
import { CapabilityService } from '../bitrix/capabilities.js';
import { BitrixClient, type FetchLike } from '../bitrix/client.js';
import { CursorStore } from '../bitrix/pagination.js';
import { RateLimiter } from '../bitrix/rate-limiter.js';
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
import { OperationsStore } from '../storage/operations.js';
import { allTools } from '../tools/index.js';
import type { ToolDefinition } from '../tools/types.js';

export interface AppContainer {
  readonly config: AppConfig;
  readonly policies: Policies;
  readonly logger: AppLogger;
  readonly db: Database;
  readonly secretBox: SecretBox;
  readonly audit: AuditLog;
  readonly auth: BitrixAuthProvider;
  readonly limiter: RateLimiter;
  readonly bitrix: BitrixClient;
  readonly capabilities: CapabilityService;
  readonly cursors: CursorStore;
  readonly operations: OperationsStore;
  readonly approvals: ApprovalService;
  readonly mutations: MutationExecutor;
  readonly files: FileStaging;
  /** Учётные записи и сессии панели /admin. */
  readonly admin: AdminAccounts;
  readonly outputPolicy: OutputPolicyEngine;
  readonly principal: Principal;
  /** Лимит входящих read-вызовов на оператора (ТЗ §8.6). */
  readonly inboundLimiter: InboundLimiter;
  readonly tools: readonly ToolDefinition[];
  close(): void;
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

export function createApp(config: AppConfig, opts: CreateAppOptions = {}): AppContainer {
  const logger = opts.logger ?? createLogger({ level: config.logging.level, name: config.server.name });

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

  const policies = loadPolicies({
    methods: config.policy.methodPolicyFile,
    access: config.policy.accessPolicyFile,
    output: config.policy.outputPolicyFile,
  });
  const principal = resolveLocalPrincipal(config.server.principalId, policies.access);

  const key = opts.masterKey ?? ensureMasterKey(config.storage.secretsKeyFile, { create: false }).key;
  const secretBox = new SecretBox(key);

  const db = Database.open(opts.inMemoryDatabase ? ':memory:' : config.storage.databasePath);
  const audit = new AuditLog(db, key, logger, config.logging.auditEnabled, config.logging.auditRetentionDays);

  const auth = new WebhookAuthProvider(config.bitrix.webhook);
  const limiter = new RateLimiter({
    requestsPerSecond: config.bitrix.requestsPerSecond,
    maxConcurrency: config.bitrix.maxConcurrency,
    maxQueueSize: config.bitrix.maxQueueSize,
  });
  const bitrix = new BitrixClient({
    auth,
    fetch: opts.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    limiter,
    logger,
    allowedHosts: config.bitrix.allowedHosts,
    timeoutMs: config.bitrix.timeoutMs,
    uploadTimeoutMs: config.bitrix.uploadTimeoutMs,
    maxUpstreamResponseBytes: config.bitrix.maxUpstreamResponseBytes,
    maxReadRetries: config.bitrix.maxReadRetries,
  });
  const capabilities = new CapabilityService(db, bitrix);
  const cursors = new CursorStore(db, secretBox, config.limits.cursorTtlSeconds);
  const operations = new OperationsStore(db);
  const recovered = operations.recoverAfterRestart();
  if (recovered > 0) logger.warn({ recovered }, 'operations in executing state marked unknown after restart');
  operations.expireStale();
  cursors.cleanupExpired();
  const outputPolicy = new OutputPolicyEngine(policies.output);
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
  const files = new FileStaging(
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
  );
  files.cleanupExpired();
  const admin = new AdminAccounts(db, (id) => policies.access.principals[id]?.role);
  admin.cleanupExpired();

  const tools = allTools().filter((t) => config.policy.enabledModules.has(t.module));

  return {
    config,
    policies,
    logger,
    db,
    secretBox,
    audit,
    auth,
    limiter,
    bitrix,
    capabilities,
    cursors,
    operations,
    approvals,
    mutations,
    files,
    admin,
    outputPolicy,
    principal,
    inboundLimiter: new InboundLimiter(config.server.inboundReadPerMinute),
    tools,
    close() {
      db.close();
    },
  };
}

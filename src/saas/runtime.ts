/**
 * Сборка режима saas (SaaS-ТЗ §5.1–5.2, §16; docs/saas/runtime.md): общие сервисы процесса и контекст арендатора
 * на запрос. Модули этапов S2–S8 собираются здесь в один объект `SaasRuntime`; HTTP-маршруты — src/saas/http.ts,
 * задачи worker — src/saas/worker-tasks.ts, точка входа — src/saas/main.ts.
 *
 * Процесс (web и worker): PostgreSQL (роль без BYPASSRLS, миграции), KEK → TenantKeyRing, Coordination (Redis),
 * репозитории control plane, тарифы по умолчанию, тиражное приложение Bitrix24 (S3), сервер авторизации MCP (S4),
 * тарифы/учёт/подписки (S6/S7), метрики (S8), Platform на PostgreSQL и TenantScopeRegistry.
 *
 * Запрос: токен сервиса → (арендатор, пользователь) → TenantScope из реестра (LRU+TTL, сброс по событиям отзыва):
 * провайдер Bitrix24 пользователя (его OAuth-токены, D3), общий лимитер портала (кластер), только хост портала
 * (SSRF), ключ шифрования планов/курсоров — DEK арендатора (D7), principal операций = tenant_users.id.
 */
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assembleApp,
  createTenantScope,
  type AppContainer,
  type Platform,
  type TenantScope,
} from '../app/container.js';
import { TenantScopeRegistry } from '../app/tenant-registry.js';
import type { Principal } from '../auth/principal.js';
import { CAPABILITIES_TTL_MS } from '../bitrix/capabilities.js';
import { BitrixClient, type FetchLike } from '../bitrix/client.js';
import { RateLimiter, type PortalLimiter } from '../bitrix/rate-limiter.js';
import { ALL_MODULES } from '../config/modules.js';
import type { AppConfig } from '../config/env.js';
import { loadPolicies } from '../config/policy.js';
import { AppError, configError } from '../errors/app-error.js';
import { createScanner, type FileScanner } from '../files/scanner.js';
import { FileStaging } from '../files/staging.js';
import type { AdminAccounts } from '../http/admin-auth.js';
import { AuditLog } from '../logging/audit.js';
import { createLogger, type AppLogger } from '../logging/logger.js';
import type { DispatchHooks } from '../mcp/register-tools.js';
import { ApprovalService } from '../security/approval-service.js';
import { SecretBox } from '../security/crypto.js';
import { InboundLimiter } from '../security/inbound-limiter.js';
import { OutputPolicyEngine } from '../security/output-policy.js';
import { registerSecret } from '../security/redaction.js';
import { MemoryTtlCache } from '../storage/memory-cache.js';
import { OperationsStore } from '../storage/operations.js';
import { PostgresSqlDb } from '../storage/postgres-db.js';
import { EntitlementService } from './billing/entitlements.js';
import type { BillingNotifier } from './billing/notifier.js';
import type { PaymentProvider } from './billing/payment-provider.js';
import { billingSettingsFromDeployment, type BillingSettings } from './billing/settings.js';
import { SubscriptionService } from './billing/subscription-service.js';
import { UsageMeter } from './billing/usage-meter.js';
import { YooKassaProvider } from './billing/yookassa.js';
import {
  BitrixAppStatusService,
  BitrixEventsService,
  BitrixInstallService,
  BitrixLoginGatewayAdapter,
  BitrixLoginService,
  BitrixOAuthClient,
  BitrixOAuthProviderFactory,
  BitrixTokenStore,
  bitrixAppUrls,
  DEFAULT_OAUTH_SERVER_URL,
  parseInvalidateMessage,
  portalKeyForMember,
  TENANT_INVALIDATE_CHANNEL,
  type BitrixAppSettings,
  type BitrixAppUrls,
  type EventResult,
  type PortalClientFactory,
} from './bitrix/index.js';
import type { Coordination } from './coordination.js';
import { ReachCountingLimiter, saasDispatchHooks } from './dispatch-hooks.js';
import { TenantKeyRing } from './keyring.js';
import type { HostResolver } from './oauth/cimd-fetch.js';
import {
  AuthorizationServer,
  REVOCATION_CHANNEL,
  resolveOAuthSettings,
  SaasTokenVerifier,
  SigningKeyStore,
  type OAuthServerSettings,
  type SaasPrincipal,
} from './oauth/index.js';
import { ClusterPortalLimiter, type SlotStore } from './ops/cluster-limiter.js';
import { createSaasMetrics, type SaasMetrics } from './ops/metrics.js';
import { RedisCoordination } from './ops/redis-coordination.js';
import { PlansRepo, SubscriptionsRepo } from './repos/plans.js';
import { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from './repos/tenants.js';

export interface SaasRuntimeOptions {
  /** Все исходящие HTTP (Bitrix24 OAuth и REST порталов, ЮKassa, документы CIMD); тесты — имитации. */
  readonly fetch?: FetchLike;
  readonly logger?: AppLogger;
  /** Координация; по умолчанию RedisCoordination(REDIS_URL). Тесты могут передать InMemoryCoordination. */
  readonly coordination?: Coordination;
  /** KEK вместо чтения KEK_FILE (тесты). */
  readonly kek?: Buffer;
  /** Чтение файлов секретов (client_secret, ключ ЮKassa, токен метрик). По умолчанию — файловая система. */
  readonly readSecretFile?: (path: string) => string;
  readonly scanner?: FileScanner;
  /** Письма и баннеры биллинга; по умолчанию — журнал событий без ПДн (реализация писем — отдельный этап). */
  readonly notifier?: BillingNotifier;
  /** Провайдер платежей вместо ЮKassa из конфигурации. */
  readonly paymentProvider?: PaymentProvider;
  readonly metrics?: SaasMetrics;
  /** DNS для CIMD (тесты без сети). */
  readonly resolveHost?: HostResolver;
  readonly postgresMaxConnections?: number;
  /** Срок кэша TenantScope (SaaS-ТЗ §5.2: 60 с). */
  readonly scopeCacheTtlMs?: number;
  /** Периодический сброс учёта в PostgreSQL в этом процессе (по умолчанию true; §9.2). */
  readonly startUsageFlush?: boolean;
}

export interface SaasRepos {
  readonly tenants: TenantsRepo;
  readonly users: TenantUsersRepo;
  readonly tenantSettings: TenantSettingsRepo;
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
}

export interface SaasBitrix {
  readonly settings: BitrixAppSettings;
  readonly urls: BitrixAppUrls;
  readonly oauth: BitrixOAuthClient;
  readonly tokens: BitrixTokenStore;
  readonly providers: BitrixOAuthProviderFactory;
  readonly install: BitrixInstallService;
  readonly events: BitrixEventsService;
  readonly login: BitrixLoginService;
  readonly appStatus: BitrixAppStatusService;
  /** Клиент REST портала для служб (установка, вход, app.info): общий лимитер портала, только его хост. */
  readonly portalClient: PortalClientFactory;
}

export interface SaasOAuth {
  readonly settings: OAuthServerSettings;
  readonly keys: SigningKeyStore;
  readonly server: AuthorizationServer;
  readonly verifier: SaasTokenVerifier;
}

export interface SaasBilling {
  readonly settings: BillingSettings;
  readonly entitlements: EntitlementService;
  readonly usage: UsageMeter;
  readonly subscriptions: SubscriptionService;
  readonly provider: PaymentProvider | undefined;
}

/** Хранилища подтверждений арендатора для кабинета (без обращения к Bitrix24 и без токенов пользователя). */
export interface TenantApprovals {
  readonly tenantId: string;
  /** Ключ портала операций (portalKeyForMember): операции арендатора в ledger привязаны к нему. */
  readonly portalKey: string;
  readonly operations: OperationsStore;
  readonly approvals: ApprovalService;
}

/** Всё, что нужно сессии MCP пользователя: контейнер вызова, principal и хуки диспетчера saas. */
export interface SaasSessionContext {
  readonly app: AppContainer;
  readonly principal: Principal;
  readonly hooks: DispatchHooks;
}

export type InvalidateListener = (tenantId: string, userId: string | undefined) => void;

export interface SaasRuntime {
  readonly config: AppConfig;
  readonly logger: AppLogger;
  readonly publicBaseUrl: string;
  readonly platform: Platform;
  readonly db: PostgresSqlDb;
  readonly keyring: TenantKeyRing;
  readonly coordination: Coordination;
  readonly metrics: SaasMetrics;
  readonly registry: TenantScopeRegistry;
  readonly repos: SaasRepos;
  readonly bitrix: SaasBitrix;
  readonly oauth: SaasOAuth;
  readonly billing: SaasBilling;
  readonly audit: AuditLog;
  /** Staging файлов процесса; арендатору — `fileStaging.forTenant(tenantId)` (fileToken виден только ему). */
  readonly fileStaging: FileStaging;
  /** Токен доступа к /metrics (из METRICS_TOKEN_FILE); undefined — только loopback. */
  readonly metricsToken: string | undefined;
  /** Контекст арендатора для пользователя (кэш реестра); ошибки Bitrix-авторизации — AppError. */
  scopeFor(tenantId: string, userId: string): Promise<TenantScope>;
  /** Контекст сессии MCP по проверенному токену сервиса. */
  sessionFor(principal: SaasPrincipal): Promise<SaasSessionContext>;
  /** Подтверждения арендатора для кабинета (/app/approvals/<operationId>). */
  tenantApprovals(tenantId: string): Promise<TenantApprovals>;
  /** POST /b24/events: событие приложения; удаление приложения дополнительно отзывает доступ и останавливает биллинг. */
  handleBitrixEvent(body: string | URLSearchParams | Record<string, unknown>): Promise<EventResult>;
  /** Подписка на сброс контекстов (отзыв доступа, удаление приложения) — для закрытия MCP-сессий. */
  onInvalidate(listener: InvalidateListener): () => void;
  readiness(): Promise<{ database: boolean; redis: boolean }>;
  close(): Promise<void>;
}

/** KEK: 64 hex-символа (как `openssl rand -hex 32`), base64 32 байт или 32 байта как есть. */
export function parseKek(content: Buffer): Buffer {
  const text = content.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, 'base64');
  if (content.length === 32) return Buffer.from(content);
  throw configError(
    'KEK_FILE',
    'ожидается 32 байта: 64 hex-символа (openssl rand -hex 32), base64 или двоичный файл',
  );
}

const derive = (kek: Buffer, label: string): Buffer =>
  Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), `mcp-saas:${label}`, 32));

/** Панель /admin в saas не регистрируется (подтверждения — кабинет /app); любое обращение — явная ошибка. */
const ADMIN_DISABLED = new Proxy(
  {},
  {
    get() {
      throw new AppError('FEATURE_UNAVAILABLE', 'Панель /admin в режиме saas не используется');
    },
  },
) as AdminAccounts;

/** Уведомления биллинга по умолчанию: только журнал (tenantId, тип события) — без ПДн и сумм в тексте. */
function loggingNotifier(logger: AppLogger): BillingNotifier {
  return {
    quotaThreshold: (e) =>
      logger.info({ tenantId: e.tenantId, metric: e.metric, percent: e.percent }, 'billing quota threshold'),
    subscriptionEvent: (e) =>
      logger.info({ tenantId: e.tenantId, type: e.type, status: e.status }, 'billing subscription event'),
    dataDeletionDue: (e) => logger.warn({ tenantId: e.tenantId }, 'tenant data deletion due'),
  };
}

const hasSlotStore = (c: Coordination): c is Coordination & SlotStore =>
  typeof (c as Partial<SlotStore>).acquireSlot === 'function';
const hasPing = (c: Coordination): c is Coordination & { ping(): Promise<boolean> } =>
  typeof (c as { ping?: unknown }).ping === 'function';

export async function createSaasRuntime(
  config: AppConfig,
  opts: SaasRuntimeOptions = {},
): Promise<SaasRuntime> {
  const d = config.deployment;
  if (d.mode !== 'saas' || !d.publicBaseUrl || !d.postgresUrl || !d.redisUrl || !d.ops) {
    throw new AppError('CONFIG_INVALID', 'createSaasRuntime: ожидается DEPLOYMENT_MODE=saas', {
      field: 'DEPLOYMENT_MODE',
    });
  }
  const publicBaseUrl = d.publicBaseUrl;
  const logger = opts.logger ?? createLogger({ level: config.logging.level, name: config.server.name });
  const fetch: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const readSecret = opts.readSecretFile ?? ((p: string) => readFileSync(p, 'utf8').trim());
  const need = (field: string, v: string | undefined): string => {
    if (!v) throw configError(field, 'обязателен при DEPLOYMENT_MODE=saas');
    return v;
  };

  // Ключи и секреты читаются до подключения к БД: ошибка конфигурации не оставляет открытых соединений.
  const kek = opts.kek ?? parseKek(readFileSync(need('KEK_FILE', d.files.kek)));
  const keyring = new TenantKeyRing(kek);
  const clientSecret = readSecret(need('B24_APP_CLIENT_SECRET_FILE', d.files.b24ClientSecret));
  registerSecret(clientSecret);
  const metricsToken = config.deployment.http.metricsTokenFile
    ? readSecret(config.deployment.http.metricsTokenFile)
    : undefined;
  if (metricsToken !== undefined) {
    if (metricsToken.length < 16) throw configError('METRICS_TOKEN_FILE', 'токен короче 16 символов');
    registerSecret(metricsToken);
  }
  const billingSettings = billingSettingsFromDeployment(d, readSecret);
  if (billingSettings.yookassa) registerSecret(billingSettings.yookassa.secretKey);
  const oauthSettings = resolveOAuthSettings({
    ...d.oauth,
    publicBaseUrl,
    signingKeysDir: need('OAUTH_SIGNING_KEYS_DIR', d.files.oauthSigningKeysDir),
  });
  const policies = loadPolicies({
    methods: config.policy.methodPolicyFile,
    access: config.policy.accessPolicyFile,
    output: config.policy.outputPolicyFile,
  });

  const coordination =
    opts.coordination ??
    new RedisCoordination({
      url: d.redisUrl,
      namespace: d.ops.redisNamespace,
      commandTimeoutMs: d.ops.redisCommandTimeoutMs,
      onConnectionError: (message) => logger.warn({ where: 'redis' }, message),
    });
  let db: PostgresSqlDb;
  try {
    db = await PostgresSqlDb.open({
      connectionString: d.postgresUrl,
      requireRls: true,
      ...(opts.postgresMaxConnections ? { maxConnections: opts.postgresMaxConnections } : {}),
    });
  } catch (e) {
    await coordination.close().catch(() => undefined);
    throw e;
  }
  const cleanup: (() => Promise<void>)[] = [];
  try {
    const metrics = opts.metrics ?? createSaasMetrics();
    const repos: SaasRepos = {
      tenants: new TenantsRepo(db, keyring),
      users: new TenantUsersRepo(db),
      tenantSettings: new TenantSettingsRepo(db),
      plans: new PlansRepo(db),
      subscriptions: new SubscriptionsRepo(db),
    };
    await repos.plans.seedDefaults();

    // ---- Platform на PostgreSQL (общие сервисы процесса) ----
    const audit = new AuditLog(
      db,
      derive(kek, 'audit-alias'),
      logger,
      config.logging.auditEnabled,
      config.logging.auditRetentionDays,
    );
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
    const platform: Platform = {
      config,
      policies,
      logger,
      db,
      sqlite: undefined,
      // Ключ платформы (курсоры/планы вне контекста арендатора); у арендатора — его DEK (TenantSpec.secretBox).
      secretBox: new SecretBox(derive(kek, 'platform-box')),
      audit,
      fileStaging,
      metadataCache: new MemoryTtlCache(CAPABILITIES_TTL_MS),
      admin: ADMIN_DISABLED,
      outputPolicy: new OutputPolicyEngine(policies.output),
      inboundLimiter: new InboundLimiter(config.server.inboundReadPerMinute),
      fetch,
      close() {
        // БД и координацию закрывает SaasRuntime.close().
      },
    };

    // ---- лимитер портала: общий для пользователей арендатора и (через Redis) для кластера, S15 ----
    const limiters = new Map<string, PortalLimiter>();
    const limiterFor = (portalKey: string): PortalLimiter => {
      let l = limiters.get(portalKey);
      if (!l) {
        const base: PortalLimiter = hasSlotStore(coordination)
          ? new ClusterPortalLimiter({
              store: coordination,
              portalKey,
              requestsPerSecond: config.bitrix.requestsPerSecond,
              maxConcurrency: config.bitrix.maxConcurrency,
              maxQueueSize: config.bitrix.maxQueueSize,
              ...(d.ops?.portalLimitFallbackRps
                ? { fallbackRequestsPerSecond: d.ops.portalLimitFallbackRps }
                : {}),
              metrics,
              onStoreError: (message) => logger.warn({ where: 'portal_limiter' }, message),
            })
          : new RateLimiter({
              requestsPerSecond: config.bitrix.requestsPerSecond,
              maxConcurrency: config.bitrix.maxConcurrency,
              maxQueueSize: config.bitrix.maxQueueSize,
            });
        l = new ReachCountingLimiter(base);
        if (limiters.size > 10_000) limiters.clear();
        limiters.set(portalKey, l);
      }
      return l;
    };
    const portalClient: PortalClientFactory = (auth, hosts) =>
      new BitrixClient({
        auth,
        fetch,
        limiter: limiterFor(auth.portalKey),
        logger,
        allowedHosts: hosts,
        timeoutMs: config.bitrix.timeoutMs,
        uploadTimeoutMs: config.bitrix.uploadTimeoutMs,
        maxUpstreamResponseBytes: config.bitrix.maxUpstreamResponseBytes,
        maxReadRetries: config.bitrix.maxReadRetries,
      });

    // ---- S3: тиражное приложение Bitrix24 ----
    const b24Settings: BitrixAppSettings = {
      clientId: need('B24_APP_CLIENT_ID', d.b24App.clientId),
      clientSecret,
      oauthServerUrl: d.b24App.oauthServerUrl ?? DEFAULT_OAUTH_SERVER_URL,
      publicBaseUrl,
    };
    const b24Oauth = new BitrixOAuthClient({ settings: b24Settings, fetch, logger });
    const urls = bitrixAppUrls(b24Settings);
    const tokens = new BitrixTokenStore(db, keyring);
    const providers = new BitrixOAuthProviderFactory({
      tenants: repos.tenants,
      users: repos.users,
      tokens,
      oauth: b24Oauth,
      coordination,
      logger,
      urls,
    });
    const install = new BitrixInstallService({
      tenants: repos.tenants,
      users: repos.users,
      plans: repos.plans,
      subscriptions: repos.subscriptions,
      tokens,
      oauth: b24Oauth,
      portal: portalClient,
      coordination,
      logger,
      urls,
    });
    const events = new BitrixEventsService({ db, tenants: repos.tenants, install, coordination, logger });
    const login = new BitrixLoginService({
      tenants: repos.tenants,
      users: repos.users,
      settings: repos.tenantSettings,
      tokens,
      oauth: b24Oauth,
      portal: portalClient,
      coordination,
      logger,
      urls,
    });
    const appStatus = new BitrixAppStatusService({
      db,
      tenants: repos.tenants,
      users: repos.users,
      tokens,
      providers,
      portal: portalClient,
      logger,
    });

    // ---- S4: сервер авторизации MCP ----
    const signingKeys = await SigningKeyStore.open(oauthSettings);
    const authServer = new AuthorizationServer({
      settings: oauthSettings,
      db,
      keys: signingKeys,
      coordination,
      gateway: new BitrixLoginGatewayAdapter(login),
      tenants: repos.tenants,
      users: repos.users,
      tenantSettings: repos.tenantSettings,
      fetch,
      ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
      logger,
    });
    const verifier = new SaasTokenVerifier({
      settings: oauthSettings,
      keys: signingKeys,
      tenants: repos.tenants,
      users: repos.users,
      coordination,
    });

    // ---- S6/S7: тарифы, учёт, подписки ----
    const notifier = opts.notifier ?? loggingNotifier(logger);
    const usage = new UsageMeter({
      db,
      coordination,
      notifier,
      logger,
      warnPercent: billingSettings.quotaWarnPercent,
    });
    const entitlements = new EntitlementService({
      plans: repos.plans,
      subscriptions: repos.subscriptions,
      settings: repos.tenantSettings,
      usage,
      cabinetUrl: billingSettings.cabinetUrl,
      allModules: ALL_MODULES,
    });
    const provider: PaymentProvider | undefined =
      opts.paymentProvider ??
      (billingSettings.yookassa
        ? new YooKassaProvider({ settings: billingSettings.yookassa, seller: billingSettings.seller, fetch })
        : undefined);
    const subscriptions = new SubscriptionService({
      db,
      keys: keyring,
      plans: repos.plans,
      settings: billingSettings,
      notifier,
      logger,
      ...(provider ? { provider } : {}),
      users: repos.users,
      coordination,
    });

    // ---- реестр контекстов и сброс по событиям (§5.2: LRU, TTL 60 с, инвалидация через pub/sub) ----
    const registry = new TenantScopeRegistry({ ttlMs: opts.scopeCacheTtlMs ?? 60_000, maxEntries: 5000 });
    const listeners = new Set<InvalidateListener>();
    const invalidate = (tenantId: string, userId: string | undefined) => {
      registry.invalidate(tenantId, userId);
      for (const l of listeners) {
        try {
          l(tenantId, userId);
        } catch (e) {
          logger.warn({ reason: e instanceof Error ? e.name : 'unknown' }, 'invalidate listener failed');
        }
      }
    };
    cleanup.push(
      await coordination.subscribe(TENANT_INVALIDATE_CHANNEL, (m) => {
        const { tenantId, userId } = parseInvalidateMessage(m);
        invalidate(tenantId, userId);
      }),
    );
    cleanup.push(
      await coordination.subscribe(REVOCATION_CHANNEL, (m) => {
        try {
          const v = JSON.parse(m) as { tenantId?: unknown; userId?: unknown };
          if (typeof v.tenantId === 'string')
            invalidate(v.tenantId, typeof v.userId === 'string' ? v.userId : undefined);
        } catch {
          logger.warn({ channel: REVOCATION_CHANNEL }, 'malformed revocation message');
        }
      }),
    );
    cleanup.push(await entitlements.listen(coordination));

    const buildScope = async (tenantId: string, userId: string): Promise<TenantScope> => {
      const auth = await providers.open(tenantId, userId);
      const user = await repos.users.get(tenantId, userId);
      const box = await keyring.boxFor(db, tenantId);
      return createTenantScope(platform, {
        tenantId,
        auth,
        principal: { id: userId, role: user?.role ?? 'reader', source: 'oauth' },
        allowedHosts: auth.allowedHosts,
        limiter: limiterFor(auth.portalKey),
        secretBox: box,
        maintenance: false,
        onMutationFinished: async (e) => {
          const ent = await entitlements.load(tenantId);
          await usage.recordWrite({
            tenantId,
            userId: e.principalId,
            tool: e.tool,
            ...(ent.plan ? { limits: ent.plan.limits } : {}),
          });
        },
      });
    };
    const scopeFor = (tenantId: string, userId: string) =>
      registry.get(tenantId, userId, () => buildScope(tenantId, userId));

    const hookDeps = { entitlements, usage, metrics, publicBaseUrl, logger };

    if (opts.startUsageFlush !== false) usage.start(billingSettings.usageFlushIntervalMs);

    let closed = false;
    const runtime: SaasRuntime = {
      config,
      logger,
      publicBaseUrl,
      platform,
      db,
      keyring,
      coordination,
      metrics,
      registry,
      repos,
      bitrix: {
        settings: b24Settings,
        urls,
        oauth: b24Oauth,
        tokens,
        providers,
        install,
        events,
        login,
        appStatus,
        portalClient,
      },
      oauth: { settings: oauthSettings, keys: signingKeys, server: authServer, verifier },
      billing: { settings: billingSettings, entitlements, usage, subscriptions, provider },
      audit,
      fileStaging,
      metricsToken,
      scopeFor,
      async sessionFor(p) {
        const scope = await scopeFor(p.tenantId, p.userId);
        const snapshot = await entitlements.load(p.tenantId);
        return {
          app: assembleApp(platform, scope),
          principal: { id: p.userId, role: p.role, source: 'oauth' },
          hooks: saasDispatchHooks(hookDeps, { tenantId: p.tenantId, userId: p.userId, snapshot }),
        };
      },
      async tenantApprovals(tenantId) {
        const tenant = await repos.tenants.get(tenantId);
        if (!tenant) throw new AppError('NOT_FOUND', 'Арендатор не найден');
        const box = await keyring.boxFor(db, tenantId);
        const operations = new OperationsStore(db, tenantId);
        return {
          tenantId,
          portalKey: portalKeyForMember(tenant.memberId),
          operations,
          approvals: new ApprovalService(operations, box, config.limits.approvalTtlSeconds, policies.version),
        };
      },
      async handleBitrixEvent(body) {
        const r = await events.handle(body);
        if (r.event === 'ONAPPUNINSTALL' && 'uninstall' in r) {
          const tenantId = r.uninstall.tenantId;
          // §4 сценарий 6, §7.4: refresh-токены сервиса отозваны, списания остановлены. Повтор события идемпотентен.
          await authServer.revokeTenant(tenantId);
          await subscriptions.stopForUninstall(tenantId);
          invalidate(tenantId, undefined);
        }
        return r;
      },
      onInvalidate(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async readiness() {
        let database = true;
        try {
          await db.ping();
        } catch {
          database = false;
        }
        const redis = hasPing(coordination) ? await coordination.ping().catch(() => false) : true;
        return { database, redis };
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const fn of cleanup.splice(0)) await fn().catch(() => undefined);
        await usage.stop().catch((e: unknown) => {
          logger.error({ reason: e instanceof Error ? e.name : 'unknown' }, 'final usage flush failed');
        });
        await coordination.close().catch(() => undefined);
        await db.close().catch(() => undefined);
      },
    };
    return runtime;
  } catch (e) {
    for (const fn of cleanup.splice(0)) await fn().catch(() => undefined);
    await coordination.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw e;
  }
}

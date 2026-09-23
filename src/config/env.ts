/**
 * Строгая загрузка конфигурации (ТЗ §13, T01, T02).
 *
 * Правила:
 *  - `.env` берётся из `--config`/`CONFIG_PATH`, относительные пути в нём считаются
 *    от каталога этого файла, а не от cwd MCP-клиента;
 *  - булевы значения — только `true`/`false`, строка "false" не считается истиной;
 *  - опасные сочетания блокируют старт кодом CONFIG_INVALID;
 *  - секреты после разбора регистрируются в редакторе и никогда не печатаются.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { AppError, configError } from '../errors/app-error.js';
import { registerSecret } from '../security/redaction.js';
import { ALL_MODULES, isModuleName, type ModuleName } from './modules.js';

const strictBool = (name: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      const lower = v.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      ctx.addIssue({ code: 'custom', message: `${name}: допустимы только true или false` });
      return z.NEVER;
    });

const intInRange = (name: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${name}: ожидается целое число`)
    .transform(Number)
    .refine((n) => n >= min && n <= max, `${name}: допустимый диапазон ${min}..${max}`);

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const csv = z
  .string()
  .trim()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MCP_SERVER_NAME: z.string().trim().min(1).default('bitrix24-mcp-server'),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HOST: z.string().trim().min(1).default('127.0.0.1'),
  MCP_PORT: intInRange('MCP_PORT', 1, 65535).default(3000),
  MCP_PUBLIC_URL: optionalString,
  LOCAL_PRINCIPAL_ID: z.string().trim().min(1).max(64).default('owner'),

  BITRIX_AUTH_MODE: z.enum(['webhook', 'oauth']).default('webhook'),
  BITRIX_PORTAL_URL: optionalString,
  BITRIX_WEBHOOK_BASE_URL: optionalString,
  BITRIX_ALLOWED_HOSTS: csv,
  BITRIX_DEPLOYMENT: z.enum(['cloud', 'on-premise']).default('cloud'),
  DEFAULT_TIMEZONE: z.string().trim().min(1).default('Europe/Moscow'),

  ENABLED_MODULES: csv,
  READ_ONLY_MODE: strictBool('READ_ONLY_MODE').default(true),
  CONFIRM_ALL_WRITES: strictBool('CONFIRM_ALL_WRITES').default(true),
  CONFIRM_DESTRUCTIVE_ACTIONS: strictBool('CONFIRM_DESTRUCTIVE_ACTIONS').default(true),
  ENABLE_DESTRUCTIVE_TOOLS: strictBool('ENABLE_DESTRUCTIVE_TOOLS').default(false),
  ENABLE_RAW_REST: strictBool('ENABLE_RAW_REST').default(true),
  RAW_REST_MODE: z.enum(['read-only', 'disabled']).default('read-only'),
  METHOD_POLICY_FILE: z.string().trim().min(1).default('./policies/methods.json'),
  ACCESS_POLICY_FILE: z.string().trim().min(1).default('./policies/access.json'),
  OUTPUT_POLICY_FILE: z.string().trim().min(1).default('./policies/output.json'),

  DATA_DIR: z.string().trim().min(1).default('./data'),
  DATABASE_URL: z.string().trim().min(1).default('file:./data/mcp.sqlite'),
  SECRETS_KEY_FILE: z.string().trim().min(1).default('./data/secrets/master.key'),
  APPROVAL_TTL_SECONDS: intInRange('APPROVAL_TTL_SECONDS', 30, 3600).default(600),
  IDEMPOTENCY_TTL_HOURS: intInRange('IDEMPOTENCY_TTL_HOURS', 1, 720).default(168),
  CURSOR_TTL_SECONDS: intInRange('CURSOR_TTL_SECONDS', 30, 3600).default(600),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_BODY: strictBool('LOG_BODY').default(false),
  AUDIT_ENABLED: strictBool('AUDIT_ENABLED').default(true),
  AUDIT_RETENTION_DAYS: intInRange('AUDIT_RETENTION_DAYS', 1, 3650).default(90),
  LOG_RETENTION_DAYS: intInRange('LOG_RETENTION_DAYS', 1, 3650).default(14),

  BITRIX_TIMEOUT_MS: intInRange('BITRIX_TIMEOUT_MS', 1000, 120_000).default(20_000),
  BITRIX_UPLOAD_TIMEOUT_MS: intInRange('BITRIX_UPLOAD_TIMEOUT_MS', 1000, 300_000).default(60_000),
  BITRIX_MAX_READ_RETRIES: intInRange('BITRIX_MAX_READ_RETRIES', 0, 3).default(3),
  BITRIX_REQUESTS_PER_SECOND: intInRange('BITRIX_REQUESTS_PER_SECOND', 1, 10).default(1),
  BITRIX_MAX_CONCURRENCY: intInRange('BITRIX_MAX_CONCURRENCY', 1, 10).default(2),
  BITRIX_MAX_QUEUE_SIZE: intInRange('BITRIX_MAX_QUEUE_SIZE', 1, 10_000).default(100),
  MAX_RESPONSE_BYTES: intInRange('MAX_RESPONSE_BYTES', 4096, 10_485_760).default(65_536),
  MAX_UPSTREAM_RESPONSE_BYTES: intInRange('MAX_UPSTREAM_RESPONSE_BYTES', 65_536, 104_857_600).default(
    5_242_880,
  ),
  DEFAULT_PAGE_SIZE: intInRange('DEFAULT_PAGE_SIZE', 1, 50).default(20),
  MAX_PAGE_SIZE: intInRange('MAX_PAGE_SIZE', 1, 50).default(50),
  MAX_AGGREGATION_RECORDS: intInRange('MAX_AGGREGATION_RECORDS', 50, 50_000).default(5000),
  MAX_AGGREGATION_SECONDS: intInRange('MAX_AGGREGATION_SECONDS', 5, 300).default(30),

  UPLOAD_ROOT: z.string().trim().min(1).default('./data/inbox'),
  STAGING_DIR: z.string().trim().min(1).default('./data/staging'),
  MAX_UPLOAD_BYTES: intInRange('MAX_UPLOAD_BYTES', 1, 104_857_600).default(10_485_760),
  MAX_INLINE_FILE_BYTES: intInRange('MAX_INLINE_FILE_BYTES', 1, 1_048_576).default(262_144),
  UPLOAD_TTL_SECONDS: intInRange('UPLOAD_TTL_SECONDS', 60, 86_400).default(86_400),
  UPLOAD_SCAN_REQUIRED: strictBool('UPLOAD_SCAN_REQUIRED').default(false),
  UPLOAD_SCANNER_URL: optionalString,
  ALLOW_REMOTE_FILE_URLS: strictBool('ALLOW_REMOTE_FILE_URLS').default(false),

  MCP_AUTH_MODE: z.enum(['local', 'oauth']).default('local'),
  MCP_AUTH_ISSUER: optionalString,
  MCP_AUTH_AUDIENCE: optionalString,
  MCP_AUTH_JWKS_URI: optionalString,
  MCP_AUTH_ALLOWED_SUBJECTS: csv,
  MCP_ALLOWED_ORIGINS: csv,
  MCP_ALLOWED_HOSTS: csv,

  BITRIX_CLIENT_ID: optionalString,
  BITRIX_CLIENT_SECRET: optionalString,
  BITRIX_REDIRECT_URI: optionalString,
  BITRIX_INSTALL_URL: optionalString,
  BITRIX_OAUTH_TOKEN_ENDPOINT: optionalString,
  BITRIX_EXPECTED_MEMBER_ID: optionalString,
  BITRIX_ACCESS_TOKEN: optionalString,
  BITRIX_REFRESH_TOKEN: optionalString,

  LIVE_TESTS_ENABLED: strictBool('LIVE_TESTS_ENABLED').default(false),
  LIVE_TEST_PREFIX: z.string().trim().min(1).default('[MCP TEST]'),
  TEST_RESPONSIBLE_USER_ID: optionalString,
  TEST_CRM_CATEGORY_ID: optionalString,
  TEST_CRM_STAGE_ID: optionalString,
  TEST_CHAT_DIALOG_ID: optionalString,
  TEST_DISK_FOLDER_ID: optionalString,
  TEST_CALENDAR_TYPE: z.enum(['user', 'group', 'company']).default('user'),
  TEST_CALENDAR_OWNER_ID: optionalString,
  TEST_CALENDAR_SECTION_ID: optionalString,
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

/** Данные вебхука. Поле `secret` — единственное место хранения секрета в памяти. */
export interface WebhookCredentials {
  readonly kind: 'webhook';
  /** Полный базовый URL с завершающим `/`, например https://p.bitrix24.ru/rest/1/xxx/ */
  readonly baseUrl: string;
  readonly userId: number;
  readonly secret: string;
}

export interface AppConfig {
  readonly raw: RawEnv;
  /** Каталог, от которого считаются относительные пути (каталог .env). */
  readonly baseDir: string;
  readonly configPath: string | undefined;
  readonly server: {
    readonly name: string;
    readonly transport: 'stdio' | 'http';
    readonly host: string;
    readonly port: number;
    readonly publicUrl: string | undefined;
    readonly principalId: string;
    readonly authMode: 'local' | 'oauth';
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
  };
  readonly bitrix: {
    readonly authMode: 'webhook' | 'oauth';
    /** Origin портала без секрета, например https://p.bitrix24.ru */
    readonly portalOrigin: string | undefined;
    readonly allowedHosts: readonly string[];
    readonly deployment: 'cloud' | 'on-premise';
    readonly timezone: string;
    readonly webhook: WebhookCredentials | undefined;
    readonly timeoutMs: number;
    readonly uploadTimeoutMs: number;
    readonly maxReadRetries: number;
    readonly requestsPerSecond: number;
    readonly maxConcurrency: number;
    readonly maxQueueSize: number;
    readonly maxUpstreamResponseBytes: number;
  };
  readonly policy: {
    readonly enabledModules: ReadonlySet<ModuleName>;
    readonly readOnlyMode: boolean;
    readonly confirmAllWrites: boolean;
    readonly confirmDestructiveActions: boolean;
    readonly enableDestructiveTools: boolean;
    readonly enableRawRest: boolean;
    readonly rawRestMode: 'read-only' | 'disabled';
    readonly methodPolicyFile: string;
    readonly accessPolicyFile: string;
    readonly outputPolicyFile: string;
  };
  readonly limits: {
    readonly maxResponseBytes: number;
    readonly defaultPageSize: number;
    readonly maxPageSize: number;
    readonly maxAggregationRecords: number;
    readonly maxAggregationSeconds: number;
    readonly approvalTtlSeconds: number;
    readonly idempotencyTtlHours: number;
    readonly cursorTtlSeconds: number;
  };
  readonly storage: {
    readonly dataDir: string;
    readonly databasePath: string;
    readonly secretsKeyFile: string;
    readonly uploadRoot: string;
    readonly stagingDir: string;
  };
  readonly logging: {
    readonly level: RawEnv['LOG_LEVEL'];
    readonly logBody: boolean;
    readonly auditEnabled: boolean;
    readonly auditRetentionDays: number;
    readonly logRetentionDays: number;
  };
  readonly files: {
    readonly maxUploadBytes: number;
    readonly maxInlineFileBytes: number;
    readonly uploadTtlSeconds: number;
    readonly scanRequired: boolean;
    readonly scannerUrl: string | undefined;
    readonly allowRemoteFileUrls: boolean;
  };
  readonly live: {
    readonly enabled: boolean;
    readonly prefix: string;
    readonly responsibleUserId: number | undefined;
    readonly crmCategoryId: number | undefined;
    readonly crmStageId: string | undefined;
    readonly chatDialogId: string | undefined;
    readonly diskFolderId: number | undefined;
    readonly calendarType: 'user' | 'group' | 'company';
    readonly calendarOwnerId: number | undefined;
    readonly calendarSectionId: number | undefined;
  };
}

export interface LoadConfigOptions {
  /** Путь к .env из CLI `--config`; приоритетнее CONFIG_PATH. */
  configPath?: string | undefined;
  /** Переменные процесса; по умолчанию process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Рабочий каталог для поиска `./.env` по умолчанию. */
  cwd?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseDotenv(readFileSync(filePath, 'utf8'));
}

/** Разбор секретного URL вебхука. Значение в сообщениях об ошибке не печатается. */
export function parseWebhookBaseUrl(value: string, portalOrigin: string | undefined): WebhookCredentials {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError('BITRIX_WEBHOOK_BASE_URL', 'не является корректным URL');
  }
  if (url.protocol !== 'https:') throw configError('BITRIX_WEBHOOK_BASE_URL', 'допускается только https');
  if (url.search || url.hash) {
    throw configError('BITRIX_WEBHOOK_BASE_URL', 'не должен содержать query string или #fragment');
  }
  const m = /^\/rest\/(\d+)\/([A-Za-z0-9_-]{6,})\/$/.exec(url.pathname);
  if (!m) {
    throw configError(
      'BITRIX_WEBHOOK_BASE_URL',
      'ожидается вид https://портал/rest/<userId>/<код>/ с завершающим слэшем и без имени метода',
    );
  }
  if (portalOrigin && url.origin !== portalOrigin) {
    throw configError('BITRIX_WEBHOOK_BASE_URL', 'origin не совпадает с BITRIX_PORTAL_URL');
  }
  const userId = Number(m[1]);
  const secret = m[2] ?? '';
  return { kind: 'webhook', baseUrl: url.toString(), userId, secret };
}

function parsePortalOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError('BITRIX_PORTAL_URL', 'не является корректным URL');
  }
  if (url.protocol !== 'https:') throw configError('BITRIX_PORTAL_URL', 'допускается только https');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw configError(
      'BITRIX_PORTAL_URL',
      'укажите только адрес портала без путей, например https://x.bitrix24.ru',
    );
  }
  return url.origin;
}

function optionalInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw configError(name, 'ожидается положительное целое число');
  return Number(value);
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const processEnv = options.processEnv ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPathRaw = options.configPath ?? processEnv['CONFIG_PATH'];
  const configPath = configPathRaw ? path.resolve(cwd, configPathRaw) : path.resolve(cwd, '.env');
  const explicit = Boolean(configPathRaw);
  if (explicit && !existsSync(configPath)) {
    throw configError('CONFIG_PATH', 'файл конфигурации не найден по указанному пути');
  }
  const baseDir = path.dirname(configPath);

  const fileValues = readEnvFile(configPath);
  const merged: Record<string, string> = { ...fileValues };
  for (const key of Object.keys(RawEnvSchema.shape)) {
    const v = processEnv[key];
    if (v !== undefined) merged[key] = v;
  }

  const parsed = RawEnvSchema.safeParse(merged);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const joined = first?.path.join('.') ?? '';
    const field = joined === '' ? 'ENV' : joined;
    const message = first?.message ?? 'неверное значение';
    throw configError(
      field,
      message.startsWith(`${field}:`) ? message.slice(field.length + 1).trim() : message,
    );
  }
  const raw = parsed.data;

  const resolve = (p: string) => path.resolve(baseDir, p);

  const portalOrigin = parsePortalOrigin(raw.BITRIX_PORTAL_URL);
  let webhook: WebhookCredentials | undefined;
  if (raw.BITRIX_AUTH_MODE === 'webhook' && raw.BITRIX_WEBHOOK_BASE_URL) {
    webhook = parseWebhookBaseUrl(raw.BITRIX_WEBHOOK_BASE_URL, portalOrigin);
    registerSecret(webhook.secret);
    registerSecret(webhook.baseUrl);
  }
  if (raw.BITRIX_AUTH_MODE === 'oauth') {
    throw configError('BITRIX_AUTH_MODE', 'режим oauth не реализован на текущем этапе; используйте webhook');
  }
  for (const s of [raw.BITRIX_CLIENT_SECRET, raw.BITRIX_ACCESS_TOKEN, raw.BITRIX_REFRESH_TOKEN])
    registerSecret(s);

  const enabledModules = new Set<ModuleName>();
  for (const m of raw.ENABLED_MODULES.length ? raw.ENABLED_MODULES : ['system']) {
    if (!isModuleName(m))
      throw configError('ENABLED_MODULES', `неизвестный модуль; допустимы: ${ALL_MODULES.join(', ')}`);
    enabledModules.add(m);
  }
  enabledModules.add('system');

  // Опасные сочетания (ТЗ §13 п.4, §8.1, §8.2).
  if (raw.MCP_TRANSPORT === 'http' && !isLoopbackHost(raw.MCP_HOST) && raw.MCP_AUTH_MODE === 'local') {
    throw configError(
      'MCP_HOST',
      'внешний интерфейс запрещён при MCP_AUTH_MODE=local; допустим только loopback',
    );
  }
  if (raw.MCP_AUTH_MODE === 'oauth') {
    throw configError(
      'MCP_AUTH_MODE',
      'режим oauth реализуется на этапе удалённого подключения; пока используйте local',
    );
  }
  if (!raw.READ_ONLY_MODE && !raw.CONFIRM_ALL_WRITES) {
    throw configError(
      'CONFIRM_ALL_WRITES',
      'при выключенном READ_ONLY_MODE подтверждение всех записей обязательно',
    );
  }
  if (!raw.CONFIRM_DESTRUCTIVE_ACTIONS) {
    throw configError('CONFIRM_DESTRUCTIVE_ACTIONS', 'обязательный инвариант; значение false недопустимо');
  }
  if (raw.DEFAULT_PAGE_SIZE > raw.MAX_PAGE_SIZE) {
    throw configError('DEFAULT_PAGE_SIZE', 'не может превышать MAX_PAGE_SIZE');
  }
  if (raw.MAX_INLINE_FILE_BYTES > raw.MAX_UPLOAD_BYTES) {
    throw configError('MAX_INLINE_FILE_BYTES', 'не может превышать MAX_UPLOAD_BYTES');
  }
  if (raw.UPLOAD_SCAN_REQUIRED && !raw.UPLOAD_SCANNER_URL) {
    throw configError('UPLOAD_SCANNER_URL', 'обязателен при UPLOAD_SCAN_REQUIRED=true');
  }
  if (raw.ALLOW_REMOTE_FILE_URLS) {
    throw configError('ALLOW_REMOTE_FILE_URLS', 'загрузка по произвольным URL запрещена ТЗ §8.5');
  }

  const databasePath = raw.DATABASE_URL.startsWith('file:')
    ? resolve(raw.DATABASE_URL.slice('file:'.length))
    : resolve(raw.DATABASE_URL);

  const bitrixAllowedHosts = new Set<string>();
  if (portalOrigin) bitrixAllowedHosts.add(new URL(portalOrigin).host);
  for (const h of raw.BITRIX_ALLOWED_HOSTS) bitrixAllowedHosts.add(h.toLowerCase());

  return {
    raw,
    baseDir,
    configPath: existsSync(configPath) ? configPath : undefined,
    server: {
      name: raw.MCP_SERVER_NAME,
      transport: raw.MCP_TRANSPORT,
      host: raw.MCP_HOST,
      port: raw.MCP_PORT,
      publicUrl: raw.MCP_PUBLIC_URL,
      principalId: raw.LOCAL_PRINCIPAL_ID,
      authMode: raw.MCP_AUTH_MODE,
      allowedHosts: raw.MCP_ALLOWED_HOSTS,
      allowedOrigins: raw.MCP_ALLOWED_ORIGINS,
    },
    bitrix: {
      authMode: raw.BITRIX_AUTH_MODE,
      portalOrigin,
      allowedHosts: [...bitrixAllowedHosts],
      deployment: raw.BITRIX_DEPLOYMENT,
      timezone: raw.DEFAULT_TIMEZONE,
      webhook,
      timeoutMs: raw.BITRIX_TIMEOUT_MS,
      uploadTimeoutMs: raw.BITRIX_UPLOAD_TIMEOUT_MS,
      maxReadRetries: raw.BITRIX_MAX_READ_RETRIES,
      requestsPerSecond: raw.BITRIX_REQUESTS_PER_SECOND,
      maxConcurrency: raw.BITRIX_MAX_CONCURRENCY,
      maxQueueSize: raw.BITRIX_MAX_QUEUE_SIZE,
      maxUpstreamResponseBytes: raw.MAX_UPSTREAM_RESPONSE_BYTES,
    },
    policy: {
      enabledModules,
      readOnlyMode: raw.READ_ONLY_MODE,
      confirmAllWrites: raw.CONFIRM_ALL_WRITES,
      confirmDestructiveActions: raw.CONFIRM_DESTRUCTIVE_ACTIONS,
      enableDestructiveTools: raw.ENABLE_DESTRUCTIVE_TOOLS,
      enableRawRest: raw.ENABLE_RAW_REST,
      rawRestMode: raw.RAW_REST_MODE,
      methodPolicyFile: resolve(raw.METHOD_POLICY_FILE),
      accessPolicyFile: resolve(raw.ACCESS_POLICY_FILE),
      outputPolicyFile: resolve(raw.OUTPUT_POLICY_FILE),
    },
    limits: {
      maxResponseBytes: raw.MAX_RESPONSE_BYTES,
      defaultPageSize: raw.DEFAULT_PAGE_SIZE,
      maxPageSize: raw.MAX_PAGE_SIZE,
      maxAggregationRecords: raw.MAX_AGGREGATION_RECORDS,
      maxAggregationSeconds: raw.MAX_AGGREGATION_SECONDS,
      approvalTtlSeconds: raw.APPROVAL_TTL_SECONDS,
      idempotencyTtlHours: raw.IDEMPOTENCY_TTL_HOURS,
      cursorTtlSeconds: raw.CURSOR_TTL_SECONDS,
    },
    storage: {
      dataDir: resolve(raw.DATA_DIR),
      databasePath,
      secretsKeyFile: resolve(raw.SECRETS_KEY_FILE),
      uploadRoot: resolve(raw.UPLOAD_ROOT),
      stagingDir: resolve(raw.STAGING_DIR),
    },
    logging: {
      level: raw.LOG_LEVEL,
      logBody: raw.LOG_BODY,
      auditEnabled: raw.AUDIT_ENABLED,
      auditRetentionDays: raw.AUDIT_RETENTION_DAYS,
      logRetentionDays: raw.LOG_RETENTION_DAYS,
    },
    files: {
      maxUploadBytes: raw.MAX_UPLOAD_BYTES,
      maxInlineFileBytes: raw.MAX_INLINE_FILE_BYTES,
      uploadTtlSeconds: raw.UPLOAD_TTL_SECONDS,
      scanRequired: raw.UPLOAD_SCAN_REQUIRED,
      scannerUrl: raw.UPLOAD_SCANNER_URL,
      allowRemoteFileUrls: raw.ALLOW_REMOTE_FILE_URLS,
    },
    live: {
      enabled: raw.LIVE_TESTS_ENABLED,
      prefix: raw.LIVE_TEST_PREFIX,
      responsibleUserId: optionalInt('TEST_RESPONSIBLE_USER_ID', raw.TEST_RESPONSIBLE_USER_ID),
      crmCategoryId: optionalInt('TEST_CRM_CATEGORY_ID', raw.TEST_CRM_CATEGORY_ID),
      crmStageId: raw.TEST_CRM_STAGE_ID,
      chatDialogId: raw.TEST_CHAT_DIALOG_ID,
      diskFolderId: optionalInt('TEST_DISK_FOLDER_ID', raw.TEST_DISK_FOLDER_ID),
      calendarType: raw.TEST_CALENDAR_TYPE,
      calendarOwnerId: optionalInt('TEST_CALENDAR_OWNER_ID', raw.TEST_CALENDAR_OWNER_ID),
      calendarSectionId: optionalInt('TEST_CALENDAR_SECTION_ID', raw.TEST_CALENDAR_SECTION_ID),
    },
  };
}

/** Безопасное описание конфигурации для doctor/connection_info: без единого секрета. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    configPath:
      config.configPath ?? '(файл .env не найден, используются значения по умолчанию и переменные процесса)',
    transport: config.server.transport,
    host: config.server.host,
    port: config.server.port,
    mcpAuthMode: config.server.authMode,
    bitrixAuthMode: config.bitrix.authMode,
    portalOrigin: config.bitrix.portalOrigin ?? null,
    webhookConfigured: Boolean(config.bitrix.webhook),
    webhookUserId: config.bitrix.webhook?.userId ?? null,
    deployment: config.bitrix.deployment,
    timezone: config.bitrix.timezone,
    enabledModules: [...config.policy.enabledModules],
    readOnlyMode: config.policy.readOnlyMode,
    confirmAllWrites: config.policy.confirmAllWrites,
    enableRawRest: config.policy.enableRawRest,
    rawRestMode: config.policy.rawRestMode,
    dataDir: config.storage.dataDir,
    databasePath: config.storage.databasePath,
  };
}

export function assertConfigOrExit(fn: () => AppConfig): AppConfig {
  try {
    return fn();
  } catch (e) {
    const err = AppError.from(e);
    process.stderr.write(`[${err.code}] ${err.message}\n`);
    process.exit(2);
  }
}

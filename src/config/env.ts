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
import { isIP } from 'node:net';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { parseScannerUrl } from '../files/scanner.js';
import { z } from 'zod';
import { AppError, configError } from '../errors/app-error.js';
import { registerSecret } from '../security/redaction.js';
import { ALL_MODULES, isModuleName, type ModuleName } from './modules.js';
import type { OAuthServerSettings } from '../saas/oauth/settings.js';
import { readOpsSettings, type OpsSettings } from '../saas/ops/settings.js';

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
  // Режим развёртывания (SaaS-ТЗ D14, §5.3, §15): single — как базовое ТЗ; saas — много арендаторов.
  DEPLOYMENT_MODE: z.enum(['single', 'saas']).default('single'),
  PUBLIC_BASE_URL: optionalString,
  REDIS_URL: optionalString,
  PROCESS_ROLE: z.enum(['web', 'worker']).default('web'),
  KEK_FILE: optionalString,
  B24_APP_CLIENT_ID: optionalString,
  B24_APP_CLIENT_SECRET_FILE: optionalString,
  B24_OAUTH_SERVER_URL: optionalString,
  OAUTH_SIGNING_KEYS_DIR: optionalString,
  YOOKASSA_SHOP_ID: optionalString,
  YOOKASSA_SECRET_KEY_FILE: optionalString,
  YOOKASSA_API_URL: optionalString,
  SELLER_NAME: optionalString,
  SELLER_INN: optionalString,
  SELLER_TAX_SYSTEM_CODE: optionalString,
  SELLER_VAT_CODE: optionalString,
  SMTP_URL: optionalString,
  MAIL_FROM: optionalString,
  // SaaS: сервер авторизации MCP (S4, docs/saas/s4-oauth.md) — все необязательны, значения по умолчанию §7.1.
  OAUTH_SIGNING_ALG: z.enum(['ES256', 'EdDSA']).optional(),
  OAUTH_ACCESS_TOKEN_TTL_SEC: optionalString,
  OAUTH_REFRESH_TOKEN_TTL_SEC: optionalString,
  OAUTH_CODE_TTL_SEC: optionalString,
  OAUTH_AUTH_REQUEST_TTL_SEC: optionalString,
  OAUTH_KEY_ROTATION_SEC: optionalString,
  OAUTH_DCR_LIMIT: optionalString,
  OAUTH_DCR_WINDOW_SEC: optionalString,
  OAUTH_CLIENT_RETENTION_DAYS: optionalString,
  OAUTH_CIMD_ENABLED: optionalString,
  OAUTH_CIMD_ALLOWED_HOSTS: csv,
  // SaaS: эксплуатация (S8, docs/saas/s8-operations.md) — разбирает readOpsSettings.
  REDIS_NAMESPACE: optionalString,
  REDIS_COMMAND_TIMEOUT_MS: optionalString,
  WORKER_LEASE_TTL_MS: optionalString,
  WORKER_RENEW_INTERVAL_MS: optionalString,
  WORKER_SHUTDOWN_GRACE_MS: optionalString,
  WORKER_TASKS: optionalString,
  WORKER_TASK_INTERVALS: optionalString,
  PORTAL_LIMIT_FALLBACK_RPS: optionalString,
  // SaaS: HTTP (docs/saas/runtime.md): доверенные прокси (адрес клиента из X-Forwarded-For) и токен /metrics.
  TRUSTED_PROXIES: csv,
  METRICS_TOKEN_FILE: optionalString,
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
  /** Папка для скачанных с портала файлов (disk_file_download, chat_files_download); пусто — скачивание выключено. */
  DOWNLOAD_DIR: optionalString,
  MAX_DOWNLOAD_BYTES: intInRange('MAX_DOWNLOAD_BYTES', 1, 104_857_600).default(52_428_800),

  MCP_AUTH_MODE: z.enum(['local', 'oauth']).default('local'),
  MCP_AUTH_ISSUER: optionalString,
  MCP_AUTH_AUDIENCE: optionalString,
  MCP_AUTH_JWKS_URI: optionalString,
  MCP_AUTH_ALLOWED_SUBJECTS: csv,
  MCP_ALLOWED_ORIGINS: csv,
  MCP_ALLOWED_HOSTS: csv,
  /** ТЗ §8.6: входящие read-вызовы на оператора в минуту (write-подготовки ограничены в MutationExecutor: 10/мин). */
  MCP_INBOUND_READ_PER_MINUTE: intInRange('MCP_INBOUND_READ_PER_MINUTE', 1, 100_000).default(60),
  /** Панель подтверждений и web-upload (ТЗ §4.5 /admin/*): отдельный вход по паролю. */
  ADMIN_PANEL_ENABLED: strictBool('ADMIN_PANEL_ENABLED').default(false),

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

export interface DeploymentSettings {
  readonly mode: 'single' | 'saas';
  /** saas: публичный адрес сервиса (issuer, ресурс MCP, redirect). */
  readonly publicBaseUrl: string | undefined;
  /** saas: адрес Redis (секрет зарегистрирован в редакторе). */
  readonly redisUrl: string | undefined;
  /** saas: адрес PostgreSQL (секрет зарегистрирован в редакторе); в single — не используется. */
  readonly postgresUrl: string | undefined;
  readonly processRole: 'web' | 'worker';
  /** Файлы секретов и публичные параметры saas (секреты читаются из файлов при сборке, не хранятся в конфиге). */
  readonly files: {
    readonly kek: string | undefined;
    readonly b24ClientSecret: string | undefined;
    readonly oauthSigningKeysDir: string | undefined;
    readonly yookassaSecretKey: string | undefined;
  };
  readonly b24App: { readonly clientId: string | undefined; readonly oauthServerUrl: string | undefined };
  readonly yookassa: { readonly shopId: string | undefined; readonly apiUrl: string | undefined };
  readonly seller: {
    readonly name: string | undefined;
    readonly inn: string | undefined;
    readonly taxSystemCode: string | undefined;
    readonly vatCode: string | undefined;
  };
  readonly mail: { readonly smtpUrl: string | undefined; readonly from: string | undefined };
  /** saas: параметры сервера авторизации MCP (OAUTH_*); секретов нет — ключи лежат в OAUTH_SIGNING_KEYS_DIR. */
  readonly oauth: SaasOAuthEnv;
  /** saas: Redis, worker, запасной лимит портала (REDIS_*, WORKER_*, PORTAL_LIMIT_FALLBACK_RPS); в single — нет. */
  readonly ops: OpsSettings | undefined;
  readonly http: {
    /** Адреса/подсети прокси (nginx), которым доверяется X-Forwarded-For. Пусто — адрес соединения. */
    readonly trustedProxies: readonly string[];
    /** Файл с токеном доступа к /metrics (Bearer); без него /metrics — только с loopback. */
    readonly metricsTokenFile: string | undefined;
  };
}

/** Необязательные настройки сервера авторизации из окружения (дополняются в resolveOAuthSettings). */
export type SaasOAuthEnv = Partial<
  Omit<OAuthServerSettings, 'publicBaseUrl' | 'signingKeysDir' | 'cimd' | 'registrationRateLimit'>
> & {
  readonly registrationRateLimit?: { readonly limit: number; readonly windowSec: number };
  readonly cimd?: { readonly enabled?: boolean; readonly allowedHosts?: readonly string[] };
};

export interface AppConfig {
  readonly raw: RawEnv;
  readonly deployment: DeploymentSettings;
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
    /** Заполнено только при MCP_AUTH_MODE=oauth. */
    readonly auth: McpAuthSettings | undefined;
    readonly inboundReadPerMinute: number;
    readonly adminPanelEnabled: boolean;
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
    /** Куда сохранять скачанные файлы; undefined — скачивание на диск сервера выключено. */
    readonly downloadDir: string | undefined;
    readonly maxDownloadBytes: number;
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

/** Настройки OAuth-защиты MCP (ТЗ §4.2, §18.3; спецификация MCP Authorization, S25). */
export interface McpAuthSettings {
  /** Ожидаемый `iss` — строка как задана, без нормализации (сравнение точное). */
  readonly issuer: string;
  /** Ожидаемый `aud`; по умолчанию — канонический адрес сервера (RFC 8707). */
  readonly audience: string;
  readonly jwksUri: string;
  readonly allowedSubjects: readonly string[];
  /** Канонический URI ресурса: MCP_PUBLIC_URL без завершающего `/` и без fragment. */
  readonly resource: string;
  /** Адрес документа RFC 9728 для заголовка WWW-Authenticate. */
  readonly metadataUrl: string;
  readonly publicOrigin: string;
}

/** https обязателен; http допустим только для loopback (локальные проверки). Без учётных данных и fragment. */
function parseServiceUrl(field: string, value: string | undefined, why: string): URL {
  if (!value) throw configError(field, why);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(field, 'не является абсолютным URL');
  }
  if (url.username || url.password) throw configError(field, 'учётные данные в URL недопустимы');
  if (url.hash) throw configError(field, 'fragment (#...) недопустим');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw configError(field, 'требуется https (http допустим только для loopback)');
}

function canonicalResource(publicUrl: URL): string {
  const path = publicUrl.pathname.replace(/\/+$/, '');
  return `${publicUrl.origin}${path}`;
}

/** RFC 9728 §3: `/.well-known/oauth-protected-resource` + путь ресурса. */
function protectedResourceMetadataUrl(publicUrl: URL): string {
  const path = publicUrl.pathname.replace(/\/+$/, '');
  return `${publicUrl.origin}/.well-known/oauth-protected-resource${path}`;
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

const isPostgresUrl = (v: string) => /^postgres(ql)?:\/\//i.test(v);

/** Адрес сервиса без учётных данных; пароль регистрируется в редакторе, чтобы не попасть в логи. */
function parseSecretServiceUrl(field: string, value: string | undefined, schemes: readonly string[]): string {
  if (!value) throw configError(field, 'обязателен при DEPLOYMENT_MODE=saas');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(field, 'не является корректным URL');
  }
  if (!schemes.includes(url.protocol)) throw configError(field, `ожидается схема ${schemes.join(' или ')}`);
  if (url.password) registerSecret(decodeURIComponent(url.password));
  registerSecret(value);
  return value;
}

const EMPTY_SAAS = {
  files: {
    kek: undefined,
    b24ClientSecret: undefined,
    oauthSigningKeysDir: undefined,
    yookassaSecretKey: undefined,
  },
  b24App: { clientId: undefined, oauthServerUrl: undefined },
  yookassa: { shopId: undefined, apiUrl: undefined },
  seller: { name: undefined, inn: undefined, taxSystemCode: undefined, vatCode: undefined },
  mail: { smtpUrl: undefined, from: undefined },
  oauth: {},
  ops: undefined,
  http: { trustedProxies: [], metricsTokenFile: undefined },
} as const;

function intSetting(field: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw configError(field, 'ожидается целое число');
  const n = Number(value);
  if (n < min || n > max) throw configError(field, `допустимый диапазон ${String(min)}..${String(max)}`);
  return n;
}

function boolSetting(field: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw configError(field, 'допустимы только true или false');
}

/** OAUTH_* → частичные настройки сервера авторизации (инварианты проверяет resolveOAuthSettings при сборке). */
function parseOAuthEnv(raw: RawEnv): SaasOAuthEnv {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  set('signingAlg', raw.OAUTH_SIGNING_ALG);
  set('accessTokenTtlSec', intSetting('OAUTH_ACCESS_TOKEN_TTL_SEC', raw.OAUTH_ACCESS_TOKEN_TTL_SEC, 1, 3600));
  set(
    'refreshTokenTtlSec',
    intSetting('OAUTH_REFRESH_TOKEN_TTL_SEC', raw.OAUTH_REFRESH_TOKEN_TTL_SEC, 60, 365 * 86_400),
  );
  set('authCodeTtlSec', intSetting('OAUTH_CODE_TTL_SEC', raw.OAUTH_CODE_TTL_SEC, 1, 60));
  set(
    'authRequestTtlSec',
    intSetting('OAUTH_AUTH_REQUEST_TTL_SEC', raw.OAUTH_AUTH_REQUEST_TTL_SEC, 60, 3600),
  );
  set(
    'signingKeyRotationSec',
    intSetting('OAUTH_KEY_ROTATION_SEC', raw.OAUTH_KEY_ROTATION_SEC, 3600, 365 * 86_400),
  );
  set(
    'unusedClientRetentionDays',
    intSetting('OAUTH_CLIENT_RETENTION_DAYS', raw.OAUTH_CLIENT_RETENTION_DAYS, 1, 3650),
  );
  const dcrLimit = intSetting('OAUTH_DCR_LIMIT', raw.OAUTH_DCR_LIMIT, 1, 100_000);
  const dcrWindow = intSetting('OAUTH_DCR_WINDOW_SEC', raw.OAUTH_DCR_WINDOW_SEC, 1, 86_400);
  if (dcrLimit !== undefined || dcrWindow !== undefined)
    out['registrationRateLimit'] = { limit: dcrLimit ?? 10, windowSec: dcrWindow ?? 3600 };
  const cimdEnabled = boolSetting('OAUTH_CIMD_ENABLED', raw.OAUTH_CIMD_ENABLED);
  if (cimdEnabled !== undefined || raw.OAUTH_CIMD_ALLOWED_HOSTS.length > 0) {
    out['cimd'] = {
      ...(cimdEnabled !== undefined ? { enabled: cimdEnabled } : {}),
      ...(raw.OAUTH_CIMD_ALLOWED_HOSTS.length
        ? { allowedHosts: raw.OAUTH_CIMD_ALLOWED_HOSTS.map((h) => h.toLowerCase()) }
        : {}),
    };
  }
  return out;
}

/** Адрес или подсеть (CIDR) доверенного прокси. */
function parseTrustedProxies(list: readonly string[]): string[] {
  for (const entry of list) {
    const [addr, prefix, extra] = entry.split('/');
    const kind = addr ? isIP(addr) : 0;
    const max = kind === 6 ? 128 : 32;
    if (
      !kind ||
      extra !== undefined ||
      (prefix !== undefined && !(/^\d+$/.test(prefix) && Number(prefix) <= max))
    )
      throw configError('TRUSTED_PROXIES', 'ожидается список IP-адресов или подсетей CIDR через запятую');
  }
  return [...list];
}

/** SaaS-ТЗ §15: опасные сочетания режима блокируют старт (как базовый T01). */
function parseDeployment(raw: RawEnv, resolve: (p: string) => string): DeploymentSettings {
  if (raw.DEPLOYMENT_MODE === 'single') {
    if (isPostgresUrl(raw.DATABASE_URL))
      throw configError('DATABASE_URL', 'PostgreSQL поддерживается только при DEPLOYMENT_MODE=saas');
    return {
      mode: 'single',
      publicBaseUrl: undefined,
      redisUrl: undefined,
      postgresUrl: undefined,
      processRole: 'web',
      ...EMPTY_SAAS,
    };
  }
  const base = parseServiceUrl(
    'PUBLIC_BASE_URL',
    raw.PUBLIC_BASE_URL,
    'обязателен при DEPLOYMENT_MODE=saas: публичный https-адрес сервиса, например https://mcp.example.ru',
  );
  if (base.pathname !== '/' || base.search)
    throw configError('PUBLIC_BASE_URL', 'только origin без пути и query, например https://mcp.example.ru');
  if (raw.BITRIX_WEBHOOK_BASE_URL)
    throw configError(
      'BITRIX_WEBHOOK_BASE_URL',
      'в SaaS вебхуки не используются: порталы подключаются тиражным приложением (SaaS-ТЗ D2)',
    );
  if (raw.MCP_TRANSPORT !== 'http')
    throw configError('MCP_TRANSPORT', 'SaaS работает только по HTTP (stdio — для DEPLOYMENT_MODE=single)');
  if (!isPostgresUrl(raw.DATABASE_URL))
    throw configError(
      'DATABASE_URL',
      'при DEPLOYMENT_MODE=saas требуется PostgreSQL (postgres://…), SQLite — только single',
    );
  const postgresUrl = parseSecretServiceUrl('DATABASE_URL', raw.DATABASE_URL, ['postgres:', 'postgresql:']);
  const redisUrl = parseSecretServiceUrl('REDIS_URL', raw.REDIS_URL, ['redis:', 'rediss:']);
  const need = (field: string, v: string | undefined) => {
    if (!v) throw configError(field, 'обязателен при DEPLOYMENT_MODE=saas');
    return v;
  };
  if (raw.SELLER_INN && !/^(\d{10}|\d{12})$/.test(raw.SELLER_INN))
    throw configError('SELLER_INN', 'ИНН — 10 или 12 цифр');
  for (const [field, v] of [
    ['B24_OAUTH_SERVER_URL', raw.B24_OAUTH_SERVER_URL],
    ['YOOKASSA_API_URL', raw.YOOKASSA_API_URL],
  ] as const) {
    if (v) parseServiceUrl(field, v, 'https-адрес');
  }
  return {
    mode: 'saas',
    publicBaseUrl: base.origin,
    redisUrl,
    postgresUrl,
    processRole: raw.PROCESS_ROLE,
    files: {
      kek: resolve(need('KEK_FILE', raw.KEK_FILE)),
      b24ClientSecret: resolve(need('B24_APP_CLIENT_SECRET_FILE', raw.B24_APP_CLIENT_SECRET_FILE)),
      oauthSigningKeysDir: resolve(need('OAUTH_SIGNING_KEYS_DIR', raw.OAUTH_SIGNING_KEYS_DIR)),
      yookassaSecretKey: raw.YOOKASSA_SECRET_KEY_FILE ? resolve(raw.YOOKASSA_SECRET_KEY_FILE) : undefined,
    },
    b24App: {
      clientId: need('B24_APP_CLIENT_ID', raw.B24_APP_CLIENT_ID),
      oauthServerUrl: raw.B24_OAUTH_SERVER_URL,
    },
    yookassa: { shopId: raw.YOOKASSA_SHOP_ID, apiUrl: raw.YOOKASSA_API_URL },
    seller: {
      name: raw.SELLER_NAME,
      inn: raw.SELLER_INN,
      taxSystemCode: raw.SELLER_TAX_SYSTEM_CODE,
      vatCode: raw.SELLER_VAT_CODE,
    },
    mail: {
      smtpUrl: raw.SMTP_URL
        ? parseSecretServiceUrl('SMTP_URL', raw.SMTP_URL, ['smtp:', 'smtps:'])
        : undefined,
      from: raw.MAIL_FROM,
    },
    oauth: parseOAuthEnv(raw),
    ops: parseOps(raw, redisUrl),
    http: {
      trustedProxies: parseTrustedProxies(raw.TRUSTED_PROXIES),
      metricsTokenFile: raw.METRICS_TOKEN_FILE ? resolve(raw.METRICS_TOKEN_FILE) : undefined,
    },
  };
}

/** REDIS_*, WORKER_*, PORTAL_LIMIT_FALLBACK_RPS через readOpsSettings (S8); ошибка → CONFIG_INVALID. */
function parseOps(raw: RawEnv, redisUrl: string): OpsSettings {
  try {
    return readOpsSettings({
      REDIS_URL: redisUrl,
      REDIS_NAMESPACE: raw.REDIS_NAMESPACE,
      REDIS_COMMAND_TIMEOUT_MS: raw.REDIS_COMMAND_TIMEOUT_MS,
      WORKER_LEASE_TTL_MS: raw.WORKER_LEASE_TTL_MS,
      WORKER_RENEW_INTERVAL_MS: raw.WORKER_RENEW_INTERVAL_MS,
      WORKER_SHUTDOWN_GRACE_MS: raw.WORKER_SHUTDOWN_GRACE_MS,
      WORKER_TASKS: raw.WORKER_TASKS,
      WORKER_TASK_INTERVALS: raw.WORKER_TASK_INTERVALS,
      PORTAL_LIMIT_FALLBACK_RPS: raw.PORTAL_LIMIT_FALLBACK_RPS,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'неверное значение';
    const field = /^([A-Z][A-Z_]+)\b/.exec(message)?.[1] ?? 'WORKER_TASKS';
    throw configError(field, message.replace(/^[A-Z][A-Z_]+:?\s*/, ''));
  }
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
  const saas = parsed.data.DEPLOYMENT_MODE === 'saas';
  // SaaS-ТЗ §15: в saas режим записи задают тариф и арендатор, READ_ONLY_MODE — аварийный выключатель
  // (по умолчанию false); модули — тариф и администратор арендатора (по умолчанию включены все).
  const raw: RawEnv = saas
    ? {
        ...parsed.data,
        READ_ONLY_MODE: merged['READ_ONLY_MODE'] === undefined ? false : parsed.data.READ_ONLY_MODE,
        ENABLED_MODULES: parsed.data.ENABLED_MODULES.length ? parsed.data.ENABLED_MODULES : [...ALL_MODULES],
      }
    : parsed.data;

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
  // saas: каждый запрос /mcp проверяется собственным сервером авторизации (SaaS-ТЗ D5), внешний AS не используется.
  if (saas && raw.MCP_AUTH_MODE === 'oauth') {
    throw configError(
      'MCP_AUTH_MODE',
      'в saas сервис сам является сервером авторизации MCP; MCP_AUTH_MODE/MCP_AUTH_* не задаются',
    );
  }
  if (
    !saas &&
    raw.MCP_TRANSPORT === 'http' &&
    !isLoopbackHost(raw.MCP_HOST) &&
    raw.MCP_AUTH_MODE === 'local'
  ) {
    throw configError(
      'MCP_HOST',
      'внешний интерфейс запрещён при MCP_AUTH_MODE=local; допустим только loopback',
    );
  }
  // Удалённый профиль (ТЗ §4.2, §8.1, §13 п.4): OAuth-защита самого MCP, не Bitrix OAuth.
  let mcpAuth: McpAuthSettings | undefined;
  if (raw.MCP_AUTH_MODE === 'oauth') {
    if (raw.MCP_TRANSPORT !== 'http') {
      throw configError(
        'MCP_AUTH_MODE',
        'oauth применим только к MCP_TRANSPORT=http; для stdio используйте local',
      );
    }
    const publicUrl = parseServiceUrl(
      'MCP_PUBLIC_URL',
      raw.MCP_PUBLIC_URL,
      'обязателен при MCP_AUTH_MODE=oauth: канонический адрес сервера, например https://mcp.example.com/mcp',
    );
    const issuer = parseServiceUrl(
      'MCP_AUTH_ISSUER',
      raw.MCP_AUTH_ISSUER,
      'обязателен при MCP_AUTH_MODE=oauth',
    );
    const jwks = parseServiceUrl(
      'MCP_AUTH_JWKS_URI',
      raw.MCP_AUTH_JWKS_URI,
      'обязателен при MCP_AUTH_MODE=oauth',
    );
    if (raw.MCP_AUTH_ALLOWED_SUBJECTS.length === 0) {
      throw configError(
        'MCP_AUTH_ALLOWED_SUBJECTS',
        'при MCP_AUTH_MODE=oauth allowlist субъектов обязателен: пустой список = никто не допущен',
      );
    }
    const resource = canonicalResource(publicUrl);
    mcpAuth = {
      issuer: raw.MCP_AUTH_ISSUER ?? issuer.href,
      audience: raw.MCP_AUTH_AUDIENCE ?? resource,
      jwksUri: jwks.href,
      allowedSubjects: raw.MCP_AUTH_ALLOWED_SUBJECTS,
      resource,
      metadataUrl: protectedResourceMetadataUrl(publicUrl),
      publicOrigin: publicUrl.origin,
    };
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
  if (raw.UPLOAD_SCANNER_URL) parseScannerUrl(raw.UPLOAD_SCANNER_URL);
  if (saas && raw.ADMIN_PANEL_ENABLED) {
    throw configError(
      'ADMIN_PANEL_ENABLED',
      'в saas панель /admin не используется: подтверждения — в кабинете /app',
    );
  }
  if (raw.ADMIN_PANEL_ENABLED && raw.MCP_TRANSPORT !== 'http') {
    throw configError('ADMIN_PANEL_ENABLED', 'панель /admin работает только при MCP_TRANSPORT=http');
  }
  if (raw.UPLOAD_SCAN_REQUIRED && !raw.UPLOAD_SCANNER_URL) {
    throw configError('UPLOAD_SCANNER_URL', 'обязателен при UPLOAD_SCAN_REQUIRED=true');
  }
  if (raw.DOWNLOAD_DIR && saas) {
    throw configError('DOWNLOAD_DIR', 'скачивание на диск сервера — только DEPLOYMENT_MODE=single');
  }
  if (raw.ALLOW_REMOTE_FILE_URLS) {
    throw configError('ALLOW_REMOTE_FILE_URLS', 'загрузка по произвольным URL запрещена ТЗ §8.5');
  }

  const deployment = parseDeployment(raw, resolve);

  const databasePath = raw.DATABASE_URL.startsWith('file:')
    ? resolve(raw.DATABASE_URL.slice('file:'.length))
    : resolve(raw.DATABASE_URL);

  const bitrixAllowedHosts = new Set<string>();
  if (portalOrigin) bitrixAllowedHosts.add(new URL(portalOrigin).host);
  for (const h of raw.BITRIX_ALLOWED_HOSTS) bitrixAllowedHosts.add(h.toLowerCase());

  return {
    raw,
    deployment,
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
      // В oauth-режиме Host по умолчанию ограничен хостом публичного адреса (ТЗ §8.6).
      allowedHosts:
        raw.MCP_ALLOWED_HOSTS.length === 0 && mcpAuth
          ? [new URL(mcpAuth.publicOrigin).hostname]
          : raw.MCP_ALLOWED_HOSTS,
      allowedOrigins: raw.MCP_ALLOWED_ORIGINS,
      auth: mcpAuth,
      inboundReadPerMinute: raw.MCP_INBOUND_READ_PER_MINUTE,
      adminPanelEnabled: raw.ADMIN_PANEL_ENABLED,
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
      downloadDir: raw.DOWNLOAD_DIR ? resolve(raw.DOWNLOAD_DIR) : undefined,
      maxDownloadBytes: raw.MAX_DOWNLOAD_BYTES,
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
    deploymentMode: config.deployment.mode,
    ...(config.deployment.mode === 'saas'
      ? { publicBaseUrl: config.deployment.publicBaseUrl, processRole: config.deployment.processRole }
      : {}),
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
    // В saas путь не печатается: DATABASE_URL — адрес PostgreSQL с паролем.
    ...(config.deployment.mode === 'single' ? { databasePath: config.storage.databasePath } : {}),
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

/**
 * Единый Bitrix API client (ТЗ §14): таймауты, лимитер, безопасные повторы, allowlist host,
 * ограничение объёма ответа, внедрение авторизации. Бизнес-логики инструментов здесь нет.
 * Это ЕДИНСТВЕННОЕ место в проекте, где выполняется сетевой вызов (ТЗ §15.1 п.7).
 */
import { randomUUID } from 'node:crypto';
import type { BitrixAuthProvider } from '../auth/bitrix-auth-provider.js';
import { AppError } from '../errors/app-error.js';
import type { AppLogger } from '../logging/logger.js';
import {
  buildLegacyRequest,
  parseLegacyResponse,
  type JsonObject,
  type JsonValue,
  type PreparedRequest,
} from './legacy-adapter.js';
import type { ApiVersion, MethodDescriptor } from './method-registry.js';
import { findMethod } from './method-registry.js';
import type { PortalLimiter } from './rate-limiter.js';
import {
  computeDelayMs,
  DEFAULT_RETRY,
  isRetryableReadError,
  parseRetryAfter,
  type RetryPolicy,
} from './retry.js';
import { buildV3Request, parseV3Response } from './v3-adapter.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  readonly requestId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Общий бюджет времени инструмента; повторы не выходят за него. */
  readonly budgetMs?: number | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Для upload — больший таймаут одной попытки. */
  readonly timeoutMs?: number | undefined;
}

export interface CallResult {
  readonly result: JsonValue;
  /** legacy: смещение следующей страницы (фактический `next`). */
  readonly next: number | undefined;
  /** legacy: total, только если API его вернул. */
  readonly total: number | undefined;
  /** v3: непрозрачный native cursor. */
  readonly nextCursor: string | undefined;
  readonly meta: {
    readonly requestId: string;
    readonly method: string;
    readonly apiVersion: ApiVersion;
    readonly durationMs: number;
    readonly attempts: number;
    readonly httpStatus: number;
  };
}

export interface BitrixClientOptions {
  readonly auth: BitrixAuthProvider;
  readonly fetch: FetchLike;
  readonly limiter: PortalLimiter;
  readonly logger: AppLogger;
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly uploadTimeoutMs: number;
  readonly maxUpstreamResponseBytes: number;
  readonly maxReadRetries: number;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
}

const isMutation = (d: MethodDescriptor): boolean =>
  d.operation !== 'read' && d.operation !== 'admin/diagnostic';

export class BitrixClient {
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: BitrixClientOptions) {
    this.retry = { ...(o.retry ?? DEFAULT_RETRY), maxRetries: o.maxReadRetries };
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get auth(): BitrixAuthProvider {
    return this.o.auth;
  }

  /** Вызов по имени: метод обязан быть в реестре. */
  async call(
    apiVersion: ApiVersion,
    method: string,
    params: JsonObject = {},
    opts: CallOptions = {},
  ): Promise<CallResult> {
    const descriptor = findMethod(apiVersion, method);
    if (!descriptor) {
      throw new AppError('METHOD_NOT_ALLOWED', 'Метод отсутствует в реестре разрешённых методов', {
        method,
        apiVersion,
      });
    }
    return this.callDescriptor(descriptor, params, opts);
  }

  async callDescriptor(
    descriptor: MethodDescriptor,
    params: JsonObject,
    opts: CallOptions = {},
  ): Promise<CallResult> {
    const requestId = opts.requestId ?? randomUUID();
    const startedAt = Date.now();
    const budgetMs = opts.budgetMs ?? (descriptor.operation === 'upload' ? 90_000 : 30_000);
    const deadline = startedAt + budgetMs;
    const mutation = isMutation(descriptor);
    const maxAttempts = mutation ? 1 : this.retry.maxRetries + 1;
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AppError('BITRIX_TIMEOUT', 'Исчерпан бюджет времени инструмента', {
          method: descriptor.method,
          apiVersion: descriptor.apiVersion,
        });
      }
      const perAttempt = Math.min(
        opts.timeoutMs ?? (descriptor.operation === 'upload' ? this.o.uploadTimeoutMs : this.o.timeoutMs),
        remaining,
      );
      try {
        const r = await this.attempt(descriptor, params, opts, requestId, perAttempt, mutation);
        const durationMs = Date.now() - startedAt;
        this.o.logger.info(
          {
            requestId,
            method: descriptor.method,
            apiVersion: descriptor.apiVersion,
            httpStatus: r.httpStatus,
            durationMs,
            attempts: attempt,
          },
          'bitrix call ok',
        );
        return {
          ...r.parsed,
          meta: {
            requestId,
            method: descriptor.method,
            apiVersion: descriptor.apiVersion,
            durationMs,
            attempts: attempt,
            httpStatus: r.httpStatus,
          },
        };
      } catch (e) {
        const err = AppError.from(e);
        this.o.logger.warn(
          {
            requestId,
            method: descriptor.method,
            apiVersion: descriptor.apiVersion,
            code: err.code,
            httpStatus: err.details.httpStatus,
            attempt,
          },
          'bitrix call failed',
        );
        // Один безопасный refresh при явном отказе авторизации (ответ получен → запись не выполнена).
        if (err.code === 'BITRIX_AUTH_FAILED' && !refreshed && err.details.reason !== 'outcome-unknown') {
          refreshed = true;
          if (await this.o.auth.tryRefresh()) continue;
        }
        if (mutation || attempt >= maxAttempts || !isRetryableReadError(err)) throw err;
        const retryAfterMs =
          err.details.httpStatus === 429 || err.details.httpStatus === 503
            ? this.lastRetryAfterMs
            : undefined;
        const delay = computeDelayMs(attempt - 1, this.retry, retryAfterMs);
        if (Date.now() + delay >= deadline) throw err;
        await this.sleep(delay);
      }
    }
  }

  private lastRetryAfterMs: number | undefined;

  private async attempt(
    descriptor: MethodDescriptor,
    params: JsonObject,
    opts: CallOptions,
    requestId: string,
    timeoutMs: number,
    mutation: boolean,
  ): Promise<{ parsed: Omit<CallResult, 'meta'>; httpStatus: number }> {
    const auth = this.o.auth.getAuth(descriptor.apiVersion);
    const req: PreparedRequest =
      descriptor.apiVersion === 'v3'
        ? buildV3Request(auth.baseUrl, descriptor, params, auth.bodyFields, opts.idempotencyKey)
        : buildLegacyRequest(auth.baseUrl, descriptor, params, auth.bodyFields);
    this.assertAllowedHost(req.url);

    const release = await this.o.limiter.acquire(opts.signal);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    try {
      let res: Response;
      try {
        res = await this.o.fetch(req.url, {
          method: req.method,
          headers: { ...req.headers, 'x-request-id': requestId },
          body: req.body,
          signal,
          redirect: 'manual',
        });
      } catch (e) {
        // Ответ потерян. Для мутации исход неизвестен — повтор запрещён (ТЗ §14.2).
        if (mutation) {
          throw new AppError(
            'OPERATION_OUTCOME_UNKNOWN',
            'Ответ Bitrix24 на операцию записи не получен; исход неизвестен',
            {
              method: descriptor.method,
              apiVersion: descriptor.apiVersion,
              reason: 'outcome-unknown',
              nextAction: 'Сверьте объект в Bitrix24 перед повторной попыткой',
            },
          );
        }
        const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError');
        throw new AppError(
          aborted ? 'BITRIX_TIMEOUT' : 'BITRIX_UPSTREAM_ERROR',
          aborted ? 'Таймаут запроса к Bitrix24' : 'Сетевая ошибка при обращении к Bitrix24',
          {
            method: descriptor.method,
            apiVersion: descriptor.apiVersion,
            retryable: true,
            reason: e instanceof Error ? e.name : 'unknown',
          },
        );
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AppError(
          'BITRIX_UPSTREAM_ERROR',
          'Bitrix24 вернул перенаправление; переходы запрещены политикой',
          {
            method: descriptor.method,
            apiVersion: descriptor.apiVersion,
            httpStatus: res.status,
          },
        );
      }
      this.lastRetryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const bodyText = await this.readBodyLimited(res, descriptor, mutation);
      const parsed =
        descriptor.apiVersion === 'v3'
          ? (() => {
              const v = parseV3Response(res.status, bodyText, this.lastRetryAfterMs, descriptor);
              return { result: v.result, next: undefined, total: undefined, nextCursor: v.nextCursor };
            })()
          : (() => {
              const l = parseLegacyResponse(res.status, bodyText, this.lastRetryAfterMs, descriptor);
              return { result: l.result, next: l.next, total: l.total, nextCursor: undefined };
            })();
      return { parsed, httpStatus: res.status };
    } finally {
      release();
    }
  }

  /**
   * Скачивание файла портала (DOWNLOAD_URL из disk.file.get) для извлечения текста на сервере.
   * Адрес содержит авторизацию (у вебхука — его код в пути): он не логируется, не попадает в ошибки и не выходит из
   * сервера. Только https (или протокол портала) и host из BITRIX_ALLOWED_HOSTS, без перенаправлений, с пределом
   * размера и таймаутом загрузок; через общий лимитер портала.
   */
  async downloadFile(
    url: string,
    opts: { maxBytes: number; requestId?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const details = { method: 'disk.file.get', apiVersion: 'legacy' as const };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'Портал вернул некорректный адрес файла', details);
    }
    const portalProtocol = this.o.auth.portalOrigin ? new URL(this.o.auth.portalOrigin).protocol : 'https:';
    if (parsed.protocol !== 'https:' && parsed.protocol !== portalProtocol) {
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'Адрес файла портала не https', details);
    }
    this.assertAllowedHost(url);
    const release = await this.o.limiter.acquire(opts.signal);
    const timeoutSignal = AbortSignal.timeout(this.o.uploadTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    try {
      let res: Response;
      try {
        res = await this.o.fetch(url, {
          method: 'GET',
          headers: { 'x-request-id': opts.requestId ?? randomUUID() },
          signal,
          redirect: 'manual',
        });
      } catch (e) {
        const aborted = signal.aborted || (e instanceof Error && e.name === 'AbortError');
        throw new AppError(
          aborted ? 'BITRIX_TIMEOUT' : 'BITRIX_UPSTREAM_ERROR',
          aborted
            ? 'Таймаут скачивания файла из Bitrix24'
            : 'Сетевая ошибка при скачивании файла из Bitrix24',
          { ...details, retryable: true },
        );
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AppError('BITRIX_UPSTREAM_ERROR', 'Bitrix24 перенаправил скачивание; переходы запрещены', {
          ...details,
          httpStatus: res.status,
        });
      }
      if (res.status !== 200) {
        const code =
          res.status === 401 || res.status === 403
            ? 'BITRIX_ACCESS_DENIED'
            : res.status === 404
              ? 'NOT_FOUND'
              : 'BITRIX_UPSTREAM_ERROR';
        throw new AppError(code, 'Bitrix24 не отдал файл', { ...details, httpStatus: res.status });
      }
      const tooLarge = () =>
        new AppError('FILE_TOO_LARGE', `Файл больше предела ${String(opts.maxBytes)} байт`, {
          ...details,
          nextAction: 'Откройте файл в портале',
        });
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > opts.maxBytes) throw tooLarge();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        for await (const value of res.body as AsyncIterable<Uint8Array>) {
          size += value.byteLength;
          if (size > opts.maxBytes) throw tooLarge();
          chunks.push(value);
        }
      }
      return {
        bytes: new Uint8Array(Buffer.concat(chunks)),
        contentType: res.headers.get('content-type') ?? '',
      };
    } finally {
      release();
    }
  }

  private async readBodyLimited(
    res: Response,
    descriptor: MethodDescriptor,
    mutation: boolean,
  ): Promise<string> {
    const limit = this.o.maxUpstreamResponseBytes;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > limit) throw this.tooLarge(descriptor, mutation);
    if (!res.body) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    // ReadableStream в Node — async-итерируемый; выход из цикла отменяет поток.
    for await (const value of res.body as AsyncIterable<Uint8Array>) {
      size += value.byteLength;
      if (size > limit) throw this.tooLarge(descriptor, mutation);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private tooLarge(descriptor: MethodDescriptor, mutation: boolean): AppError {
    if (mutation) {
      return new AppError(
        'OPERATION_OUTCOME_UNKNOWN',
        'Ответ на операцию записи превысил лимит и не был прочитан',
        {
          method: descriptor.method,
          apiVersion: descriptor.apiVersion,
          reason: 'outcome-unknown',
        },
      );
    }
    return new AppError('BITRIX_UPSTREAM_ERROR', 'Ответ Bitrix24 превышает MAX_UPSTREAM_RESPONSE_BYTES', {
      method: descriptor.method,
      apiVersion: descriptor.apiVersion,
      nextAction: 'Уменьшите объём выборки (pageSize, select)',
    });
  }

  private assertAllowedHost(url: string): void {
    const host = new URL(url).host.toLowerCase();
    if (!this.o.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
      throw new AppError('CONFIG_INVALID', 'Host запроса не входит в BITRIX_ALLOWED_HOSTS', {
        field: 'BITRIX_ALLOWED_HOSTS',
      });
    }
  }
}

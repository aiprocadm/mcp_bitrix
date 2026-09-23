/**
 * Мок Bitrix24 REST: подменяемый fetch с ответами реальной формы
 * ({result,next,total,time} / {error,error_description}, HTTP 200 с ошибкой, 429 с Retry-After и т. д.).
 * Никакой сети. Записывает все вызовы для проверок «до API не дошло».
 */
import type { FetchLike } from '../../src/bitrix/client.js';

export interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Бросить сетевую ошибку вместо ответа (ответ потерян). */
  networkError?: string;
  /** Задержка перед ответом (для таймаутов). */
  delayMs?: number;
}

export type Handler = (call: RecordedCall, index: number) => MockResponse | Promise<MockResponse>;

export const PROFILE_RESULT = {
  ID: '7',
  NAME: 'Иван',
  LAST_NAME: 'Тестов',
  EMAIL: 'ivan.testov@example.com',
  ADMIN: true,
  TIME_ZONE: 'Europe/Moscow',
  PERSONAL_PHONE: '+7 999 123-45-67',
};

export function legacyOk(result: unknown, extra: Record<string, unknown> = {}): MockResponse {
  return {
    status: 200,
    body: {
      result,
      time: { start: 1, finish: 1.12, duration: 0.12, processing: 0.1, date_start: '', date_finish: '' },
      ...extra,
    },
  };
}

export function legacyError(
  error: string,
  status = 200,
  description = 'описание с секретом https://p.bitrix24.invalid/rest/1/supersecretcode/',
): MockResponse {
  return { status, body: { error, error_description: description } };
}

export class MockBitrix {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<string, Handler>();
  private fallback: Handler = () => ({
    status: 404,
    body: { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' },
  });

  /** Маршрут по имени метода (legacy `profile` → `/profile.json`, v3 `rest.scope.list` → `/rest.scope.list`). */
  on(method: string, handler: Handler | MockResponse): this {
    this.routes.set(method, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  onSequence(method: string, responses: MockResponse[]): this {
    let i = 0;
    return this.on(method, () => responses[Math.min(i++, responses.length - 1)] ?? { status: 500, body: {} });
  }

  setFallback(handler: Handler): this {
    this.fallback = handler;
    return this;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => methodFromUrl(c.url) === method);
  }

  get fetch(): FetchLike {
    return async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
        headers[k.toLowerCase()] = v;
      const call: RecordedCall = {
        url,
        method: init.method ?? 'GET',
        body:
          typeof init.body === 'string' && init.body
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {},
        headers,
      };
      const index = this.calls.length;
      this.calls.push(call);
      const method = methodFromUrl(url);
      const handler = this.routes.get(method) ?? this.fallback;
      const resp = await handler(call, index);
      if (resp.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, resp.delayMs);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      if (resp.networkError) {
        const e = new Error(resp.networkError);
        e.name = 'TypeError';
        throw e;
      }
      const text = resp.text ?? JSON.stringify(resp.body ?? {});
      return new Response(text, {
        status: resp.status ?? 200,
        headers: { 'content-type': 'application/json', ...(resp.headers ?? {}) },
      });
    };
  }
}

export function methodFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  return last.endsWith('.json') ? last.slice(0, -5) : last;
}

/** Генерирует N сделок с ID 1..N для пагинации. */
export function deals(from: number, count: number): { ID: string; TITLE: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    ID: String(from + i),
    TITLE: `[MCP TEST] Сделка ${from + i}`,
  }));
}

/** Legacy-список: страница 50 с next, как отдаёт crm.deal.list. */
export function legacyListPage(all: unknown[], start: number, pageSize = 50): MockResponse {
  const items = all.slice(start, start + pageSize);
  const next = start + pageSize < all.length ? start + pageSize : undefined;
  return legacyOk(items, { total: all.length, ...(next !== undefined ? { next } : {}) });
}

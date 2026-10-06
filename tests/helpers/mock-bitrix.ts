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

/** Схема полей сделки в форме crm.deal.fields (усечённая, но реальной структуры). */
export const DEAL_FIELDS = {
  ID: {
    type: 'integer',
    isRequired: false,
    isReadOnly: true,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'ID',
  },
  TITLE: {
    type: 'string',
    isRequired: true,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Название',
  },
  STAGE_ID: {
    type: 'crm_status',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    statusType: 'DEAL_STAGE',
    title: 'Стадия',
  },
  CATEGORY_ID: {
    type: 'crm_category',
    isRequired: false,
    isReadOnly: false,
    isImmutable: true,
    isMultiple: false,
    isDynamic: false,
    title: 'Воронка',
  },
  ASSIGNED_BY_ID: {
    type: 'user',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Ответственный',
  },
  OPPORTUNITY: {
    type: 'double',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Сумма',
  },
  CURRENCY_ID: {
    type: 'crm_currency',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Валюта',
  },
  BEGINDATE: {
    type: 'date',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Дата начала',
  },
  COMMENTS: {
    type: 'string',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Комментарий',
  },
  CLOSED: {
    type: 'char',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Закрыта',
  },
  DATE_CREATE: {
    type: 'datetime',
    isRequired: false,
    isReadOnly: true,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Дата создания',
  },
  DATE_MODIFY: {
    type: 'datetime',
    isRequired: false,
    isReadOnly: true,
    isImmutable: false,
    isMultiple: false,
    isDynamic: false,
    title: 'Дата изменения',
  },
  CONTACT_IDS: {
    type: 'crm_contact',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: true,
    isDynamic: false,
    title: 'Контакты',
  },
  UF_CRM_PRIORITY: {
    type: 'enumeration',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: true,
    title: 'Приоритет',
    items: [
      { ID: '11', VALUE: 'Низкий' },
      { ID: '12', VALUE: 'Высокий' },
    ],
  },
  UF_CRM_PASSPORT: {
    type: 'string',
    isRequired: false,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: true,
    title: 'Паспорт',
  },
};

/** Как у портала с обязательным пользовательским полем (T31). */
export const DEAL_FIELDS_WITH_REQUIRED_UF = {
  ...DEAL_FIELDS,
  UF_CRM_SOURCE_DOC: {
    type: 'string',
    isRequired: true,
    isReadOnly: false,
    isImmutable: false,
    isMultiple: false,
    isDynamic: true,
    title: 'Документ-основание',
  },
};

export function dealRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: String(id),
    TITLE: `[MCP TEST] Сделка ${id}`,
    STAGE_ID: 'NEW',
    CATEGORY_ID: '0',
    ASSIGNED_BY_ID: '7',
    OPPORTUNITY: '1000.00',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-09-23T10:00:00+03:00',
    DATE_MODIFY: '2026-09-23T10:00:00+03:00',
    UF_CRM_PASSPORT: '4500 123456',
    ...overrides,
  };
}

/** tasks.task.getfields: {fields:{NAME:{title,type,primary?,required?}}} — усечённая реальная форма. */
export const TASK_FIELDS = {
  fields: {
    ID: { title: 'ID', type: 'integer', primary: true },
    PARENT_ID: { title: 'Родительская задача', type: 'integer' },
    TITLE: { title: 'Название', type: 'string', required: true },
    DESCRIPTION: { title: 'Описание', type: 'string' },
    RESPONSIBLE_ID: { title: 'Исполнитель', type: 'integer', required: true },
    // как на живом портале (2026-10-05): getfields помечает постановщика обязательным, хотя add его не требует
    CREATED_BY: { title: 'Постановщик', type: 'integer', required: true },
    ACCOMPLICES: { title: 'Соисполнители', type: 'integer' },
    AUDITORS: { title: 'Наблюдатели', type: 'integer' },
    DEADLINE: { title: 'Крайний срок', type: 'datetime' },
    GROUP_ID: { title: 'Группа', type: 'integer' },
    STATUS: {
      title: 'Статус',
      type: 'enum',
      values: {
        '2': 'Ждёт выполнения',
        '3': 'Выполняется',
        '4': 'Ждёт контроля',
        '5': 'Завершена',
        '6': 'Отложена',
      },
    },
    PRIORITY: { title: 'Приоритет', type: 'enum', values: { '0': 'Низкий', '1': 'Средний', '2': 'Высокий' } },
    CREATED_DATE: { title: 'Дата создания', type: 'datetime' },
    CHANGED_DATE: { title: 'Дата изменения', type: 'datetime' },
    ALLOW_CHANGE_DEADLINE: { title: 'Можно менять срок', type: 'boolean' },
    UF_CRM_TASK: { title: 'CRM', type: 'string' },
    UF_TASK_COST: { title: 'Стоимость', type: 'double' },
  },
};

/** Ответ tasks.task.get/list — camelCase. */
export function taskRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(id),
    parentId: null,
    title: `[MCP TEST] Задача ${id}`,
    description: '',
    status: '2',
    priority: '1',
    responsibleId: '7',
    createdBy: '7',
    deadline: '2026-10-01T18:00:00+03:00',
    groupId: '0',
    createdDate: '2026-09-23T10:00:00+03:00',
    ...overrides,
  };
}

export function tasks(from: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => taskRecord(from + i));
}

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

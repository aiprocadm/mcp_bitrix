/**
 * Страница legacy-списка со смещением (start/START по 50 записей) и необязательным локальным фильтром.
 * Используется там, где shared.legacyListPage не подходит: имя параметра смещения отличается (department.get: START),
 * или часть условия нельзя передать в Bitrix (не документировано как фильтруемое) и она проверяется локально.
 * Состояние курсора {start, skip} хранится на сервере (statefulPage): upstream-страница перечитывается,
 * а уже выданные элементы пропускаются — без буфера данных в курсоре.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import type { PageResult } from '../../bitrix/pagination.js';
import { statefulPage, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';

interface OffsetState {
  start: number;
  skip: number;
}

export interface OffsetPageResult extends PageResult {
  /** Бюджет upstream-вызовов исчерпан до заполнения страницы (локальный фильтр отсеял много записей). */
  budgetExhausted: boolean;
  /** total из ответа Bitrix (до локального фильтра), если есть. */
  total: number | undefined;
}

export async function offsetPage(
  ctx: ToolContext,
  opts: {
    tool: string;
    method: string;
    params: JsonObject;
    bindingParts: Record<string, unknown>;
    pageSize: number;
    cursor: string | undefined;
    /** Имя параметра смещения по документации метода (обычно `start`). */
    startKey?: string;
    extract?: (result: JsonValue) => JsonValue[] | undefined;
    keep?: (item: JsonValue) => boolean;
    maxUpstreamCalls?: number;
  },
): Promise<OffsetPageResult> {
  const startKey = opts.startKey ?? 'start';
  const maxCalls = opts.maxUpstreamCalls ?? (opts.keep ? 4 : 2);
  let budgetExhausted = false;
  let total: number | undefined;
  let upstreamCalls = 0;
  const page = await statefulPage<OffsetState>(ctx, {
    tool: opts.tool,
    bindingParts: { ...opts.bindingParts, pageSize: opts.pageSize },
    cursor: opts.cursor,
    initial: { start: 0, skip: 0 },
    fetch: async (state) => {
      const out: JsonValue[] = [];
      let { start, skip } = state;
      while (upstreamCalls < maxCalls) {
        const r = await ctx.bitrix.call(
          'legacy',
          opts.method,
          { ...opts.params, [startKey]: start },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        upstreamCalls++;
        if (r.total !== undefined) total = r.total;
        const raw = opts.extract ? opts.extract(r.result) : Array.isArray(r.result) ? r.result : undefined;
        if (!Array.isArray(raw)) throw upstreamShapeError(opts.method, 'legacy');
        const kept = opts.keep ? raw.filter(opts.keep) : raw;
        const available = kept.slice(skip);
        const need = opts.pageSize - out.length;
        out.push(...available.slice(0, need));
        if (available.length > need) return { items: out, next: { start, skip: skip + need } };
        if (r.next === undefined || r.next <= start) return { items: out, next: undefined };
        start = r.next;
        skip = 0;
        if (out.length >= opts.pageSize) return { items: out, next: { start, skip } };
      }
      budgetExhausted = true;
      return { items: out, next: { start, skip } };
    },
  });
  return { ...page, upstreamCalls, budgetExhausted, total };
}

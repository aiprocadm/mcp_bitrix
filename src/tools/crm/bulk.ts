/**
 * Обход всей выборки классической сущности CRM на сервере (заявка 2026-10-13, п. 1–2): выгрузка, подсчёты,
 * «записи без связей». Записи читаются по возрастанию ID пачками по 50 с условием `>ID` и `start=-1`
 * (рекомендованный Bitrix24 способ выгрузки больших объёмов: без подсчёта total на каждой странице),
 * поэтому продолжение после паузы — просто «ID больше последнего», без смещения, которое сбивается от новых записей.
 *
 * Условие «не содержит» (`!%ПОЛЕ`) проверяется на сервере MCP, а не порталом: на живом портале фильтр
 * `!%TITLE` у компаний вернул совпадения вместо исключения. Поле добавляется в select, сравнение — без учёта регистра.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { asText, idOf, isObj, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';
import type { CrmRecord } from './crm-service.js';
import type { ClassicEntity } from './entities.js';

export const UPSTREAM_PAGE = 50;

export interface LocalCondition {
  readonly field: string;
  readonly needles: readonly string[];
}

/** Отделяет условия «не содержит» (`!%ПОЛЕ`) от фильтра для портала. */
export function splitNotContains(filter: JsonObject): { upstream: JsonObject; local: LocalCondition[] } {
  const upstream: JsonObject = {};
  const local: LocalCondition[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('!%')) {
      const values = Array.isArray(value) ? value : [value];
      const needles = values.map((v) => asText(v).toLocaleLowerCase('ru')).filter((s) => s !== '');
      if (needles.length) local.push({ field: key.slice(2), needles });
      continue;
    }
    upstream[key] = value;
  }
  return { upstream, local };
}

const textOf = (v: JsonValue | undefined): string => {
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? asText(x['VALUE']) : asText(x))).join(' ');
  if (isObj(v)) return asText(v['VALUE']);
  return asText(v);
};

export function passesLocal(row: Record<string, JsonValue>, local: readonly LocalCondition[]): boolean {
  for (const c of local) {
    const text = textOf(row[c.field]).toLocaleLowerCase('ru');
    if (c.needles.some((n) => text.includes(n))) return false;
  }
  return true;
}

/** Нижняя граница ID из пользовательского фильтра (>ID, >=ID) — объединяется с границей обхода. */
function lowerBound(filter: JsonObject): { rest: JsonObject; after: number } {
  const rest: JsonObject = {};
  let after = 0;
  for (const [k, v] of Object.entries(filter)) {
    const n = Number(asText(v));
    if (k === '>ID' && Number.isFinite(n)) after = Math.max(after, Math.floor(n));
    else if (k === '>=ID' && Number.isFinite(n)) after = Math.max(after, Math.ceil(n) - 1);
    else rest[k] = v;
  }
  return { rest, after };
}

export interface ScanBatch {
  rows: CrmRecord[];
  /** Последний прочитанный ID (до локального фильтра) — продолжение обхода. */
  lastId: number;
  done: boolean;
}

/**
 * Одна пачка до 50 записей с ID больше afterId (по возрастанию ID).
 * `filter` — уже проверенный фильтр портала (без `!%`), `local` — условия, проверяемые здесь.
 */
export async function scanBatch(
  ctx: ToolContext,
  entity: ClassicEntity,
  opts: { filter: JsonObject; local?: readonly LocalCondition[]; select: readonly string[]; afterId: number },
): Promise<ScanBatch> {
  const method = `${entity.methodBase}.list`;
  const { rest, after } = lowerBound(opts.filter);
  const select = [...new Set(['ID', ...opts.select, ...(opts.local ?? []).map((c) => c.field)])];
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    {
      filter: { ...rest, '>ID': Math.max(after, opts.afterId) },
      order: { ID: 'ASC' },
      select,
      start: -1,
    },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError(method, 'legacy');
  const all = r.result.filter(isObj);
  let lastId = opts.afterId;
  for (const row of all) {
    const id = idOf(row['ID']);
    if (id !== undefined && id > lastId) lastId = id;
  }
  if (all.length > 0 && lastId === opts.afterId) {
    // Портал проигнорировал условие >ID — обход зациклился бы.
    throw new AppError('BITRIX_UPSTREAM_ERROR', `${method}: портал не применил условие по ID при обходе`, {
      method,
      apiVersion: 'legacy',
    });
  }
  const rows = opts.local?.length ? all.filter((row) => passesLocal(row, opts.local ?? [])) : all;
  return { rows, lastId, done: all.length < UPSTREAM_PAGE };
}

/** Состояние длинного обхода между вызовами (хранится в серверном курсоре, зашифрованным). */
export interface ScanProgress {
  afterId: number;
  scanned: number;
}

/** Предел времени одного вызова: оставляем запас на запись файла и ответ. */
export function deadlineOf(ctx: ToolContext, maxSeconds: number): number {
  return ctx.startedAt + maxSeconds * 1000;
}

/**
 * Чек-листы задачи — старый API task.checklistitem.* (scope task).
 * ВАЖНО: параметры этих методов позиционные (Param #0 taskId, #1 itemId/arOrder, #2 arFields):
 * порядок ключей тела запроса строго TASKID → ITEMID → FIELDS (или TASKID → ORDER). При нарушении
 * complete/renew «молча» вернут false, update — ошибку. Тела собираются только функциями ниже.
 * complete/renew/update не проверяют принадлежность пункта задаче — это делает сервер по getlist.
 * Источник: https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/index.html
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, isObj, num, upstreamShapeError, yn } from '../shared.js';
import type { ToolContext } from '../types.js';

export interface ChecklistItem {
  id: number;
  taskId: number;
  parentId: number;
  title: string;
  sortIndex: number;
  isComplete: boolean;
  isImportant: boolean;
  toggledBy: string | null;
  toggledDate: string | null;
  members: { id: string; type: string }[];
  attachmentsCount: number;
}

/** Тела запросов в документированном порядке параметров (fixture-тесты проверяют порядок ключей). */
export const checklistParams = {
  getlist: (taskId: number): JsonObject => ({ TASKID: taskId, ORDER: { SORT_INDEX: 'asc' } }),
  add: (taskId: number, fields: JsonObject): JsonObject => ({ TASKID: taskId, FIELDS: fields }),
  update: (taskId: number, itemId: number, fields: JsonObject): JsonObject => ({
    TASKID: taskId,
    ITEMID: itemId,
    FIELDS: fields,
  }),
  item: (taskId: number, itemId: number): JsonObject => ({ TASKID: taskId, ITEMID: itemId }),
};

function toItem(raw: Record<string, JsonValue>): ChecklistItem | undefined {
  const id = num(raw['ID']);
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const members = Array.isArray(raw['MEMBERS'])
    ? raw['MEMBERS'].filter(isObj).map((m) => ({ id: asText(m['ID']), type: asText(m['TYPE']) }))
    : [];
  const att = raw['ATTACHMENTS'];
  return {
    id,
    taskId: num(raw['TASK_ID']) ?? 0,
    parentId: num(raw['PARENT_ID']) ?? 0,
    title: asText(raw['TITLE']),
    sortIndex: num(raw['SORT_INDEX']) ?? 0,
    isComplete: yn(raw['IS_COMPLETE']),
    isImportant: yn(raw['IS_IMPORTANT']),
    toggledBy:
      raw['TOGGLED_BY'] === null || raw['TOGGLED_BY'] === undefined ? null : asText(raw['TOGGLED_BY']),
    toggledDate: asText(raw['TOGGLED_DATE']) || null,
    members,
    attachmentsCount: Array.isArray(att) ? att.length : isObj(att) ? Object.keys(att).length : 0,
  };
}

export async function listChecklist(ctx: ToolContext, taskId: number): Promise<ChecklistItem[]> {
  const r = await ctx.bitrix.call('legacy', 'task.checklistitem.getlist', checklistParams.getlist(taskId), {
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  if (!Array.isArray(r.result)) throw upstreamShapeError('task.checklistitem.getlist', 'legacy');
  return r.result.filter(isObj).flatMap((x) => {
    const item = toItem(x);
    return item ? [item] : [];
  });
}

export interface TreeItem extends ChecklistItem {
  depth: number;
  childrenCount: number;
}

/** Дерево в порядке обхода: корни (PARENT_ID=0) и дети по SORT_INDEX, затем ID. Сироты — в конец как корни. */
export function flattenTree(items: readonly ChecklistItem[]): { items: TreeItem[]; orphans: number } {
  const byParent = new Map<number, ChecklistItem[]>();
  const ids = new Set(items.map((i) => i.id));
  for (const i of items) {
    const p = i.parentId && ids.has(i.parentId) ? i.parentId : 0;
    byParent.set(p, [...(byParent.get(p) ?? []), i]);
  }
  const orphans = items.filter((i) => i.parentId !== 0 && !ids.has(i.parentId)).length;
  const sorted = (xs: ChecklistItem[]) => [...xs].sort((a, b) => a.sortIndex - b.sortIndex || a.id - b.id);
  const out: TreeItem[] = [];
  const seen = new Set<number>();
  const walk = (parent: number, depth: number) => {
    for (const i of sorted(byParent.get(parent) ?? [])) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push({ ...i, depth, childrenCount: (byParent.get(i.id) ?? []).length });
      if (depth < 10) walk(i.id, depth + 1);
    }
  };
  walk(0, 0);
  return { items: out, orphans };
}

/** Пункт, принадлежащий задаче (по данным getlist); иначе NOT_FOUND без записи. */
export function findItem(items: readonly ChecklistItem[], taskId: number, itemId: number): ChecklistItem {
  const item = items.find((i) => i.id === itemId);
  if (!item || (item.taskId && item.taskId !== taskId)) {
    throw new AppError('NOT_FOUND', 'Пункт чек-листа не найден в этой задаче или недоступен', {
      method: 'task.checklistitem.getlist',
      apiVersion: 'legacy',
      field: 'itemId',
    });
  }
  return item;
}

/** Все потомки пункта (для impact удаления). */
export function descendants(items: readonly ChecklistItem[], itemId: number): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const queue = [itemId];
  const seen = new Set<number>([itemId]);
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const i of items) {
      if (i.parentId === p && !seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
        queue.push(i.id);
      }
    }
  }
  return out;
}

export function checklistItemHash(item: ChecklistItem): string {
  return stateHash({
    id: item.id,
    parentId: item.parentId,
    title: item.title,
    sortIndex: item.sortIndex,
    isComplete: item.isComplete,
    isImportant: item.isImportant,
  });
}

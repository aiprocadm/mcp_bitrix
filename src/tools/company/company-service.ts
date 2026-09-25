/**
 * Оргструктура и сотрудники (ТЗ §9.2): чтение отделов department.get, минимальные карточки сотрудников
 * user.get/user.search, хеш состояния отдела, проверка иерархии (цикл) обходом предков через department.get.
 * Персональные данные минимальны (§8.4): только ID, ФИО, должность, отделы, активность, тип — select явный.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, num, upstreamShapeError, yn } from '../shared.js';
import type { ToolContext } from '../types.js';

// ---------- отделы ----------

export interface Department {
  id: number;
  name: string;
  sort: number | null;
  parentId: number | null;
  /** UF_HEAD: в таблице полей department.get не описан, но документирован как фильтр/сортировка; null — нет в ответе. */
  headId: number | null;
}

export function normalizeDepartment(raw: JsonValue): Department | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  const sort = num(raw['SORT']);
  return {
    id,
    name: asText(raw['NAME']),
    sort: sort ?? null,
    parentId: idOf(raw['PARENT']) ?? null,
    headId: idOf(raw['UF_HEAD']) ?? null,
  };
}

/** Хеш состояния отдела для expectedStateHash (все поля department.*: NAME, SORT, PARENT, UF_HEAD). */
export function departmentStateHash(d: Department): string {
  return stateHash({ id: d.id, name: d.name, sort: d.sort, parentId: d.parentId, headId: d.headId });
}

const call = (ctx: ToolContext, method: string, params: JsonObject) =>
  ctx.bitrix.call('legacy', method, params, { requestId: ctx.requestId, signal: ctx.signal });

/** Одна страница department.get с фильтром (START — имя параметра по документации). */
export async function departmentsWhere(
  ctx: ToolContext,
  filter: JsonObject,
  start = 0,
): Promise<{ items: Department[]; next: number | undefined; total: number | undefined }> {
  const r = await call(ctx, 'department.get', { ...filter, START: start });
  if (!Array.isArray(r.result)) throw upstreamShapeError('department.get', 'legacy');
  const items = r.result.map(normalizeDepartment).filter((d): d is Department => d !== undefined);
  return { items, next: r.next, total: r.total };
}

export async function findDepartment(ctx: ToolContext, id: number): Promise<Department | undefined> {
  const { items } = await departmentsWhere(ctx, { ID: id });
  return items.find((d) => d.id === id);
}

export function departmentNotFound(id: number): AppError {
  return new AppError('NOT_FOUND', `Отдел #${String(id)} не найден или недоступен`, {
    method: 'department.get',
    apiVersion: 'legacy',
    nextAction: 'Проверьте ID через company_departments_list',
  });
}

export async function getDepartment(ctx: ToolContext, id: number): Promise<Department> {
  const d = await findDepartment(ctx, id);
  if (!d) throw departmentNotFound(id);
  return d;
}

/** Все отделы (для корня и названий), не более maxPages upstream-страниц по 50. */
export async function listAllDepartments(
  ctx: ToolContext,
  maxPages = 6,
): Promise<{ items: Department[]; complete: boolean }> {
  const items: Department[] = [];
  let start: number | undefined = 0;
  for (let i = 0; i < maxPages && start !== undefined; i++) {
    const page = await departmentsWhere(ctx, {}, start);
    items.push(...page.items);
    start = page.next !== undefined && page.next > start ? page.next : undefined;
  }
  return { items, complete: start === undefined };
}

/** Предел глубины обхода предков: глубже — отказ, а не догадка. */
export const MAX_HIERARCHY_DEPTH = 50;

/**
 * HIERARCHY_CYCLE (§9.2): новый родитель не может быть самим отделом или его потомком.
 * Обход вверх от нового родителя по PARENT через department.get: встретили id → цикл.
 * Возвращает цепочку предков нового родителя (для плана).
 */
export async function assertNoCycle(ctx: ToolContext, id: number, newParentId: number): Promise<number[]> {
  const cycle = () =>
    new AppError(
      'VALIDATION_ERROR',
      'Новый родитель — сам отдел или его подотдел: образуется цикл иерархии',
      {
        field: 'patch.parentId',
        reason: 'HIERARCHY_CYCLE',
        nextAction: 'Выберите родителя вне поддерева этого отдела (company_departments_list)',
      },
    );
  if (newParentId === id) throw cycle();
  const chain: number[] = [];
  let cur: number | null = newParentId;
  const seen = new Set<number>();
  while (cur !== null) {
    if (cur === id) throw cycle();
    if (seen.has(cur)) {
      throw new AppError('VALIDATION_ERROR', 'В текущей структуре портала уже есть цикл; перенос отклонён', {
        field: 'patch.parentId',
        reason: 'HIERARCHY_CYCLE',
      });
    }
    if (chain.length >= MAX_HIERARCHY_DEPTH) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Глубина структуры больше ${String(MAX_HIERARCHY_DEPTH)}: отсутствие цикла не доказано, перенос отклонён`,
        { field: 'patch.parentId', reason: 'HIERARCHY_CHECK_INCOMPLETE' },
      );
    }
    seen.add(cur);
    chain.push(cur);
    const d = await findDepartment(ctx, cur);
    if (!d) {
      if (cur === newParentId) throw invalidParent(newParentId, 'patch.parentId');
      throw new AppError('VALIDATION_ERROR', 'Цепочка родителей обрывается на недоступном отделе', {
        field: 'patch.parentId',
        reason: 'HIERARCHY_CHECK_INCOMPLETE',
      });
    }
    cur = d.parentId;
  }
  return chain;
}

export function invalidParent(parentId: number, field: string): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    `Родительский отдел #${String(parentId)} не найден или недоступен`,
    {
      field,
      reason: 'INVALID_PARENT',
      nextAction: 'Выберите существующий отдел через company_departments_list',
    },
  );
}

// ---------- сотрудники ----------

/** Поля сотрудника, которые вообще запрашиваются: без email, телефонов, дат рождения, фото. */
export const EMPLOYEE_SELECT = [
  'ID',
  'ACTIVE',
  'NAME',
  'LAST_NAME',
  'SECOND_NAME',
  'WORK_POSITION',
  'UF_DEPARTMENT',
  'USER_TYPE',
] as const;

export interface Employee {
  id: number;
  fullName: string;
  firstName: string;
  lastName: string;
  secondName: string;
  position: string;
  departmentIds: number[];
  active: boolean;
  userType: string;
}

export function normalizeEmployee(raw: JsonValue): Employee | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  const firstName = asText(raw['NAME']).trim();
  const lastName = asText(raw['LAST_NAME']).trim();
  const secondName = asText(raw['SECOND_NAME']).trim();
  const depRaw = raw['UF_DEPARTMENT'];
  const deps = (Array.isArray(depRaw) ? depRaw : depRaw === undefined || depRaw === null ? [] : [depRaw])
    .map(idOf)
    .filter((n): n is number => n !== undefined);
  return {
    id,
    fullName: [lastName, firstName, secondName].filter(Boolean).join(' ') || `Пользователь #${String(id)}`,
    firstName,
    lastName,
    secondName,
    position: asText(raw['WORK_POSITION']).trim(),
    departmentIds: [...new Set(deps)].sort((a, b) => a - b),
    active: yn(raw['ACTIVE']),
    userType: asText(raw['USER_TYPE']) || 'employee',
  };
}

/** Сотрудник по ID через user.get (минимальный select); undefined — нет или скрыт. */
export async function findEmployee(ctx: ToolContext, id: number): Promise<Employee | undefined> {
  const r = await call(ctx, 'user.get', { FILTER: { ID: id }, select: [...EMPLOYEE_SELECT] });
  if (!Array.isArray(r.result)) throw upstreamShapeError('user.get', 'legacy');
  return r.result.map(normalizeEmployee).find((e) => e?.id === id);
}

/** headId должен быть существующим активным сотрудником (§9.2). */
export async function assertActiveHead(ctx: ToolContext, headId: number, field: string): Promise<Employee> {
  const e = await findEmployee(ctx, headId);
  if (!e?.active) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Руководитель #${String(headId)} не найден или не является активным сотрудником`,
      {
        field,
        reason: 'INVALID_HEAD',
        nextAction: 'Найдите активного сотрудника через employee_search и передайте его ID',
      },
    );
  }
  return e;
}

/** Имена сотрудников по ID (best-effort, одна страница user.get с фильтром-массивом). */
export async function employeeNames(ctx: ToolContext, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const unique = [...new Set(ids)].slice(0, 50);
  if (unique.length === 0) return out;
  const r = await call(ctx, 'user.get', { FILTER: { ID: unique }, select: [...EMPLOYEE_SELECT] });
  if (!Array.isArray(r.result)) throw upstreamShapeError('user.get', 'legacy');
  for (const e of r.result.map(normalizeEmployee)) if (e) out.set(e.id, e.fullName);
  return out;
}

/** Сколько пользователей привязано к отделу (все, включая уволенных): первая страница + total. */
export async function departmentMemberCount(
  ctx: ToolContext,
  departmentId: number,
): Promise<{ total: number; activeOnPage: number; sampleIds: number[] }> {
  const r = await call(ctx, 'user.get', {
    FILTER: { UF_DEPARTMENT: departmentId },
    select: ['ID', 'ACTIVE'],
  });
  if (!Array.isArray(r.result)) throw upstreamShapeError('user.get', 'legacy');
  const rows = r.result.filter(isObj);
  return {
    total: r.total ?? rows.length,
    activeOnPage: rows.filter((u) => yn(u['ACTIVE'])).length,
    sampleIds: rows
      .map((u) => idOf(u['ID']))
      .filter((n): n is number => n !== undefined)
      .slice(0, 10),
  };
}

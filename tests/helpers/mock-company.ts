/**
 * Мок оргструктуры и пользователей в памяти для тестов группы company-chat.
 * Формы ответов — по страницам department.get/add/update/delete, user.get/search/update, method.get.
 * Фильтры выполняются как в документации (ID/PARENT/NAME у department.get; FILTER у user.*).
 */
import { legacyOk, type MockBitrix, type MockResponse, type RecordedCall } from './mock-bitrix.js';

export interface DeptRow {
  ID: string;
  NAME: string;
  SORT: number;
  PARENT?: string;
  UF_HEAD?: string;
}

export interface UserRow {
  ID: string;
  ACTIVE: boolean;
  NAME: string;
  LAST_NAME: string;
  SECOND_NAME: string;
  WORK_POSITION: string;
  UF_DEPARTMENT: number[];
  USER_TYPE: string;
  EMAIL: string;
  PERSONAL_MOBILE: string;
  PERSONAL_BIRTHDAY: string;
}

export interface CompanyState {
  departments: Map<number, DeptRow>;
  users: Map<number, UserRow>;
  nextDeptId: number;
  methodAvailable: Record<string, { isExisting: boolean; isAvailable: boolean }>;
}

export function user(
  id: number,
  name: string,
  lastName: string,
  deps: number[],
  extra: Partial<UserRow> = {},
): UserRow {
  return {
    ID: String(id),
    ACTIVE: true,
    NAME: name,
    LAST_NAME: lastName,
    SECOND_NAME: '',
    WORK_POSITION: 'Менеджер',
    UF_DEPARTMENT: deps,
    USER_TYPE: 'employee',
    EMAIL: `u${String(id)}@secret.invalid`,
    PERSONAL_MOBILE: '+79990000000',
    PERSONAL_BIRTHDAY: '1990-01-01',
    ...extra,
  };
}

/**
 * Структура: 1 «Компания» (корень) → 2 «Продажи» (рук. 10) → 3 «Продажи Москва»; 1 → 4 «Пустой отдел»; 1 → 5 «Склад» (только уволенный).
 * Сотрудники: 10 и 11 — оба «Иванов Иван» (T24), 12 — уволенный, 13 — в корне.
 */
export function companyState(extraUsers: UserRow[] = []): CompanyState {
  const departments = new Map<number, DeptRow>([
    [1, { ID: '1', NAME: 'Компания', SORT: 500 }],
    [2, { ID: '2', NAME: 'Продажи', SORT: 500, PARENT: '1', UF_HEAD: '10' }],
    [3, { ID: '3', NAME: 'Продажи Москва', SORT: 500, PARENT: '2' }],
    [4, { ID: '4', NAME: 'Пустой отдел', SORT: 500, PARENT: '1' }],
    [5, { ID: '5', NAME: 'Склад', SORT: 500, PARENT: '1' }],
  ]);
  const users = new Map<number, UserRow>();
  for (const u of [
    user(10, 'Иван', 'Иванов', [2], { WORK_POSITION: 'Руководитель продаж' }),
    user(11, 'Иван', 'Иванов', [3], { WORK_POSITION: 'Менеджер' }),
    user(12, 'Пётр', 'Петров', [5], { ACTIVE: false }),
    user(13, 'Анна', 'Сидорова', [1], { SECOND_NAME: 'Павловна', WORK_POSITION: 'Директор' }),
    ...extraUsers,
  ])
    users.set(Number(u.ID), u);
  return { departments, users, nextDeptId: 100, methodAvailable: {} };
}

const pageOf = <T>(all: T[], start: number): MockResponse => {
  const items = all.slice(start, start + 50);
  const next = start + 50 < all.length ? start + 50 : undefined;
  return legacyOk(items, { total: all.length, ...(next !== undefined ? { next } : {}) });
};

/** Скаляр тела запроса как строка (объекты не ожидаются). */
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const asIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number) : v === undefined ? [] : [Number(v)];

function userMatches(u: UserRow, filter: Record<string, unknown>): boolean {
  if (filter['ID'] !== undefined && !asIds(filter['ID']).includes(Number(u.ID))) return false;
  if (filter['ACTIVE'] === true && !u.ACTIVE) return false;
  if (filter['UF_DEPARTMENT'] !== undefined && !u.UF_DEPARTMENT.includes(Number(filter['UF_DEPARTMENT'])))
    return false;
  if (typeof filter['FIND'] === 'string') {
    const hay = `${u.LAST_NAME} ${u.NAME} ${u.SECOND_NAME} ${u.WORK_POSITION}`.toLowerCase();
    if (!hay.includes(filter['FIND'].toLowerCase())) return false;
  }
  return true;
}

function project(u: UserRow, select: unknown): Record<string, unknown> {
  if (!Array.isArray(select)) return { ...u };
  const out: Record<string, unknown> = {};
  for (const k of select as string[]) if (k in u) out[k] = u[k as keyof UserRow];
  return out;
}

export function installCompanyMock(bitrix: MockBitrix, s: CompanyState): void {
  const listUsers = (c: RecordedCall) => {
    const filter = (c.body['FILTER'] ?? {}) as Record<string, unknown>;
    const rows = [...s.users.values()]
      .filter((u) => userMatches(u, filter))
      .map((u) => project(u, c.body['select']));
    return pageOf(rows, Number(c.body['start'] ?? 0));
  };
  bitrix
    .on('department.get', (c) => {
      const b = c.body;
      const rows = [...s.departments.values()].filter(
        (d) =>
          (b['ID'] === undefined || Number(d.ID) === Number(b['ID'])) &&
          (b['PARENT'] === undefined || d.PARENT === str(b['PARENT'])) &&
          (b['NAME'] === undefined || d.NAME === b['NAME']),
      );
      return pageOf(rows, Number(b['START'] ?? 0));
    })
    .on('department.add', (c) => {
      const id = s.nextDeptId++;
      s.departments.set(id, {
        ID: String(id),
        NAME: str(c.body['NAME']),
        SORT: 500,
        PARENT: str(c.body['PARENT']),
        ...(c.body['UF_HEAD'] !== undefined ? { UF_HEAD: str(c.body['UF_HEAD']) } : {}),
      });
      return legacyOk(id);
    })
    .on('department.update', (c) => {
      const d = s.departments.get(Number(c.body['ID']));
      if (!d)
        return { status: 400, body: { error: 'ERROR_CORE', error_description: 'Department not found' } };
      if (c.body['NAME'] !== undefined) d.NAME = str(c.body['NAME']);
      if (c.body['PARENT'] !== undefined) d.PARENT = str(c.body['PARENT']);
      if (c.body['UF_HEAD'] !== undefined) d.UF_HEAD = str(c.body['UF_HEAD']);
      return legacyOk(true);
    })
    .on('department.delete', (c) => {
      s.departments.delete(Number(c.body['ID']));
      return legacyOk(true);
    })
    .on('user.get', listUsers)
    .on('user.search', listUsers)
    .on('user.update', (c) => {
      const u = s.users.get(Number(c.body['ID']));
      if (!u) return { status: 400, body: { error: 'ERROR_CORE', error_description: '' } };
      u.UF_DEPARTMENT = (c.body['UF_DEPARTMENT'] as number[]).map(Number);
      return legacyOk(true);
    })
    .on('method.get', (c) =>
      legacyOk(s.methodAvailable[str(c.body['name'])] ?? { isExisting: true, isAvailable: true }),
    );
}

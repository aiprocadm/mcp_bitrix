/**
 * Подстановка имён вместо ID для выгрузок, подсчётов и списков (заявка 2026-10-13, п. 1 и 5.3):
 * сотрудник (ответственный) → ФИО, компания → название, контакт → ФИО, стадия/статус/источник → название,
 * воронка → название. Справочники читаются пачками по 50 и запоминаются на время одного вызова инструмента.
 * user.get без фильтра ACTIVE отдаёт и уволенных, поэтому имя находится и у отключённых сотрудников.
 * Ошибка справочника не прерывает выгрузку: вместо имени остаётся пустое значение и предупреждение.
 */
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { EMPLOYEE_SELECT, normalizeEmployee } from '../company/company-service.js';
import { asText, idOf, isObj, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';
import { listCategories, listOnce, listStatuses } from './crm-service.js';
import { classicEntity, dealStageEntityId, recordTitle } from './entities.js';

const CHUNK = 50;

/** Поле со ссылкой на справочник → вид справочника. */
export type RefKind = 'user' | 'company' | 'contact' | 'status' | 'category';

export interface RefColumn {
  /** Исходное поле с ID/кодом. */
  readonly field: string;
  readonly kind: RefKind;
  /** Заголовок колонки с именем. */
  readonly title: string;
  /** Справочник crm.status.list (для kind=status), для стадии сделки — по воронке записи. */
  readonly statusEntity?: string;
}

const USER_FIELDS = new Set([
  'ASSIGNED_BY_ID',
  'CREATED_BY_ID',
  'MODIFY_BY_ID',
  'MOVED_BY_ID',
  'LAST_ACTIVITY_BY',
  'RESPONSIBLE_ID',
  'AUTHOR_ID',
  'EDITOR_ID',
]);

const USER_TITLES: Record<string, string> = {
  ASSIGNED_BY_ID: 'Ответственный',
  CREATED_BY_ID: 'Кем создана',
  MODIFY_BY_ID: 'Кем изменена',
  RESPONSIBLE_ID: 'Ответственный',
};

/** Колонка с именем для поля классической сущности, если поле ссылается на справочник. */
export function refColumnFor(entityType: string, field: string): RefColumn | undefined {
  if (USER_FIELDS.has(field))
    return { field, kind: 'user', title: USER_TITLES[field] ?? `${field}: сотрудник` };
  if (field === 'COMPANY_ID') return { field, kind: 'company', title: 'Компания' };
  if (field === 'CONTACT_ID') return { field, kind: 'contact', title: 'Контакт' };
  if (field === 'CATEGORY_ID' && entityType === 'deal') return { field, kind: 'category', title: 'Воронка' };
  if (field === 'STAGE_ID' && entityType === 'deal')
    return { field, kind: 'status', title: 'Стадия', statusEntity: 'DEAL_STAGE_BY_CATEGORY' };
  if (field === 'STATUS_ID' && entityType === 'lead')
    return { field, kind: 'status', title: 'Статус', statusEntity: 'STATUS' };
  if (field === 'SOURCE_ID') return { field, kind: 'status', title: 'Источник', statusEntity: 'SOURCE' };
  if (field === 'TYPE_ID' && entityType === 'deal')
    return { field, kind: 'status', title: 'Тип сделки', statusEntity: 'DEAL_TYPE' };
  if (field === 'TYPE_ID' && entityType === 'contact')
    return { field, kind: 'status', title: 'Тип контакта', statusEntity: 'CONTACT_TYPE' };
  if (field === 'COMPANY_TYPE')
    return { field, kind: 'status', title: 'Тип компании', statusEntity: 'COMPANY_TYPE' };
  if (field === 'INDUSTRY') return { field, kind: 'status', title: 'Сфера', statusEntity: 'INDUSTRY' };
  return undefined;
}

export class NameResolver {
  private readonly users = new Map<number, string>();
  private readonly companies = new Map<number, string>();
  private readonly contacts = new Map<number, string>();
  private readonly statuses = new Map<string, Map<string, string>>();
  private categories: Map<number, string> | undefined;
  readonly warnings = new Set<string>();

  constructor(private readonly ctx: ToolContext) {}

  /** Загружает имена сотрудников (включая уволенных) для ещё неизвестных ID. */
  async loadUsers(ids: Iterable<number>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.users.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const r = await this.ctx.bitrix.call(
          'legacy',
          'user.get',
          { FILTER: { ID: chunk }, select: [...EMPLOYEE_SELECT] },
          { requestId: this.ctx.requestId, signal: this.ctx.signal },
        );
        if (!Array.isArray(r.result)) throw upstreamShapeError('user.get', 'legacy');
        for (const e of r.result.map(normalizeEmployee)) if (e) this.users.set(e.id, e.fullName);
      } catch (e) {
        this.soft(e, 'Имена сотрудников недоступны (нет scope user или прав) — оставлены ID');
      }
      for (const id of chunk) if (!this.users.has(id)) this.users.set(id, '');
    }
  }

  async loadCompanies(ids: Iterable<number>): Promise<void> {
    await this.loadRecords('company', ids, this.companies, ['ID', 'TITLE']);
  }

  async loadContacts(ids: Iterable<number>): Promise<void> {
    await this.loadRecords('contact', ids, this.contacts, ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME']);
  }

  private async loadRecords(
    type: 'company' | 'contact',
    ids: Iterable<number>,
    cache: Map<number, string>,
    select: string[],
  ): Promise<void> {
    const entity = classicEntity(type);
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const page = await listOnce(this.ctx, entity, { '@ID': chunk }, select, CHUNK);
        for (const rec of page.items) {
          const id = idOf(rec['ID']);
          if (id !== undefined) cache.set(id, recordTitle(entity, rec));
        }
      } catch (e) {
        this.soft(e, `Названия (${entity.label}) недоступны — оставлены ID`);
      }
      for (const id of chunk) if (!cache.has(id)) cache.set(id, '');
    }
  }

  async statusMap(entityId: string): Promise<Map<string, string>> {
    const cached = this.statuses.get(entityId);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
      for (const s of await listStatuses(this.ctx, entityId)) map.set(s.statusId, s.name);
    } catch (e) {
      this.soft(e, `Справочник ${entityId} недоступен — оставлены коды`);
    }
    this.statuses.set(entityId, map);
    return map;
  }

  async categoryMap(): Promise<Map<number, string>> {
    if (this.categories) return this.categories;
    const map = new Map<number, string>([[0, 'Общая']]);
    try {
      for (const c of await listCategories(this.ctx, 2)) map.set(c.id, c.name);
    } catch (e) {
      this.soft(e, 'Названия воронок недоступны — оставлены ID');
    }
    this.categories = map;
    return map;
  }

  /** Подготовить справочники для пачки записей (одним проходом по всем колонкам). */
  async prepare(rows: readonly Record<string, JsonValue>[], refs: readonly RefColumn[]): Promise<void> {
    for (const ref of refs) {
      const ids = (field: string) =>
        rows.flatMap((r) => {
          const v = r[field];
          return (Array.isArray(v) ? v : [v]).map(idOf).filter((n): n is number => n !== undefined);
        });
      if (ref.kind === 'user') await this.loadUsers(ids(ref.field));
      else if (ref.kind === 'company') await this.loadCompanies(ids(ref.field));
      else if (ref.kind === 'contact') await this.loadContacts(ids(ref.field));
      else if (ref.kind === 'category') await this.categoryMap();
      else if (ref.statusEntity === 'DEAL_STAGE_BY_CATEGORY') {
        const cats = new Set(rows.map((r) => Number(asText(r['CATEGORY_ID'])) || 0));
        for (const c of cats) await this.statusMap(dealStageEntityId(c));
      } else if (ref.statusEntity) await this.statusMap(ref.statusEntity);
    }
  }

  /** Имя для значения поля записи; справочник должен быть подготовлен через prepare(). */
  label(ref: RefColumn, row: Record<string, JsonValue>): string {
    const v = row[ref.field];
    const one = (x: JsonValue | undefined): string => {
      if (ref.kind === 'status') {
        const code = asText(x);
        if (!code) return '';
        const entityId =
          ref.statusEntity === 'DEAL_STAGE_BY_CATEGORY'
            ? dealStageEntityId(Number(asText(row['CATEGORY_ID'])) || 0)
            : (ref.statusEntity ?? '');
        return this.statuses.get(entityId)?.get(code) ?? code;
      }
      const id = idOf(x);
      if (id === undefined) return ref.kind === 'category' && asText(x) === '0' ? 'Общая' : '';
      if (ref.kind === 'user') return this.users.get(id) ?? '';
      if (ref.kind === 'company') return this.companies.get(id) ?? '';
      if (ref.kind === 'contact') return this.contacts.get(id) ?? '';
      return this.categories?.get(id) ?? '';
    };
    return Array.isArray(v) ? v.map(one).filter(Boolean).join(', ') : one(v);
  }

  userName(id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    const name = this.users.get(id);
    return name === undefined || name === '' ? null : name;
  }

  private soft(e: unknown, warning: string): void {
    if (this.ctx.signal?.aborted) throw e;
    if (!AppError.is(e)) throw e;
    this.warnings.add(warning);
  }
}

/** Пустые значения (null, '', [], {}) — для компактного режима ответа. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Классические сущности CRM (ТЗ §9.1 RecordRef, §9.4): сделка, лид, контакт, компания.
 * Один источник правды для методов `crm.<entity>.*`, числовых entityTypeId, ключевых полей плана/сверки,
 * полей по умолчанию и справочников стадий. Смарт-процессы (`crm.item.*`, entityTypeId динамический) —
 * отдельный адаптер следующего среза; здесь их нет намеренно.
 * Факт из документации (S09): Bitrix пометил классические методы «развитие остановлено, используйте crm.item.*»;
 * они по-прежнему документированы и работают — переход на универсальный адаптер запланирован отдельным срезом.
 */
import { z } from 'zod';
import { asText } from './deal-fields.js';

export const CLASSIC_ENTITY_TYPES = ['deal', 'lead', 'contact', 'company'] as const;
export type ClassicEntityType = (typeof CLASSIC_ENTITY_TYPES)[number];
export const entityTypeSchema = z
  .enum(CLASSIC_ENTITY_TYPES)
  .describe(
    'Тип сущности классического CRM: deal (сделка), lead (лид), contact (контакт), company (компания)',
  );

export interface ClassicEntity {
  readonly type: ClassicEntityType;
  /** Числовой ENTITY_TYPE_ID Bitrix24: лид 1, сделка 2, контакт 3, компания 4. */
  readonly entityTypeId: number;
  readonly methodBase: string;
  /** Именительный падеж для текста плана: «сделку» строится отдельно. */
  readonly label: string;
  readonly labelAccusative: string;
  /** Поля, попадающие в план и в сверку после записи (§15.3). */
  readonly keyFields: readonly string[];
  readonly defaultSelect: readonly string[];
  /** Поле стадии/статуса и ключ фильтра для поиска по названию. */
  readonly stageField: 'STAGE_ID' | 'STATUS_ID' | undefined;
  readonly searchFields: readonly string[];
  /** Справочники crm.status.list, относящиеся к сущности (без учёта воронок сделок). */
  readonly statusEntityIds: readonly string[];
}

const DEAL: ClassicEntity = {
  type: 'deal',
  entityTypeId: 2,
  methodBase: 'crm.deal',
  label: 'сделка',
  labelAccusative: 'сделку',
  keyFields: ['TITLE', 'CATEGORY_ID', 'STAGE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID'],
  defaultSelect: [
    'ID',
    'TITLE',
    'STAGE_ID',
    'CATEGORY_ID',
    'ASSIGNED_BY_ID',
    'OPPORTUNITY',
    'CURRENCY_ID',
    'DATE_CREATE',
  ],
  stageField: 'STAGE_ID',
  searchFields: ['TITLE'],
  statusEntityIds: ['DEAL_STAGE', 'DEAL_TYPE'],
};

const LEAD: ClassicEntity = {
  type: 'lead',
  entityTypeId: 1,
  methodBase: 'crm.lead',
  label: 'лид',
  labelAccusative: 'лид',
  keyFields: ['TITLE', 'STATUS_ID', 'ASSIGNED_BY_ID', 'NAME', 'LAST_NAME', 'OPPORTUNITY', 'CURRENCY_ID'],
  defaultSelect: [
    'ID',
    'TITLE',
    'NAME',
    'LAST_NAME',
    'STATUS_ID',
    'ASSIGNED_BY_ID',
    'OPPORTUNITY',
    'CURRENCY_ID',
    'DATE_CREATE',
  ],
  stageField: 'STATUS_ID',
  searchFields: ['TITLE'],
  statusEntityIds: ['STATUS', 'SOURCE'],
};

const CONTACT: ClassicEntity = {
  type: 'contact',
  entityTypeId: 3,
  methodBase: 'crm.contact',
  label: 'контакт',
  labelAccusative: 'контакт',
  keyFields: ['NAME', 'LAST_NAME', 'ASSIGNED_BY_ID', 'COMPANY_ID', 'TYPE_ID'],
  defaultSelect: [
    'ID',
    'NAME',
    'LAST_NAME',
    'SECOND_NAME',
    'ASSIGNED_BY_ID',
    'COMPANY_ID',
    'TYPE_ID',
    'DATE_CREATE',
  ],
  stageField: undefined,
  searchFields: ['LAST_NAME', 'NAME'],
  statusEntityIds: ['CONTACT_TYPE', 'SOURCE'],
};

const COMPANY: ClassicEntity = {
  type: 'company',
  entityTypeId: 4,
  methodBase: 'crm.company',
  label: 'компания',
  labelAccusative: 'компанию',
  keyFields: ['TITLE', 'ASSIGNED_BY_ID', 'COMPANY_TYPE', 'INDUSTRY'],
  defaultSelect: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'COMPANY_TYPE', 'INDUSTRY', 'DATE_CREATE'],
  stageField: undefined,
  searchFields: ['TITLE'],
  statusEntityIds: ['COMPANY_TYPE', 'INDUSTRY'],
};

export const CLASSIC_ENTITIES: Readonly<Record<ClassicEntityType, ClassicEntity>> = {
  deal: DEAL,
  lead: LEAD,
  contact: CONTACT,
  company: COMPANY,
};

export function classicEntity(type: ClassicEntityType): ClassicEntity {
  return CLASSIC_ENTITIES[type];
}

/** Человекочитаемое название записи для плана/кандидатов поиска. */
export function recordTitle(entity: ClassicEntity, record: Record<string, unknown>): string {
  if (entity.type === 'contact') {
    return [asText(record['LAST_NAME']), asText(record['NAME']), asText(record['SECOND_NAME'])]
      .filter((s) => s !== '')
      .join(' ');
  }
  return asText(record['TITLE']);
}

/** ENTITY_ID справочника стадий сделки для воронки (0 — общая). */
export function dealStageEntityId(categoryId: number): string {
  return categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${String(categoryId)}`;
}

/** Числовой entityTypeId (1..4) → тип; для crm_stage_history/crm_stages_and_statuses. */
export function classicEntityByTypeId(entityTypeId: number): ClassicEntity | undefined {
  return Object.values(CLASSIC_ENTITIES).find((e) => e.entityTypeId === entityTypeId);
}

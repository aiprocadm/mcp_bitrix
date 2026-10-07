/** Модули Bitrix24, которыми группируются инструменты (ТЗ §9, §13 ENABLED_MODULES). */
export const ALL_MODULES = [
  'system',
  'company',
  'crm',
  'tasks',
  'calendar',
  'chat',
  'telephony',
  'disk',
  'knowledgeBase',
  'smartProcesses',
  'catalog',
  'invoices',
  'orders',
  'feed',
  'groups',
  'openlines',
  'lists',
  'bizproc',
] as const;

export type ModuleName = (typeof ALL_MODULES)[number];

export function isModuleName(value: string): value is ModuleName {
  return (ALL_MODULES as readonly string[]).includes(value);
}

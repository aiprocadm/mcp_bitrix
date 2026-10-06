/** Группы реестра методов по модулям (подключаются в method-registry.ts). */
import { crmRequisitesMethods } from './crm-requisites.js';
import { crmItemsMethods } from './crm-items.js';
import { crmLinksMethods } from './crm-links.js';
import { tasksMethods } from './tasks.js';
import { calendarDiskMethods } from './calendar-disk.js';
import { companyChatMethods } from './company-chat.js';
import { catalogSaleMethods } from './catalog-sale.js';
import { feedLandingMethods } from './feed-landing.js';
import { noteMethods } from './note.js';
import { saasAppMethods } from './saas-app.js';
import type { MethodDescriptor } from './descriptor.js';

export const REGISTRY_GROUPS: readonly (readonly (readonly [string, MethodDescriptor])[])[] = [
  crmRequisitesMethods,
  crmItemsMethods,
  crmLinksMethods,
  tasksMethods,
  calendarDiskMethods,
  companyChatMethods,
  catalogSaleMethods,
  feedLandingMethods,
  noteMethods,
  saasAppMethods,
];

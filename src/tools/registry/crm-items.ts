/**
 * Инструменты группы: CRM: универсальный адаптер crm.item.* — смарт-процессы, смарт-счета, удаление записей.
 * crm_list_records / crm_get_record / crm_create_record / crm_update_record / crm_fields_get маршрутизируют
 * entityType=smart|invoice на тот же адаптер и зарегистрированы в src/tools/index.ts.
 */
import { crmDeleteRecordTool } from '../crm/item-delete.js';
import { invoiceTools } from '../invoices/invoice-tools.js';
import { smartTools } from '../smart/smart-tools.js';
import type { ToolDefinition } from '../types.js';

export const crmItemsTools: readonly ToolDefinition[] = [
  // §9.4 удаление записи (этап 14): только ENABLE_DESTRUCTIVE_TOOLS=true и роль administrator
  crmDeleteRecordTool,
  // §9.5 счета
  ...invoiceTools,
  // §9.7 смарт-процессы
  ...smartTools,
];

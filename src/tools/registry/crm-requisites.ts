/**
 * Инструменты группы: CRM: реквизиты, адреса, банковские реквизиты, дела (запись).
 */
import { crmActivityCreateTool, crmActivityUpdateTool } from '../crm/activity-write.js';
import { crmRequisitePresetsListTool, crmRequisitesListTool } from '../crm/requisites-read.js';
import {
  crmBankAccountAddTool,
  crmRequisiteAddressSetTool,
  crmRequisiteCreateTool,
  crmRequisiteUpdateTool,
} from '../crm/requisites-write.js';
import type { ToolDefinition } from '../types.js';

export const crmRequisitesTools: readonly ToolDefinition[] = [
  crmActivityCreateTool,
  crmActivityUpdateTool,
  crmRequisiteCreateTool,
  crmRequisiteUpdateTool,
  crmRequisitesListTool,
  crmRequisitePresetsListTool,
  crmRequisiteAddressSetTool,
  crmBankAccountAddTool,
];

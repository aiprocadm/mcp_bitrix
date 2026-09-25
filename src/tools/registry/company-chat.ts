/**
 * Инструменты группы: Сотрудники и оргструктура, чаты, телефония, рабочие группы.
 */
import type { ToolDefinition } from '../types.js';
import { chatMessagesGetTool } from '../chat/messages-get.js';
import { chatRecentListTool } from '../chat/recent-list.js';
import {
  companyDepartmentCreateTool,
  companyDepartmentDeleteTool,
  companyDepartmentUpdateTool,
} from '../company/department-write.js';
import { companyDepartmentsListTool } from '../company/departments-list.js';
import { companyEmployeeDepartmentsSetTool } from '../company/employee-departments.js';
import { employeeSearchTool } from '../company/employee-search.js';
import { workgroupMembersListTool, workgroupsListTool } from '../groups/workgroups.js';
import { telephonyCallsListTool } from '../telephony/calls-list.js';

export const companyChatTools: readonly ToolDefinition[] = [
  employeeSearchTool,
  companyDepartmentsListTool,
  companyDepartmentCreateTool,
  companyDepartmentUpdateTool,
  companyDepartmentDeleteTool,
  companyEmployeeDepartmentsSetTool,
  chatRecentListTool,
  chatMessagesGetTool,
  telephonyCallsListTool,
  workgroupsListTool,
  workgroupMembersListTool,
];

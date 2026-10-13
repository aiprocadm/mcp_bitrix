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
import { employeeSearchTool, employeesGetTool } from '../company/employee-search.js';
import { workgroupMembersListTool, workgroupsListTool } from '../groups/workgroups.js';
import { telephonyCallsListTool } from '../telephony/calls-list.js';
import { callsRecordingsDownloadTool } from '../telephony/recordings.js';
import { callTranscribeTool } from '../telephony/transcribe.js';

export const companyChatTools: readonly ToolDefinition[] = [
  employeeSearchTool,
  employeesGetTool,
  companyDepartmentsListTool,
  companyDepartmentCreateTool,
  companyDepartmentUpdateTool,
  companyDepartmentDeleteTool,
  companyEmployeeDepartmentsSetTool,
  chatRecentListTool,
  chatMessagesGetTool,
  telephonyCallsListTool,
  callsRecordingsDownloadTool,
  callTranscribeTool,
  workgroupsListTool,
  workgroupMembersListTool,
];

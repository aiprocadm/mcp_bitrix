/**
 * Инструменты группы: Календарь (разделы, события, приглашения, занятость) и Диск (хранилища, обход, поиск, удаление).
 */
import { calendarListEventsTool, calendarListTool, employeeAvailabilityTool } from '../calendar/read.js';
import {
  calendarDeleteEventTool,
  calendarRespondInvitationTool,
  calendarUpdateEventTool,
} from '../calendar/write.js';
import { diskDeleteFileTool } from '../disk/delete-file.js';
import { diskChildrenListTool, diskSearchFilesTool, diskStoragesListTool } from '../disk/read.js';
import type { ToolDefinition } from '../types.js';

export const calendarDiskTools: readonly ToolDefinition[] = [
  // §9.3 календарь и занятость
  calendarListTool,
  calendarListEventsTool,
  calendarUpdateEventTool,
  calendarDeleteEventTool,
  calendarRespondInvitationTool,
  employeeAvailabilityTool,
  // §9.12 диск
  diskStoragesListTool,
  diskChildrenListTool,
  diskSearchFilesTool,
  diskDeleteFileTool,
];

/**
 * Инструменты группы: Задачи: обновление, завершение, удаление, чек-листы, обсуждение (ТЗ §9.8).
 */
import {
  taskChecklistAddTool,
  taskChecklistDeleteTool,
  taskChecklistGetTool,
  taskChecklistSetCompleteTool,
  taskChecklistUpdateTool,
} from '../tasks/task-checklist.js';
import { taskCommentAddTool, taskCommentsListTool } from '../tasks/task-comments.js';
import { taskDeleteTool } from '../tasks/task-delete.js';
import { taskCompleteTool, taskUpdateTool } from '../tasks/task-update.js';
import type { ToolDefinition } from '../types.js';

export const tasksTools: readonly ToolDefinition[] = [
  taskUpdateTool,
  taskCompleteTool,
  taskDeleteTool,
  taskChecklistGetTool,
  taskChecklistAddTool,
  taskChecklistUpdateTool,
  taskChecklistSetCompleteTool,
  taskChecklistDeleteTool,
  taskCommentAddTool,
  taskCommentsListTool,
];

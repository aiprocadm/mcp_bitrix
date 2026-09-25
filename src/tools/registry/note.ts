/**
 * Инструменты группы: База знаний 2.0 (note.*, REST 3.0).
 */
import type { ToolDefinition } from '../types.js';
import {
  kb2BaseGetTool,
  kb2BasesListTool,
  kb2DocumentGetTool,
  kb2DocumentsListTool,
  kb2DocumentsSearchTool,
} from '../kb2/read.js';
import { kb2BaseCreateTool, kb2DocumentCreateTool, kb2DocumentUpdateTool } from '../kb2/write.js';

export const noteTools: readonly ToolDefinition[] = [
  kb2BasesListTool,
  kb2BaseGetTool,
  kb2DocumentsListTool,
  kb2DocumentGetTool,
  kb2DocumentsSearchTool,
  kb2BaseCreateTool,
  kb2DocumentCreateTool,
  kb2DocumentUpdateTool,
];

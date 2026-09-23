/**
 * Полный список инструментов сервера. Модули включаются конфигурацией (ENABLED_MODULES),
 * а не форком; порядок — как в реестре ТЗ §9.
 */
import { capabilitiesTool } from './system/capabilities.js';
import { connectionInfoTool } from './system/connection-info.js';
import { operationStatusTool } from './system/operation-status.js';
import { restCallTool } from './system/rest-call.js';
import { serverVersionTool } from './system/server-version.js';
import type { ToolDefinition } from './types.js';

export function allTools(): readonly ToolDefinition[] {
  return [connectionInfoTool, serverVersionTool, capabilitiesTool, restCallTool, operationStatusTool];
}

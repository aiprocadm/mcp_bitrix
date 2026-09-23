import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import {
  MCP_SDK_VERSION,
  MCP_SPEC_VERSION,
  NODE_VERSION,
  SERVER_PACKAGE_NAME,
  SERVER_VERSION,
} from '../../version.js';
import { defineTool, LOCAL_READ_ANNOTATIONS } from '../types.js';

export const serverVersionTool = defineTool({
  name: 'bitrix_server_version',
  module: 'system',
  title: 'Версия MCP-сервера',
  description:
    'Версия собственного MCP-сервера, SDK, протокола и список включённых модулей. ' +
    'Использовать, когда нужно проверить, что сервер запущен и какой он версии. Не обращается к Bitrix24.',
  operation: 'admin/diagnostic',
  annotations: LOCAL_READ_ANNOTATIONS,
  requiresBitrix: false,
  inputSchema: z.object({}).strict(),
  outputDataSchema: z.object({
    name: z.string(),
    version: z.string(),
    mcpSdkVersion: z.string(),
    mcpSpecVersion: z.string(),
    nodeVersion: z.string(),
    transport: z.enum(['stdio', 'http']),
    enabledModules: z.array(z.string()),
    readOnlyMode: z.boolean(),
  }),
  handler: (_args, ctx) =>
    Promise.resolve(
      ok(
        {
          name: SERVER_PACKAGE_NAME,
          version: SERVER_VERSION,
          mcpSdkVersion: MCP_SDK_VERSION,
          mcpSpecVersion: MCP_SPEC_VERSION,
          nodeVersion: NODE_VERSION,
          transport: ctx.config.server.transport,
          enabledModules: [...ctx.config.policy.enabledModules],
          readOnlyMode: ctx.config.policy.readOnlyMode,
        },
        { requestId: ctx.requestId, durationMs: Date.now() - ctx.startedAt },
      ),
    ),
});

/**
 * stdio-транспорт (ТЗ §4.5): stdout — только MCP, логи — stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { AppContainer } from '../app/container.js';
import { createMcpServer } from './server.js';

export interface StdioHandle {
  close(): Promise<void>;
}

export async function startStdio(app: AppContainer): Promise<StdioHandle> {
  const { server, tools } = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  app.logger.info(
    {
      transport: 'stdio',
      tools: tools.filter((t) => t.visible).length,
      hidden: tools.filter((t) => !t.visible).length,
    },
    'mcp server started',
  );
  return {
    async close() {
      await server.close();
    },
  };
}

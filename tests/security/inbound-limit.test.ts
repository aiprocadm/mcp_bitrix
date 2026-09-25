/** ТЗ §8.6: лимит входящих read-вызовов действует в диспетчере для любого транспорта; write-подготовки не считаются в нём. */
import { describe, expect, it } from 'vitest';
import { connectInMemory, createTestApp, structured } from '../helpers/app.js';

describe('лимит входящих вызовов', () => {
  it('третий read-вызов при лимите 2/мин → RATE_LIMITED в конверте, аудит outcome=denied', async () => {
    const t = createTestApp({ MCP_INBOUND_READ_PER_MINUTE: '2' });
    const c = await connectInMemory(t.app);
    try {
      for (let i = 0; i < 2; i += 1) {
        const r = structured<{ success: boolean }>(
          await c.client.callTool({ name: 'bitrix_server_version', arguments: {} }),
        );
        expect(r.success).toBe(true);
      }
      const third = structured<{
        success: boolean;
        error: { code: string; details: { nextAction?: string } };
      }>(await c.client.callTool({ name: 'bitrix_server_version', arguments: {} }));
      expect(third.success).toBe(false);
      expect(third.error.code).toBe('RATE_LIMITED');
      expect(third.error.details.nextAction).toMatch(/Повторите/);
      const rows = await t.app.db.all<{ outcome: string; error_code: string | null }>(
        "SELECT outcome, error_code FROM audit WHERE tool = 'bitrix_server_version' ORDER BY id",
      );
      expect(rows.map((r) => r.outcome)).toEqual(['success', 'success', 'denied']);
      expect(rows[2]?.error_code).toBe('RATE_LIMITED');
    } finally {
      await c.close();
      t.app.close();
    }
  });
});

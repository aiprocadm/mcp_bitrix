import { z } from 'zod';
import { ALL_MODULES } from '../../config/modules.js';
import { ok } from '../../mcp/result.js';
import type { MethodDescriptor } from '../../bitrix/method-registry.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';

/** Соответствие модуль → префиксы методов в реестре. */
const MODULE_PREFIXES: Record<string, string[]> = {
  system: ['profile', 'user.current', 'method.get', 'scope', 'app.info', 'rest.'],
  company: ['user.', 'department.'],
  crm: ['crm.'],
  tasks: ['tasks.', 'task.'],
  calendar: ['calendar.'],
  chat: ['im.'],
  telephony: ['voximplant.'],
  disk: ['disk.'],
  knowledgeBase: ['landing.', 'note.'],
  smartProcesses: ['crm.type', 'crm.item'],
  catalog: ['catalog.'],
  invoices: ['crm.item'],
  orders: ['sale.'],
  feed: ['log.'],
  groups: ['sonet_group.'],
};

export function methodBelongsToModule(d: MethodDescriptor, module: string): boolean {
  const prefixes = MODULE_PREFIXES[module] ?? [];
  return prefixes.some((p) => d.method === p || d.method.startsWith(p));
}

export const capabilitiesTool = defineTool({
  name: 'bitrix_capabilities',
  module: 'system',
  title: 'Возможности портала',
  description:
    'Проверяет, какие методы из реестра сервера существуют и доступны на портале (через method.get), ' +
    'какие запрещены политикой сервера и какие ещё не проверены. Использовать, когда инструмент вернул ' +
    'FEATURE_UNAVAILABLE или перед включением модуля. Доступность метода не гарантирует доступ ко всем объектам.',
  operation: 'admin/diagnostic',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      module: z.enum(ALL_MODULES).optional().describe('Ограничить проверку одним модулем'),
      refresh: z.boolean().default(false).describe('Игнорировать кэш (5 минут)'),
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        method: z.string(),
        apiVersion: z.enum(['legacy', 'v3']),
        scope: z.string().optional(),
        status: z.enum(['supported', 'unavailable', 'unchecked', 'forbidden-by-policy', 'error']),
        reason: z.string().optional(),
      }),
    ),
    summary: z.record(z.string(), z.number()),
  }),
  handler: async (args, ctx) => {
    const filter = (d: MethodDescriptor) => (args.module ? methodBelongsToModule(d, args.module) : true);
    const probed = await ctx.capabilities.probeAll(ctx.requestId, filter, args.refresh);
    const items = probed.map((c) => {
      const enabled = [...ctx.config.policy.enabledModules].some((m) =>
        methodBelongsToModule({ method: c.method } as MethodDescriptor, m),
      );
      return enabled
        ? c
        : { ...c, status: 'forbidden-by-policy' as const, reason: 'модуль выключен в ENABLED_MODULES' };
    });
    const summary: Record<string, number> = {};
    for (const i of items) summary[i.status] = (summary[i.status] ?? 0) + 1;
    return ok(
      { items: items.map((i) => ({ ...i, scope: i.scope ?? undefined })), summary },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'method.get',
        apiVersion: 'legacy',
      },
    );
  },
});

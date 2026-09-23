import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';

/** Поля профиля, которые сервер сообщает модели; остальное (e-mail и т. п.) отбрасывается. */
export interface ProfileBrief {
  id: number;
  name: string;
  lastName: string;
  isAdmin: boolean;
  timeZone: string | null;
}

export function pickProfile(result: unknown): ProfileBrief {
  const obj = (result && typeof result === 'object' && !Array.isArray(result) ? result : {}) as Record<
    string,
    unknown
  >;
  const id = Number(obj['ID']);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'Ответ profile не содержит ID пользователя', {
      method: 'profile',
      apiVersion: 'legacy',
    });
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    id,
    name: str(obj['NAME']),
    lastName: str(obj['LAST_NAME']),
    isAdmin: obj['ADMIN'] === true || obj['ADMIN'] === 'Y',
    timeZone: typeof obj['TIME_ZONE'] === 'string' && obj['TIME_ZONE'] ? obj['TIME_ZONE'] : null,
  };
}

export const connectionInfoTool = defineTool({
  name: 'bitrix_connection_info',
  module: 'system',
  title: 'Информация о подключении',
  description:
    'Кто подключён к какому порталу Bitrix24 и с какими ограничениями: домен без секрета, способ авторизации, ' +
    'текущий сотрудник, режим записи, выданные scope, включённые модули. Использовать первым, чтобы проверить связь. ' +
    'Секрет вебхука никогда не возвращается.',
  operation: 'admin/diagnostic',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      refresh: z
        .boolean()
        .default(false)
        .describe('Обновить кэш scope и возможностей (по умолчанию кэш 5 минут)'),
    })
    .strict(),
  outputDataSchema: z.object({
    portalOrigin: z.string(),
    deployment: z.enum(['cloud', 'on-premise']),
    authMode: z.enum(['webhook', 'oauth']),
    principal: z.object({ id: z.string(), role: z.string() }),
    bitrixUser: z.object({
      id: z.number(),
      name: z.string(),
      lastName: z.string(),
      isAdmin: z.boolean(),
      timeZone: z.string().nullable(),
    }),
    readOnlyMode: z.boolean(),
    confirmAllWrites: z.boolean(),
    rawRest: z.object({ enabled: z.boolean(), mode: z.string() }),
    enabledModules: z.array(z.string()),
    scopes: z.array(z.string()),
    scopesSource: z.enum(['portal', 'unavailable']),
    timezone: z.string(),
  }),
  handler: async (args, ctx) => {
    const profile = await ctx.bitrix.call(
      'legacy',
      'profile',
      {},
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const user = pickProfile(profile.result);
    let scopes: string[] = [];
    let scopesSource: 'portal' | 'unavailable' = 'portal';
    const warnings: string[] = [];
    try {
      scopes = await ctx.capabilities.scopes(ctx.requestId, args.refresh);
    } catch (e) {
      scopesSource = 'unavailable';
      warnings.push(`Список scope недоступен: ${AppError.from(e).code}`);
    }
    return ok(
      {
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        deployment: ctx.config.bitrix.deployment,
        authMode: ctx.bitrix.auth.mode,
        principal: { id: ctx.principal.id, role: ctx.principal.role },
        bitrixUser: user,
        readOnlyMode: ctx.config.policy.readOnlyMode,
        confirmAllWrites: ctx.config.policy.confirmAllWrites,
        rawRest: { enabled: ctx.config.policy.enableRawRest, mode: ctx.config.policy.rawRestMode },
        enabledModules: [...ctx.config.policy.enabledModules],
        scopes,
        scopesSource,
        timezone: ctx.config.bitrix.timezone,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'profile',
        apiVersion: 'legacy',
        attempts: profile.meta.attempts,
        warnings,
      },
    );
  },
});

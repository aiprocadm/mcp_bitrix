/**
 * Открытые линии (чтение): список линий, чаты линий по записи CRM, история переписки сессии.
 * Методы imopenlines.config.list.get, imopenlines.crm.chat.get, imopenlines.session.history.get (scope imopenlines).
 * Из истории отдаются только текст, дата и автор (клиент/оператор/система); файлы — имя, тип и размер,
 * без ссылок скачивания (в них токен доступа, §8.4). Очередь операторов линии не запрашивается.
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { asText, idOf, idSchema, isObj, isoDateSchema, num, upstreamShapeError, yn } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { classicEntity, entityTypeSchema, recordTitle } from '../crm/entities.js';
import { getRecord } from '../crm/crm-service.js';

const meta = (ctx: ToolContext, method: string, warnings: string[] = [], partial = false) => ({
  requestId: ctx.requestId,
  durationMs: Date.now() - ctx.startedAt,
  method,
  apiVersion: 'legacy' as const,
  completeness: partial ? ('partial' as const) : ('complete' as const),
  warnings,
});

// ---------- openlines_list ----------

export const openlinesListTool = defineTool({
  name: 'openlines_list',
  module: 'openlines',
  title: 'Открытые линии',
  description:
    'Список открытых линий портала (imopenlines.config.list.get): ID, название, активна ли. ' +
    'Использовать, когда спрашивают «какие у нас каналы связи с клиентами», перед чтением переписки. Очередь операторов не отдаётся.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({}).strict(),
  outputDataSchema: z.object({
    items: z.array(z.object({ id: z.number(), name: z.string(), active: z.boolean() })),
    returnedCount: z.number(),
  }),
  handler: async (_args, ctx) => {
    const r = await ctx.bitrix.call(
      'legacy',
      'imopenlines.config.list.get',
      { PARAMS: { select: ['ID', 'LINE_NAME', 'ACTIVE'], order: { ID: 'asc' }, limit: 200 } },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError('imopenlines.config.list.get', 'legacy');
    const items = r.result.filter(isObj).flatMap((x) => {
      const id = idOf(x['ID']);
      return id === undefined ? [] : [{ id, name: asText(x['LINE_NAME']), active: yn(x['ACTIVE']) }];
    });
    const warnings = items.length >= 200 ? ['Показаны первые 200 линий'] : [];
    return ok({ items, returnedCount: items.length }, meta(ctx, 'imopenlines.config.list.get', warnings));
  },
});

// ---------- openlines_crm_chats ----------

export const openlinesCrmChatsTool = defineTool({
  name: 'openlines_crm_chats',
  module: 'openlines',
  title: 'Чаты открытых линий записи CRM',
  description:
    'Чаты открытых линий (мессенджеры, онлайн-чат сайта), привязанные к лиду, сделке, контакту или компании (imopenlines.crm.chat.get): ' +
    'ID чата и канал. Использовать, когда спрашивают «о чём клиент писал в мессенджере», затем openlines_chat_history по chatId. ' +
    'activeOnly=true — только открытые сейчас диалоги.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      recordId: idSchema.describe('ID записи CRM'),
      activeOnly: z
        .boolean()
        .default(false)
        .describe('Только активные чаты (по умолчанию все, включая закрытые)'),
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.string(),
    recordId: z.number(),
    recordTitle: z.string(),
    items: z.array(z.object({ chatId: z.number(), connectorId: z.string(), connectorTitle: z.string() })),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const entity = classicEntity(args.entityType);
    // Официальная страница: на несуществующую запись метод отвечает пустым списком — запись читается первой.
    const record = await getRecord(ctx, entity, args.recordId);
    const r = await ctx.bitrix.call(
      'legacy',
      'imopenlines.crm.chat.get',
      { CRM_ENTITY_TYPE: entity.type, CRM_ENTITY: args.recordId, ACTIVE_ONLY: args.activeOnly ? 'Y' : 'N' },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError('imopenlines.crm.chat.get', 'legacy');
    const items = r.result.filter(isObj).flatMap((x) => {
      const chatId = idOf(x['CHAT_ID']);
      return chatId === undefined
        ? []
        : [{ chatId, connectorId: asText(x['CONNECTOR_ID']), connectorTitle: asText(x['CONNECTOR_TITLE']) }];
    });
    return ok(
      {
        entityType: entity.type,
        recordId: args.recordId,
        recordTitle: recordTitle(entity, record),
        items,
        returnedCount: items.length,
      },
      meta(ctx, 'imopenlines.crm.chat.get'),
    );
  },
});

// ---------- openlines_chat_history ----------

/** BB-коды сообщений Битрикс24 → обычный текст: [b], [i], [url=…]текст[/url], [USER=…]имя[/USER], [br] и т. п. */
export function bbToText(s: string): string {
  return s
    .replace(/\[br\]/gi, '\n')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[(user|chat|context|send|put)=[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2')
    .replace(/\[\/?(b|i|u|s|quote|code|color(=[^\]]*)?|size(=[^\]]*)?|url|icon=[^\]]*|attach=[^\]]*)\]/gi, '')
    .replace(/------------------------------------------------------\n?/g, '')
    .trim();
}

/** entityData2 чата линии: «LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0» → ненулевые привязки CRM. */
export function crmBindings(entityData2: string): Record<string, number> {
  const parts = entityData2.split('|');
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const id = Number(parts[i + 1]);
    const key = (parts[i] ?? '').toLowerCase();
    if (key && Number.isSafeInteger(id) && id > 0) out[key] = id;
  }
  return out;
}

const authorKind = z.enum(['client', 'operator', 'system']);

export interface HistoryMessage {
  id: number;
  date: string;
  authorKind: z.infer<typeof authorKind>;
  authorId: number;
  authorName: string;
  text: string;
  files: { name: string; type: string; size: number | null }[];
}

export interface History {
  chatId: number;
  sessionId: number | null;
  chatName: string;
  connectorId: string;
  /** ID линии из entityId чата («коннектор|линия|…»). */
  lineId: number | null;
  crm: Record<string, number>;
  messages: HistoryMessage[];
}

/** Переписка сессии (imopenlines.session.history.get) в разобранном виде, сообщения по возрастанию даты. */
export async function loadHistory(
  ctx: ToolContext,
  ids: { chatId?: number | undefined; sessionId?: number | undefined },
): Promise<History> {
  const params: Record<string, number> = {};
  if (ids.sessionId !== undefined) params['SESSION_ID'] = ids.sessionId;
  if (ids.chatId !== undefined) params['CHAT_ID'] = ids.chatId;
  const r = await ctx.bitrix.call('legacy', 'imopenlines.session.history.get', params, {
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  if (!isObj(r.result)) throw upstreamShapeError('imopenlines.session.history.get', 'legacy');
  const res = r.result;
  const chatId = idOf(res['chatId']) ?? ids.chatId;
  if (chatId === undefined) {
    throw new AppError('NOT_FOUND', 'Сессия открытой линии не найдена или недоступна', {
      method: 'imopenlines.session.history.get',
      apiVersion: 'legacy',
    });
  }
  const users = isObj(res['users']) ? res['users'] : {};
  const files = isObj(res['files']) ? res['files'] : {};
  const chats = isObj(res['chat']) ? res['chat'] : {};
  const chat = isObj(chats[String(chatId)]) ? (chats[String(chatId)] as Record<string, JsonValue>) : {};
  const rawMessages = isObj(res['message']) ? Object.values(res['message']) : [];

  const messages: HistoryMessage[] = rawMessages
    .filter(isObj)
    .flatMap((m) => {
      const id = idOf(m['id']);
      if (id === undefined) return [];
      const authorId = num(m['senderid']) ?? 0;
      const user = isObj(users[String(authorId)])
        ? (users[String(authorId)] as Record<string, JsonValue>)
        : {};
      const kind: z.infer<typeof authorKind> =
        authorId === 0
          ? 'system'
          : user['connector'] === true || yn(user['connector'])
            ? 'client'
            : 'operator';
      const params = isObj(m['params']) ? m['params'] : {};
      const fileIds = [params['FILE_ID'], params['fileId']].flatMap((v) => (Array.isArray(v) ? v : []));
      return [
        {
          id,
          date: asText(m['date']),
          authorKind: kind,
          authorId,
          authorName: kind === 'system' ? 'Система' : asText(user['name']),
          text: bbToText(asText(m['text'])),
          files: fileIds.flatMap((fid) => {
            const f = files[asText(fid)];
            return isObj(f)
              ? [{ name: asText(f['name']), type: asText(f['type']), size: num(f['size']) ?? null }]
              : [];
          }),
        },
      ];
    })
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  const entityParts = asText(chat['entityId']).split('|');
  return {
    chatId,
    sessionId: idOf(res['sessionId']) ?? null,
    chatName: asText(chat['name']),
    connectorId: entityParts[0] ?? '',
    lineId: idOf(entityParts[1]) ?? null,
    crm: crmBindings(asText(chat['entityData2'])),
    messages,
  };
}

/** Дата сообщения попадает в период (строки ISO с зоной сравниваются как моменты времени). */
export function inPeriod(date: string, from: string | undefined, to: string | undefined): boolean {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return from === undefined && to === undefined;
  if (from !== undefined && t < Date.parse(from)) return false;
  if (to !== undefined && t > Date.parse(to)) return false;
  return true;
}

export const openlinesChatHistoryTool = defineTool({
  name: 'openlines_chat_history',
  module: 'openlines',
  title: 'Переписка в открытой линии',
  description:
    'Сообщения сессии открытой линии (imopenlines.session.history.get) по chatId (последняя сессия) или sessionId: ' +
    'дата, автор (client — клиент, operator — сотрудник, system — служебные), текст без разметки, имена файлов. ' +
    'Использовать, когда нужно прочитать переписку с клиентом из мессенджера или чата сайта; chatId — из openlines_crm_chats. ' +
    'Ссылки на файлы не отдаются. Длинная сессия — последние maxMessages сообщений. from/to — сообщения за период, textOnly=true — без системных строк. ' +
    'Весь список диалогов за период — openlines_dialogs_list, переписка в файл — openlines_chat_export.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      chatId: idSchema
        .optional()
        .describe('ID чата линии (без префикса chat); без sessionId — последняя сессия'),
      sessionId: idSchema.optional().describe('ID сессии (точнее, чем chatId)'),
      maxMessages: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Сколько последних сообщений отдать'),
      from: isoDateSchema.optional().describe('Только сообщения с этой даты (ISO 8601)'),
      to: isoDateSchema.optional().describe('Только сообщения до этой даты'),
      textOnly: z
        .boolean()
        .default(false)
        .describe(
          'Только сообщения клиента и оператора, без системных строк («оператор начал работу», «диалог завершён»)',
        ),
    })
    .strict()
    .refine((a) => a.chatId !== undefined || a.sessionId !== undefined, {
      message: 'укажите chatId или sessionId',
      path: ['chatId'],
    }),
  outputDataSchema: z.object({
    chatId: z.number(),
    sessionId: z.number().nullable(),
    chatName: z.string(),
    connectorId: z.string(),
    crm: z.record(z.string(), z.number()),
    messages: z.array(
      z.object({
        id: z.number(),
        date: z.string(),
        authorKind,
        authorId: z.number(),
        authorName: z.string(),
        text: z.string(),
        files: z.array(z.object({ name: z.string(), type: z.string(), size: z.number().nullable() })),
      }),
    ),
    returnedCount: z.number(),
    totalInSession: z.number(),
  }),
  handler: async (args, ctx) => {
    const h = await loadHistory(ctx, args);
    const messages = h.messages.filter(
      (m) => (!args.textOnly || m.authorKind !== 'system') && inPeriod(m.date, args.from, args.to),
    );
    const shown = messages.slice(-args.maxMessages);
    const warnings: string[] = [];
    if (shown.length < messages.length)
      warnings.push(
        `Показаны последние ${String(shown.length)} из ${String(messages.length)} сообщений сессии`,
      );
    if (args.sessionId === undefined)
      warnings.push('Без sessionId портал отдаёт последнюю сессию чата; ранние сессии — по их sessionId');
    return ok(
      {
        chatId: h.chatId,
        sessionId: h.sessionId,
        chatName: h.chatName,
        connectorId: h.connectorId,
        crm: h.crm,
        messages: shown,
        returnedCount: shown.length,
        totalInSession: h.messages.length,
      },
      meta(ctx, 'imopenlines.session.history.get', warnings, shown.length < messages.length),
    );
  },
});

export const openlinesTools = [openlinesListTool, openlinesCrmChatsTool, openlinesChatHistoryTool] as const;

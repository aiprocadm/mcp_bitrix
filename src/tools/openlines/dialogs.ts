/**
 * Диалоги открытых линий за период (заявка 2026-10-13, п. 4): «кому не ответили в WhatsApp за неделю» одним вызовом.
 * Сессии находятся по делам CRM открытых линий (crm.activity.list, PROVIDER_ID=IMOPENLINES_SESSION; ID сессии —
 * ASSOCIATED_ENTITY_ID дела), затем по каждой сессии сервер читает переписку (imopenlines.session.history.get)
 * и считает: сообщений клиента и оператора, кто написал последним, ждёт ли клиент ответа, время первого ответа.
 * В разговор — одна строка на диалог; текст переписки — openlines_chat_history или файлом через openlines_chat_export.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { checkFolder, downloadRoot, ensureFolder, safeFileName } from '../../files/download-store.js';
import { freeFileName } from '../../files/table-file.js';
import { ok } from '../../mcp/result.js';
import { NameResolver } from '../crm/names.js';
import { asText, idOf, idSchema, isObj, isoDateSchema, upstreamShapeError, yn } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { inPeriod, loadHistory, type History } from './openlines.js';

const OWNER_TYPES: Record<number, string> = { 1: 'lead', 2: 'deal', 3: 'contact', 4: 'company' };

/** Канал по ID коннектора открытой линии (Wazzup и др. ставят своё имя, но название мессенджера в нём есть). */
export function channelOf(connectorId: string): string {
  const c = connectorId.toLowerCase();
  if (c.includes('whatsapp') || c.includes('wz_wa') || c === 'wa') return 'WhatsApp';
  if (c.includes('telegram') || c.includes('tg')) return 'Telegram';
  if (/(^|[_.-])max($|[_.-])/.test(c) || c.includes('maxmessenger')) return 'Max';
  if (c.includes('viber')) return 'Viber';
  if (c.includes('vk')) return 'ВКонтакте';
  if (c.includes('avito')) return 'Авито';
  if (c.includes('instagram') || c.includes('fbinstagram')) return 'Instagram';
  if (c === 'livechat') return 'Онлайн-чат сайта';
  if (c.includes('mail')) return 'Почта';
  return connectorId || 'неизвестно';
}

interface SessionRef {
  sessionId: number;
  responsibleId: number | null;
  owner: { entityType: string; id: number } | null;
  completed: boolean;
}

/** Сессии открытых линий, активные в периоде: дело создано до `to` и обновлялось после `from`. */
async function sessionsInPeriod(
  ctx: ToolContext,
  opts: { from: string; to: string; operatorId?: number | undefined; limit: number; deadline: number },
): Promise<{ sessions: SessionRef[]; complete: boolean }> {
  const filter: JsonObject = {
    PROVIDER_ID: 'IMOPENLINES_SESSION',
    '>=LAST_UPDATED': opts.from,
    '<=CREATED': opts.to,
  };
  if (opts.operatorId !== undefined) filter['RESPONSIBLE_ID'] = opts.operatorId;
  const sessions: SessionRef[] = [];
  const seen = new Set<number>();
  let start = 0;
  while (Date.now() < opts.deadline) {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.activity.list',
      {
        filter,
        select: [
          'ID',
          'ASSOCIATED_ENTITY_ID',
          'RESPONSIBLE_ID',
          'OWNER_TYPE_ID',
          'OWNER_ID',
          'COMPLETED',
          'LAST_UPDATED',
        ],
        order: { LAST_UPDATED: 'DESC', ID: 'DESC' },
        start,
      },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!Array.isArray(r.result)) throw upstreamShapeError('crm.activity.list', 'legacy');
    for (const a of r.result.filter(isObj)) {
      const sessionId = idOf(a['ASSOCIATED_ENTITY_ID']);
      if (sessionId === undefined || seen.has(sessionId)) continue;
      seen.add(sessionId);
      const ownerType = OWNER_TYPES[idOf(a['OWNER_TYPE_ID']) ?? 0];
      const ownerId = idOf(a['OWNER_ID']);
      sessions.push({
        sessionId,
        responsibleId: idOf(a['RESPONSIBLE_ID']) ?? null,
        owner: ownerType && ownerId !== undefined ? { entityType: ownerType, id: ownerId } : null,
        completed: yn(a['COMPLETED']),
      });
      if (sessions.length >= opts.limit) return { sessions, complete: false };
    }
    if (r.next === undefined || r.next <= start) return { sessions, complete: true };
    start = r.next;
  }
  return { sessions, complete: false };
}

/** Итоги переписки сессии: кто писал, кто последний, сколько ждал клиент первого ответа. */
export function dialogStats(h: History, from?: string, to?: string) {
  const msgs = h.messages.filter((m) => m.authorKind !== 'system');
  const inRange = msgs.filter((m) => inPeriod(m.date, from, to));
  const last = msgs[msgs.length - 1];
  const firstClient = msgs.find((m) => m.authorKind === 'client');
  const firstReply = firstClient
    ? msgs.find((m) => m.authorKind === 'operator' && Date.parse(m.date) >= Date.parse(firstClient.date))
    : undefined;
  const replySec =
    firstClient && firstReply
      ? Math.round((Date.parse(firstReply.date) - Date.parse(firstClient.date)) / 1000)
      : null;
  return {
    messages: inRange.length,
    clientMessages: inRange.filter((m) => m.authorKind === 'client').length,
    operatorMessages: inRange.filter((m) => m.authorKind === 'operator').length,
    lastMessageAt: last?.date ?? null,
    lastFrom: last ? (last.authorKind as 'client' | 'operator') : null,
    waitingReply: last?.authorKind === 'client',
    operatorReplied: msgs.some((m) => m.authorKind === 'operator'),
    firstReplyMinutes: replySec === null || Number.isNaN(replySec) ? null : Math.round(replySec / 6) / 10,
  };
}

const dialogOut = z.object({
  sessionId: z.number(),
  chatId: z.number(),
  channel: z.string(),
  connectorId: z.string(),
  lineId: z.number().nullable(),
  lineName: z.string().nullable(),
  operatorId: z.number().nullable(),
  operatorName: z.string().nullable(),
  clientName: z.string(),
  crm: z.record(z.string(), z.number()),
  messages: z.number(),
  clientMessages: z.number(),
  operatorMessages: z.number(),
  lastMessageAt: z.string().nullable(),
  lastFrom: z.enum(['client', 'operator']).nullable(),
  waitingReply: z.boolean(),
  operatorReplied: z.boolean(),
  firstReplyMinutes: z.number().nullable(),
  closed: z.boolean(),
});

export const openlinesDialogsListTool = defineTool({
  name: 'openlines_dialogs_list',
  module: 'openlines',
  title: 'Диалоги открытых линий за период',
  description:
    'Все диалоги открытых линий (WhatsApp, Telegram, Max, чат сайта…) за период одной таблицей: канал, линия, оператор (ФИО), клиент и привязка CRM, ' +
    'дата последнего сообщения, сколько написали клиент и оператор, кто написал последним, ждёт ли клиент ответа (waitingReply), время первого ответа. ' +
    'Использовать для вопросов «кому не ответили в WhatsApp за неделю» (waitingOnly=true, channel=WhatsApp), «сколько обращений по каждому оператору». ' +
    'Переписка конкретного диалога — openlines_chat_history по sessionId. Диалоги ищутся по делам CRM открытых линий; до maxDialogs за вызов.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      from: isoDateSchema.describe('Начало периода (ISO 8601 с зоной)'),
      to: isoDateSchema.describe('Конец периода'),
      operatorId: idSchema.optional().describe('Только диалоги этого оператора'),
      lineId: idSchema.optional().describe('Только эта открытая линия (ID из openlines_list)'),
      channel: z
        .string()
        .min(2)
        .max(40)
        .optional()
        .describe('Только канал: WhatsApp, Telegram, Max, Viber, «Онлайн-чат сайта»…'),
      waitingOnly: z
        .boolean()
        .default(false)
        .describe('Только диалоги, где последним написал клиент (ждёт ответа)'),
      maxDialogs: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(150)
        .describe('Сколько диалогов проверить за вызов'),
    })
    .strict()
    .refine((a) => Date.parse(a.from) <= Date.parse(a.to), {
      message: 'from должен быть не позже to',
      path: ['to'],
    }),
  outputDataSchema: z.object({
    items: z.array(dialogOut),
    returnedCount: z.number(),
    checkedDialogs: z.number(),
    waitingReply: z.number(),
    complete: z.boolean(),
  }),
  handler: async (args, ctx) => {
    const deadline = ctx.startedAt + 100_000;
    const found = await sessionsInPeriod(ctx, {
      from: args.from,
      to: args.to,
      operatorId: args.operatorId,
      limit: args.maxDialogs,
      deadline,
    });
    // Названия линий — одним запросом; недоступность справочника не мешает списку.
    const lineNames = new Map<number, string>();
    try {
      const r = await ctx.bitrix.call(
        'legacy',
        'imopenlines.config.list.get',
        { PARAMS: { select: ['ID', 'LINE_NAME'], order: { ID: 'asc' }, limit: 200 } },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      if (Array.isArray(r.result))
        for (const x of r.result.filter(isObj)) {
          const id = idOf(x['ID']);
          if (id !== undefined) lineNames.set(id, asText(x['LINE_NAME']));
        }
    } catch (e) {
      if (ctx.signal?.aborted || !AppError.is(e)) throw e;
    }
    const names = new NameResolver(ctx);
    await names.loadUsers(found.sessions.map((s) => s.responsibleId).filter((u): u is number => u !== null));
    const items: z.infer<typeof dialogOut>[] = [];
    let checked = 0;
    let failed = 0;
    let complete = found.complete;
    const wanted = args.channel?.toLowerCase();
    for (const s of found.sessions) {
      if (Date.now() >= deadline) {
        complete = false;
        break;
      }
      let h: History;
      try {
        h = await loadHistory(ctx, { sessionId: s.sessionId });
      } catch (e) {
        if (ctx.signal?.aborted || !AppError.is(e)) throw e;
        failed++;
        continue;
      }
      checked++;
      const channel = channelOf(h.connectorId);
      if (args.lineId !== undefined && h.lineId !== args.lineId) continue;
      if (wanted && !channel.toLowerCase().includes(wanted) && !h.connectorId.toLowerCase().includes(wanted))
        continue;
      const stats = dialogStats(h, args.from, args.to);
      if (args.waitingOnly && !stats.waitingReply) continue;
      const crm = { ...h.crm };
      if (Object.keys(crm).length === 0 && s.owner) crm[s.owner.entityType] = s.owner.id;
      items.push({
        sessionId: s.sessionId,
        chatId: h.chatId,
        channel,
        connectorId: h.connectorId,
        lineId: h.lineId,
        lineName: h.lineId !== null ? (lineNames.get(h.lineId) ?? null) : null,
        operatorId: s.responsibleId,
        operatorName: names.userName(s.responsibleId),
        clientName: h.chatName,
        crm,
        ...stats,
        closed: s.completed,
      });
    }
    items.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    const warnings = [...names.warnings];
    if (!complete)
      warnings.push(
        `Проверены не все диалоги периода (предел maxDialogs=${String(args.maxDialogs)} или времени) — сузьте период или оператора`,
      );
    if (failed)
      warnings.push(`Переписка ${String(failed)} диалогов недоступна (нет прав или сессия удалена)`);
    return ok(
      {
        items,
        returnedCount: items.length,
        checkedDialogs: checked,
        waitingReply: items.filter((i) => i.waitingReply).length,
        complete,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'imopenlines.session.history.get',
        apiVersion: 'legacy',
        completeness: complete ? 'complete' : 'partial',
        warnings,
      },
    );
  },
});

export const openlinesChatExportTool = defineTool({
  name: 'openlines_chat_export',
  module: 'openlines',
  title: 'Переписку открытой линии в файл',
  description:
    'Сохранить переписку диалога открытой линии в текстовый файл в DOWNLOAD_DIR: «дата время — автор: текст», с именами файлов-вложений. ' +
    'Использовать, когда переписка длинная и нужна целиком (прочитать, переслать, разобрать), а не в ответе. chatId или sessionId — из openlines_dialogs_list ' +
    'или openlines_crm_chats. textOnly=true — без системных строк. Портал не меняется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      chatId: idSchema.optional().describe('ID чата линии; без sessionId — последняя сессия'),
      sessionId: idSchema.optional().describe('ID сессии'),
      textOnly: z.boolean().default(true).describe('Без системных строк'),
      folder: z.string().min(1).max(200).default('переписка').describe('Подпапка внутри DOWNLOAD_DIR'),
    })
    .strict()
    .refine((a) => a.chatId !== undefined || a.sessionId !== undefined, {
      message: 'укажите chatId или sessionId',
      path: ['chatId'],
    }),
  outputDataSchema: z.object({
    path: z.string(),
    messages: z.number(),
    chatName: z.string(),
    channel: z.string(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const dir = await ensureFolder(root, checkFolder(args.folder));
    const h = await loadHistory(ctx, args);
    const msgs = h.messages.filter((m) => !args.textOnly || m.authorKind !== 'system');
    const who = { client: 'Клиент', operator: 'Оператор', system: 'Система' };
    const lines = msgs.map((m) => {
      const files = m.files.length ? ` [файлы: ${m.files.map((f) => f.name).join(', ')}]` : '';
      const date = m.date.replace('T', ' ').slice(0, 16);
      return `${date} — ${who[m.authorKind]}${m.authorName && m.authorKind !== 'system' ? ` (${m.authorName})` : ''}: ${m.text}${files}`;
    });
    const channel = channelOf(h.connectorId);
    const head = [
      `Диалог: ${h.chatName}`,
      `Канал: ${channel}`,
      `Чат ${String(h.chatId)}${h.sessionId !== null ? `, сессия ${String(h.sessionId)}` : ''}`,
      '',
    ];
    const base = safeFileName(
      `${(msgs[0]?.date ?? '').slice(0, 10) || 'без-даты'}_${h.chatName || 'диалог'}_сессия${String(h.sessionId ?? h.chatId)}`,
      'диалог',
    );
    const name = await freeFileName(dir, base, 'txt');
    const file = path.join(dir, name);
    await writeFile(file, [...head, ...lines].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    return ok(
      { path: file, messages: msgs.length, chatName: h.chatName, channel },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'imopenlines.session.history.get',
        apiVersion: 'legacy',
        completeness: 'complete',
        warnings:
          args.sessionId === undefined
            ? ['Без sessionId портал отдаёт последнюю сессию чата; ранние сессии — по их sessionId']
            : [],
      },
    );
  },
});

/**
 * telephony_calls_list (ТЗ §9.9, заявка 2026-10-13 п. 3): история звонков voximplant.statistic.get.
 * Ссылки на записи и логи (CALL_RECORD_URL, CALL_LOG), расшифровки и комментарии не выдаются; вместо ссылки —
 * ID файла записи на Диске (recordFileId: RECORD_FILE_ID звонка или файл дела-звонка CRM), по нему запись
 * скачивается сервером (disk_file_download, calls_recordings_download) или переводится в текст (call_transcribe).
 * Номер абонента по умолчанию маскируется (§8.4). Фильтры направления, результата, длительности, линии,
 * привязки к CRM и последних цифр номера проверяются сервером MCP; mode=summary — сводка по сотрудникам и линиям.
 * Полнота внешней АТС не гарантируется; отсутствие модуля телефонии → FEATURE_UNAVAILABLE.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { asText, idOf, idSchema, isObj, isoDateSchema, num, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { offsetPage } from '../company/offset-page.js';
import { isEmptyValue, NameResolver } from '../crm/names.js';

const CALL_TYPES: Record<string, string> = {
  '1': 'outgoing',
  '2': 'incoming',
  '3': 'incoming-redirected',
  '4': 'callback',
  '5': 'info',
};
const INCOMING = new Set(['2', '3', '4']);

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return digits ? '***' : '';
  return `***${digits.slice(-4)}`;
}

export interface Call {
  id: number;
  callId?: string | null;
  userId: number | null;
  userName?: string | null;
  type: string;
  category?: string | null;
  startDate: string | null;
  durationSec: number;
  answered: boolean;
  resultCode: string | null;
  resultReason?: string | null;
  phoneNumber: string | null;
  lineNumber: string | null;
  crm: { entityType: string; entityId: number | null } | null;
  crmActivityId: number | null;
  hasRecording: boolean;
  recordFileId?: number | null;
}

/** Явный allowlist: всё, чего здесь нет (в т.ч. ссылки на записи/логи), в ответ не попадает. */
export function normalizeCall(raw: JsonValue, includePhoneNumbers: boolean): Call | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  const phone = asText(raw['PHONE_NUMBER']);
  const typeCode = asText(raw['CALL_TYPE']);
  const crmType = asText(raw['CRM_ENTITY_TYPE']);
  const resultCode = asText(raw['CALL_FAILED_CODE']) || null;
  const recordFileId = idOf(raw['RECORD_FILE_ID']) ?? null;
  return {
    id,
    callId: asText(raw['CALL_ID']) || null,
    userId: idOf(raw['PORTAL_USER_ID']) ?? null,
    type: CALL_TYPES[typeCode] ?? 'unknown',
    category: asText(raw['CALL_CATEGORY']) || null,
    startDate: asText(raw['CALL_START_DATE']) || null,
    durationSec: num(raw['CALL_DURATION']) ?? 0,
    answered: resultCode === '200',
    resultCode,
    resultReason: asText(raw['CALL_FAILED_REASON']) || null,
    phoneNumber: includePhoneNumbers ? phone || null : phone ? maskPhone(phone) : null,
    lineNumber: asText(raw['PORTAL_NUMBER']) || null,
    crm: crmType ? { entityType: crmType, entityId: idOf(raw['CRM_ENTITY_ID']) ?? null } : null,
    crmActivityId: idOf(raw['CRM_ACTIVITY_ID']) ?? null,
    hasRecording: Boolean(asText(raw['CALL_RECORD_URL']) || recordFileId),
    recordFileId,
  };
}

// ---------- фильтры ----------

export const callFiltersShape = {
  direction: z
    .enum(['incoming', 'outgoing'])
    .optional()
    .describe('incoming — входящие (в т. ч. переадресованные и обратные), outgoing — исходящие'),
  status: z
    .enum(['answered', 'missed'])
    .optional()
    .describe('answered — разговор состоялся (код 200), missed — не состоялся (для входящих — пропущен)'),
  minDurationSec: z.number().int().min(0).max(86_400).optional().describe('Длительность от N секунд'),
  lineNumber: z.string().min(1).max(100).optional().describe('Линия (номер портала, PORTAL_NUMBER)'),
  crmBound: z.boolean().optional().describe('true — только привязанные к CRM, false — только без привязки'),
  phoneLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Последние 4 цифры номера абонента (номер в ответе остаётся скрытым)'),
};

export interface CallFilters {
  direction?: 'incoming' | 'outgoing' | undefined;
  status?: 'answered' | 'missed' | undefined;
  minDurationSec?: number | undefined;
  lineNumber?: string | undefined;
  crmBound?: boolean | undefined;
  phoneLast4?: string | undefined;
}

export const hasCallFilters = (f: CallFilters) =>
  f.direction !== undefined ||
  f.status !== undefined ||
  f.minDurationSec !== undefined ||
  f.lineNumber !== undefined ||
  f.crmBound !== undefined ||
  f.phoneLast4 !== undefined;

/** Проверка звонка по фильтрам — по исходной строке voximplant.statistic.get. */
export function passesCallFilters(raw: JsonValue, f: CallFilters): boolean {
  if (!isObj(raw)) return false;
  const type = asText(raw['CALL_TYPE']);
  if (f.direction === 'incoming' && !INCOMING.has(type)) return false;
  if (f.direction === 'outgoing' && type !== '1') return false;
  const answered = asText(raw['CALL_FAILED_CODE']) === '200';
  if (f.status === 'answered' && !answered) return false;
  if (f.status === 'missed' && answered) return false;
  if (f.minDurationSec !== undefined && (num(raw['CALL_DURATION']) ?? 0) < f.minDurationSec) return false;
  if (f.lineNumber !== undefined && asText(raw['PORTAL_NUMBER']) !== f.lineNumber) return false;
  if (f.crmBound !== undefined && Boolean(asText(raw['CRM_ENTITY_TYPE'])) !== f.crmBound) return false;
  if (f.phoneLast4 !== undefined && !asText(raw['PHONE_NUMBER']).replace(/\D/g, '').endsWith(f.phoneLast4))
    return false;
  return true;
}

export function periodFilter(from: string, to: string, userId: number | undefined): JsonObject {
  const filter: JsonObject = { '>=CALL_START_DATE': from, '<=CALL_START_DATE': to };
  if (userId !== undefined) filter['PORTAL_USER_ID'] = userId;
  return filter;
}

export function telephonyUnavailable(e: unknown): unknown {
  if (AppError.is(e) && e.code === 'FEATURE_UNAVAILABLE') {
    return new AppError(
      'FEATURE_UNAVAILABLE',
      'Телефония недоступна на портале (модуль или метод отсутствует)',
      {
        ...e.details,
        reason: 'TELEPHONY_UNAVAILABLE',
        nextAction: 'Проверьте, что модуль телефонии подключён и вебхуку выдан scope telephony',
      },
    );
  }
  return e;
}

/**
 * Все звонки периода (с локальными фильтрами) — для сводки и пакетного скачивания записей.
 * Обход по start пачками по 50, до maxCalls строк и до deadline.
 */
export async function fetchAllCalls(
  ctx: ToolContext,
  opts: { filter: JsonObject; keep: (raw: JsonValue) => boolean; maxCalls: number; deadline: number },
): Promise<{ rows: JsonValue[]; complete: boolean; scanned: number }> {
  const rows: JsonValue[] = [];
  let start = 0;
  let scanned = 0;
  while (Date.now() < opts.deadline && rows.length < opts.maxCalls) {
    let r;
    try {
      r = await ctx.bitrix.call(
        'legacy',
        'voximplant.statistic.get',
        { FILTER: opts.filter, SORT: 'CALL_START_DATE', ORDER: 'ASC', start },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
    } catch (e) {
      throw telephonyUnavailable(e);
    }
    if (!Array.isArray(r.result))
      throw new AppError('BITRIX_UPSTREAM_ERROR', 'voximplant.statistic.get вернул не массив');
    scanned += r.result.length;
    rows.push(...r.result.filter(opts.keep));
    if (r.next === undefined || r.next <= start)
      return { rows: rows.slice(0, opts.maxCalls), complete: true, scanned };
    start = r.next;
  }
  return { rows: rows.slice(0, opts.maxCalls), complete: false, scanned };
}

/**
 * ID файлов записей по делам-звонкам CRM (у внешних АТС запись лежит в FILES дела, а не в RECORD_FILE_ID).
 * Сначала одним запросом crm.activity.list с select FILES; если портал поле не вернул — crm.activity.get по каждому.
 */
export async function recordFilesByActivity(
  ctx: ToolContext,
  activityIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = [...new Set(activityIds)];
  const firstFile = (files: JsonValue | undefined): number | undefined => {
    if (!Array.isArray(files)) return undefined;
    for (const f of files) {
      const id = isObj(f) ? idOf(f['id'] ?? f['ID']) : idOf(f);
      if (id !== undefined) return id;
    }
    return undefined;
  };
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const pending = new Set(chunk);
    try {
      const r = await ctx.bitrix.call(
        'legacy',
        'crm.activity.list',
        { filter: { '@ID': chunk }, select: ['ID', 'FILES'], order: { ID: 'ASC' } },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      if (Array.isArray(r.result)) {
        for (const row of r.result.filter(isObj)) {
          const id = idOf(row['ID']);
          if (id === undefined || !('FILES' in row)) continue;
          pending.delete(id);
          const file = firstFile(row['FILES']);
          if (file !== undefined) out.set(id, file);
        }
      }
    } catch (e) {
      if (ctx.signal?.aborted || !AppError.is(e)) throw e;
    }
    for (const id of pending) {
      try {
        const r = await ctx.bitrix.call(
          'legacy',
          'crm.activity.get',
          { id },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const file = isObj(r.result) ? firstFile(r.result['FILES']) : undefined;
        if (file !== undefined) out.set(id, file);
      } catch (e) {
        if (ctx.signal?.aborted || !AppError.is(e)) throw e;
      }
    }
  }
  return out;
}

/** Добавляет recordFileId из дел CRM тем звонкам, у которых его нет в статистике. */
export async function fillRecordFiles(ctx: ToolContext, calls: Call[]): Promise<void> {
  const need = calls.filter((c) => !c.recordFileId && c.crmActivityId && c.durationSec > 0);
  if (need.length === 0) return;
  const files = await recordFilesByActivity(
    ctx,
    need.map((c) => c.crmActivityId ?? 0),
  );
  for (const c of need) {
    const f = files.get(c.crmActivityId ?? 0);
    if (f !== undefined) {
      c.recordFileId = f;
      c.hasRecording = true;
    }
  }
}

// ---------- сводка ----------

interface Bucket {
  total: number;
  incoming: number;
  outgoing: number;
  answered: number;
  missed: number;
  talkSec: number;
}
const emptyBucket = (): Bucket => ({
  total: 0,
  incoming: 0,
  outgoing: 0,
  answered: 0,
  missed: 0,
  talkSec: 0,
});

function addTo(b: Bucket, raw: Record<string, JsonValue>): void {
  b.total += 1;
  if (INCOMING.has(asText(raw['CALL_TYPE']))) b.incoming += 1;
  else if (asText(raw['CALL_TYPE']) === '1') b.outgoing += 1;
  if (asText(raw['CALL_FAILED_CODE']) === '200') {
    b.answered += 1;
    b.talkSec += num(raw['CALL_DURATION']) ?? 0;
  } else b.missed += 1;
}

const bucketOut = (b: Bucket) => ({
  total: b.total,
  incoming: b.incoming,
  outgoing: b.outgoing,
  answered: b.answered,
  missed: b.missed,
  talkMinutes: Math.round((b.talkSec / 60) * 10) / 10,
  avgTalkSec: b.answered ? Math.round(b.talkSec / b.answered) : 0,
});

const summaryRow = z.object({
  total: z.number(),
  incoming: z.number(),
  outgoing: z.number(),
  answered: z.number(),
  missed: z.number(),
  talkMinutes: z.number(),
  avgTalkSec: z.number(),
});

export const telephonyCallsListTool = defineTool({
  name: 'telephony_calls_list',
  module: 'telephony',
  title: 'История звонков',
  description:
    'История звонков портала за период (voximplant.statistic.get): время, направление, длительность, состоялся ли разговор, сотрудник (ФИО), ' +
    'привязка к CRM, recordFileId — ID файла записи на Диске. Использовать для вопросов «кто кому звонил», «сколько пропущенных», «звонки сотрудника за неделю». ' +
    'Фильтры сервера: direction, status (answered/missed), minDurationSec, lineNumber, crmBound, phoneLast4. ' +
    'mode=summary — вместо списка сводка по сотрудникам и линиям (всего, входящие, исходящие, отвечено, пропущено, минуты разговора) одним вызовом. ' +
    'Ссылок на записи нет: запись скачать — disk_file_download по recordFileId или calls_recordings_download за период; текст — call_transcribe. ' +
    'Номер абонента маскируется; includePhoneNumbers=true — только для роли administrator или по профилю выдачи. Полнота внешней АТС не гарантируется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      from: isoDateSchema.describe('Начало периода (ISO 8601, со смещением зоны)'),
      to: isoDateSchema.describe('Конец периода (ISO 8601)'),
      userId: idSchema.optional().describe('Только звонки этого сотрудника'),
      ...callFiltersShape,
      mode: z
        .enum(['list', 'summary'])
        .default('list')
        .describe('list — страница звонков; summary — сводка по сотрудникам и линиям за весь период'),
      withRecordFiles: z
        .boolean()
        .default(true)
        .describe('Найти ID файла записи в деле CRM, если его нет в статистике (внешние АТС)'),
      compact: z
        .boolean()
        .default(true)
        .describe('Короткий ответ: без callId, категории, текста причины и пустых полей'),
      includePhoneNumbers: z
        .boolean()
        .default(false)
        .describe('Показать номер абонента полностью (персональные данные; по умолчанию маска ***1234)'),
      ...pageArgsShape,
    })
    .strict()
    .refine((a) => Date.parse(a.from) <= Date.parse(a.to), {
      message: 'from должен быть не позже to',
      path: ['to'],
    }),
  outputDataSchema: z.object({
    items: z
      .array(
        z.object({
          id: z.number(),
          callId: z.string().nullable().optional(),
          userId: z.number().nullable().optional(),
          userName: z.string().nullable().optional(),
          type: z.string(),
          category: z.string().nullable().optional(),
          startDate: z.string().nullable().optional(),
          durationSec: z.number(),
          answered: z.boolean(),
          resultCode: z.string().nullable().optional(),
          resultReason: z.string().nullable().optional(),
          phoneNumber: z.string().nullable().optional(),
          lineNumber: z.string().nullable().optional(),
          crm: z.object({ entityType: z.string(), entityId: z.number().nullable() }).nullable().optional(),
          crmActivityId: z.number().nullable().optional(),
          hasRecording: z.boolean(),
          recordFileId: z.number().nullable().optional(),
        }),
      )
      .optional(),
    returnedCount: z.number().optional(),
    total: z.number().nullable().optional(),
    summary: z
      .object({
        all: summaryRow,
        byUser: z.array(
          summaryRow.extend({ userId: z.number().nullable(), userName: z.string().nullable() }),
        ),
        byLine: z.array(summaryRow.extend({ lineNumber: z.string().nullable() })),
        scannedCalls: z.number(),
        complete: z.boolean(),
      })
      .optional(),
  }),
  handler: async (args, ctx) => {
    // Полный номер абонента — персональные данные (§8.4): флаг модели сам по себе не расширяет выдачу.
    // Нужна роль administrator либо явный профиль выдачи telephony.calls с полем phoneNumber.
    if (
      args.includePhoneNumbers &&
      ctx.principal.role !== 'administrator' &&
      !ctx.outputPolicy.allowedFields(ctx.principal.role, 'telephony', 'calls')?.has('phoneNumber')
    ) {
      throw new AppError('ACCESS_DENIED', 'Полные номера абонентов доступны только по политике выдачи', {
        field: 'includePhoneNumbers',
        reason: 'PERSONAL_DATA_POLICY',
        nextAction:
          'Повторите без includePhoneNumbers (номера маскируются) или добавьте phoneNumber в профиль telephony.calls',
      });
    }
    const filter = periodFilter(args.from, args.to, args.userId);
    const filters: CallFilters = args;
    const keep = (raw: JsonValue) => passesCallFilters(raw, filters);
    const names = new NameResolver(ctx);

    if (args.mode === 'summary') {
      const all = await fetchAllCalls(ctx, {
        filter,
        keep,
        maxCalls: 50_000,
        deadline: ctx.startedAt + 100_000,
      });
      const total = emptyBucket();
      const byUser = new Map<number | null, Bucket>();
      const byLine = new Map<string | null, Bucket>();
      for (const raw of all.rows.filter(isObj)) {
        addTo(total, raw);
        const u = idOf(raw['PORTAL_USER_ID']) ?? null;
        const l = asText(raw['PORTAL_NUMBER']) || null;
        if (!byUser.has(u)) byUser.set(u, emptyBucket());
        if (!byLine.has(l)) byLine.set(l, emptyBucket());
        addTo(byUser.get(u) ?? emptyBucket(), raw);
        addTo(byLine.get(l) ?? emptyBucket(), raw);
      }
      await names.loadUsers([...byUser.keys()].filter((k): k is number => k !== null));
      const warnings = [...names.warnings, 'История не гарантирует полноту звонков внешней АТС'];
      if (!all.complete)
        warnings.push(
          `Сводка неполная: просмотрено ${String(all.scanned)} звонков — сузьте период или выберите сотрудника`,
        );
      return ok(
        {
          summary: {
            all: bucketOut(total),
            byUser: [...byUser]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([userId, b]) => ({ userId, userName: names.userName(userId), ...bucketOut(b) })),
            byLine: [...byLine]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([lineNumber, b]) => ({ lineNumber, ...bucketOut(b) })),
            scannedCalls: all.scanned,
            complete: all.complete,
          },
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          method: 'voximplant.statistic.get',
          apiVersion: 'legacy' as const,
          completeness: all.complete ? ('complete' as const) : ('partial' as const),
          warnings,
        },
      );
    }

    const pageSize = pageSizeOf(ctx, args.pageSize);
    const filtered = hasCallFilters(filters);
    let page;
    try {
      page = await offsetPage(ctx, {
        tool: 'telephony_calls_list',
        method: 'voximplant.statistic.get',
        params: { FILTER: filter, SORT: 'CALL_START_DATE', ORDER: 'DESC' },
        bindingParts: {
          from: args.from,
          to: args.to,
          userId: args.userId ?? null,
          direction: args.direction ?? null,
          status: args.status ?? null,
          minDurationSec: args.minDurationSec ?? null,
          lineNumber: args.lineNumber ?? null,
          crmBound: args.crmBound ?? null,
          phoneLast4: args.phoneLast4 ?? null,
        },
        pageSize,
        cursor: args.cursor,
        ...(filtered ? { keep, maxUpstreamCalls: 10 } : {}),
      });
    } catch (e) {
      throw telephonyUnavailable(e);
    }
    const calls = page.items
      .map((c) => normalizeCall(c, args.includePhoneNumbers))
      .filter((c): c is Call => c !== undefined);
    if (args.withRecordFiles) await fillRecordFiles(ctx, calls);
    await names.loadUsers(calls.map((c) => c.userId).filter((u): u is number => u !== null));
    const items = calls.map((c) => {
      const full: Call = { ...c, userName: names.userName(c.userId) };
      if (!args.compact) return full;
      const { callId: _c, category: _cat, resultReason: _r, ...rest } = full;
      return Object.fromEntries(
        Object.entries(rest).filter(([k, v]) => k === 'hasRecording' || k === 'answered' || !isEmptyValue(v)),
      ) as Omit<Call, 'callId' | 'category' | 'resultReason'>;
    });
    const warnings = [
      ...names.warnings,
      'История не гарантирует полноту звонков внешней АТС; ссылки на записи не выдаются',
    ];
    if (args.includePhoneNumbers) warnings.push('Номера абонентов показаны полностью (персональные данные)');
    if (filtered && page.budgetExhausted && page.hasMore)
      warnings.push('Фильтр отсеял много звонков: страница короче pageSize, продолжение — по cursor');
    return ok(
      { items, returnedCount: items.length, total: filtered ? null : (page.total ?? null) },
      pageMeta(ctx, 'voximplant.statistic.get', page, 'legacy', warnings),
    );
  },
});

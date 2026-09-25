/**
 * Чтение календаря (ТЗ §9.3, T28): calendar_list, calendar_list_events, employee_availability.
 * calendar.event.get отдаёт весь период одним ответом — страницы по pageSize выдаются из снимка,
 * сохранённого в серверном курсоре (привязан к пользователю и параметрам выборки).
 * Занятость — данные календаря, а не присутствие на работе; без данных «свободен» не утверждается.
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { asText, idOf, isObj, pageSizeOf, statefulPage, upstreamShapeError, yn } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  allDayDate,
  calendarRef,
  calendarTypeSchema,
  currentUserId,
  eventTimes,
  normalizeEvent,
  ownerIdSchema,
  parseRange,
  type CalendarEvent,
} from './common.js';
import { dateInZone, unixToIsoInZone, zonedDayStart, addDays } from './time.js';

const rangeFrom = z
  .string()
  .min(10)
  .max(40)
  .describe('Начало: дата YYYY-MM-DD (в зоне timezone) либо ISO с явным смещением 2026-10-01T09:00:00+03:00');
const rangeTo = z
  .string()
  .min(10)
  .max(40)
  .describe('Конец: YYYY-MM-DD включительно либо ISO с явным смещением (должно быть позже from)');
const tzArg = z
  .string()
  .max(64)
  .optional()
  .describe(
    'IANA-зона для дат без времени и для показа результата; по умолчанию зона портала из конфигурации',
  );

// ---------- calendar_list ----------

export const calendarListTool = defineTool({
  name: 'calendar_list',
  module: 'calendar',
  title: 'Календари сотрудника, группы или компании',
  description:
    'Список календарей (разделов) Bitrix24 через calendar.section.get: ID, название, тип, владелец и права текущего пользователя ' +
    '(видеть время/название/всё, добавлять, редактировать). Использовать перед calendar_list_events или calendar_create_event, ' +
    'чтобы узнать sectionId. type=user + ownerId сотрудника, type=group + ownerId группы, type=company — общий календарь компании.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ type: calendarTypeSchema, ownerId: ownerIdSchema.optional() }).strict(),
  outputDataSchema: z.object({
    type: z.string(),
    ownerId: z.number(),
    sections: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        description: z.string().optional(),
        color: z.string().optional(),
        calendarType: z.string(),
        ownerId: z.number().optional(),
        externalType: z.string().optional(),
        isCollab: z.boolean(),
        permissions: z.record(z.string(), z.boolean()),
      }),
    ),
  }),
  handler: async (args, ctx) => {
    const ref = calendarRef(args.type, args.ownerId);
    const r = await ctx.bitrix.call('legacy', 'calendar.section.get', ref, {
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    if (!Array.isArray(r.result)) throw upstreamShapeError('calendar.section.get', 'legacy');
    const sections = r.result.filter(isObj).flatMap((s) => {
      const id = idOf(s['ID']);
      if (id === undefined) return [];
      const perm = isObj(s['PERM']) ? s['PERM'] : {};
      const permissions: Record<string, boolean> = {};
      for (const [k, key] of [
        ['view_time', 'viewTime'],
        ['view_title', 'viewTitle'],
        ['view_full', 'viewFull'],
        ['add', 'add'],
        ['edit', 'edit'],
        ['edit_section', 'editSection'],
        ['access', 'access'],
      ] as const) {
        if (perm[k] !== undefined) permissions[key] = yn(perm[k]);
      }
      const owner = idOf(s['OWNER_ID']);
      return [
        {
          id,
          name: asText(s['NAME']),
          ...(asText(s['DESCRIPTION']) ? { description: asText(s['DESCRIPTION']).slice(0, 500) } : {}),
          ...(asText(s['COLOR']) ? { color: asText(s['COLOR']) } : {}),
          calendarType: asText(s['CAL_TYPE']) || ref.type,
          ...(owner !== undefined ? { ownerId: owner } : {}),
          ...(asText(s['EXTERNAL_TYPE']) ? { externalType: asText(s['EXTERNAL_TYPE']) } : {}),
          isCollab: yn(s['IS_COLLAB']),
          permissions,
        },
      ];
    });
    const warnings =
      sections.length >= 50
        ? ['Портал вернул 50 календарей — возможно, это не весь список (метод отдаёт одну страницу)']
        : [];
    return ok(
      { type: args.type, ownerId: ref.ownerId, sections },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'calendar.section.get',
        apiVersion: 'legacy',
        completeness: warnings.length ? 'unknown' : 'complete',
        warnings,
      },
    );
  },
});

// ---------- calendar_list_events ----------

const MAX_EVENTS_DAYS = 93;
const SNAPSHOT_LIMIT = 1000;

interface EventsState {
  snapshot?: CalendarEvent[];
  offset: number;
  truncated?: boolean;
  unknownTimes?: number;
}

const eventOut = z.object({
  id: z.number(),
  name: z.string(),
  from: z.string(),
  to: z.string(),
  allDay: z.boolean(),
  eventTimezone: z.string().optional(),
  sectionId: z.number().optional(),
  recurring: z.boolean(),
  recurrence: z.string().optional(),
  isMeeting: z.boolean(),
  hostId: z.number().optional(),
  myStatus: z.string().optional(),
  attendees: z.array(z.object({ id: z.number(), status: z.string() })),
  location: z.string().optional(),
  accessibility: z.string().optional(),
  importance: z.string().optional(),
  private: z.boolean(),
  description: z.string().optional(),
});

export const calendarListEventsTool = defineTool({
  name: 'calendar_list_events',
  module: 'calendar',
  title: 'События календаря за период',
  description:
    'События календаря Bitrix24 за период (calendar.event.get): название, начало/конец со смещением зоны, весь день, участники и их ответы, ' +
    'повторяемость. Использовать, когда спрашивают «что у меня/у сотрудника в календаре на неделе», «какие встречи в группе». ' +
    'from/to — обе даты YYYY-MM-DD (включительно) либо обе ISO с явным смещением; период не длиннее 93 дней; to позже from. ' +
    'sectionIds сужает до выбранных календарей (calendar_list). Повторяющиеся события показываются вхождениями с recurring=true. ' +
    'Страница до 50 событий, продолжение — по cursor (снимок на момент первого запроса).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      type: calendarTypeSchema,
      ownerId: ownerIdSchema.optional(),
      from: rangeFrom,
      to: rangeTo,
      timezone: tzArg,
      sectionIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    type: z.string(),
    ownerId: z.number(),
    timezone: z.string(),
    items: z.array(eventOut),
    returnedCount: z.number(),
    totalInSnapshot: z.number(),
  }),
  handler: async (args, ctx) => {
    const ref = calendarRef(args.type, args.ownerId);
    const range = parseRange(
      args.from,
      args.to,
      args.timezone ?? ctx.config.bitrix.timezone,
      MAX_EVENTS_DAYS,
    );
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const sections = args.sectionIds ? [...new Set(args.sectionIds)].sort((a, b) => a - b) : undefined;
    let snapshotInfo: EventsState = { offset: 0 };
    const page = await statefulPage<EventsState>(ctx, {
      tool: 'calendar_list_events',
      bindingParts: {
        ...ref,
        fromTs: range.fromTs,
        toTs: range.toTs,
        timezone: range.timezone,
        sections: sections ?? null,
        pageSize,
      },
      cursor: args.cursor,
      initial: { offset: 0 },
      fetch: async (state) => {
        let snapshot = state.snapshot;
        let truncated = state.truncated ?? false;
        let unknownTimes = state.unknownTimes ?? 0;
        if (!snapshot) {
          const meId = ref.type === 'user' ? await currentUserId(ctx).catch(() => undefined) : undefined;
          const r = await ctx.bitrix.call(
            'legacy',
            'calendar.event.get',
            {
              ...ref,
              from: range.bitrixFrom,
              to: range.bitrixTo,
              ...(sections ? { section: sections } : {}),
            },
            { requestId: ctx.requestId, signal: ctx.signal },
          );
          if (!Array.isArray(r.result)) throw upstreamShapeError('calendar.event.get', 'legacy');
          const all: CalendarEvent[] = [];
          for (const raw of r.result) {
            if (!isObj(raw) || yn(raw['DELETED'])) continue;
            const t = eventTimes(raw);
            if (t.fromTs !== undefined && t.toTs !== undefined) {
              // событие на весь день может иметь конец = начало последнего дня
              const end = t.allDay ? Math.max(t.toTs, t.fromTs) + 86_400 : Math.max(t.toTs, t.fromTs + 1);
              if (!(t.fromTs < range.toTs && end > range.fromTs)) continue;
            } else {
              unknownTimes += 1;
            }
            if (sections) {
              const sec = idOf(raw['SECTION_ID'] ?? raw['SECT_ID']);
              if (sec !== undefined && !sections.includes(sec)) continue;
            }
            const ev = normalizeEvent(raw, range.timezone, meId);
            if (ev) all.push(ev);
          }
          all.sort((a, b) => (a.fromTs ?? 0) - (b.fromTs ?? 0) || a.id - b.id);
          truncated = all.length > SNAPSHOT_LIMIT;
          snapshot = all.slice(0, SNAPSHOT_LIMIT);
        }
        const items = snapshot.slice(state.offset, state.offset + pageSize);
        const nextOffset = state.offset + pageSize;
        snapshotInfo = { snapshot, offset: state.offset, truncated, unknownTimes };
        return {
          items: items as unknown as JsonValue[],
          next:
            nextOffset < snapshot.length
              ? { snapshot, offset: nextOffset, truncated, unknownTimes }
              : undefined,
        };
      },
    });
    const items = (page.items as unknown as CalendarEvent[]).map((e) => {
      const { fromTs: _f, toTs: _t, ...rest } = e;
      return rest;
    });
    const warnings: string[] = [];
    if (args.cursor) warnings.push('Страница из снимка первого запроса; изменения после него не отражены');
    if (snapshotInfo.truncated)
      warnings.push(`В периоде больше ${String(SNAPSHOT_LIMIT)} событий; показаны первые — сузьте период`);
    if (snapshotInfo.unknownTimes)
      warnings.push(
        `${String(snapshotInfo.unknownTimes)} событий без распознанного времени включены без точной проверки периода`,
      );
    const partial = page.hasMore || snapshotInfo.truncated === true;
    return ok(
      {
        type: args.type,
        ownerId: ref.ownerId,
        timezone: range.timezone,
        items,
        returnedCount: items.length,
        totalInSnapshot: snapshotInfo.snapshot?.length ?? items.length,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'calendar.event.get',
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: partial ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

// ---------- employee_availability ----------

const MAX_AVAILABILITY_DAYS = 62;

type BusyKind = 'busy' | 'absent' | 'tentative';
const KIND: Record<string, BusyKind> = { busy: 'busy', absent: 'absent', quest: 'tentative' };

interface Interval {
  from: number;
  to: number;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ ...i });
  }
  return out;
}

export const employeeAvailabilityTool = defineTool({
  name: 'employee_availability',
  module: 'calendar',
  title: 'Календарная занятость сотрудников',
  description:
    'Занятость сотрудников по данным их календарей Bitrix24 (calendar.accessibility.get): интервалы busy/absent/tentative и свободные ' +
    'промежутки внутри периода. Использовать, чтобы подобрать время встречи для нескольких человек (до 50). Это только календарь — ' +
    'не присутствие на работе и не загрузка задачами. Если по сотруднику данных нет, completeness=unknown и свободное время не ' +
    'утверждается. from/to — обе даты YYYY-MM-DD или обе ISO с явным смещением; период до 62 дней. Названия чужих событий не выдаются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      userIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(50),
      from: rangeFrom,
      to: rangeTo,
      timezone: tzArg,
    })
    .strict(),
  outputDataSchema: z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
    users: z.array(
      z.object({
        userId: z.number(),
        completeness: z.enum(['complete', 'unknown']),
        busy: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            allDay: z.boolean(),
            kind: z.enum(['busy', 'absent', 'tentative']),
          }),
        ),
        free: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        note: z.string().optional(),
      }),
    ),
  }),
  handler: async (args, ctx) => {
    const range = parseRange(
      args.from,
      args.to,
      args.timezone ?? ctx.config.bitrix.timezone,
      MAX_AVAILABILITY_DAYS,
    );
    const userIds = [...new Set(args.userIds)];
    const r = await ctx.bitrix.call(
      'legacy',
      'calendar.accessibility.get',
      { users: userIds, from: range.bitrixFrom, to: range.bitrixTo },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    // PHP отдаёт пустой ассоциативный массив как []: это «нет данных ни по кому», а не «все свободны».
    const byUser: Record<string, JsonValue> = isObj(r.result) ? r.result : {};
    if (!isObj(r.result) && !(Array.isArray(r.result) && r.result.length === 0)) {
      throw upstreamShapeError('calendar.accessibility.get', 'legacy');
    }
    const iso = (ts: number) => unixToIsoInZone(ts, range.timezone);
    let unknown = 0;
    const users = userIds.map((userId) => {
      const events = byUser[String(userId)];
      if (!Array.isArray(events)) {
        unknown += 1;
        return {
          userId,
          completeness: 'unknown' as const,
          busy: [],
          note: 'Портал не вернул данные календаря по сотруднику (нет доступа или неизвестный ID); свободное время не определено',
        };
      }
      const busy: { from: number; to: number; allDay: boolean; kind: BusyKind }[] = [];
      let skipped = 0;
      for (const raw of events) {
        if (!isObj(raw)) continue;
        const kind = KIND[asText(raw['ACCESSIBILITY'])];
        if (!kind) continue; // free — время не занято
        const t = eventTimes(raw);
        let from: number | undefined = t.fromTs;
        let to: number | undefined = t.toTs;
        if (t.allDay) {
          const zone = t.tz ?? range.timezone;
          const day =
            allDayDate(asText(raw['DATE_FROM'])) ?? (from !== undefined ? dateInZone(from, zone) : undefined);
          const last = allDayDate(asText(raw['DATE_TO'])) ?? (to !== undefined ? dateInZone(to, zone) : day);
          if (day && last) {
            from = zonedDayStart(day, range.timezone);
            to = zonedDayStart(addDays(last, 1), range.timezone);
          }
        }
        if (from === undefined || to === undefined) {
          skipped += 1;
          continue;
        }
        const cf = Math.max(from, range.fromTs);
        const ct = Math.min(to, range.toTs);
        if (ct <= cf) continue;
        busy.push({ from: cf, to: ct, allDay: t.allDay, kind });
      }
      busy.sort((a, b) => a.from - b.from);
      if (skipped) {
        unknown += 1;
        return {
          userId,
          completeness: 'unknown' as const,
          busy: busy.map((b) => ({ from: iso(b.from), to: iso(b.to), allDay: b.allDay, kind: b.kind })),
          note: `${String(skipped)} событий без распознанного времени; свободное время не определено`,
        };
      }
      const merged = mergeIntervals(busy);
      const free: { from: string; to: string }[] = [];
      let cursor = range.fromTs;
      for (const m of merged) {
        if (m.from > cursor) free.push({ from: iso(cursor), to: iso(m.from) });
        cursor = Math.max(cursor, m.to);
      }
      if (cursor < range.toTs) free.push({ from: iso(cursor), to: iso(range.toTs) });
      return {
        userId,
        completeness: 'complete' as const,
        busy: busy.map((b) => ({ from: iso(b.from), to: iso(b.to), allDay: b.allDay, kind: b.kind })),
        free,
      };
    });
    const warnings = [
      'Занятость — только по календарю Bitrix24: не присутствие на работе и не загрузка задачами; «free» — нет событий в календаре',
    ];
    if (unknown)
      warnings.push(`По ${String(unknown)} сотрудникам данных нет или они неполны (completeness=unknown)`);
    return ok(
      { from: iso(range.fromTs), to: iso(range.toTs), timezone: range.timezone, users },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'calendar.accessibility.get',
        apiVersion: 'legacy',
        completeness: unknown ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

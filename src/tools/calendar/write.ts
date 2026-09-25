/**
 * Запись календаря (ТЗ §9.3, §8.2, T28): calendar_update_event, calendar_delete_event, calendar_respond_invitation.
 * Всё через MutationExecutor: чтение события → stateHash/CONFLICT → план с diff (включая участников) →
 * подтверждение человеком → одна запись → сверка перечитыванием.
 * Повторяющиеся события: без recurrenceScope — RECURRENCE_SCOPE_REQUIRED. update поддерживает документированный
 * recurrence_mode (this|next|all + current_date_from); delete принимает только id — поэтому только scope=all.
 * Участие меняется только от текущей Bitrix-личности (владельца вебхука) и только документированными статусами Y/N.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
  yn,
} from '../shared.js';
import { defineTool, DESTRUCTIVE_ANNOTATIONS, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import {
  allDayDate,
  assertEventInCalendar,
  attendeeStatus,
  calendarRef,
  calendarTypeSchema,
  currentUserId,
  eventAttendees,
  eventGone,
  eventIdSchema,
  eventStateHash,
  eventTimes,
  getEvent,
  isRecurring,
  ownerIdSchema,
} from './common.js';
import { assertTimeZone, parseAllDayDate, parseIsoWithZone, unixToIsoInZone } from './time.js';

const recurrenceScopeSchema = z
  .enum(['this', 'next', 'all'])
  .describe(
    'Для повторяющегося события: this — только это вхождение, next — это и последующие, all — вся серия',
  );

function conflictBeforePlan(): AppError {
  return new AppError('CONFLICT', 'Событие изменилось после чтения: expectedStateHash не совпадает', {
    field: 'expectedStateHash',
    reason: 'STATE_CHANGED',
    nextAction: 'Перечитайте событие (dryRun) и подготовьте новый план',
  });
}

function conflictInPrecheck(): AppError {
  return new AppError('CONFLICT', 'Событие изменилось после подтверждения; запись отменена', {
    reason: 'STATE_CHANGED',
    nextAction: 'Перечитайте событие и подготовьте новый план',
  });
}

function recurrenceRequired(what: string): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    `Событие повторяющееся: укажите recurrenceScope, чтобы ${what} (this — одно вхождение, next — это и последующие, all — вся серия)`,
    { field: 'recurrenceScope', reason: 'RECURRENCE_SCOPE_REQUIRED' },
  );
}

const describeTimes = (ev: Record<string, JsonValue>, tz: string): { from: string; to: string } => {
  const t = eventTimes(ev);
  if (t.allDay) {
    return {
      from: allDayDate(asText(ev['DATE_FROM'])) ?? asText(ev['DATE_FROM']),
      to: allDayDate(asText(ev['DATE_TO'])) ?? asText(ev['DATE_TO']),
    };
  }
  return {
    from: t.fromTs !== undefined ? unixToIsoInZone(t.fromTs, t.tz ?? tz) : asText(ev['DATE_FROM']),
    to:
      t.toTs !== undefined
        ? unixToIsoInZone(t.toTs, asText(ev['TZ_TO']) || (t.tz ?? tz))
        : asText(ev['DATE_TO']),
  };
};

// ---------- calendar_update_event ----------

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    from: z.string().max(40).optional().describe('Новое начало: ISO с зоной, либо YYYY-MM-DD при allDay'),
    to: z.string().max(40).optional().describe('Новое окончание: ISO с зоной, либо YYYY-MM-DD при allDay'),
    allDay: z.boolean().optional().describe('Смена «весь день» требует и from, и to'),
    timezone: z.string().max(64).optional().describe('IANA-зона события'),
    location: z.string().max(255).optional(),
    sectionId: z.number().int().positive().optional().describe('Перенести в другой календарь (раздел)'),
    accessibility: z.enum(['busy', 'absent', 'quest', 'free']).optional(),
    importance: z.enum(['high', 'normal', 'low']).optional(),
    privateEvent: z.boolean().optional(),
    attendeeIds: z
      .array(z.number().int().positive())
      .max(50)
      .optional()
      .describe('Новый ПОЛНЫЙ список участников; пустой — встреча станет событием без участников'),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'patch не должен быть пустым');

interface Change {
  field: string;
  before: unknown;
  after: unknown;
  added?: number[];
  removed?: number[];
}

export const calendarUpdateEventTool = defineTool({
  name: 'calendar_update_event',
  module: 'calendar',
  title: 'Изменить событие календаря',
  description:
    'Изменить существующее событие календаря Bitrix24 (calendar.event.update): название, время, описание, место, календарь, участников. ' +
    'Использовать, когда пользователь просит перенести встречу или поправить событие. Даты — ISO с явным смещением, timezone — IANA; ' +
    'to позже from. attendeeIds — новый полный список: план покажет, кто добавится и кто будет удалён (им придут уведомления). ' +
    'Для повторяющегося события обязателен recurrenceScope (this/next требуют occurrenceDate — дату вхождения YYYY-MM-DD). ' +
    'expectedStateHash из dryRun защищает от одновременного изменения. Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      eventId: eventIdSchema,
      type: calendarTypeSchema,
      ownerId: ownerIdSchema.optional(),
      patch: patchSchema,
      recurrenceScope: recurrenceScopeSchema.optional(),
      occurrenceDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Дата изменяемого вхождения (для recurrenceScope this/next)'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    eventId: z.number(),
    ...mutationOutputShape,
    stateHash: z.string().optional(),
    newEventId: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const ref = calendarRef(args.type, args.ownerId);
    const ev = await getEvent(ctx, args.eventId);
    assertEventInCalendar(ev, ref);
    const recurring = isRecurring(ev);
    if (recurring && !args.recurrenceScope) throw recurrenceRequired('изменить событие');
    if (!recurring && args.recurrenceScope && args.recurrenceScope !== 'all') {
      throw new AppError(
        'VALIDATION_ERROR',
        'Событие не повторяющееся: recurrenceScope this/next неприменим',
        {
          field: 'recurrenceScope',
        },
      );
    }
    if (recurring && args.recurrenceScope !== 'all' && !args.occurrenceDate) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Для recurrenceScope this/next укажите occurrenceDate (YYYY-MM-DD)',
        {
          field: 'occurrenceDate',
        },
      );
    }
    const currentHash = eventStateHash(ev);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw conflictBeforePlan();
    }

    const p = args.patch;
    const before = eventTimes(ev);
    const params: JsonObject = { id: args.eventId, type: ref.type, ownerId: ref.ownerId };
    const changes: Change[] = [];
    const risks: string[] = [];
    const cfgTz = ctx.config.bitrix.timezone;
    const beforeTimes = describeTimes(ev, cfgTz);

    // Даты: время с зоной → from_ts/to_ts + timezone_from/to; весь день → from/to датой + skip_time=Y.
    let expectFromTs: number | undefined;
    let expectToTs: number | undefined;
    const timeTouched =
      p.from !== undefined || p.to !== undefined || p.allDay !== undefined || p.timezone !== undefined;
    if (timeTouched) {
      const allDay = p.allDay ?? before.allDay;
      if (
        p.allDay !== undefined &&
        p.allDay !== before.allDay &&
        (p.from === undefined || p.to === undefined)
      ) {
        throw new AppError('VALIDATION_ERROR', 'Смена allDay требует и from, и to в новом формате', {
          field: 'patch.from',
        });
      }
      const tz = assertTimeZone(p.timezone ?? before.tz ?? cfgTz);
      if (allDay) {
        const from = parseAllDayDate('patch.from', p.from ?? beforeTimes.from);
        const to = parseAllDayDate('patch.to', p.to ?? beforeTimes.to);
        if (to < from) {
          throw new AppError('VALIDATION_ERROR', 'to раньше from', {
            field: 'patch.to',
            reason: 'INVALID_DATE_RANGE',
          });
        }
        Object.assign(params, { from, to, skip_time: 'Y' });
        changes.push({ field: 'dates', before: beforeTimes, after: { from, to, allDay: true } });
      } else {
        const fromTs = p.from !== undefined ? parseIsoWithZone('patch.from', p.from) : before.fromTs;
        const toTs = p.to !== undefined ? parseIsoWithZone('patch.to', p.to) : before.toTs;
        if (fromTs === undefined || toTs === undefined) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Текущее время события не распознано: передайте и from, и to',
            {
              field: 'patch.from',
            },
          );
        }
        if (toTs <= fromTs) {
          throw new AppError('VALIDATION_ERROR', 'to должно быть позже from', {
            field: 'patch.to',
            reason: 'INVALID_DATE_RANGE',
          });
        }
        if (toTs - fromTs > 31 * 86_400) {
          throw new AppError('VALIDATION_ERROR', 'событие длиннее 31 дня', { field: 'patch.to' });
        }
        expectFromTs = fromTs;
        expectToTs = toTs;
        Object.assign(params, {
          from_ts: fromTs,
          to_ts: toTs,
          timezone_from: tz,
          timezone_to: tz,
          skip_time: 'N',
        });
        changes.push({
          field: 'dates',
          before: { ...beforeTimes, timezone: before.tz ?? '' },
          after: { from: unixToIsoInZone(fromTs, tz), to: unixToIsoInZone(toTs, tz), timezone: tz },
        });
      }
    }
    const simple: [keyof typeof p, string, string, (v: unknown) => JsonValue][] = [
      ['name', 'name', 'NAME', (v) => asText(v)],
      ['description', 'description', 'DESCRIPTION', (v) => asText(v)],
      ['location', 'location', 'LOCATION', (v) => asText(v)],
      ['accessibility', 'accessibility', 'ACCESSIBILITY', (v) => asText(v)],
      ['importance', 'importance', 'IMPORTANCE', (v) => asText(v)],
    ];
    for (const [key, param, field, conv] of simple) {
      if (p[key] === undefined) continue;
      params[param] = conv(p[key]);
      changes.push({ field: key, before: asText(ev[field]), after: p[key] });
    }
    if (p.privateEvent !== undefined) {
      params['private_event'] = p.privateEvent ? 'Y' : 'N';
      changes.push({ field: 'privateEvent', before: yn(ev['PRIVATE_EVENT']), after: p.privateEvent });
    }
    if (p.sectionId !== undefined) {
      params['section'] = p.sectionId;
      changes.push({
        field: 'sectionId',
        before: idOf(ev['SECTION_ID'] ?? ev['SECT_ID']) ?? null,
        after: p.sectionId,
      });
      risks.push('Событие переносится в другой календарь: изменится круг тех, кто его видит');
    }

    const attendeesBefore = eventAttendees(ev);
    const beforeIds = attendeesBefore.map((a) => a.id);
    let attendeesAfter: number[] | undefined;
    const hostId = idOf(ev['MEETING_HOST']);
    if (p.attendeeIds !== undefined) {
      attendeesAfter = [...new Set(p.attendeeIds)];
      const added = attendeesAfter.filter((id) => !beforeIds.includes(id));
      const removed = beforeIds.filter((id) => !attendeesAfter?.includes(id) && id !== hostId);
      if (attendeesAfter.length) {
        params['is_meeting'] = 'Y';
        params['attendees'] =
          hostId && !attendeesAfter.includes(hostId) ? [hostId, ...attendeesAfter] : attendeesAfter;
      } else {
        params['is_meeting'] = 'N';
        risks.push('Список участников пуст: встреча станет событием без участников');
      }
      changes.push({ field: 'attendees', before: beforeIds, after: attendeesAfter, added, removed });
      if (added.length) risks.push(`Новые участники (${added.join(', ')}) получат приглашения`);
      if (removed.length)
        risks.push(`Участники ${removed.join(', ')} будут удалены из встречи и получат уведомление`);
    }
    // host передаётся только если меняет не организатор (документация calendar.event.update).
    if (yn(ev['IS_MEETING']) && hostId) {
      const me = await currentUserId(ctx);
      if (me !== hostId) {
        params['host'] = hostId;
        risks.push(
          `Вы не организатор встречи (организатор #${String(hostId)}): портал может отказать в изменении`,
        );
      }
    }
    if (yn(ev['IS_MEETING']) && beforeIds.length > 1) {
      risks.push(`Участники встречи (${String(beforeIds.length)}) получат уведомление об изменении`);
    }
    if (recurring) {
      params['recurrence_mode'] = args.recurrenceScope ?? 'all';
      if (args.recurrenceScope !== 'all' && args.occurrenceDate)
        params['current_date_from'] = args.occurrenceDate;
      risks.push(
        args.recurrenceScope === 'all'
          ? 'Изменение применится ко ВСЕЙ серии повторяющегося события'
          : args.recurrenceScope === 'next'
            ? `Серия будет разделена: изменятся вхождение ${args.occurrenceDate ?? ''} и все последующие`
            : `Изменится только вхождение ${args.occurrenceDate ?? ''}: портал выделит его в отдельное событие`,
      );
    }
    if (!args.expectedStateHash) {
      risks.push(
        'expectedStateHash не передан: если событие изменят до выполнения, правка всё равно применится',
      );
    }

    const name = asText(ev['NAME']) || `#${String(args.eventId)}`;
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'calendar_update_event',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить событие «${name}» (#${String(args.eventId)})${recurring ? `, повторяющееся: ${args.recurrenceScope ?? ''}` : ''}`,
        target: `calendar.event:${String(args.eventId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'calendar.event.update',
          calendar: `${ref.type}/${String(ref.ownerId)}`,
          eventId: args.eventId,
          stateHash: currentHash,
          current: { name, ...beforeTimes, attendees: beforeIds, hostId: hostId ?? null },
          changes,
          params,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getEvent(ctx, args.eventId);
        if (eventStateHash(fresh) !== args.expectedStateHash) throw conflictInPrecheck();
      },
      perform: async () => {
        const r = await ctx.bitrix.call('legacy', 'calendar.event.update', params, {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        const single = idOf(r.result);
        if (single !== undefined) return { id: single, result: { eventId: single } };
        if (isObj(r.result)) {
          const recId = idOf(r.result['recEventId']);
          const id = idOf(r.result['id']) ?? args.eventId;
          if (recId !== undefined || idOf(r.result['id']) !== undefined) {
            return {
              id: recId ?? id,
              result: { eventId: id, ...(recId !== undefined ? { newEventId: recId } : {}) },
            };
          }
        }
        throw outcomeUnknown(
          'calendar.event.update',
          'legacy',
          'Проверьте событие в календаре перед повторной попыткой',
        );
      },
      verify: async (performed) => {
        const target = typeof performed.id === 'number' ? performed.id : args.eventId;
        const saved = await getEvent(ctx, target);
        const warnings: string[] = [];
        if (p.name !== undefined && asText(saved['NAME']) !== p.name)
          warnings.push(`Название в портале: «${asText(saved['NAME'])}»`);
        const t = eventTimes(saved);
        if (
          expectFromTs !== undefined &&
          args.recurrenceScope !== 'this' &&
          args.recurrenceScope !== 'next'
        ) {
          if (t.fromTs !== expectFromTs || t.toTs !== expectToTs)
            warnings.push('Время события в портале отличается от плана');
        }
        if (p.sectionId !== undefined && idOf(saved['SECTION_ID'] ?? saved['SECT_ID']) !== p.sectionId)
          warnings.push('Календарь (раздел) в портале не совпадает с планом');
        if (attendeesAfter) {
          const got = eventAttendees(saved).map((a) => a.id);
          const missing = attendeesAfter.filter((id) => !got.includes(id));
          if (missing.length) warnings.push(`Не найдены среди участников: ${missing.join(', ')}`);
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    let stateHash: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed && !recurring) {
      try {
        stateHash = eventStateHash(await getEvent(ctx, args.eventId));
      } catch {
        stateHash = undefined;
      }
    }
    return mutationResponse(ctx, outcome, {
      base: { eventId: args.eventId, ...(stateHash ? { stateHash } : {}) },
      method: 'calendar.event.update',
      resultFields: ['newEventId'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

// ---------- calendar_delete_event ----------

export const calendarDeleteEventTool = defineTool({
  name: 'calendar_delete_event',
  module: 'calendar',
  title: 'Удалить событие календаря',
  description:
    'Удалить событие календаря Bitrix24 (calendar.event.delete). Использовать, только когда пользователь явно просит удалить или отменить ' +
    'конкретное событие. Участники встречи получат уведомление об отмене. Для повторяющегося события обязателен recurrenceScope; ' +
    'метод удаления принимает только ID события, поэтому поддерживается лишь recurrenceScope=all (вся серия) — удаление одного ' +
    'вхождения не документировано и отклоняется. Порядок: APPROVAL_REQUIRED с планом (что удаляется, участники) → подтверждение ' +
    'человеком → повтор с approvalId; после удаления событие перечитывается.',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      eventId: eventIdSchema,
      type: calendarTypeSchema,
      ownerId: ownerIdSchema.optional(),
      recurrenceScope: recurrenceScopeSchema.optional(),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    eventId: z.number(),
    ...mutationOutputShape,
    deleted: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const ref = calendarRef(args.type, args.ownerId);
    let ev: Record<string, JsonValue>;
    try {
      ev = await getEvent(ctx, args.eventId);
    } catch (e) {
      // Повтор уже выполненного удаления: события нет, но ledger вернёт сохранённый результат без новой записи.
      if (args.approvalId && e instanceof AppError && e.code === 'NOT_FOUND') {
        const outcome = await ctx.mutations.execute({
          requestId: ctx.requestId,
          principal: mutationPrincipal(ctx),
          tool: 'calendar_delete_event',
          operationKind: 'delete',
          args,
          expectedStateHash: args.expectedStateHash ?? null,
          summary: {
            action: `Удалить событие #${String(args.eventId)}`,
            target: `calendar.event:${String(args.eventId)}`,
            portalOrigin: ctx.bitrix.auth.portalOrigin,
            details: { method: 'calendar.event.delete', eventId: args.eventId },
            risks: [],
          },
          precheck: () => Promise.reject(e),
          perform: () => Promise.reject(e),
        });
        return mutationResponse(ctx, outcome, {
          base: { eventId: args.eventId },
          method: 'calendar.event.delete',
          resultFields: ['deleted'],
        });
      }
      throw e;
    }
    assertEventInCalendar(ev, ref);
    const recurring = isRecurring(ev);
    if (recurring && !args.recurrenceScope) throw recurrenceRequired('удалить событие');
    if (args.recurrenceScope && args.recurrenceScope !== 'all') {
      throw new AppError(
        'VALIDATION_ERROR',
        'calendar.event.delete принимает только ID события: удаление одного вхождения или «этого и последующих» не документировано',
        {
          field: 'recurrenceScope',
          reason: 'RECURRENCE_SCOPE_UNSUPPORTED',
          nextAction:
            'Удалите всю серию (recurrenceScope=all) или измените вхождение через calendar_update_event',
        },
      );
    }
    const currentHash = eventStateHash(ev);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw conflictBeforePlan();
    }
    const name = asText(ev['NAME']) || `#${String(args.eventId)}`;
    const times = describeTimes(ev, ctx.config.bitrix.timezone);
    const attendees = eventAttendees(ev);
    const hostId = idOf(ev['MEETING_HOST']);
    const others = attendees.filter((a) => a.id !== hostId);
    const risks = ['Удаление необратимо через MCP: восстановить событие инструментами сервера нельзя'];
    if (yn(ev['IS_MEETING']) && others.length) {
      risks.unshift(
        `Участники (${String(others.length)}: ${others.map((a) => a.id).join(', ')}) получат уведомление об отмене встречи`,
      );
    }
    if (recurring) risks.unshift('Событие повторяющееся: будет удалена ВСЯ серия');
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если событие изменят до выполнения, удаление всё равно выполнится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'calendar_delete_event',
      operationKind: 'delete',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Удалить событие «${name}» (#${String(args.eventId)})${recurring ? ' — всю серию' : ''}`,
        target: `calendar.event:${String(args.eventId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'calendar.event.delete',
          calendar: `${ref.type}/${String(ref.ownerId)}`,
          eventId: args.eventId,
          stateHash: currentHash,
          impact: {
            name,
            ...times,
            recurring,
            isMeeting: yn(ev['IS_MEETING']),
            hostId: hostId ?? null,
            attendees: attendees.map((a) => ({ id: a.id, status: a.status })),
          },
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await getEvent(ctx, args.eventId);
        if (args.expectedStateHash && eventStateHash(fresh) !== args.expectedStateHash)
          throw conflictInPrecheck();
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'calendar.event.delete',
          { id: args.eventId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (r.result !== true) {
          throw outcomeUnknown('calendar.event.delete', 'legacy', 'Проверьте календарь: удалено ли событие');
        }
        return { id: args.eventId, result: { deleted: true } };
      },
      verify: async () => {
        const gone = await eventGone(ctx, args.eventId);
        return { verified: gone, warnings: gone ? [] : ['Событие всё ещё читается после удаления'] };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { eventId: args.eventId },
      method: 'calendar.event.delete',
      resultFields: ['deleted'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

// ---------- calendar_respond_invitation ----------

/** Документированные статусы calendar.meeting.status.set: Y — принято, N — отклонено (Q — «не ответил», не ответ). */
const STATUS_CODE: Record<string, 'Y' | 'N'> = { accepted: 'Y', declined: 'N' };

async function myMeetingStatus(ctx: ToolContext, eventId: number): Promise<string> {
  const r = await ctx.bitrix.call(
    'legacy',
    'calendar.meeting.status.get',
    { eventId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  return asText(r.result);
}

export const calendarRespondInvitationTool = defineTool({
  name: 'calendar_respond_invitation',
  module: 'calendar',
  title: 'Ответить на приглашение',
  description:
    'Принять или отклонить приглашение на встречу от имени текущего пользователя Bitrix24 — владельца вебхука ' +
    '(calendar.meeting.status.set). Использовать, когда пользователь просит принять/отклонить приглашение в календаре. ' +
    'Ответить за другого сотрудника нельзя: сервер проверяет, что текущий пользователь — участник события. status: accepted | declined; ' +
    'tentative («под вопросом») методом не поддерживается и отклоняется (INVALID_STATUS). Организатор ответить не может. ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId; затем статус перечитывается.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      eventId: eventIdSchema,
      status: z.enum(['accepted', 'declined', 'tentative']),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    eventId: z.number(),
    status: z.string(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const code = STATUS_CODE[args.status];
    if (!code) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Статус ${args.status} не поддерживается calendar.meeting.status.set (документированы только Y — принято, N — отклонено)`,
        { field: 'status', reason: 'INVALID_STATUS', nextAction: 'Используйте accepted или declined' },
      );
    }
    const me = await currentUserId(ctx);
    const ev = await getEvent(ctx, args.eventId);
    const mine = eventAttendees(ev).find((a) => a.id === me);
    if (!yn(ev['IS_MEETING']) || !mine) {
      throw new AppError(
        'ACCESS_DENIED',
        'Текущий пользователь Bitrix24 не участник этой встречи: менять участие можно только за себя',
        { field: 'eventId', reason: 'NOT_AN_ATTENDEE' },
      );
    }
    if (mine.status === 'host' || idOf(ev['MEETING_HOST']) === me) {
      throw new AppError('VALIDATION_ERROR', 'Вы организатор встречи: ответ на приглашение неприменим', {
        field: 'eventId',
        reason: 'ORGANIZER_CANNOT_RESPOND',
      });
    }
    const name = asText(ev['NAME']) || `#${String(args.eventId)}`;
    const risks = ['Организатор встречи получит уведомление о вашем ответе'];
    if (mine.status === args.status) risks.push('Статус уже такой: запись ничего не изменит');
    if (isRecurring(ev)) risks.push('Событие повторяющееся: портал может применить ответ ко всей серии');
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'calendar_respond_invitation',
      operationKind: 'update',
      args,
      summary: {
        action: `${args.status === 'accepted' ? 'Принять' : 'Отклонить'} приглашение на «${name}» (#${String(args.eventId)}) от имени пользователя #${String(me)}`,
        target: `calendar.event:${String(args.eventId)}:attendee:${String(me)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'calendar.meeting.status.set',
          eventId: args.eventId,
          userId: me,
          ...describeTimes(ev, ctx.config.bitrix.timezone),
          hostId: idOf(ev['MEETING_HOST']) ?? null,
          statusBefore: mine.status,
          statusAfter: args.status,
          bitrixStatus: code,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'calendar.meeting.status.set',
          { eventId: args.eventId, status: code },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (r.result !== true) {
          throw outcomeUnknown(
            'calendar.meeting.status.set',
            'legacy',
            'Проверьте свой статус участия в событии',
          );
        }
        return { id: args.eventId, result: { status: args.status } };
      },
      verify: async () => {
        const got = await myMeetingStatus(ctx, args.eventId);
        const okStatus = got === code;
        return {
          verified: okStatus,
          warnings: okStatus ? [] : [`Статус в портале: ${attendeeStatus(got)}`],
        };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { eventId: args.eventId, status: args.status },
      method: 'calendar.meeting.status.set',
    });
  },
});

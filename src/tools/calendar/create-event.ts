/**
 * calendar_create_event (ТЗ §9.3, §10.1, §15.3): одиночное событие в известном календаре.
 * Даты — ISO с явным смещением, отдельно IANA-зона; to > from; участники входят в подтверждение.
 * Повторяющиеся события — не в MVP. Bitrix получает from_ts/to_ts + timezone_from/to.
 * Источник: https://apidocs.bitrix24.ru/api-reference/calendar/calendar-event/calendar-event-add.html
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool, type ToolContext } from '../types.js';
import { asText } from '../crm/deal-fields.js';
import { calendarRef } from './common.js';
import {
  assertTimeZone,
  bitrixDateTimeToUnix,
  parseAllDayDate,
  parseIsoWithZone,
  unixToZoned,
} from './time.js';

const CalendarType = z.enum(['user', 'group', 'company']);

async function assertSection(
  ctx: ToolContext,
  type: string,
  ownerId: number,
  sectionId: number,
): Promise<string> {
  const r = await ctx.bitrix.call(
    'legacy',
    'calendar.section.get',
    { type, ownerId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const sections = Array.isArray(r.result) ? (r.result as Record<string, unknown>[]) : [];
  const found = sections.find((s) => Number(s['ID']) === sectionId);
  if (!found) {
    throw new AppError(
      'NOT_FOUND',
      `Календарь (sectionId=${sectionId}) не найден среди доступных для ${type}/${ownerId}`,
      {
        field: 'sectionId',
        nextAction: 'Список календарей: bitrix_rest_call calendar.section.get {type, ownerId}',
      },
    );
  }
  return asText(found['NAME']) || `#${sectionId}`;
}

export const calendarCreateEventTool = defineTool({
  name: 'calendar_create_event',
  module: 'calendar',
  title: 'Создать событие календаря',
  description:
    'Создать одиночное событие или встречу в календаре Bitrix24 (calendar.event.add). Использовать, когда известны тип и владелец ' +
    'календаря (type=user + ownerId сотрудника, или group/company) и sectionId раздела. Даты — ISO 8601 с явным смещением ' +
    '(2026-10-01T10:00:00+03:00), timezone — IANA-зона (по умолчанию зона портала из конфигурации). allDay=true — даты YYYY-MM-DD. ' +
    'Участники (attendeeIds) получат приглашения. Повторяющиеся события не поддерживаются. ' +
    'Порядок: без approvalId — APPROVAL_REQUIRED с планом; после подтверждения тот же вызов с approvalId создаёт событие ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      type: CalendarType,
      ownerId: z
        .number()
        .int()
        .positive()
        .describe('ID владельца: сотрудника (user), группы (group) или компании'),
      sectionId: z.number().int().positive().describe('ID раздела календаря (calendar.section.get)'),
      name: z.string().min(1).max(255),
      from: z.string().max(40).describe('Начало: ISO с зоной, либо YYYY-MM-DD при allDay'),
      to: z.string().max(40).describe('Окончание: ISO с зоной, либо YYYY-MM-DD при allDay'),
      timezone: z.string().max(64).optional().describe('IANA-зона события, по умолчанию DEFAULT_TIMEZONE'),
      attendeeIds: z.array(z.number().int().positive()).max(50).optional(),
      description: z.string().max(10_000).optional(),
      allDay: z.boolean().default(false),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    eventId: z.number().nullable().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
    event: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (args, ctx) => {
    const timezone = assertTimeZone(args.timezone ?? ctx.config.bitrix.timezone);
    let fromTs: number;
    let toTs: number;
    let fromText: string;
    let toText: string;
    if (args.allDay) {
      fromText = parseAllDayDate('from', args.from);
      toText = parseAllDayDate('to', args.to);
      fromTs = Math.floor(Date.parse(`${fromText}T00:00:00Z`) / 1000);
      toTs = Math.floor(Date.parse(`${toText}T00:00:00Z`) / 1000);
      if (toTs < fromTs)
        throw new AppError('VALIDATION_ERROR', 'to раньше from', {
          field: 'to',
          reason: 'INVALID_DATE_RANGE',
        });
    } else {
      fromTs = parseIsoWithZone('from', args.from);
      toTs = parseIsoWithZone('to', args.to);
      if (toTs <= fromTs)
        throw new AppError('VALIDATION_ERROR', 'to должно быть позже from', {
          field: 'to',
          reason: 'INVALID_DATE_RANGE',
        });
      if (toTs - fromTs > 31 * 86_400)
        throw new AppError('VALIDATION_ERROR', 'событие длиннее 31 дня', { field: 'to' });
      fromText = `${unixToZoned(fromTs, timezone)} (${timezone})`;
      toText = `${unixToZoned(toTs, timezone)} (${timezone})`;
    }
    const attendees = [...new Set(args.attendeeIds ?? [])];
    // Документированный тип общего календаря — company_calendar с ownerId=0.
    const ref = calendarRef(args.type, args.ownerId);
    const sectionName = await assertSection(ctx, ref.type, ref.ownerId, args.sectionId);

    const fields: JsonObject = {
      type: ref.type,
      ownerId: ref.ownerId,
      section: args.sectionId,
      name: args.name,
      from_ts: fromTs,
      to_ts: toTs,
      timezone_from: timezone,
      timezone_to: timezone,
      skip_time: args.allDay ? 'Y' : 'N',
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(attendees.length ? { is_meeting: 'Y', attendees, host: args.ownerId } : {}),
    };
    const risks = attendees.length
      ? [`Участники (${attendees.length}) получат приглашения и уведомления`]
      : ['Событие без участников: уведомления только владельцу календаря'];
    if (args.type !== 'user') risks.push('Событие в общем календаре видно всем его участникам');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'calendar_create_event',
      operationKind: 'create',
      args: { ...args, timezone, fromTs, toTs, attendeeIds: attendees },
      summary: {
        action: `Создать событие «${args.name}»`,
        target: `calendar:${args.type}/${args.ownerId}/${args.sectionId}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'calendar.event.add',
          calendar: `${sectionName} (sectionId ${args.sectionId}, ${args.type} ${args.ownerId})`,
          from: fromText,
          to: toText,
          timezone,
          allDay: args.allDay,
          attendees,
          description: args.description ?? '',
          fields,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const r = await ctx.bitrix.call('legacy', 'calendar.event.add', fields, {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        const id = typeof r.result === 'number' ? r.result : Number(asText(r.result));
        if (!Number.isInteger(id) || id <= 0) {
          throw new AppError(
            'OPERATION_OUTCOME_UNKNOWN',
            'calendar.event.add вернул ответ без ID; исход неизвестен',
            {
              method: 'calendar.event.add',
              apiVersion: 'legacy',
              reason: 'outcome-unknown',
              nextAction: 'Проверьте календарь в Bitrix24 перед повторной попыткой',
            },
          );
        }
        return { id, result: { eventId: id } };
      },
      verify: async (performed) => {
        const r = await ctx.bitrix.call(
          'legacy',
          'calendar.event.getbyid',
          { id: performed.id },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const ev =
          r.result && typeof r.result === 'object' && !Array.isArray(r.result)
            ? (r.result as Record<string, unknown>)
            : undefined;
        if (!ev) return { verified: false, warnings: ['Событие создано, но не читается по ID'] };
        const warnings: string[] = [];
        const nameOk = asText(ev['NAME']) === args.name;
        if (!nameOk) warnings.push(`Название в портале: «${asText(ev['NAME'])}»`);
        if (!args.allDay) {
          const gotFrom = bitrixDateTimeToUnix(asText(ev['DATE_FROM']), asText(ev['TZ_FROM']) || timezone);
          const gotTo = bitrixDateTimeToUnix(asText(ev['DATE_TO']), asText(ev['TZ_TO']) || timezone);
          if (gotFrom === null || gotTo === null)
            warnings.push('Даты события в портале в нераспознанном формате; сверка дат не выполнена');
          else if (gotFrom !== fromTs || gotTo !== toTs)
            warnings.push(
              `Даты в портале: ${asText(ev['DATE_FROM'])} — ${asText(ev['DATE_TO'])} (${asText(ev['TZ_FROM'])})`,
            );
        }
        if (attendees.length) {
          const got = Array.isArray(ev['ATTENDEE_LIST'])
            ? (ev['ATTENDEE_LIST'] as Record<string, unknown>[]).map((a) => Number(a['id']))
            : [];
          const missing = attendees.filter((a) => !got.includes(a));
          if (got.length && missing.length)
            warnings.push(`Не найдены среди участников: ${missing.join(', ')}`);
        }
        return { verified: nameOk && warnings.length === 0, warnings };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        { dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: событие не создавалось, подтверждение не создано'],
        },
      );
    }
    return ok(
      {
        eventId: typeof outcome.id === 'number' ? outcome.id : null,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        event: { name: args.name, from: fromText, to: toText, timezone, attendees },
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'calendar.event.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

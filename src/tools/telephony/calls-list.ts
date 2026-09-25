/**
 * telephony_calls_list (ТЗ §9.9): история звонков voximplant.statistic.get — только метаданные.
 * Ссылки на записи и логи (CALL_RECORD_URL, RECORD_FILE_ID, CALL_LOG), расшифровки и комментарии не выдаются:
 * записи и скачивание аудио выключены по умолчанию. Номер абонента по умолчанию маскируется (§8.4).
 * Полнота внешней АТС не гарантируется; отсутствие модуля телефонии → FEATURE_UNAVAILABLE.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { asText, idOf, idSchema, isObj, isoDateSchema, num, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { offsetPage } from '../company/offset-page.js';

const CALL_TYPES: Record<string, string> = {
  '1': 'outgoing',
  '2': 'incoming',
  '3': 'incoming-redirected',
  '4': 'callback',
  '5': 'info',
};

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return digits ? '***' : '';
  return `***${digits.slice(-4)}`;
}

/** Явный allowlist: всё, чего здесь нет (в т.ч. ссылки на записи/логи), в ответ не попадает. */
function normalizeCall(raw: JsonValue, includePhoneNumbers: boolean) {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  const phone = asText(raw['PHONE_NUMBER']);
  const typeCode = asText(raw['CALL_TYPE']);
  const crmType = asText(raw['CRM_ENTITY_TYPE']);
  return {
    id,
    callId: asText(raw['CALL_ID']) || null,
    userId: idOf(raw['PORTAL_USER_ID']) ?? null,
    type: CALL_TYPES[typeCode] ?? 'unknown',
    category: asText(raw['CALL_CATEGORY']) || null,
    startDate: asText(raw['CALL_START_DATE']) || null,
    durationSec: num(raw['CALL_DURATION']) ?? 0,
    resultCode: asText(raw['CALL_FAILED_CODE']) || null,
    resultReason: asText(raw['CALL_FAILED_REASON']) || null,
    phoneNumber: includePhoneNumbers ? phone || null : phone ? maskPhone(phone) : null,
    lineNumber: asText(raw['PORTAL_NUMBER']) || null,
    crm: crmType ? { entityType: crmType, entityId: idOf(raw['CRM_ENTITY_ID']) ?? null } : null,
    crmActivityId: idOf(raw['CRM_ACTIVITY_ID']) ?? null,
    hasRecording: Boolean(asText(raw['CALL_RECORD_URL']) || idOf(raw['RECORD_FILE_ID'])),
  };
}

export const telephonyCallsListTool = defineTool({
  name: 'telephony_calls_list',
  module: 'telephony',
  title: 'История звонков',
  description:
    'История звонков портала за период (voximplant.statistic.get): время, направление, длительность, результат, сотрудник, ' +
    'привязка к CRM. Использовать для вопросов «кто кому звонил», «сколько пропущенных», «звонки сотрудника за неделю». ' +
    'Только метаданные: ссылок на записи разговоров и логи нет (hasRecording лишь сообщает, что запись существует); ' +
    'номер абонента маскируется, если не запрошен includePhoneNumbers=true. Полнота внешней АТС не гарантируется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      from: isoDateSchema.describe('Начало периода (ISO 8601, со смещением зоны)'),
      to: isoDateSchema.describe('Конец периода (ISO 8601)'),
      userId: idSchema.optional().describe('Только звонки этого сотрудника'),
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
    items: z.array(
      z.object({
        id: z.number(),
        callId: z.string().nullable(),
        userId: z.number().nullable(),
        type: z.string(),
        category: z.string().nullable(),
        startDate: z.string().nullable(),
        durationSec: z.number(),
        resultCode: z.string().nullable(),
        resultReason: z.string().nullable(),
        phoneNumber: z.string().nullable(),
        lineNumber: z.string().nullable(),
        crm: z.object({ entityType: z.string(), entityId: z.number().nullable() }).nullable(),
        crmActivityId: z.number().nullable(),
        hasRecording: z.boolean(),
      }),
    ),
    returnedCount: z.number(),
    total: z.number().nullable(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const filter: JsonObject = { '>=CALL_START_DATE': args.from, '<=CALL_START_DATE': args.to };
    if (args.userId !== undefined) filter['PORTAL_USER_ID'] = args.userId;
    let page;
    try {
      page = await offsetPage(ctx, {
        tool: 'telephony_calls_list',
        method: 'voximplant.statistic.get',
        params: { FILTER: filter, SORT: 'CALL_START_DATE', ORDER: 'DESC' },
        bindingParts: { from: args.from, to: args.to, userId: args.userId ?? null },
        pageSize,
        cursor: args.cursor,
      });
    } catch (e) {
      if (AppError.is(e) && e.code === 'FEATURE_UNAVAILABLE') {
        throw new AppError(
          'FEATURE_UNAVAILABLE',
          'Телефония недоступна на портале (модуль или метод отсутствует)',
          {
            ...e.details,
            reason: 'TELEPHONY_UNAVAILABLE',
            nextAction: 'Проверьте, что модуль телефонии подключён и вебхуку выдан scope telephony',
          },
        );
      }
      throw e;
    }
    const items = page.items
      .map((c) => normalizeCall(c, args.includePhoneNumbers))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    const warnings = ['История не гарантирует полноту звонков внешней АТС; записи разговоров не выдаются'];
    if (args.includePhoneNumbers) warnings.push('Номера абонентов показаны полностью (персональные данные)');
    return ok(
      { items, returnedCount: items.length, total: page.total ?? null },
      pageMeta(ctx, 'voximplant.statistic.get', page, 'legacy', warnings),
    );
  },
});

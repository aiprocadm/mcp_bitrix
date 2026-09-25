/**
 * Запись дел CRM (ТЗ §9.4): crm_activity_create и crm_activity_update.
 * Провайдеры — ЯВНЫЙ allowlist того, что документировано без приложения:
 *  - todo    — универсальное дело, crm.activity.todo.add (современный метод; crm.activity.add помечен DEPRECATED);
 *  - call    — звонок, crm.activity.add с TYPE_ID=2 (нужна одна коммуникация — телефон);
 *  - meeting — встреча, crm.activity.add с TYPE_ID=1 (нужны коммуникации — участники).
 * Всё остальное (e-mail, задачи, SMS, открытые линии, конфигурируемые дела приложений) — UNSUPPORTED_PROVIDER.
 * Изменение — crm.activity.update с ограниченным перечнем документированных полей; сверка — crm.activity.get.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import { stateHash } from '../../security/idempotency.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  isoDateSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  num,
  outcomeUnknown,
  yn,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import { classicEntity, entityTypeSchema, recordTitle } from './entities.js';
import { getRecord } from './crm-service.js';

const opts = (ctx: ToolContext) => ({ requestId: ctx.requestId, signal: ctx.signal });

export const SUPPORTED_PROVIDERS = ['todo', 'call', 'meeting'] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];
/** TYPE_ID по crm_enum_activitytype: 1 — встреча, 2 — звонок. */
const TYPE_ID: Record<Exclude<Provider, 'todo'>, number> = { meeting: 1, call: 2 };
/** Провайдер универсального дела (документация crm.activity.todo.*: фильтр PROVIDER_ID = CRM_TODO). */
const TODO_PROVIDER_ID = 'CRM_TODO';
const PRIORITY = { low: 1, medium: 2, high: 3 } as const;

function unsupportedProvider(what: string): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    `${what}: поддерживаются только ${SUPPORTED_PROVIDERS.join(', ')} (универсальное дело, звонок, встреча)`,
    {
      field: 'provider',
      reason: 'UNSUPPORTED_PROVIDER',
      nextAction:
        'Для задачи используйте task_create, для письма/SMS — интерфейс Bitrix24; через MCP доступны todo, call, meeting',
    },
  );
}

export async function getActivity(ctx: ToolContext, id: number): Promise<Record<string, JsonValue>> {
  const r = await ctx.bitrix.call('legacy', 'crm.activity.get', { id }, opts(ctx));
  if (!isObj(r.result) || idOf(r.result['ID']) === undefined) {
    throw new AppError('NOT_FOUND', 'Дело не найдено или недоступно', {
      method: 'crm.activity.get',
      apiVersion: 'legacy',
      nextAction: 'Найдите ID дела через crm_activities_list',
    });
  }
  return r.result;
}

/** Классификация существующего дела по тому же allowlist; undefined — не поддерживается. */
function providerOf(activity: Record<string, JsonValue>): Provider | undefined {
  if (asText(activity['PROVIDER_ID']) === TODO_PROVIDER_ID) return 'todo';
  const type = num(activity['TYPE_ID']);
  if (type === TYPE_ID.call) return 'call';
  if (type === TYPE_ID.meeting) return 'meeting';
  return undefined;
}

const sameTime = (a: unknown, b: unknown) => {
  const x = Date.parse(asText(a));
  const y = Date.parse(asText(b));
  return Number.isNaN(x) || Number.isNaN(y) ? asText(a) === asText(b) : x === y;
};

// ---------- crm_activity_create ----------

const communicationSchema = z
  .object({
    entityType: z
      .enum(['contact', 'company', 'lead'])
      .describe('С кем дело: контакт, компания или лид (ENTITY_TYPE_ID 3/4/1)'),
    entityId: idSchema.describe('ID контакта/компании/лида'),
    value: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Для звонка — номер телефона; для встречи — имя участника (необязательно)'),
  })
  .strict();

export const crmActivityCreateTool = defineTool({
  name: 'crm_activity_create',
  module: 'crm',
  title: 'Создать дело CRM',
  description:
    'Создать дело в таймлайне записи CRM (сделка, лид, контакт, компания). provider из явного списка: ' +
    'todo — универсальное дело с крайним сроком (crm.activity.todo.add), call — звонок, meeting — встреча (crm.activity.add, ' +
    'нужны communications: для звонка один телефон, для встречи — участники). Остальные виды (письмо, задача, SMS) — UNSUPPORTED_PROVIDER. ' +
    'Использовать, когда пользователь просит запланировать звонок, встречу или напоминание по клиенту. ' +
    'Порядок: APPROVAL_REQUIRED с планом → подтверждение человеком → повтор с approvalId; после записи дело перечитывается (crm.activity.get).',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      recordId: idSchema.describe('ID записи, к которой относится дело'),
      provider: z
        .string()
        .min(1)
        .max(64)
        .describe('Вид дела: todo (универсальное дело), call (звонок), meeting (встреча)'),
      subject: z.string().trim().min(1).max(255).describe('Тема дела'),
      description: z.string().max(5000).optional().describe('Описание (обычный текст)'),
      responsibleId: idSchema.describe('ID ответственного сотрудника'),
      deadline: isoDateSchema.optional().describe('Крайний срок (обязателен для todo), ISO 8601'),
      start: isoDateSchema.optional().describe('Начало звонка/встречи (обязательно для call/meeting)'),
      end: isoDateSchema.optional().describe('Окончание звонка/встречи; по умолчанию = start'),
      direction: z
        .enum(['incoming', 'outgoing'])
        .optional()
        .describe('Только для звонка: входящий/исходящий (по умолчанию outgoing)'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Важность (для call/meeting)'),
      communications: z
        .array(communicationSchema)
        .min(1)
        .max(10)
        .optional()
        .describe('С кем звонок/встреча; для todo не передаётся'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: entityTypeSchema,
    recordId: z.number(),
    provider: z.string(),
    activityId: z.number().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const provider = SUPPORTED_PROVIDERS.find((p) => p === args.provider.trim().toLowerCase());
    if (!provider) throw unsupportedProvider(`provider «${args.provider}» не поддерживается`);
    const bad = (field: string, message: string) =>
      new AppError('VALIDATION_ERROR', `${field}: ${message}`, { field });
    if (provider === 'todo') {
      if (!args.deadline) throw bad('deadline', 'обязателен для универсального дела (todo)');
      for (const k of ['start', 'end', 'direction', 'priority', 'communications'] as const) {
        if (args[k] !== undefined) throw bad(k, 'не поддерживается crm.activity.todo.add; уберите параметр');
      }
    } else {
      if (!args.start) throw bad('start', `обязателен для ${provider === 'call' ? 'звонка' : 'встречи'}`);
      if (args.deadline) throw bad('deadline', 'для звонка/встречи срок берётся из start (crm.activity.add)');
      if (args.end && Date.parse(args.end) < Date.parse(args.start)) throw bad('end', 'раньше start');
      const comms = args.communications ?? [];
      if (comms.length === 0)
        throw bad('communications', 'crm.activity.add требует COMMUNICATIONS для звонка и встречи');
      if (provider === 'call') {
        if (comms.length !== 1) throw bad('communications', 'для звонка допускается ровно одна коммуникация');
        if (!comms[0]?.value) throw bad('communications', 'для звонка нужен номер телефона в value');
      } else if (args.direction) {
        throw bad('direction', 'направление указывается только для звонка');
      }
    }
    const entity = classicEntity(args.entityType);
    // Запись должна существовать и быть доступной до плана.
    const record = await getRecord(ctx, entity, args.recordId);
    const title = recordTitle(entity, record);

    let method: string;
    let payload: JsonObject;
    if (provider === 'todo') {
      method = 'crm.activity.todo.add';
      payload = {
        ownerTypeId: entity.entityTypeId,
        ownerId: args.recordId,
        deadline: args.deadline ?? '',
        title: args.subject,
        responsibleId: args.responsibleId,
        ...(args.description !== undefined ? { description: args.description } : {}),
      };
    } else {
      method = 'crm.activity.add';
      const start = args.start ?? '';
      const fields: JsonObject = {
        OWNER_TYPE_ID: entity.entityTypeId,
        OWNER_ID: args.recordId,
        TYPE_ID: TYPE_ID[provider],
        SUBJECT: args.subject,
        RESPONSIBLE_ID: args.responsibleId,
        START_TIME: start,
        END_TIME: args.end ?? start,
        COMPLETED: 'N',
        COMMUNICATIONS: (args.communications ?? []).map((c) => ({
          ENTITY_TYPE_ID: classicEntity(c.entityType).entityTypeId,
          ENTITY_ID: c.entityId,
          ...(provider === 'call' ? { TYPE: 'PHONE' } : {}),
          ...(c.value !== undefined ? { VALUE: c.value } : {}),
        })),
      };
      if (args.description !== undefined) {
        fields['DESCRIPTION'] = args.description;
        fields['DESCRIPTION_TYPE'] = 1; // crm_enum_contenttype: 1 — обычный текст
      }
      if (provider === 'call') fields['DIRECTION'] = args.direction === 'incoming' ? 1 : 2;
      if (args.priority) fields['PRIORITY'] = PRIORITY[args.priority];
      payload = { fields };
    }
    const risks = [
      'Ответственный получит уведомление; дело появится в таймлайне и в списке дел',
      'Могут сработать роботы/автоматизация, реагирующие на новые дела',
    ];
    if (provider !== 'todo') {
      risks.push(
        'crm.activity.add помечен в документации как DEPRECATED (поддерживается, но не развивается)',
      );
      risks.push('Коммуникации (телефон/имя) сохраняются в деле и видны всем, у кого есть доступ к записи');
    }

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_activity_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать дело (${provider}) «${args.subject}»: ${entity.label} #${String(args.recordId)} «${title}»`,
        target: `${entity.methodBase}:${String(args.recordId)}:activity`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { provider, method, entityType: entity.type, recordId: args.recordId, params: payload },
        risks,
      },
      validationLevel: 'local',
      perform: async () => {
        const r = await ctx.bitrix.call('legacy', method, payload, opts(ctx));
        // Форма ответа по документации: todo.add — {id}, activity.add — число.
        const id =
          provider === 'todo' ? (isObj(r.result) ? idOf(r.result['id']) : undefined) : idOf(r.result);
        if (id === undefined) {
          throw outcomeUnknown(
            method,
            'legacy',
            'Проверьте дела записи (crm_activities_list) перед повторной попыткой',
          );
        }
        return { id, result: { activityId: id } };
      },
      verify: async (performed) => {
        const saved = await getActivity(ctx, Number(performed.id));
        const warnings: string[] = [];
        if (num(saved['OWNER_TYPE_ID']) !== entity.entityTypeId || num(saved['OWNER_ID']) !== args.recordId)
          warnings.push('Дело привязано не к той записи');
        if (asText(saved['SUBJECT']) !== args.subject) warnings.push('Тема дела в портале отличается');
        if (num(saved['RESPONSIBLE_ID']) !== args.responsibleId)
          warnings.push('Ответственный в портале другой');
        if (provider !== 'todo' && num(saved['TYPE_ID']) !== TYPE_ID[provider])
          warnings.push('Тип дела в портале отличается');
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { entityType: entity.type, recordId: args.recordId, provider },
      method,
      resultFields: ['activityId'],
    });
  },
});

// ---------- crm_activity_update ----------

/** Изменяемые поля — документированные поля crm.activity.update/crm.activity.fields; DEADLINE напрямую не задаётся. */
const activityFieldsSchema = z
  .object({
    SUBJECT: z.string().trim().min(1).max(255).optional().describe('Тема'),
    DESCRIPTION: z.string().max(5000).optional().describe('Описание (обычный текст)'),
    COMPLETED: z.boolean().optional().describe('true — дело выполнено (закрыть), false — вернуть в работу'),
    START_TIME: isoDateSchema.optional().describe('Начало (для звонка/встречи — это и крайний срок)'),
    END_TIME: isoDateSchema.optional().describe('Окончание'),
    RESPONSIBLE_ID: idSchema.optional().describe('ID нового ответственного'),
    PRIORITY: z.enum(['low', 'medium', 'high']).optional().describe('Важность'),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'укажите хотя бы одно поле');

const STATE_FIELDS = [
  'OWNER_TYPE_ID',
  'OWNER_ID',
  'TYPE_ID',
  'PROVIDER_ID',
  'SUBJECT',
  'DESCRIPTION',
  'COMPLETED',
  'START_TIME',
  'END_TIME',
  'DEADLINE',
  'RESPONSIBLE_ID',
  'PRIORITY',
  'STATUS',
] as const;

export function activityStateHash(a: Record<string, JsonValue>): string {
  return stateHash(STATE_FIELDS.map((f) => [f, asText(a[f])]));
}

export const crmActivityUpdateTool = defineTool({
  name: 'crm_activity_update',
  module: 'crm',
  title: 'Изменить или закрыть дело CRM',
  description:
    'Изменить дело CRM (crm.activity.update): тему, описание, время начала/окончания, ответственного, важность, ' +
    'или закрыть его (COMPLETED=true). Использовать, когда пользователь просит перенести, переназначить или отметить выполненным ' +
    'звонок, встречу или универсальное дело; ID — из crm_activities_list. Другие виды дел (письма, задачи, SMS) — UNSUPPORTED_PROVIDER. ' +
    'План показывает diff «было → станет» и stateHash (передайте как expectedStateHash: при чужом изменении будет CONFLICT). ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      activityId: idSchema.describe('ID дела'),
      fields: activityFieldsSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    activityId: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const current = await getActivity(ctx, args.activityId);
    const provider = providerOf(current);
    if (!provider) {
      throw unsupportedProvider(
        `дело #${String(args.activityId)} (TYPE_ID ${asText(current['TYPE_ID'])}, ${asText(current['PROVIDER_ID'])}) не входит в поддерживаемые`,
      );
    }
    const currentHash = activityStateHash(current);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Дело изменилось после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Подготовьте план заново (dryRun=true)',
      });
    }
    const f = args.fields;
    const start = f.START_TIME ?? asText(current['START_TIME']);
    const end = f.END_TIME ?? asText(current['END_TIME']);
    if (
      (f.START_TIME || f.END_TIME) &&
      start &&
      end &&
      !Number.isNaN(Date.parse(start)) &&
      !Number.isNaN(Date.parse(end)) &&
      Date.parse(end) < Date.parse(start)
    ) {
      throw new AppError('VALIDATION_ERROR', 'END_TIME раньше START_TIME', { field: 'fields.END_TIME' });
    }
    const fields: JsonObject = {};
    if (f.SUBJECT !== undefined) fields['SUBJECT'] = f.SUBJECT;
    if (f.DESCRIPTION !== undefined) {
      fields['DESCRIPTION'] = f.DESCRIPTION;
      fields['DESCRIPTION_TYPE'] = 1;
    }
    if (f.COMPLETED !== undefined) fields['COMPLETED'] = f.COMPLETED ? 'Y' : 'N';
    if (f.START_TIME !== undefined) fields['START_TIME'] = f.START_TIME;
    if (f.END_TIME !== undefined) fields['END_TIME'] = f.END_TIME;
    if (f.RESPONSIBLE_ID !== undefined) fields['RESPONSIBLE_ID'] = f.RESPONSIBLE_ID;
    if (f.PRIORITY !== undefined) fields['PRIORITY'] = PRIORITY[f.PRIORITY];
    const changes: Record<string, { from: JsonValue; to: JsonValue }> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'DESCRIPTION_TYPE') changes[k] = { from: current[k] ?? null, to: v };
    }
    const risks = ['Могут сработать роботы/автоматизация и уведомления по делу'];
    if (f.COMPLETED === true && !yn(current['COMPLETED']))
      risks.push('Дело будет закрыто: исчезнет из списка текущих дел и счётчиков');
    if (f.RESPONSIBLE_ID !== undefined && num(current['RESPONSIBLE_ID']) !== f.RESPONSIBLE_ID)
      risks.push('Смена ответственного: уведомление новому ответственному');
    if (provider === 'todo')
      risks.push(
        'Универсальное дело: для него документация рекомендует crm.activity.todo.update; START/END не меняют крайний срок',
      );
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если дело изменят до выполнения, изменение всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_activity_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить дело #${String(args.activityId)} «${asText(current['SUBJECT'])}»: ${Object.keys(changes).join(', ')}`,
        target: `crm.activity:${String(args.activityId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'crm.activity.update',
          activityId: args.activityId,
          provider,
          owner: { typeId: num(current['OWNER_TYPE_ID']) ?? null, id: num(current['OWNER_ID']) ?? null },
          stateHash: currentHash,
          changes,
        },
        risks,
      },
      validationLevel: 'local',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getActivity(ctx, args.activityId);
        if (activityStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Дело изменилось после подтверждения; изменение отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Подготовьте план заново и подтвердите новый diff',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'crm.activity.update',
          { id: args.activityId, fields },
          opts(ctx),
        );
        if (r.result !== true) {
          throw outcomeUnknown(
            'crm.activity.update',
            'legacy',
            'Прочитайте дело и сверьте с планом перед повторной попыткой',
          );
        }
        return {
          id: args.activityId,
          result: { activityId: args.activityId, changedFields: Object.keys(changes) },
        };
      },
      verify: async () => {
        const saved = await getActivity(ctx, args.activityId);
        const warnings: string[] = [];
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'DESCRIPTION_TYPE') continue;
          const ok =
            k === 'START_TIME' || k === 'END_TIME' ? sameTime(saved[k], v) : asText(saved[k]) === asText(v);
          if (!ok) warnings.push(`${k}: в портале «${asText(saved[k])}», ожидалось «${asText(v)}»`);
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    let after: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed) {
      try {
        after = activityStateHash(await getActivity(ctx, args.activityId));
      } catch {
        after = undefined;
      }
    }
    return mutationResponse(ctx, outcome, {
      base: { activityId: args.activityId, ...(after ? { stateHash: after } : {}) },
      method: 'crm.activity.update',
      resultFields: ['changedFields'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

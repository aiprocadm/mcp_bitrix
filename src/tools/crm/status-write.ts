/**
 * Запись справочников CRM (стадии, источники, причины и т. п.): crm.status.add и crm.status.update, без удаления.
 * Правила кода STATUS_ID и префикса воронки — по официальной странице crm.status.add; справочник должен
 * существовать в crm.status.entity.types. Через MutationExecutor: план → подтверждение → одна запись → сверка
 * по crm.status.get. Метод доступен только администратору CRM — иначе портал вернёт ACCESS_DENIED.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import { stateHash } from '../../security/idempotency.js';
import { mutationPrincipal, mutationResponse } from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import { asText } from './deal-fields.js';
import { listStatusEntityTypes, type StatusEntityType } from './crm-service.js';

const entityIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,59}$/)
  .describe(
    'Код справочника из crm_stages_and_statuses / crm.status.entity.types, например SOURCE, STATUS, DEAL_STAGE_3',
  );
const nameSchema = z.string().trim().min(1).max(100);
const sortSchema = z.number().int().min(0).max(1_000_000);
const colorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('Цвет стадии, например #39A8EF');
const SEMANTICS = { process: '', success: 'S', failure: 'F' } as const;

/** Справочник стадий (лиды, сделки, КП, счета, смарт-процессы) — у них есть семантика и цвет. */
export function isStageDirectory(entityId: string): boolean {
  return entityId === 'STATUS' || entityId === 'QUOTE_STATUS' || entityId.includes('STAGE');
}

/**
 * Итоговый STATUS_ID по правилам crm.status.add: у стадий — только латиница, цифры, «-», «_» и предел длины
 * (STATUS 21, QUOTE_STATUS и DEAL_STAGE 22); для DEAL_STAGE_xx портал сам добавляет префикс «Cxx:».
 * Остальные справочники — до 50 любых символов.
 */
export function finalStatusId(entityId: string, raw: string): string {
  const pipeline = /^DEAL_STAGE_(\d+)$/.exec(entityId);
  const prefix = pipeline ? `C${pipeline[1] ?? ''}:` : '';
  const value = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (isStageDirectory(entityId)) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'statusId: у стадий допустимы только латинские буквы, цифры, дефис и подчёркивание',
        { field: 'statusId', reason: 'INVALID_STATUS_ID' },
      );
    }
    const max =
      entityId === 'STATUS' ? 21 : entityId === 'QUOTE_STATUS' || entityId === 'DEAL_STAGE' ? 22 : 50;
    if (prefix.length + value.length > max) {
      throw new AppError('VALIDATION_ERROR', `statusId: длиннее ${String(max)} символов`, {
        field: 'statusId',
        reason: 'INVALID_STATUS_ID',
      });
    }
  } else if (raw.length > 50) {
    throw new AppError('VALIDATION_ERROR', 'statusId: длиннее 50 символов', {
      field: 'statusId',
      reason: 'INVALID_STATUS_ID',
    });
  }
  return prefix + value;
}

export interface StatusRow {
  id: number;
  statusId: string;
  name: string;
  sort: number;
  color: string;
  semantics: string;
  system: boolean;
}

function toRow(x: Record<string, unknown>): StatusRow {
  return {
    id: Number(asText(x['ID'])),
    statusId: asText(x['STATUS_ID']),
    name: asText(x['NAME']),
    sort: Number(asText(x['SORT'])) || 0,
    color: asText(x['COLOR']),
    semantics: asText(x['SEMANTICS']),
    system: asText(x['SYSTEM']) === 'Y',
  };
}

/** Элементы справочника с числовым ID (кэш crm_stages_and_statuses ID не хранит, читаем заново). */
export async function readDirectory(ctx: ToolContext, entityId: string): Promise<StatusRow[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.status.list',
    { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'crm.status.list вернул не массив', {
      method: 'crm.status.list',
      apiVersion: 'legacy',
    });
  }
  return (r.result as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(toRow)
    .filter((s) => Number.isSafeInteger(s.id) && s.id > 0);
}

async function readStatus(ctx: ToolContext, id: number): Promise<Record<string, unknown>> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.status.get',
    { id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) {
    throw new AppError('NOT_FOUND', 'Элемент справочника не найден', {
      method: 'crm.status.get',
      apiVersion: 'legacy',
    });
  }
  return r.result;
}

async function resolveDirectory(ctx: ToolContext, entityId: string): Promise<StatusEntityType> {
  const types = await listStatusEntityTypes(ctx);
  const dir = types.find((t) => t.id === entityId);
  if (!dir) {
    throw new AppError('VALIDATION_ERROR', `entityId: справочника ${entityId} нет на портале`, {
      field: 'entityId',
      reason: 'UNKNOWN_DIRECTORY',
      nextAction: `Доступные справочники: ${types.map((t) => t.id).join(', ')}`,
    });
  }
  return dir;
}

function duplicate(entityId: string, statusId: string): AppError {
  return new AppError('CONFLICT', `В справочнике ${entityId} уже есть элемент с кодом ${statusId}`, {
    field: 'statusId',
    reason: 'DUPLICATE_STATUS',
    nextAction: 'Выберите другой код или измените существующий элемент через crm_status_update',
  });
}

/** Сбросить кэш метаданных портала: справочники стадий/источников изменились. */
function invalidateDirectories(ctx: ToolContext): void {
  ctx.capabilities.invalidate();
}

// ---------- crm_status_create ----------

export const crmStatusCreateTool = defineTool({
  name: 'crm_status_create',
  module: 'crm',
  title: 'Новый элемент справочника CRM',
  description:
    'Добавить элемент в справочник CRM (crm.status.add): стадию лида/сделки/КП, источник, тип, причину отказа и т. п. ' +
    'Использовать, когда просят «добавь источник», «добавь стадию в воронку». Удаление не поддерживается. ' +
    'Нужны права администратора CRM. Код стадии — латиница/цифры/«-»/«_»; для воронки DEAL_STAGE_xx префикс «Cxx:» добавит портал (план покажет итоговый код). ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом; человек подтверждает; повтор с approvalId добавляет элемент ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityId: entityIdSchema,
      statusId: z.string().trim().min(1).max(60).describe('Код элемента, уникальный в справочнике'),
      name: nameSchema.describe('Название'),
      sort: sortSchema.optional().describe('Порядок (по умолчанию 10); у стадий: в работе < успех < провал'),
      color: colorSchema.optional(),
      semantics: z
        .enum(['process', 'success', 'failure'])
        .optional()
        .describe('Только для стадий: в работе (по умолчанию), успех, провал'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityId: z.string(),
    statusId: z.string(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    id: z.number().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const dir = await resolveDirectory(ctx, args.entityId);
    const stage = isStageDirectory(args.entityId);
    if (!stage && (args.semantics !== undefined || args.color !== undefined)) {
      throw new AppError('VALIDATION_ERROR', 'semantics и color задаются только у стадий', {
        field: args.semantics !== undefined ? 'semantics' : 'color',
        reason: 'NOT_A_STAGE_DIRECTORY',
      });
    }
    const statusId = finalStatusId(args.entityId, args.statusId);
    const existing = await readDirectory(ctx, args.entityId);
    if (!args.approvalId && existing.some((s) => s.statusId === statusId))
      throw duplicate(args.entityId, statusId);

    const fields: JsonObject = { ENTITY_ID: args.entityId, STATUS_ID: statusId, NAME: args.name };
    if (args.sort !== undefined) fields['SORT'] = args.sort;
    if (args.color !== undefined) fields['COLOR'] = args.color;
    if (args.semantics !== undefined) fields['SEMANTICS'] = SEMANTICS[args.semantics];
    const risks = ['Новый элемент сразу увидят все пользователи CRM в списках выбора'];
    if (stage) {
      risks.push('Новая стадия появится в воронке; роботы и права на ней не настроены');
      risks.push(
        'Порядок стадий по sort: сначала «в работе», затем «успех», затем «провал» — иначе воронка ломается',
      );
      if (args.semantics === 'success' || args.semantics === 'failure')
        risks.push('Стадия успеха/провала закрывает запись и меняет отчёты по конверсии');
    }

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_status_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Добавить в справочник «${dir.name}» (${args.entityId}) элемент «${args.name}» с кодом ${statusId}`,
        target: `crm.status:${args.entityId}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'crm.status.add', fields, itemsBefore: existing.length },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await readDirectory(ctx, args.entityId);
        if (fresh.some((s) => s.statusId === statusId)) throw duplicate(args.entityId, statusId);
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'crm.status.add',
          { fields },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        invalidateDirectories(ctx);
        const id = Number(r.result);
        if (!Number.isSafeInteger(id) || id <= 0) {
          throw new AppError('OPERATION_OUTCOME_UNKNOWN', 'crm.status.add не вернул ID элемента', {
            method: 'crm.status.add',
            apiVersion: 'legacy',
          });
        }
        return { id, result: { id } };
      },
      verify: async (performed) => {
        const saved = await readStatus(ctx, Number(performed.id));
        const warnings: string[] = [];
        if (asText(saved['ENTITY_ID']) !== args.entityId)
          warnings.push('Элемент записан в другой справочник');
        if (asText(saved['STATUS_ID']) !== statusId)
          warnings.push(`Код в портале: ${asText(saved['STATUS_ID'])} (ожидался ${statusId})`);
        if (asText(saved['NAME']) !== args.name)
          warnings.push('Название в портале отличается от отправленного');
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { entityId: args.entityId, statusId },
      method: 'crm.status.add',
      resultFields: ['id'],
    });
  },
});

// ---------- crm_status_update ----------

export const crmStatusUpdateTool = defineTool({
  name: 'crm_status_update',
  module: 'crm',
  title: 'Изменить элемент справочника CRM',
  description:
    'Переименовать элемент справочника CRM, поменять порядок или цвет (crm.status.update): стадию, источник, причину отказа. ' +
    'Использовать, когда просят «переименуй стадию», «поменяй порядок источников». Код и семантику не меняет; удаление не поддерживается. ' +
    'Нужны права администратора CRM. Элемент ищется по entityId + statusId; stateHash из ответа плана защищает от гонки. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом «было → станет»; человек подтверждает; повтор с approvalId изменяет ровно один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityId: entityIdSchema,
      statusId: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe('Код изменяемого элемента (с префиксом воронки, как в справочнике)'),
      name: nameSchema.optional().describe('Новое название'),
      sort: sortSchema.optional().describe('Новый порядок'),
      color: colorSchema.optional(),
      ...updateArgsShape,
    })
    .strict()
    .superRefine((a, c) => {
      requireIdempotencyUnlessDryRun(a, c);
      if (a.name === undefined && a.sort === undefined && a.color === undefined)
        c.addIssue({ code: 'custom', path: ['name'], message: 'укажите хотя бы одно из name, sort, color' });
    }),
  outputDataSchema: z.object({
    entityId: z.string(),
    statusId: z.string(),
    id: z.number(),
    stateHash: z.string(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const dir = await resolveDirectory(ctx, args.entityId);
    if (args.color !== undefined && !isStageDirectory(args.entityId)) {
      throw new AppError('VALIDATION_ERROR', 'color задаётся только у стадий', {
        field: 'color',
        reason: 'NOT_A_STAGE_DIRECTORY',
      });
    }
    const findCurrent = async (): Promise<StatusRow> => {
      const row = (await readDirectory(ctx, args.entityId)).find((s) => s.statusId === args.statusId);
      if (!row) {
        throw new AppError('NOT_FOUND', `В справочнике ${args.entityId} нет элемента ${args.statusId}`, {
          field: 'statusId',
          nextAction: 'Коды элементов — crm_stages_and_statuses',
        });
      }
      return row;
    };
    const snapshot = (r: StatusRow) => ({ name: r.name, sort: r.sort, color: r.color });
    const current = await findCurrent();
    const hash = stateHash(snapshot(current));
    // Повтор с approvalId после успешного изменения: хеш закономерно другой — сверка тогда только в precheck.
    if (args.expectedStateHash && !args.approvalId && args.expectedStateHash !== hash) {
      throw new AppError('CONFLICT', 'Элемент справочника изменился с момента чтения', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Подготовьте план заново без expectedStateHash или с новым stateHash',
      });
    }
    const wanted: Record<string, string | number> = {};
    if (args.name !== undefined) wanted['NAME'] = args.name;
    if (args.sort !== undefined) wanted['SORT'] = args.sort;
    if (args.color !== undefined) wanted['COLOR'] = args.color;
    const before: Record<string, string | number> = {
      NAME: current.name,
      SORT: current.sort,
      COLOR: current.color,
    };
    const fields: JsonObject = {};
    const changes: Record<string, { from: string | number; to: string | number }> = {};
    for (const [k, v] of Object.entries(wanted)) {
      if (String(before[k]).toLowerCase() === String(v).toLowerCase()) continue;
      fields[k] = v;
      changes[k] = { from: before[k] ?? '', to: v };
    }
    if (Object.keys(fields).length === 0 && !args.approvalId) {
      throw new AppError('VALIDATION_ERROR', 'Изменений нет: значения совпадают с текущими', {
        reason: 'NO_CHANGES',
      });
    }
    const risks = ['Новое название сразу увидят все пользователи CRM'];
    if (current.system) risks.push('Системный элемент портала: код и семантика остаются прежними');
    if ('SORT' in fields && isStageDirectory(args.entityId))
      risks.push('Смена порядка стадий: «в работе» должны идти раньше «успеха», «успех» — раньше «провала»');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_status_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить в справочнике «${dir.name}» (${args.entityId}) элемент ${args.statusId} «${current.name}»`,
        target: `crm.status:${String(current.id)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'crm.status.update', id: current.id, fields, changes },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await findCurrent();
        if (args.expectedStateHash && stateHash(snapshot(fresh)) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Элемент справочника изменился после подтверждения', {
            field: 'expectedStateHash',
            reason: 'STATE_CHANGED',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'crm.status.update',
          { id: current.id, fields },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        invalidateDirectories(ctx);
        if (r.result !== true) {
          throw new AppError('OPERATION_OUTCOME_UNKNOWN', 'crm.status.update не подтвердил изменение', {
            method: 'crm.status.update',
            apiVersion: 'legacy',
          });
        }
        return { id: current.id, result: {} };
      },
      verify: async () => {
        const saved = await readStatus(ctx, current.id);
        const warnings: string[] = [];
        for (const [k, v] of Object.entries(fields)) {
          if (asText(saved[k]).toLowerCase() !== asText(v).toLowerCase())
            warnings.push(`Поле ${k}: в портале «${asText(saved[k])}», ожидалось «${asText(v)}»`);
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { entityId: args.entityId, statusId: args.statusId, id: current.id, stateHash: hash },
      method: 'crm.status.update',
    });
  },
});

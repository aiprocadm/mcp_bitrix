import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { validateFilter, validateOrder, validateSelect } from './deal-fields.js';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { splitNotContains } from './bulk.js';
import { getFieldsMeta, listRecords } from './crm-service.js';
import { isEmptyValue, NameResolver, refColumnFor } from './names.js';
import {
  entityTypeIdSchema,
  itemListEnvelope,
  recordEntityTypeSchema,
  resolveRecordTarget,
} from './item-ops.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);

export const crmListRecordsTool = defineTool({
  name: 'crm_list_records',
  module: 'crm',
  title: 'Список записей CRM',
  description:
    'Страница записей CRM (сделки, лиды, контакты, компании, элементы смарт-процессов, новые счета, коммерческие предложения) с фильтром, сортировкой и выбором полей. ' +
    'Использовать, когда нужен список записей по условию: стадия, ответственный, даты, часть названия. ' +
    'Классика (crm.<entity>.list): ключи ИМЯ_ПОЛЯ с префиксом (=, %, >, <, >=, <=, !, @, ><), например {">=DATE_CREATE": "2026-09-01", "%TITLE": "договор"}. ' +
    'smart (нужен entityTypeId), invoice и quote идут через crm.item.list: поля camelCase, например {">=createdTime": "2026-09-01", "%title": "договор"}; регистр автоматически не переводится. ' +
    'Поля проверяются по схеме портала (crm_fields_get). «!%ПОЛЕ» (не содержит) проверяется сервером MCP. ' +
    'compact=true — только ID, название, дата, ответственный и без пустых полей; withNames=true — рядом с ID сотрудника, компании, стадии их имена (поле *_NAME). ' +
    'Одна страница до 50 записей; продолжение — по cursor из ответа (pageSize при продолжении можно менять). ' +
    'Если нужна вся выборка или число — crm_export (файл) и crm_count (итоги) вместо листания.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      filter: z
        .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
        .default({})
        .describe('Условия фильтра Bitrix24; поля из схемы портала'),
      order: z
        .record(z.string().max(100), z.enum(['ASC', 'DESC', 'asc', 'desc']))
        .optional()
        .describe(
          'Сортировка, например {"DATE_CREATE": "DESC"} (smart/invoice/quote: {"createdTime": "DESC"}); по умолчанию ID по убыванию',
        ),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe(
          'Поля в ответе; по умолчанию ключевые поля сущности (ID, название/имя, стадия, ответственный, даты)',
        ),
      compact: z
        .boolean()
        .default(false)
        .describe(
          'Короткий ответ: по умолчанию только ID, название, дата, ответственный; пустые поля и null убираются',
        ),
      withNames: z
        .boolean()
        .default(false)
        .describe(
          'Добавить имена: ASSIGNED_BY_NAME (ФИО, в т. ч. уволенных), COMPANY_NAME, STAGE_NAME, SOURCE_NAME…',
        ),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const resolved = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    if (resolved.kind === 'item') {
      return itemListEnvelope(
        ctx,
        resolved.target,
        { tool: 'crm_list_records', ...args },
        { entityType: args.entityType, entityTypeId: resolved.target.entityTypeId },
      );
    }
    const entity = resolved.entity;
    const meta = await getFieldsMeta(ctx, entity);
    const { upstream: filter, local } = splitNotContains(validateFilter(args.filter, meta));
    const order = validateOrder(args.order ?? { ID: 'DESC' }, meta);
    const compactSelect = (entity.type === 'contact' ? ['ID', 'NAME', 'LAST_NAME'] : ['ID', 'TITLE']).concat([
      'DATE_CREATE',
      'ASSIGNED_BY_ID',
    ]);
    const select = validateSelect(
      args.select ?? (args.compact ? compactSelect : [...entity.defaultSelect]),
      meta,
    );
    const pageSize = Math.min(
      args.pageSize ?? ctx.config.limits.defaultPageSize,
      ctx.config.limits.maxPageSize,
    );
    const page = await listRecords(ctx, entity, {
      filter,
      order,
      select,
      pageSize,
      cursor: args.cursor,
      local,
    });
    const requested = new Set(select);
    let items = (page.items as Record<string, JsonValue>[]).map((it) => {
      // Поля, добавленные только для проверки «!%», в ответ не попадают.
      if (!local.length || requested.has('*')) return it;
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(it))
        if (requested.has(k) || (requested.has('UF_*') && k.startsWith('UF_'))) out[k] = v;
      return out;
    });
    const warnings: string[] = [];
    if (args.withNames) {
      const names = new NameResolver(ctx);
      const fields = new Set(items.flatMap((it) => Object.keys(it)));
      const refs = [...fields].flatMap((f) => {
        const ref = refColumnFor(entity.type, f);
        return ref ? [ref] : [];
      });
      await names.prepare(items, refs);
      items = items.map((it) => {
        const out: Record<string, JsonValue> = { ...it };
        for (const ref of refs) {
          if (!(ref.field in it)) continue;
          const name = names.label(ref, it);
          if (name) out[`${ref.field.replace(/_ID$/, '')}_NAME`] = name;
        }
        return out;
      });
      warnings.push(...names.warnings);
    }
    if (args.compact)
      items = items.map((it) => Object.fromEntries(Object.entries(it).filter(([, v]) => !isEmptyValue(v))));
    if (local.length)
      warnings.push('Условия «!%» (не содержит) проверены сервером MCP; страница может быть короче pageSize');
    if (page.upstreamCalls === 0) warnings.push('Страница отдана из буфера предыдущего запроса к порталу');
    return ok(
      {
        entityType: entity.type,
        items,
        returnedCount: page.items.length,
        ...(page.upstreamTotal !== undefined ? { upstreamTotal: page.upstreamTotal } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: `${entity.methodBase}.list`,
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: page.hasMore ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

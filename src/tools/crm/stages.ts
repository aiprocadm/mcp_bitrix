/**
 * crm_stages_and_statuses (ТЗ §9.4): воронки, стадии и справочники с их ID.
 * Без аргументов — перечень справочников (crm.status.entity.types); entityType=deal — воронки (crm.category.list)
 * и стадии выбранной/общей воронки; lead — статусы STATUS; contact/company — их справочники типов/сфер;
 * statusEntityId — любой конкретный справочник (crm.status.list).
 */
import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { classicEntity, dealStageEntityId, entityTypeSchema } from './entities.js';
import { listCategories, listStatuses, listStatusEntityTypes, type StatusItem } from './crm-service.js';

const statusSchema = z.object({
  statusId: z.string(),
  name: z.string(),
  sort: z.number(),
  entityId: z.string(),
  semantics: z.string().optional(),
  categoryId: z.number().optional(),
});

function pub(s: StatusItem): z.infer<typeof statusSchema> {
  return {
    statusId: s.statusId,
    name: s.name,
    sort: s.sort,
    entityId: s.entityId,
    ...(s.semantics ? { semantics: s.semantics } : {}),
    ...(s.categoryId !== undefined ? { categoryId: s.categoryId } : {}),
  };
}

export const crmStagesAndStatusesTool = defineTool({
  name: 'crm_stages_and_statuses',
  module: 'crm',
  title: 'Стадии, воронки и справочники CRM',
  description:
    'Воронки, стадии и справочники CRM с их ID. Использовать перед созданием/изменением записи, чтобы взять точный STAGE_ID/STATUS_ID ' +
    'или значение справочника (тип контакта, сфера компании, источник). Без аргументов — перечень всех справочников портала; ' +
    'entityType=deal — воронки и стадии (categoryId выбирает воронку, по умолчанию общая); entityType=lead — статусы лида; ' +
    'statusEntityId — конкретный справочник, например SOURCE или DEAL_STAGE_5.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema.optional(),
      categoryId: z.number().int().min(0).max(1_000_000).optional().describe('Воронка сделок (0 — общая)'),
      statusEntityId: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,60}$/)
        .optional()
        .describe(
          'ID справочника из перечня: STATUS, SOURCE, DEAL_STAGE, DEAL_STAGE_<воронка>, CONTACT_TYPE, COMPANY_TYPE, INDUSTRY…',
        ),
      refresh: z.boolean().default(false).describe('Игнорировать кэш справочников (5 минут)'),
    })
    .strict(),
  outputDataSchema: z.object({
    dictionaries: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          entityTypeId: z.number().optional(),
          categoryId: z.number().optional(),
        }),
      )
      .optional(),
    categories: z
      .array(z.object({ id: z.number(), name: z.string(), sort: z.number(), isDefault: z.boolean() }))
      .optional(),
    selectedCategoryId: z.number().optional(),
    statuses: z.array(statusSchema).optional(),
  }),
  handler: async (args, ctx) => {
    const base = { requestId: ctx.requestId, durationMs: 0, apiVersion: 'legacy' as const };
    const done = (data: Record<string, unknown>, method: string, warnings: string[] = []) =>
      ok(data, { ...base, durationMs: Date.now() - ctx.startedAt, method, warnings });

    if (args.statusEntityId) {
      const statuses = await listStatuses(ctx, args.statusEntityId, args.refresh);
      return done({ statuses: statuses.map(pub) }, 'crm.status.list');
    }
    if (!args.entityType) {
      const dictionaries = await listStatusEntityTypes(ctx);
      return done(
        {
          dictionaries: dictionaries.map((d) => ({
            id: d.id,
            name: d.name,
            ...(d.entityTypeId !== undefined && Number.isFinite(d.entityTypeId)
              ? { entityTypeId: d.entityTypeId }
              : {}),
            ...(d.categoryId !== undefined && Number.isFinite(d.categoryId)
              ? { categoryId: d.categoryId }
              : {}),
          })),
        },
        'crm.status.entity.types',
      );
    }
    const entity = classicEntity(args.entityType);
    if (entity.type === 'deal') {
      const categories = await listCategories(ctx, entity.entityTypeId);
      const selected = args.categoryId ?? categories.find((c) => c.isDefault)?.id ?? 0;
      const warnings: string[] = [];
      if (args.categoryId !== undefined && !categories.some((c) => c.id === args.categoryId)) {
        warnings.push(
          `Воронка ${String(args.categoryId)} не найдена в crm.category.list; стадии могут быть пустыми`,
        );
      }
      const statuses = await listStatuses(ctx, dealStageEntityId(selected), args.refresh);
      return done(
        { categories, selectedCategoryId: selected, statuses: statuses.map(pub) },
        'crm.status.list',
        warnings.concat(
          categories.length > 1
            ? ['Стадии показаны для одной воронки; другую выберите через categoryId']
            : [],
        ),
      );
    }
    const statuses: StatusItem[] = [];
    for (const entityId of entity.statusEntityIds)
      statuses.push(...(await listStatuses(ctx, entityId, args.refresh)));
    return done({ statuses: statuses.map(pub) }, 'crm.status.list');
  },
});

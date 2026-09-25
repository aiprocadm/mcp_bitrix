/**
 * Чтение реквизитов CRM (ТЗ §9.4): crm_requisites_list и crm_requisite_presets_list.
 * Реквизиты отдаются в ограниченном профиле: паспортные данные и персональные номера не запрашиваются (§8.4).
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { idSchema, isObj, pageMeta, pageSizeOf, asText, idOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  addressText,
  addressTypes,
  normalizePreset,
  presetFields,
  presetsPage,
  REQUISITE_DEFAULT_SELECT,
  REQUISITE_SENSITIVE_FIELD,
  requisiteAddresses,
  requisitesPage,
  type Preset,
  type PresetField,
} from './requisites-service.js';

export const ownerEntityTypeIdSchema = z
  .union([z.literal(3), z.literal(4)])
  .describe('Тип владельца реквизита: 3 — контакт, 4 — компания (crm.enum.ownertype)');

const FIELD_NAME = /^(?:[A-Z][A-Z0-9_]{0,59})$/;

// ---------- crm_requisites_list ----------

export const crmRequisitesListTool = defineTool({
  name: 'crm_requisites_list',
  module: 'crm',
  title: 'Реквизиты компании или контакта',
  description:
    'Реквизиты компании или контакта CRM (crm.requisite.list): название, шаблон, ИНН/КПП/ОГРН, руководитель; по желанию — адреса реквизитов. ' +
    'Использовать, когда нужны реквизиты клиента для документа/счёта или ID реквизита для изменения, адреса и банковских реквизитов. ' +
    'Паспортные данные и персональные номера не выдаются. Одна страница до 50 реквизитов, продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      ownerEntityTypeId: ownerEntityTypeIdSchema,
      ownerId: idSchema.describe('ID компании или контакта'),
      select: z
        .array(z.string().regex(FIELD_NAME, 'имя поля ВЕРХНИМ_РЕГИСТРОМ, например RQ_OKPO или UF_CRM_…'))
        .min(1)
        .max(60)
        .optional()
        .describe('Поля реквизита (по умолчанию — ID, название, шаблон, ИНН/КПП/ОГРН, руководитель)'),
      includeAddresses: z
        .boolean()
        .default(false)
        .describe('Добавить адреса реквизитов (crm.address.list) с названиями типов'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    ownerEntityTypeId: z.number(),
    ownerId: z.number(),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const denied = (args.select ?? []).filter((f) => REQUISITE_SENSITIVE_FIELD.test(f));
    if (denied.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Поля ${denied.join(', ')} содержат персональные документы и не выдаются`,
        { field: 'select', reason: 'FIELD_NOT_ALLOWED' },
      );
    }
    const select = args.select
      ? [...new Set(['ID', 'ENTITY_TYPE_ID', 'ENTITY_ID', 'PRESET_ID', 'NAME', ...args.select])]
      : [...REQUISITE_DEFAULT_SELECT];
    const page = await requisitesPage(ctx, {
      ownerEntityTypeId: args.ownerEntityTypeId,
      ownerId: args.ownerId,
      select,
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const allowed = new Set(select);
    const items = page.items.filter(isObj).map((r) => {
      const out: Record<string, JsonValue> = {};
      // Портал может вернуть больше полей, чем запрошено: выдаём только выбранные и не чувствительные.
      for (const [k, v] of Object.entries(r)) {
        if (allowed.has(k) && !REQUISITE_SENSITIVE_FIELD.test(k)) out[k] = v;
      }
      return out;
    });
    const warnings: string[] = [];
    if (args.includeAddresses && items.length > 0) {
      const ids = items.map((i) => idOf(i['ID'])).filter((id): id is number => id !== undefined);
      const [addresses, types] = await Promise.all([requisiteAddresses(ctx, ids), addressTypes(ctx)]);
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      for (const item of items) {
        const own = addresses.filter((a) => asText(a['ENTITY_ID']) === asText(item['ID']));
        item['addresses'] = own.map((a) => {
          const typeId = idOf(a['TYPE_ID']) ?? 0;
          return {
            typeId,
            typeName: typeName.get(typeId) ?? '',
            ...Object.fromEntries(Object.entries(addressText(a)).filter(([, v]) => v !== '')),
          };
        });
      }
    }
    return ok(
      {
        ownerEntityTypeId: args.ownerEntityTypeId,
        ownerId: args.ownerId,
        items,
        returnedCount: items.length,
      },
      pageMeta(ctx, 'crm.requisite.list', page, 'legacy', warnings),
    );
  },
});

// ---------- crm_requisite_presets_list ----------

const MAX_PRESETS_WITH_FIELDS = 10;

export const crmRequisitePresetsListTool = defineTool({
  name: 'crm_requisite_presets_list',
  module: 'crm',
  title: 'Шаблоны реквизитов',
  description:
    'Шаблоны (пресеты) реквизитов CRM: «Организация», «ИП», «Физ. лицо» и т. п. с ID, страной и активностью (crm.requisite.preset.list); ' +
    'с includeFields — поля каждого шаблона (crm.requisite.preset.field.list). Использовать перед crm_requisite_create: ' +
    'presetId берётся отсюда, а поля RQ_* реквизита должны входить в выбранный шаблон. countryId: 1 — Россия.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      countryId: idSchema.optional().describe('ID страны шаблона (crm.requisite.preset.countries; 1 — RU)'),
      activeOnly: z.boolean().default(true).describe('Только активные шаблоны'),
      includeFields: z
        .boolean()
        .default(false)
        .describe(
          `Добавить поля шаблонов (не более ${String(MAX_PRESETS_WITH_FIELDS)} шаблонов на страницу)`,
        ),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        countryId: z.number().optional(),
        active: z.boolean(),
        fields: z.array(z.object({ fieldName: z.string(), title: z.string(), sort: z.number() })).optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const page = await presetsPage(ctx, {
      countryId: args.countryId,
      activeOnly: args.activeOnly,
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    const presets = page.items.map(normalizePreset).filter((p): p is Preset => p !== undefined);
    const warnings: string[] = [];
    const fieldsById = new Map<number, PresetField[]>();
    if (args.includeFields) {
      const withFields = presets.slice(0, MAX_PRESETS_WITH_FIELDS);
      if (presets.length > withFields.length) {
        warnings.push(
          `Поля показаны для первых ${String(MAX_PRESETS_WITH_FIELDS)} шаблонов; уменьшите pageSize для остальных`,
        );
      }
      for (const p of withFields) fieldsById.set(p.id, await presetFields(ctx, p.id));
    }
    const items = presets.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.countryId !== undefined ? { countryId: p.countryId } : {}),
      active: p.active,
      ...(fieldsById.has(p.id) ? { fields: fieldsById.get(p.id) } : {}),
    }));
    return ok(
      { items, returnedCount: items.length },
      pageMeta(ctx, 'crm.requisite.preset.list', page, 'legacy', warnings),
    );
  },
});

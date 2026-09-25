/**
 * Запись реквизитов CRM (ТЗ §9.4, §8.2 — изменение реквизитов относится к повышенному риску):
 * crm_requisite_create, crm_requisite_update, crm_requisite_address_set, crm_bank_account_add.
 * Всё — через MutationExecutor: проверки и чтения до плана → APPROVAL_REQUIRED → подтверждение человеком →
 * одна запись → сверка повторным чтением. Поля проверяются по метаданным портала (crm.requisite.fields,
 * crm.requisite.bankdetail.fields) и составу шаблона (crm.requisite.preset.field.list).
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
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  num,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import { validateFieldsForWrite, type DealFieldsMeta } from './deal-fields.js';
import { classicEntity, recordTitle } from './entities.js';
import { getRecord } from './crm-service.js';
import { ownerEntityTypeIdSchema } from './requisites-read.js';
import {
  ADDRESS_OWNER_REQUISITE,
  ADDRESS_TEXT_FIELDS,
  addBankDetail,
  addRequisite,
  addressText,
  addressTypes,
  bankDetailFieldsMeta,
  COUNTRY_ID_RU,
  findPreset,
  getBankDetail,
  getRequisite,
  presetFields,
  REQUISITE_OWNER_TYPES,
  REQUISITE_SENSITIVE_FIELD,
  requisiteAddresses,
  requisiteFieldsMeta,
  requisiteStateHash,
  updateRequisite,
  writeAddress,
  type AddressTextField,
  type Preset,
  type Requisite,
} from './requisites-service.js';

const REQUISITE_RISK =
  'Повышенный риск (ТЗ §8.2): реквизиты используются в счетах, коммерческих предложениях и печатных документах; ' +
  'ошибка попадёт во все новые документы клиента';

const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const fieldsRecord = (what: string) =>
  z
    .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/, 'имена полей — ВЕРХНИЙ_РЕГИСТР'), fieldValue)
    .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 80, 'от 1 до 80 полей')
    .describe(what);

/** Ошибка метаданных полей — с подсказкой, где смотреть допустимые поля реквизита. */
function validateWith(
  fields: Record<string, unknown>,
  meta: DealFieldsMeta,
  mode: 'create' | 'update',
  nextAction: string,
): JsonObject {
  try {
    return validateFieldsForWrite(fields, meta, mode);
  } catch (e) {
    if (AppError.is(e)) throw new AppError(e.code, e.message, { ...e.details, nextAction });
    throw e;
  }
}

function rejectKeys(fields: Record<string, unknown>, keys: readonly string[], why: string): void {
  const bad = Object.keys(fields).filter((k) => keys.includes(k));
  if (bad.length > 0) {
    throw new AppError('VALIDATION_ERROR', `${bad.join(', ')}: ${why}`, {
      field: bad[0] ?? 'fields',
      reason: 'FIELD_NOT_ALLOWED',
    });
  }
}

function rejectSensitive(fields: Record<string, unknown>): void {
  const bad = Object.keys(fields).filter((k) => REQUISITE_SENSITIVE_FIELD.test(k));
  if (bad.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${bad.join(', ')}: персональные документы/номера через MCP не записываются (ТЗ §8.4)`,
      { field: bad[0] ?? 'fields', reason: 'FIELD_NOT_ALLOWED' },
    );
  }
}

/** Поля RQ_* должны входить в шаблон реквизита: иначе портал сохранит их, но пользователь их не увидит. */
async function assertInPreset(ctx: ToolContext, preset: Preset, fields: Record<string, unknown>) {
  const rq = Object.keys(fields).filter((k) => k.startsWith('RQ_'));
  if (rq.length === 0) return;
  const inPreset = new Set((await presetFields(ctx, preset.id)).map((f) => f.fieldName));
  const missing = rq.filter((k) => !inPreset.has(k));
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${missing.join(', ')}: поля нет в шаблоне «${preset.name}» (ID ${String(preset.id)}); значение сохранилось бы, но не было бы видно в карточке`,
      {
        field: missing[0] ?? 'fields',
        reason: 'FIELD_NOT_IN_PRESET',
        nextAction: 'Посмотрите поля шаблона: crm_requisite_presets_list с includeFields=true',
      },
    );
  }
}

const same = (a: unknown, b: unknown) => asText(a) === asText(b);

function compareWritten(sent: JsonObject, saved: Record<string, JsonValue>): string[] {
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(sent)) {
    if (!same(saved[k], v)) warnings.push(`${k}: в портале «${asText(saved[k])}», ожидалось «${asText(v)}»`);
  }
  return warnings;
}

// ---------- crm_requisite_create ----------

export const crmRequisiteCreateTool = defineTool({
  name: 'crm_requisite_create',
  module: 'crm',
  title: 'Создать реквизит',
  description:
    'Создать реквизит компании или контакта CRM (crm.requisite.add) по шаблону: presetId — из crm_requisite_presets_list, ' +
    'поля RQ_* (ИНН, КПП, ОГРН, названия, руководитель) — только входящие в шаблон и известные crm.requisite.fields. ' +
    'Использовать, когда пользователь явно просит добавить реквизиты клиента. Шаблон проверяется до плана (INVALID_PRESET), ' +
    'владелец должен существовать. Адрес и банковские реквизиты добавляются отдельно (crm_requisite_address_set, crm_bank_account_add). ' +
    'Порядок: APPROVAL_REQUIRED с планом → подтверждение человеком → повтор с approvalId.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      ownerEntityTypeId: ownerEntityTypeIdSchema,
      ownerId: idSchema.describe('ID компании или контакта'),
      presetId: idSchema.describe('ID шаблона реквизита (crm_requisite_presets_list)'),
      name: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe('Название реквизита, например «Реквизиты ООО Ромашка»'),
      fields: fieldsRecord(
        'Поля реквизита RQ_*, UF_CRM_* и служебные (SORT, ACTIVE…) по crm.requisite.fields',
      )
        .optional()
        .default({}),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    ownerEntityTypeId: z.number(),
    ownerId: z.number(),
    requisiteId: z.number().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    // 1. Шаблон — до всего остального: неизвестный шаблон не порождает план (INVALID_PRESET).
    const preset = await findPreset(ctx, args.presetId);
    if (!preset) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Шаблон реквизита ${String(args.presetId)} не найден на портале`,
        {
          field: 'presetId',
          reason: 'INVALID_PRESET',
          nextAction: 'Выберите шаблон из crm_requisite_presets_list',
        },
      );
    }
    // 2. Поля: системные задаются отдельными параметрами; остальные — по метаданным и составу шаблона.
    rejectKeys(
      args.fields,
      ['ID', 'ENTITY_TYPE_ID', 'ENTITY_ID', 'PRESET_ID', 'NAME'],
      'задаются параметрами ownerEntityTypeId/ownerId/presetId/name',
    );
    rejectSensitive(args.fields);
    const meta = await requisiteFieldsMeta(ctx);
    const fields = validateWith(
      {
        ...args.fields,
        ENTITY_TYPE_ID: args.ownerEntityTypeId,
        ENTITY_ID: args.ownerId,
        PRESET_ID: args.presetId,
        NAME: args.name,
      },
      meta,
      'create',
      'Допустимые поля — страница crm.requisite.add и шаблон (crm_requisite_presets_list с includeFields=true)',
    );
    await assertInPreset(ctx, preset, args.fields);
    // 3. Владелец существует и доступен (NOT_FOUND без плана).
    const owner = classicEntity(REQUISITE_OWNER_TYPES[args.ownerEntityTypeId]);
    const ownerRecord = await getRecord(ctx, owner, args.ownerId);
    const ownerTitle = recordTitle(owner, ownerRecord);

    const risks = [REQUISITE_RISK];
    if (!preset.active) risks.push(`Шаблон «${preset.name}» неактивен: в интерфейсе его нельзя выбрать`);
    if (!('RQ_INN' in fields) && preset.countryId === COUNTRY_ID_RU)
      risks.push('ИНН (RQ_INN) не указан: документы по этим реквизитам будут неполными');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_requisite_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать реквизит «${args.name}» по шаблону «${preset.name}» для: ${owner.label} #${String(args.ownerId)} «${ownerTitle}»`,
        target: `${owner.methodBase}:${String(args.ownerId)}:requisite`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'crm.requisite.add',
          owner: { entityTypeId: args.ownerEntityTypeId, id: args.ownerId, title: ownerTitle },
          preset: { id: preset.id, name: preset.name, countryId: preset.countryId ?? null },
          fields,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const id = await addRequisite(ctx, fields);
        return { id, result: { requisiteId: id } };
      },
      verify: async (performed) => {
        const saved = await getRequisite(ctx, Number(performed.id));
        const warnings = compareWritten(fields, saved);
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { ownerEntityTypeId: args.ownerEntityTypeId, ownerId: args.ownerId },
      method: 'crm.requisite.add',
      resultFields: ['requisiteId'],
    });
  },
});

// ---------- crm_requisite_update ----------

function updateRisks(fields: JsonObject, current: Requisite, hasExpected: boolean): string[] {
  const risks = [REQUISITE_RISK];
  const key = ['RQ_INN', 'RQ_KPP', 'RQ_OGRN', 'RQ_OGRNIP', 'RQ_COMPANY_NAME', 'RQ_COMPANY_FULL_NAME'].filter(
    (k) => k in fields && !same(fields[k], current[k]),
  );
  if (key.length > 0)
    risks.push(
      `Меняются ключевые реквизиты (${key.join(', ')}): уже выставленные документы не изменятся, новые — будут с новыми данными`,
    );
  if (!hasExpected)
    risks.push(
      'expectedStateHash не передан: если реквизит изменят до выполнения, изменение всё равно применится',
    );
  return risks;
}

export const crmRequisiteUpdateTool = defineTool({
  name: 'crm_requisite_update',
  module: 'crm',
  title: 'Изменить реквизит',
  description:
    'Изменить поля существующего реквизита CRM (crm.requisite.update): название, ИНН/КПП, руководитель и другие поля шаблона. ' +
    'Использовать, когда пользователь явно просит исправить реквизиты клиента; передавайте только изменяемые поля. ' +
    'Владелец и шаблон реквизита не меняются. План показывает diff «было → станет» и stateHash; передайте его как ' +
    'expectedStateHash, чтобы одновременное изменение дало CONFLICT, а не тихую перезапись. ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      requisiteId: idSchema.describe('ID реквизита (crm_requisites_list)'),
      fields: fieldsRecord('Изменяемые поля реквизита по crm.requisite.fields: NAME, RQ_*, UF_CRM_*'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    requisiteId: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    rejectKeys(args.fields, ['ID'], 'ID задаётся параметром requisiteId');
    rejectSensitive(args.fields);
    const meta = await requisiteFieldsMeta(ctx);
    const fields = validateWith(
      args.fields,
      meta,
      'update',
      'Допустимые поля — страница crm.requisite.update; владелец и шаблон реквизита не изменяются',
    );
    const current = await getRequisite(ctx, args.requisiteId);
    const currentHash = requisiteStateHash(current);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Реквизит изменился после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Подготовьте план заново (dryRun=true) и сверьте изменения',
      });
    }
    const presetId = idOf(current['PRESET_ID']);
    if (presetId !== undefined) {
      const preset = (await findPreset(ctx, presetId)) ?? {
        id: presetId,
        name: '',
        countryId: undefined,
        active: true,
        entityTypeId: undefined,
      };
      await assertInPreset(ctx, preset, fields);
    }
    const changes: Record<string, { from: JsonValue; to: JsonValue }> = {};
    for (const [k, v] of Object.entries(fields)) changes[k] = { from: current[k] ?? null, to: v };
    const ownerTypeId = num(current['ENTITY_TYPE_ID']);
    const ownerId = num(current['ENTITY_ID']);

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_requisite_update',
      operationKind: 'update',
      args: { ...args, fields },
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить реквизит #${String(args.requisiteId)} «${asText(current['NAME'])}»: ${Object.keys(fields).join(', ')}`,
        target: `crm.requisite:${String(args.requisiteId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'crm.requisite.update',
          requisiteId: args.requisiteId,
          owner: { entityTypeId: ownerTypeId ?? null, id: ownerId ?? null },
          stateHash: currentHash,
          changes,
        },
        risks: updateRisks(fields, current, args.expectedStateHash !== undefined),
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getRequisite(ctx, args.requisiteId);
        if (requisiteStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Реквизит изменился после подтверждения; изменение отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Подготовьте план заново и подтвердите новый diff',
          });
        }
      },
      perform: async () => {
        await updateRequisite(ctx, args.requisiteId, fields);
        return {
          id: args.requisiteId,
          result: { requisiteId: args.requisiteId, changedFields: Object.keys(fields) },
        };
      },
      verify: async () => {
        const warnings = compareWritten(fields, await getRequisite(ctx, args.requisiteId));
        return { verified: warnings.length === 0, warnings };
      },
    });
    let after: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed) {
      try {
        after = requisiteStateHash(await getRequisite(ctx, args.requisiteId));
      } catch {
        after = undefined;
      }
    }
    return mutationResponse(ctx, outcome, {
      base: { requisiteId: args.requisiteId, ...(after ? { stateHash: after } : {}) },
      method: 'crm.requisite.update',
      resultFields: ['changedFields'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

// ---------- crm_requisite_address_set ----------

const addressFieldsSchema = z
  .object({
    ADDRESS_1: z.string().max(255).optional().describe('Улица, дом, корпус, строение'),
    ADDRESS_2: z.string().max(255).optional().describe('Квартира / офис'),
    CITY: z.string().max(128).optional().describe('Город'),
    POSTAL_CODE: z.string().max(16).optional().describe('Почтовый индекс'),
    REGION: z.string().max(128).optional().describe('Район'),
    PROVINCE: z.string().max(128).optional().describe('Область / регион'),
    COUNTRY: z.string().max(128).optional().describe('Страна'),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'укажите хотя бы одно поле адреса')
  .describe('Поля адреса crm.address.*; пустая строка "" очищает поле');

type AddressState = { exists: false } | { exists: true; text: Record<AddressTextField, string> };

async function readAddress(ctx: ToolContext, requisiteId: number, typeId: number): Promise<AddressState> {
  const rows = await requisiteAddresses(ctx, [requisiteId], typeId);
  const row = rows.find(
    (r) => idOf(r['TYPE_ID']) === typeId && asText(r['ENTITY_ID']) === String(requisiteId),
  );
  return row ? { exists: true, text: addressText(row) } : { exists: false };
}

const addressHash = (s: AddressState) => stateHash(s.exists ? s.text : { exists: false });

async function plannedModeOf(ctx: ToolContext, approvalId: string): Promise<'create' | 'update' | undefined> {
  const row = await ctx.operations.getOwn(approvalId, ctx.principal.id, ctx.bitrix.auth.portalKey);
  const m = /:(create|update)$/.exec(row?.target ?? '');
  return m?.[1] === 'create' || m?.[1] === 'update' ? m[1] : undefined;
}

export const crmRequisiteAddressSetTool = defineTool({
  name: 'crm_requisite_address_set',
  module: 'crm',
  title: 'Адрес реквизита',
  description:
    'Создать или изменить адрес реквизита CRM (юридический, фактический, почтовый…): crm.address.list определяет, есть ли уже ' +
    'адрес этого типа, затем crm.address.add либо crm.address.update — выбранный режим create/update показывается в плане. ' +
    'Использовать, когда пользователь просит указать адрес компании/контакта: адрес привязан к РЕКВИЗИТУ (requisiteId из crm_requisites_list), ' +
    'а не к компании. addressTypeId — из справочника crm.enum.addresstype (1 — фактический, 6 — юридический), иначе INVALID_ADDRESS_TYPE. ' +
    'При изменении не переданные поля сохраняются, "" очищает поле. Порядок: APPROVAL_REQUIRED → подтверждение → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      requisiteId: idSchema.describe('ID реквизита (не компании!)'),
      addressTypeId: idSchema.describe(
        'Тип адреса по crm.enum.addresstype: 1 — фактический, 6 — юридический…',
      ),
      addressFields: addressFieldsSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    requisiteId: z.number(),
    addressTypeId: z.number(),
    mode: z.enum(['create', 'update']).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const types = await addressTypes(ctx);
    const type = types.find((t) => t.id === args.addressTypeId);
    if (!type) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Тип адреса ${String(args.addressTypeId)} отсутствует в справочнике портала; допустимые: ${types
          .map((t) => `${String(t.id)} (${t.name})`)
          .join(', ')}`,
        { field: 'addressTypeId', reason: 'INVALID_ADDRESS_TYPE', nextAction: 'Выберите TYPE_ID из списка' },
      );
    }
    const requisite = await getRequisite(ctx, args.requisiteId);
    const current = await readAddress(ctx, args.requisiteId, args.addressTypeId);
    const currentHash = addressHash(current);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Адрес изменился после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Подготовьте план заново (dryRun=true)',
      });
    }
    const mode: 'create' | 'update' = current.exists ? 'update' : 'create';
    const given = args.addressFields as Partial<Record<AddressTextField, string>>;
    // crm.address.update очищает не переданные текстовые поля (документация): переносим текущие значения сами.
    const text: Partial<Record<AddressTextField, string>> = {};
    for (const f of ADDRESS_TEXT_FIELDS) {
      const v = given[f] ?? (current.exists ? current.text[f] : undefined);
      if (v !== undefined && (v !== '' || current.exists)) text[f] = v;
    }
    if (mode === 'create' && !Object.values(text).some((v) => v !== undefined && v.trim() !== '')) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Для нового адреса нужно хотя бы одно непустое поле: без них crm.address.add вернёт true, но адрес не создаст',
        { field: 'addressFields', reason: 'EMPTY_ADDRESS' },
      );
    }
    const payload: JsonObject = {
      TYPE_ID: args.addressTypeId,
      ENTITY_TYPE_ID: ADDRESS_OWNER_REQUISITE,
      ENTITY_ID: args.requisiteId,
      ...text,
    };
    const changes: Record<string, { from: string; to: string }> = {};
    for (const f of ADDRESS_TEXT_FIELDS) {
      const from = current.exists ? current.text[f] : '';
      const to = text[f] ?? '';
      if (from !== to) changes[f] = { from, to };
    }
    // С approvalId (выполнение/повтор) состояние закономерно уже другое — решает исполнитель и precheck.
    if (!args.approvalId && mode === 'update' && Object.keys(changes).length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Адрес уже совпадает с переданным: изменять нечего', {
        field: 'addressFields',
        reason: 'NO_CHANGES',
      });
    }
    const method = mode === 'create' ? 'crm.address.add' : 'crm.address.update';
    // Режим, показанный человеку в подтверждённом плане, хранится в target операции.
    const plannedMode = args.approvalId ? await plannedModeOf(ctx, args.approvalId) : mode;
    const risks = [REQUISITE_RISK];
    const cleared = Object.entries(changes).filter(([, c]) => c.to === '' && c.from !== '');
    if (cleared.length > 0) risks.push(`Будут очищены поля: ${cleared.map(([k]) => k).join(', ')}`);
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если адрес изменят до выполнения, запись всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_requisite_address_set',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `${mode === 'create' ? 'Добавить' : 'Изменить'} адрес «${type.name}» реквизита #${String(args.requisiteId)} «${asText(requisite['NAME'])}»`,
        target: `crm.requisite:${String(args.requisiteId)}:address:${String(args.addressTypeId)}:${mode}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          mode,
          method,
          addressType: { id: type.id, name: type.name },
          requisite: {
            id: args.requisiteId,
            ownerEntityTypeId: num(requisite['ENTITY_TYPE_ID']) ?? null,
            ownerId: num(requisite['ENTITY_ID']) ?? null,
          },
          stateHash: currentHash,
          fields: payload,
          changes,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      // Режим — часть плана: если адрес этого типа появился/исчез после подтверждения, запись не выполняется.
      precheck: async () => {
        const fresh = await readAddress(ctx, args.requisiteId, args.addressTypeId);
        const freshMode = fresh.exists ? 'update' : 'create';
        if (
          freshMode !== (plannedMode ?? mode) ||
          (args.expectedStateHash && addressHash(fresh) !== args.expectedStateHash)
        ) {
          throw new AppError('CONFLICT', 'Адрес изменился после подтверждения; запись отменена', {
            reason: 'STATE_CHANGED',
            nextAction: 'Подготовьте план заново: режим create/update мог измениться',
          });
        }
      },
      perform: async () => {
        await writeAddress(ctx, mode, payload);
        return {
          id: args.requisiteId,
          result: { requisiteId: args.requisiteId, addressTypeId: args.addressTypeId, mode },
        };
      },
      verify: async () => {
        const saved = await readAddress(ctx, args.requisiteId, args.addressTypeId);
        if (!saved.exists) return { verified: false, warnings: ['Адрес не найден после записи'] };
        const warnings: string[] = [];
        for (const f of ADDRESS_TEXT_FIELDS) {
          const want = text[f] ?? '';
          if (saved.text[f] !== want)
            warnings.push(`${f}: в портале «${saved.text[f]}», ожидалось «${want}»`);
        }
        return { verified: warnings.length === 0, warnings };
      },
    });
    const storedMode = outcome.kind === 'executed' ? outcome.result['mode'] : undefined;
    return mutationResponse(ctx, outcome, {
      base: {
        requisiteId: args.requisiteId,
        addressTypeId: args.addressTypeId,
        mode: storedMode === 'create' || storedMode === 'update' ? storedMode : mode,
      },
      method:
        storedMode === 'create' ? 'crm.address.add' : storedMode === 'update' ? 'crm.address.update' : method,
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

// ---------- crm_bank_account_add ----------

/** IBAN: 2 буквы страны, 2 контрольные цифры, до 30 символов; проверка контрольной суммы mod 97 (ISO 13616). */
function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** Базовая проверка форматов (INVALID_BANK_DETAILS); пустые поля не проверяются. */
function bankFormatErrors(fields: JsonObject, countryId: number | undefined): string[] {
  const errors: string[] = [];
  const v = (k: string) => asText(fields[k]).trim();
  if (countryId === COUNTRY_ID_RU) {
    const digits: [string, number, string][] = [
      ['RQ_BIK', 9, 'БИК'],
      ['RQ_ACC_NUM', 20, 'расчётный счёт'],
      ['RQ_COR_ACC_NUM', 20, 'корреспондентский счёт'],
    ];
    for (const [k, len, label] of digits) {
      if (v(k) !== '' && !new RegExp(`^\\d{${String(len)}}$`).test(v(k)))
        errors.push(`${k} (${label}): ожидается ровно ${String(len)} цифр`);
    }
  }
  if (v('RQ_IBAN') !== '' && !ibanValid(v('RQ_IBAN')))
    errors.push('RQ_IBAN: неверный формат или контрольная сумма');
  if (v('RQ_SWIFT') !== '' && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v('RQ_SWIFT')))
    errors.push('RQ_SWIFT: ожидается 8 или 11 символов (буквы/цифры, первые 6 — буквы)');
  return errors;
}

export const crmBankAccountAddTool = defineTool({
  name: 'crm_bank_account_add',
  module: 'crm',
  title: 'Добавить банковские реквизиты',
  description:
    'Добавить банковский счёт к реквизиту CRM (crm.requisite.bankdetail.add): банк, БИК, расчётный и корреспондентский счёт, IBAN/SWIFT. ' +
    'Использовать, когда пользователь явно просит добавить банковские реквизиты клиента; requisiteId — из crm_requisites_list. ' +
    'Поля проверяются по crm.requisite.bankdetail.fields и базовым форматам (для шаблона РФ: БИК 9 цифр, счета 20 цифр; IBAN, SWIFT) — ' +
    'иначе INVALID_BANK_DETAILS. Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      requisiteId: idSchema.describe('ID реквизита (crm_requisites_list)'),
      name: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe('Название счёта, например «Основной счёт в Сбербанке»'),
      bankFields: fieldsRecord(
        'Поля банковского реквизита по crm.requisite.bankdetail.fields: RQ_BANK_NAME, RQ_BIK, RQ_ACC_NUM, RQ_COR_ACC_NUM, RQ_IBAN, RQ_SWIFT, COMMENTS…',
      ),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    requisiteId: z.number(),
    bankDetailId: z.number().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    rejectKeys(
      args.bankFields,
      ['ID', 'ENTITY_ID', 'NAME', 'COUNTRY_ID'],
      'задаются сервером по requisiteId/name и шаблону реквизита',
    );
    const meta = await bankDetailFieldsMeta(ctx);
    const requisite = await getRequisite(ctx, args.requisiteId);
    const presetId = idOf(requisite['PRESET_ID']);
    const preset = presetId !== undefined ? await findPreset(ctx, presetId) : undefined;
    const countryId = preset?.countryId;
    const fields = validateWith(
      {
        ...args.bankFields,
        ENTITY_ID: args.requisiteId,
        NAME: args.name,
        ...(countryId !== undefined && meta['COUNTRY_ID'] ? { COUNTRY_ID: countryId } : {}),
      },
      meta,
      'create',
      'Допустимые поля — страница crm.requisite.bankdetail.add',
    );
    const errors = bankFormatErrors(fields, countryId);
    if (errors.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Банковские реквизиты не прошли проверку: ${errors.join('; ')}`,
        {
          field: 'bankFields',
          reason: 'INVALID_BANK_DETAILS',
          nextAction: 'Исправьте значения и повторите',
        },
      );
    }
    const risks = [REQUISITE_RISK, 'Счёт появится в печатных формах счетов и документов по этим реквизитам'];
    if (countryId === undefined)
      risks.push('Страна шаблона не определена: проверены только IBAN/SWIFT, национальные форматы — нет');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_bank_account_add',
      operationKind: 'create',
      args,
      summary: {
        action: `Добавить банковский счёт «${args.name}» к реквизиту #${String(args.requisiteId)} «${asText(requisite['NAME'])}»`,
        target: `crm.requisite:${String(args.requisiteId)}:bankdetail`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'crm.requisite.bankdetail.add',
          requisite: {
            id: args.requisiteId,
            ownerEntityTypeId: num(requisite['ENTITY_TYPE_ID']) ?? null,
            ownerId: num(requisite['ENTITY_ID']) ?? null,
            presetId: presetId ?? null,
            countryId: countryId ?? null,
          },
          fields,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const id = await addBankDetail(ctx, fields);
        return { id, result: { bankDetailId: id } };
      },
      verify: async (performed) => {
        const saved = await getBankDetail(ctx, Number(performed.id));
        const warnings = compareWritten(fields, saved);
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { requisiteId: args.requisiteId },
      method: 'crm.requisite.bankdetail.add',
      resultFields: ['bankDetailId'],
    });
  },
});

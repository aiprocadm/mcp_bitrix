/**
 * Запись карточек каталога (ТЗ §9.6, §8.2): catalog_product_create и catalog_product_update.
 * Метод выбирается по виду позиции (catalog.product.* / .service.* / .offer.*); вид сверяется с каталогом
 * и с фактическим типом позиции (INVALID_PRODUCT_TYPE). Поля — явный перечень карточки, дополнительно
 * проверяемый по getFieldsByFilter портала. Цены, закупочная цена и остатки этими инструментами
 * не меняются (отдельные сущности). Всё через MutationExecutor: план → подтверждение → одна запись → сверка.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import {
  asText,
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, UPDATE_ANNOTATIONS } from '../types.js';
import {
  assertKindFitsCatalog,
  assertRecordKind,
  compareProductFields,
  fieldValue,
  findCatalog,
  getFieldsMeta,
  getProduct,
  KINDS,
  productFieldsSchema,
  productKindSchema,
  productStateHash,
  validateProductFields,
  writtenProductId,
} from './catalog-service.js';

const NO_PRICE_RISK =
  'Цены, закупочная цена и складские остатки не меняются: для цены — catalog_price_set, остатки — складские документы';

// ---------- catalog_product_create ----------

export const catalogProductCreateTool = defineTool({
  name: 'catalog_product_create',
  module: 'catalog',
  title: 'Создать товар или услугу',
  description:
    'Создать позицию торгового каталога: простой товар (catalog.product.add), услугу (catalog.product.service.add) ' +
    'или вариацию (catalog.product.offer.add, только в каталоге вариаций). Использовать, когда пользователь явно просит ' +
    'завести новый товар/услугу; iblockId — из catalog_list. Поля проверяются по схеме каталога портала; цена и остатки ' +
    'не задаются (цена — отдельно через catalog_price_set). Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED ' +
    'с планом; человек подтверждает; повтор с теми же параметрами и approvalId создаёт позицию ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      iblockId: idSchema.describe('ID инфоблока торгового каталога (catalog_list)'),
      productKind: productKindSchema,
      fields: productFieldsSchema.describe('Поля карточки; name обязательно'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    iblockId: z.number(),
    productKind: productKindSchema,
    productId: z.number().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const kind = args.productKind;
    const spec = KINDS[kind];
    const fields: Record<string, unknown> = { ...args.fields };
    if (fields['name'] === undefined) {
      throw new AppError('VALIDATION_ERROR', 'Не заполнено название позиции', {
        field: 'fields.name',
        reason: 'REQUIRED_FIELD_MISSING',
      });
    }
    const catalog = await findCatalog(ctx, args.iblockId);
    assertKindFitsCatalog(kind, catalog);
    const meta = await getFieldsMeta(ctx, kind, args.iblockId);
    validateProductFields(kind, fields, meta, 'create');
    const method = `${spec.base}.add`;
    const risks = [NO_PRICE_RISK, 'Позиция сразу появится в каталоге и в подборе товаров CRM'];
    if (fields['active'] !== 'N') risks.push('Позиция будет активной (active≠N) и доступной к выбору');
    if (kind === 'offer' && fields['parentId'] === undefined)
      risks.push('parentId не указан: будет создана вариация без родительского товара');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'catalog_product_create',
      operationKind: 'create',
      args: { ...args, fields },
      summary: {
        action: `Создать ${spec.label} «${asText(fields['name'])}» в каталоге ${String(catalog.iblockId)} «${catalog.name}»`,
        target: `${spec.base}:new@iblock:${String(catalog.iblockId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method, iblockId: catalog.iblockId, productKind: kind, fields },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          method,
          { fields: { iblockId: args.iblockId, ...fields } as JsonObject },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const id = writtenProductId(kind, r.result);
        if (id === undefined)
          throw outcomeUnknown(
            method,
            'legacy',
            'Найдите позицию в каталоге (catalog_products_list) перед повтором',
          );
        return { id, result: { productId: id } };
      },
      verify: async (performed) => {
        const saved = await getProduct(ctx, kind, Number(performed.id));
        const warnings = compareProductFields(fields, saved);
        const t = saved['type'];
        if (t !== undefined && t !== null && !spec.types.includes(Number(t)))
          warnings.push(`Портал создал позицию типа ${asText(t)}, а не «${spec.label}»`);
        return { verified: warnings.length === 0, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { iblockId: args.iblockId, productKind: kind },
      method,
      resultFields: ['productId'],
    });
  },
});

// ---------- catalog_product_update ----------

export const catalogProductUpdateTool = defineTool({
  name: 'catalog_product_update',
  module: 'catalog',
  title: 'Изменить карточку товара',
  description:
    'Изменить поля карточки товара, услуги или вариации (catalog.product.update / .service.update / .offer.update). ' +
    'Использовать, когда пользователь явно просит поменять название, описание, активность, НДС, габариты и т. п.; ' +
    'передавайте только изменяемые поля. Цены и остатки этим инструментом не меняются. productKind должен совпадать ' +
    'с фактическим типом позиции (иначе INVALID_PRODUCT_TYPE). stateHash — из dryRun; с expectedStateHash изменение, ' +
    'сделанное кем-то ещё, даст CONFLICT. Порядок: APPROVAL_REQUIRED с diff «было → станет» → подтверждение → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      productId: idSchema.describe('ID товара/услуги/вариации'),
      productKind: productKindSchema,
      fields: productFieldsSchema.describe('Только изменяемые поля'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    productId: z.number(),
    productKind: productKindSchema,
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const kind = args.productKind;
    const spec = KINDS[kind];
    const fields: Record<string, unknown> = { ...args.fields };
    const current = await getProduct(ctx, kind, args.productId);
    assertRecordKind(kind, current, args.productId);
    const iblockId = Number(current['iblockId']);
    if (!Number.isSafeInteger(iblockId) || iblockId <= 0) {
      throw new AppError('BITRIX_UPSTREAM_ERROR', `${spec.base}.get не вернул iblockId позиции`, {
        method: `${spec.base}.get`,
        apiVersion: 'legacy',
      });
    }
    const meta = await getFieldsMeta(ctx, kind, iblockId);
    validateProductFields(kind, fields, meta, 'update');
    const currentHash = productStateHash(kind, current);
    // С approvalId сверку делает исполнитель и precheck (после записи хеш закономерно другой — не мешаем replay).
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Карточка изменилась после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Получите новый stateHash (dryRun) и подготовьте новый план',
      });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) changes[k] = { from: fieldValue(current, k), to: v };
    const method = `${spec.base}.update`;
    const title = asText(current['name']);
    const risks = [NO_PRICE_RISK];
    if (fields['active'] === 'N' && current['active'] !== 'N')
      risks.push('Деактивация: позиция пропадёт из подбора товаров в CRM и на витринах');
    if ('vatId' in fields || 'vatIncluded' in fields)
      risks.push(
        'Смена НДС влияет на новые документы и сделки; существующие товарные строки не пересчитываются',
      );
    if ('parentId' in fields) risks.push('Смена родителя переносит вариацию к другому товару');
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если карточку изменят до выполнения, изменение всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'catalog_product_update',
      operationKind: 'update',
      args: { ...args, fields },
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить ${spec.label} #${String(args.productId)} «${title}»: ${Object.keys(fields).join(', ')}`,
        target: `${spec.base}:${String(args.productId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method, productId: args.productId, iblockId, stateHash: currentHash, changes },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getProduct(ctx, kind, args.productId);
        if (productStateHash(kind, fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Карточка изменилась после подтверждения; изменение отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте позицию заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          method,
          { id: args.productId, fields: fields as JsonObject },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (writtenProductId(kind, r.result) === undefined)
          throw outcomeUnknown(method, 'legacy', 'Прочитайте карточку и сверьте поля перед повтором');
        return {
          id: args.productId,
          result: { productId: args.productId, changedFields: Object.keys(fields) },
        };
      },
      verify: async () => {
        const after = await getProduct(ctx, kind, args.productId);
        const warnings = compareProductFields(fields, after);
        return { verified: warnings.length === 0, warnings };
      },
    });

    let stateHashAfter: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed) {
      try {
        stateHashAfter = productStateHash(kind, await getProduct(ctx, kind, args.productId));
      } catch {
        stateHashAfter = undefined;
      }
    }
    return mutationResponse(ctx, outcome, {
      base: {
        productId: args.productId,
        productKind: kind,
        ...(stateHashAfter ? { stateHash: stateHashAfter } : {}),
      },
      method,
      resultFields: ['changedFields'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

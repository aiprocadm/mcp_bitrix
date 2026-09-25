/**
 * catalog_price_set (ТЗ §9.6, §8.2): создать или изменить одну цену товара заданного типа.
 * До плана: позиция существует и соответствует виду, тип цены — из catalog.priceType.list (INVALID_PRICE_TYPE),
 * валюта — из crm.currency.list (INVALID_CURRENCY), точность суммы — не больше знаков валюты (INVALID_PRECISION).
 * Режим выбирается по catalog.price.list: цены нет → catalog.price.add, одна есть → catalog.price.update;
 * несколько строк (диапазоны количества) → отказ, чтобы не изменить не ту. Сумма — десятичная строка без float-арифметики.
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { defineTool, UPDATE_ANNOTATIONS } from '../types.js';
import {
  assertRecordKind,
  findPrices,
  getProduct,
  KINDS,
  listCurrencies,
  listPriceTypes,
  priceStateHash,
  productKindSchema,
  type PriceRow,
} from './catalog-service.js';
import {
  canonicalDecimal,
  decimalAmountSchema,
  fractionDigits,
  sameDecimal,
  toUpstreamNumber,
} from './decimal.js';

function assertSingle(rows: PriceRow[]): PriceRow | undefined {
  if (rows.length > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      `У товара ${String(rows.length)} цены этого типа (диапазоны количества): какую менять — неоднозначно`,
      {
        field: 'priceTypeId',
        reason: 'PRICE_RANGES_UNSUPPORTED',
        nextAction: 'Измените цены с диапазонами в интерфейсе Bitrix24',
      },
    );
  }
  return rows[0];
}

export const catalogPriceSetTool = defineTool({
  name: 'catalog_price_set',
  module: 'catalog',
  title: 'Установить цену товара',
  description:
    'Создать или изменить одну цену товара/услуги/вариации заданного типа цены (catalog.price.add или catalog.price.update ' +
    'по результату catalog.price.list). Использовать, когда пользователь явно просит поставить цену. amount — строка ' +
    '"1234.10" (не число, без экспоненты и минуса, знаков после точки не больше, чем у валюты); currency — код валюты портала; ' +
    'priceTypeId — тип цены (например, базовая). План показывает режим (создание/изменение) и «было → станет»; ' +
    'stateHash из dryRun защищает от параллельного изменения (CONFLICT). Порядок: APPROVAL_REQUIRED → подтверждение → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      productId: idSchema.describe('ID товара/услуги/вариации'),
      productKind: productKindSchema.default('product'),
      priceTypeId: idSchema.describe('ID типа цены (catalog.priceType.list)'),
      amount: decimalAmountSchema,
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/, 'код валюты из трёх заглавных латинских букв, например RUB')
        .describe('Код валюты портала, например RUB'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    productId: z.number(),
    priceTypeId: z.number(),
    mode: z.enum(['create', 'update']).optional(),
    priceId: z.number().optional(),
    amount: z.string(),
    currency: z.string(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const spec = KINDS[args.productKind];
    const product = await getProduct(ctx, args.productKind, args.productId);
    assertRecordKind(args.productKind, product, args.productId);

    const priceTypes = await listPriceTypes(ctx);
    const priceType = priceTypes.find((p) => p.id === args.priceTypeId);
    if (!priceType) {
      throw new AppError('VALIDATION_ERROR', `Тип цены ${String(args.priceTypeId)} не найден на портале`, {
        field: 'priceTypeId',
        reason: 'INVALID_PRICE_TYPE',
        nextAction: `Доступные типы цен: ${priceTypes
          .slice(0, 20)
          .map((p) => `${String(p.id)} «${p.name}»${p.base ? ' (базовый)' : ''}`)
          .join(', ')}`,
      });
    }
    const currencies = await listCurrencies(ctx);
    const currency = currencies.get(args.currency);
    if (!currency) {
      throw new AppError('VALIDATION_ERROR', `Валюта ${args.currency} не настроена на портале`, {
        field: 'currency',
        reason: 'INVALID_CURRENCY',
        nextAction: `Валюты портала: ${[...currencies.keys()].slice(0, 30).join(', ')}`,
      });
    }
    if (fractionDigits(args.amount) > currency.decimals) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Для ${currency.code} допустимо не больше ${String(currency.decimals)} знаков после точки`,
        { field: 'amount', reason: 'INVALID_PRECISION' },
      );
    }
    const amountNumber = toUpstreamNumber(args.amount);

    const rows = await findPrices(ctx, args.productId, args.priceTypeId);
    const existing = assertSingle(rows);
    const currentHash = priceStateHash(rows);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Цена изменилась после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Получите новый stateHash (dryRun) и подготовьте новый план',
      });
    }
    const mode: 'create' | 'update' = existing ? 'update' : 'create';
    const method = mode === 'create' ? 'catalog.price.add' : 'catalog.price.update';
    const before = existing ? { amount: existing.amount, currency: existing.currency } : null;
    const after = { amount: canonicalDecimal(args.amount), currency: currency.code };
    const risks = [
      'Новая цена сразу используется при подборе товара в сделки, счета и заказы; существующие товарные строки не меняются',
    ];
    if (existing && existing.currency !== currency.code)
      risks.push(`Меняется валюта цены: ${existing.currency} → ${currency.code}`);
    if (existing && sameDecimal(existing.amount, args.amount) && existing.currency === currency.code)
      risks.push('Цена уже совпадает с запрошенной: запись ничего не изменит');
    if (priceType.base) risks.push('Это базовый тип цены: от него могут считаться другие цены и наценки');
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если цену изменят до выполнения, изменение всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'catalog_price_set',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action:
          mode === 'create'
            ? `Создать цену «${priceType.name}» для ${spec.label} #${String(args.productId)} «${asText(product['name'])}»: ${after.amount} ${after.currency}`
            : `Изменить цену «${priceType.name}» для ${spec.label} #${String(args.productId)} «${asText(product['name'])}»: ${before?.amount ?? ''} ${before?.currency ?? ''} → ${after.amount} ${after.currency}`,
        target: `catalog.price:${String(args.productId)}:${String(args.priceTypeId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method,
          mode,
          productId: args.productId,
          priceTypeId: args.priceTypeId,
          priceTypeName: priceType.name,
          ...(existing ? { priceId: existing.id } : {}),
          before,
          after,
          stateHash: currentHash,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await findPrices(ctx, args.productId, args.priceTypeId);
        const freshOne = assertSingle(fresh);
        // Режим плана должен остаться верным даже без expectedStateHash: цену могли создать/удалить параллельно.
        const modeChanged = (freshOne?.id ?? null) !== (existing?.id ?? null);
        if (modeChanged || (args.expectedStateHash && priceStateHash(fresh) !== args.expectedStateHash)) {
          throw new AppError('CONFLICT', 'Цена изменилась после подтверждения; запись отменена', {
            reason: 'STATE_CHANGED',
            nextAction: 'Подготовьте новый план (dryRun покажет актуальную цену)',
          });
        }
      },
      perform: async () => {
        const r =
          mode === 'create'
            ? await ctx.bitrix.call(
                'legacy',
                'catalog.price.add',
                {
                  fields: {
                    productId: args.productId,
                    catalogGroupId: args.priceTypeId,
                    price: amountNumber,
                    currency: currency.code,
                  },
                },
                { requestId: ctx.requestId, signal: ctx.signal },
              )
            : await ctx.bitrix.call(
                'legacy',
                'catalog.price.update',
                { id: existing?.id ?? 0, fields: { price: amountNumber, currency: currency.code } },
                { requestId: ctx.requestId, signal: ctx.signal },
              );
        const saved = isObj(r.result) ? r.result['price'] : undefined;
        const priceId = isObj(saved) ? idOf(saved['id']) : undefined;
        if (priceId === undefined)
          throw outcomeUnknown(
            method,
            'legacy',
            'Проверьте цену товара (dryRun покажет текущую) перед повтором',
          );
        return {
          id: priceId,
          result: { priceId, mode, amount: after.amount, currency: after.currency },
        };
      },
      verify: async (performed) => {
        const fresh = await findPrices(ctx, args.productId, args.priceTypeId);
        const warnings: string[] = [];
        const row = fresh.find((p) => p.id === Number(performed.id));
        if (!row) warnings.push('Цена не найдена после записи');
        else {
          if (!sameDecimal(row.amount, args.amount))
            warnings.push(
              `В портале цена ${row.amount} вместо ${after.amount} (возможны правила округления)`,
            );
          if (row.currency !== currency.code)
            warnings.push(`В портале валюта ${row.currency} вместо ${currency.code}`);
        }
        if (fresh.length > 1) warnings.push('У товара несколько цен этого типа после записи');
        return { verified: warnings.length === 0, warnings };
      },
    });

    let stateHashAfter: string | undefined;
    if (outcome.kind === 'executed' && !outcome.replayed) {
      try {
        stateHashAfter = priceStateHash(await findPrices(ctx, args.productId, args.priceTypeId));
      } catch {
        stateHashAfter = undefined;
      }
    }
    return mutationResponse(ctx, outcome, {
      base: {
        productId: args.productId,
        priceTypeId: args.priceTypeId,
        amount: after.amount,
        currency: after.currency,
        ...(stateHashAfter ? { stateHash: stateHashAfter } : {}),
      },
      method,
      resultFields: ['priceId', 'mode'],
      dryRunExtra: { mode, stateHash: currentHash, ...(existing ? { priceId: existing.id } : {}) },
    });
  },
});

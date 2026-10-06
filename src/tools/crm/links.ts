/**
 * Связи записей CRM: контакты сделки и компании контакта (чтение и привязка без удаления).
 * Методы crm.deal.contact.items.get / crm.deal.contact.add и crm.contact.company.items.get / crm.contact.company.add.
 * Привязка — через MutationExecutor: план → подтверждение человеком → одна запись → сверка по списку связей.
 * Отвязка (*.delete, *.items.delete) не реализуется: в реестре этих методов нет.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { mutationPrincipal, mutationResponse } from '../shared.js';
import { CREATE_ANNOTATIONS, defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { asText } from './deal-fields.js';
import { classicEntity, recordTitle, type ClassicEntity } from './entities.js';
import { getRecord, listOnce } from './crm-service.js';

const recordId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Описание пары «владелец → привязанные записи». */
interface LinkKind {
  readonly tool: string;
  readonly owner: ClassicEntity;
  readonly linked: ClassicEntity;
  readonly readMethod: string;
  readonly addMethod: string;
  /** Поле id привязанной записи в ответе и в fields: CONTACT_ID / COMPANY_ID. */
  readonly idField: 'CONTACT_ID' | 'COMPANY_ID';
}

const DEAL_CONTACTS: LinkKind = {
  tool: 'deal_contacts',
  owner: classicEntity('deal'),
  linked: classicEntity('contact'),
  readMethod: 'crm.deal.contact.items.get',
  addMethod: 'crm.deal.contact.add',
  idField: 'CONTACT_ID',
};

const CONTACT_COMPANIES: LinkKind = {
  tool: 'contact_companies',
  owner: classicEntity('contact'),
  linked: classicEntity('company'),
  readMethod: 'crm.contact.company.items.get',
  addMethod: 'crm.contact.company.add',
  idField: 'COMPANY_ID',
};

export interface LinkItem {
  id: number;
  isPrimary: boolean;
  sort: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Список связей: массив {CONTACT_ID|COMPANY_ID, SORT, ROLE_ID, IS_PRIMARY} (официальные страницы методов). */
export async function readLinks(ctx: ToolContext, kind: LinkKind, ownerId: number): Promise<LinkItem[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    kind.readMethod,
    { id: ownerId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', `${kind.readMethod} вернул не массив`, {
      method: kind.readMethod,
      apiVersion: 'legacy',
    });
  }
  return (r.result as unknown[])
    .filter(isObj)
    .map((x) => ({
      id: Number(asText(x[kind.idField])),
      isPrimary: asText(x['IS_PRIMARY']) === 'Y',
      sort: Number(asText(x['SORT'])) || 0,
    }))
    .filter((x) => Number.isSafeInteger(x.id) && x.id > 0);
}

/** Названия привязанных записей одним запросом (до 50; остальные — без названия). */
async function linkedTitles(
  ctx: ToolContext,
  entity: ClassicEntity,
  ids: number[],
): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  if (ids.length === 0) return titles;
  const select = entity.type === 'contact' ? ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'] : ['ID', 'TITLE'];
  const { items } = await listOnce(ctx, entity, { '@ID': ids.slice(0, 50) }, select, 50);
  for (const it of items) titles.set(Number(asText(it['ID'])), recordTitle(entity, it));
  return titles;
}

const linkOutput = z.object({
  id: z.number(),
  title: z.string().nullable(),
  isPrimary: z.boolean(),
  sort: z.number(),
});

function readTool(kind: LinkKind, name: string, title: string, description: string) {
  const ownerKey = kind.owner.type === 'deal' ? 'dealId' : 'contactId';
  return defineTool({
    name,
    module: 'crm',
    title,
    description,
    operation: 'read',
    annotations: READ_ANNOTATIONS,
    requiresBitrix: true,
    inputSchema: z.object({ [ownerKey]: recordId.describe(`ID: ${kind.owner.label}`) }).strict(),
    outputDataSchema: z.object({
      ownerId: z.number(),
      ownerTitle: z.string(),
      items: z.array(linkOutput),
      returnedCount: z.number(),
    }),
    handler: async (args, ctx) => {
      const ownerId = Number((args as Record<string, unknown>)[ownerKey]);
      // Владелец читается первым: crm.contact.company.items.get на несуществующий контакт отвечает пустым списком.
      const owner = await getRecord(ctx, kind.owner, ownerId);
      const links = await readLinks(ctx, kind, ownerId);
      const titles = await linkedTitles(
        ctx,
        kind.linked,
        links.map((l) => l.id),
      );
      const warnings: string[] = [];
      if (links.length > 50) warnings.push('Названия показаны для первых 50 связей');
      return ok(
        {
          ownerId,
          ownerTitle: recordTitle(kind.owner, owner),
          items: links.map((l) => ({ ...l, title: titles.get(l.id) ?? null })),
          returnedCount: links.length,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          method: kind.readMethod,
          apiVersion: 'legacy',
          completeness: 'complete',
          warnings,
        },
      );
    },
  });
}

export const crmDealContactsListTool = readTool(
  DEAL_CONTACTS,
  'crm_deal_contacts_list',
  'Контакты сделки',
  'Все контакты, привязанные к сделке (crm.deal.contact.items.get): ID, ФИО, основной ли контакт, порядок. ' +
    'Использовать, когда спрашивают «кто контакты по сделке», «кто основной контакт», перед привязкой нового контакта. ' +
    'Поле CONTACT_ID карточки сделки показывает только основной контакт — полный список здесь.',
);

export const crmContactCompaniesListTool = readTool(
  CONTACT_COMPANIES,
  'crm_contact_companies_list',
  'Компании контакта',
  'Все компании, привязанные к контакту (crm.contact.company.items.get): ID, название, основная ли компания, порядок. ' +
    'Использовать, когда спрашивают «в каких компаниях работает контакт», перед привязкой компании к контакту.',
);

function alreadyLinked(kind: LinkKind, linkedId: number): AppError {
  return new AppError(
    'CONFLICT',
    `${kind.linked.label} #${String(linkedId)} уже привязан(а) к записи (${kind.owner.label})`,
    {
      reason: 'ALREADY_LINKED',
      nextAction: 'Ничего делать не нужно; список связей — инструментом чтения связей',
    },
  );
}

function addTool(
  kind: LinkKind,
  name: string,
  title: string,
  description: string,
  ownerKey: 'dealId' | 'contactId',
  linkedKey: 'contactId' | 'companyId',
) {
  return defineTool({
    name,
    module: 'crm',
    title,
    description,
    operation: 'create',
    annotations: CREATE_ANNOTATIONS,
    requiresBitrix: true,
    inputSchema: z
      .object({
        [ownerKey]: recordId.describe(`ID: ${kind.owner.label}`),
        [linkedKey]: recordId.describe(`ID привязываемой записи: ${kind.linked.label}`),
        isPrimary: z
          .boolean()
          .optional()
          .describe(
            'true — сделать основной (прежняя основная перестанет ею быть); не указано — основной станет, только если основной ещё нет',
          ),
        ...writeArgsShape,
      })
      .strict()
      .superRefine((a, c) => requireIdempotencyUnlessDryRun(a as never, c)),
    outputDataSchema: z.object({
      ownerId: z.number(),
      linkedId: z.number(),
      dryRun: z.boolean().optional(),
      plan: z.record(z.string(), z.unknown()).optional(),
      validationLevel: z.string().optional(),
      linked: z.boolean().optional(),
      operationId: z.string().optional(),
      verified: z.boolean().optional(),
      replayed: z.boolean().optional(),
    }),
    handler: async (rawArgs, ctx) => {
      const args = rawArgs as Record<string, unknown> & { isPrimary?: boolean; approvalId?: string };
      const ownerId = Number(args[ownerKey]);
      const linkedId = Number(args[linkedKey]);
      // Обе записи должны существовать и читаться до плана.
      const owner = await getRecord(ctx, kind.owner, ownerId);
      const linkedRecord = await getRecord(ctx, kind.linked, linkedId);
      const links = await readLinks(ctx, kind, ownerId);
      // Повтор с approvalId после успешной привязки не должен падать: проверка «уже привязан» тогда — в precheck.
      if (!args.approvalId && links.some((l) => l.id === linkedId)) throw alreadyLinked(kind, linkedId);
      const currentPrimary = links.find((l) => l.isPrimary);
      const becomesPrimary = args.isPrimary === true || (args.isPrimary === undefined && !currentPrimary);
      const ownerTitle = recordTitle(kind.owner, owner);
      const linkedTitle = recordTitle(kind.linked, linkedRecord);
      const fields: JsonObject = { [kind.idField]: linkedId };
      if (args.isPrimary !== undefined) fields['IS_PRIMARY'] = args.isPrimary ? 'Y' : 'N';
      const risks = [
        'Связь увидят все, у кого есть доступ к записям; отвязать через MCP нельзя — только в портале',
      ];
      if (becomesPrimary && currentPrimary) {
        risks.push(
          `Основной сменится: #${String(currentPrimary.id)} перестанет быть основным(ой), основным(ой) станет #${String(linkedId)}`,
        );
      }

      const outcome = await ctx.mutations.execute({
        requestId: ctx.requestId,
        principal: mutationPrincipal(ctx),
        tool: name,
        operationKind: 'create',
        args,
        summary: {
          action: `Привязать ${kind.linked.labelAccusative} #${String(linkedId)} «${linkedTitle}» к записи (${kind.owner.label}) #${String(ownerId)} «${ownerTitle}»`,
          target: `${kind.owner.methodBase}:${String(ownerId)}`,
          portalOrigin: ctx.bitrix.auth.portalOrigin,
          details: {
            method: kind.addMethod,
            ownerId,
            linkedId,
            fields,
            becomesPrimary,
            currentPrimaryId: currentPrimary?.id ?? null,
            linkedBefore: links.length,
          },
          risks,
        },
        validationLevel: 'local+metadata',
        precheck: async () => {
          const fresh = await readLinks(ctx, kind, ownerId);
          if (fresh.some((l) => l.id === linkedId)) throw alreadyLinked(kind, linkedId);
        },
        perform: async () => {
          const r = await ctx.bitrix.call(
            'legacy',
            kind.addMethod,
            { id: ownerId, fields },
            { requestId: ctx.requestId, signal: ctx.signal },
          );
          // true — связь добавлена; false — уже была (официальные страницы); иное — исход неизвестен.
          if (r.result === false) throw alreadyLinked(kind, linkedId);
          if (r.result !== true) {
            throw new AppError('OPERATION_OUTCOME_UNKNOWN', `${kind.addMethod} не подтвердил привязку`, {
              method: kind.addMethod,
              apiVersion: 'legacy',
            });
          }
          return { id: linkedId, result: { linked: true } };
        },
        verify: async () => {
          const after = await readLinks(ctx, kind, ownerId);
          const link = after.find((l) => l.id === linkedId);
          const warnings: string[] = [];
          if (!link) warnings.push('После записи связь не найдена в списке');
          else if (becomesPrimary && !link.isPrimary)
            warnings.push('Связь добавлена, но основной её портал не сделал');
          return { verified: warnings.length === 0, warnings };
        },
      });
      return mutationResponse(ctx, outcome, {
        base: { ownerId, linkedId },
        method: kind.addMethod,
        resultFields: ['linked'],
      });
    },
  });
}

export const crmDealContactAddTool = addTool(
  DEAL_CONTACTS,
  'crm_deal_contact_add',
  'Привязать контакт к сделке',
  'Добавить контакт в список контактов сделки (crm.deal.contact.add); isPrimary=true делает его основным. ' +
    'Использовать, когда просят «добавь контакт в сделку», «сделай основным контактом». Отвязка не поддерживается. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом; человек подтверждает; ' +
    'повторный вызов с теми же параметрами и approvalId выполняет привязку ровно один раз. Уже привязанный — CONFLICT ALREADY_LINKED.',
  'dealId',
  'contactId',
);

export const crmContactCompanyAddTool = addTool(
  CONTACT_COMPANIES,
  'crm_contact_company_add',
  'Привязать компанию к контакту',
  'Добавить компанию в список компаний контакта (crm.contact.company.add); isPrimary=true делает её основной ' +
    '(записывается в поле COMPANY_ID контакта). Использовать, когда просят «привяжи контакт к компании». Отвязка не поддерживается. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом; человек подтверждает; ' +
    'повторный вызов с теми же параметрами и approvalId выполняет привязку ровно один раз. Уже привязанная — CONFLICT ALREADY_LINKED.',
  'contactId',
  'companyId',
);

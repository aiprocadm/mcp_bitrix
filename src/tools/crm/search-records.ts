/**
 * crm_search_records (ТЗ §9.4): найти записи по названию/имени, телефону или email.
 * Название — через `crm.<entity>.list` с фильтром `%ПОЛЕ`; телефон/email — через `crm.duplicate.findbycomm`
 * (только лиды, контакты, компании) и подгрузка карточек по `@ID`. Слишком широкий запрос отклоняется (QUERY_TOO_BROAD).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { asText } from './deal-fields.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  CLASSIC_ENTITY_TYPES,
  classicEntity,
  entityTypeSchema,
  recordTitle,
  type ClassicEntityType,
} from './entities.js';
import { findByComm, listOnce, type CrmRecord } from './crm-service.js';

const COMM_TYPES: Record<Exclude<ClassicEntityType, 'deal'>, 'LEAD' | 'CONTACT' | 'COMPANY'> = {
  lead: 'LEAD',
  contact: 'CONTACT',
  company: 'COMPANY',
};

interface Candidate {
  entityType: ClassicEntityType;
  id: number;
  title: string;
  matchedBy: 'title' | 'name' | 'phone' | 'email';
  record: Record<string, unknown>;
}

function candidate(
  type: ClassicEntityType,
  rec: CrmRecord,
  matchedBy: Candidate['matchedBy'],
): Candidate | undefined {
  const id = Number(asText(rec['ID']));
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return { entityType: type, id, title: recordTitle(classicEntity(type), rec), matchedBy, record: rec };
}

export const crmSearchRecordsTool = defineTool({
  name: 'crm_search_records',
  module: 'crm',
  title: 'Поиск записей CRM',
  description:
    'Найти записи CRM по части названия/имени (query), телефону (phone) или email. Использовать, когда пользователь называет ' +
    'клиента словами, а не ID: «найди компанию Ромашка», «есть ли контакт с телефоном…». Возвращает кандидатов с основанием ' +
    'совпадения — выбор среди них делает пользователь. Телефон/email ищутся среди лидов, контактов и компаний (сделки — только по названию). ' +
    'Запрос короче 3 символов отклоняется как слишком широкий.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityTypes: z
        .array(entityTypeSchema)
        .min(1)
        .max(4)
        .default([...CLASSIC_ENTITY_TYPES])
        .describe('Где искать; по умолчанию везде'),
      query: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe('Часть названия сделки/лида/компании или фамилии/имени контакта'),
      phone: z
        .string()
        .trim()
        .min(5)
        .max(30)
        .regex(/^[+\d][\d\s()-]*$/, 'только цифры, пробелы, скобки, дефис')
        .optional(),
      email: z.email().max(120).optional(),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Максимум кандидатов на тип сущности (по умолчанию 20)'),
    })
    .strict(),
  outputDataSchema: z.object({
    candidates: z.array(
      z.object({
        entityType: entityTypeSchema,
        id: z.number(),
        title: z.string(),
        matchedBy: z.enum(['title', 'name', 'phone', 'email']),
        record: z.record(z.string(), z.unknown()),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    if (!args.query && !args.phone && !args.email) {
      throw new AppError('VALIDATION_ERROR', 'Укажите query, phone или email: пустой поиск слишком широк', {
        field: 'query',
        reason: 'QUERY_TOO_BROAD',
      });
    }
    if (args.query !== undefined && args.query.length < 3) {
      throw new AppError('VALIDATION_ERROR', 'query короче 3 символов: слишком широкий поиск', {
        field: 'query',
        reason: 'QUERY_TOO_BROAD',
      });
    }
    const limit = Math.min(args.pageSize ?? ctx.config.limits.defaultPageSize, ctx.config.limits.maxPageSize);
    const types = [...new Set(args.entityTypes)];
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    let partial = false;
    const push = (c: Candidate | undefined): void => {
      if (!c) return;
      const key = `${c.entityType}:${String(c.id)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };

    if (args.query) {
      for (const type of types) {
        const entity = classicEntity(type);
        for (const field of entity.searchFields) {
          const filter: JsonObject = { [`%${field}`]: args.query };
          const page = await listOnce(ctx, entity, filter, entity.defaultSelect, limit);
          if (page.hasMore) partial = true;
          for (const rec of page.items) push(candidate(type, rec, field === 'TITLE' ? 'title' : 'name'));
        }
      }
    }

    const commTypes = types.filter((t): t is Exclude<ClassicEntityType, 'deal'> => t !== 'deal');
    if ((args.phone || args.email) && types.includes('deal')) {
      warnings.push(
        'Сделки по телефону/email не ищутся (crm.duplicate.findbycomm работает для лидов, контактов, компаний)',
      );
    }
    for (const [commType, value] of [
      ['PHONE', args.phone],
      ['EMAIL', args.email],
    ] as const) {
      if (!value || commTypes.length === 0) continue;
      const only = commTypes.length === 1 ? COMM_TYPES[commTypes[0] ?? 'contact'] : undefined;
      const found = await findByComm(ctx, commType, [value], only);
      for (const type of commTypes) {
        const ids = found[COMM_TYPES[type]].slice(0, limit);
        if (ids.length === 0) continue;
        if (found[COMM_TYPES[type]].length > limit) partial = true;
        const entity = classicEntity(type);
        const page = await listOnce(ctx, entity, { '@ID': ids }, entity.defaultSelect, limit);
        for (const rec of page.items) push(candidate(type, rec, commType === 'PHONE' ? 'phone' : 'email'));
      }
    }

    return ok(
      { candidates: out, returnedCount: out.length },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: args.phone || args.email ? 'crm.duplicate.findbycomm' : 'crm.*.list',
        apiVersion: 'legacy',
        completeness: partial ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

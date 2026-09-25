/**
 * Рабочие группы и проекты (ТЗ §9.11): workgroups_list (sonet_group.get) и workgroup_members_list (sonet_group.user.get).
 * Видимость — по правам владельца вебхука (IS_ADMIN не передаётся): отсутствие группы в списке не доказывает её удаление.
 * PROJECT не входит в документированные поля фильтра sonet_group.get, поэтому projectOnly проверяется локально.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  isObj,
  num,
  pageMeta,
  pageSizeOf,
  statefulPage,
  upstreamShapeError,
  yn,
} from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { employeeNames } from '../company/company-service.js';
import { offsetPage } from '../company/offset-page.js';

function normalizeGroup(raw: JsonValue) {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['ID']);
  if (id === undefined) return undefined;
  return {
    id,
    name: asText(raw['NAME']),
    isProject: yn(raw['PROJECT']),
    active: yn(raw['ACTIVE']),
    archived: yn(raw['CLOSED']),
    visible: yn(raw['VISIBLE']),
    opened: yn(raw['OPENED']),
    extranet: yn(raw['IS_EXTRANET']),
    ownerId: idOf(raw['OWNER_ID']) ?? null,
    membersCount: num(raw['NUMBER_OF_MEMBERS']) ?? null,
    subject: asText(raw['SUBJECT_NAME']) || null,
    dateActivity: asText(raw['DATE_ACTIVITY']) || null,
  };
}

const groupOut = z.object({
  id: z.number(),
  name: z.string(),
  isProject: z.boolean(),
  active: z.boolean(),
  archived: z.boolean(),
  visible: z.boolean(),
  opened: z.boolean(),
  extranet: z.boolean(),
  ownerId: z.number().nullable(),
  membersCount: z.number().nullable(),
  subject: z.string().nullable(),
  dateActivity: z.string().nullable(),
});

export const workgroupsListTool = defineTool({
  name: 'workgroups_list',
  module: 'groups',
  title: 'Рабочие группы и проекты',
  description:
    'Рабочие группы и проекты, видимые владельцу интеграции (sonet_group.get): ID, название, проект или группа, активность, ' +
    'архивность, владелец, число участников. Использовать, чтобы найти ID группы/проекта для задач или участников. ' +
    'Закрытые группы без доступа не показываются — их отсутствие не означает удаления. activeOnly=true по умолчанию.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      projectOnly: z.boolean().default(false).describe('Только проекты (не обычные группы)'),
      activeOnly: z.boolean().default(true).describe('Только активные (ACTIVE=Y) и не архивные'),
      nameContains: z.string().trim().min(1).max(100).optional().describe('Подстрока названия'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(groupOut),
    returnedCount: z.number(),
    total: z.number().nullable(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const filter: JsonObject = {};
    if (args.activeOnly) {
      filter['ACTIVE'] = 'Y';
      filter['CLOSED'] = 'N';
    }
    if (args.nameContains) filter['%NAME'] = args.nameContains;
    const page = await offsetPage(ctx, {
      tool: 'workgroups_list',
      method: 'sonet_group.get',
      params: { FILTER: filter, ORDER: { NAME: 'ASC' } },
      bindingParts: {
        projectOnly: args.projectOnly,
        activeOnly: args.activeOnly,
        nameContains: args.nameContains ?? null,
      },
      pageSize,
      cursor: args.cursor,
      ...(args.projectOnly ? { keep: (g: JsonValue) => isObj(g) && yn(g['PROJECT']) } : {}),
    });
    const items = page.items.map(normalizeGroup).filter((g): g is NonNullable<typeof g> => g !== undefined);
    const warnings = ['Список ограничен правами владельца интеграции; закрытые группы могут отсутствовать'];
    if (args.projectOnly)
      warnings.push('projectOnly применён локально: total относится ко всем группам фильтра');
    if (page.budgetExhausted)
      warnings.push('Страница заполнена не полностью: лимит запросов исчерпан, продолжение — по cursor');
    return ok(
      { items, returnedCount: items.length, total: args.projectOnly ? null : (page.total ?? null) },
      pageMeta(ctx, 'sonet_group.get', page, 'legacy', warnings),
    );
  },
});

// ---------- workgroup_members_list ----------

const ROLES: Record<string, string> = { A: 'owner', E: 'moderator', K: 'member' };

function groupAccessDenied(groupId: number, details: Record<string, unknown> = {}): AppError {
  return new AppError(
    'BITRIX_ACCESS_DENIED',
    `Группа #${String(groupId)} не найдена или закрыта для владельца интеграции`,
    {
      ...details,
      method: 'sonet_group.user.get',
      apiVersion: 'legacy',
      reason: 'GROUP_ACCESS_DENIED',
      nextAction:
        'Проверьте ID через workgroups_list; участники закрытых групп доступны только их участникам',
    },
  );
}

async function loadMembers(ctx: ToolContext, groupId: number) {
  let r;
  try {
    r = await ctx.bitrix.call(
      'legacy',
      'sonet_group.user.get',
      { ID: groupId },
      {
        requestId: ctx.requestId,
        signal: ctx.signal,
      },
    );
  } catch (e) {
    // По документации «группа не найдена/закрыта» приходит HTTP 400 без кода ошибки.
    if (
      AppError.is(e) &&
      (e.code === 'BITRIX_ACCESS_DENIED' ||
        e.code === 'NOT_FOUND' ||
        (e.code === 'BITRIX_UPSTREAM_ERROR' && e.details.httpStatus === 400 && !e.details.upstreamCode))
    )
      throw groupAccessDenied(groupId);
    throw e;
  }
  if (!Array.isArray(r.result)) throw upstreamShapeError('sonet_group.user.get', 'legacy');
  return r.result;
}

interface MembersState {
  offset: number;
}

export const workgroupMembersListTool = defineTool({
  name: 'workgroup_members_list',
  module: 'groups',
  title: 'Участники группы',
  description:
    'Активные участники рабочей группы или проекта с ролями owner/moderator/member (sonet_group.user.get) и именами. ' +
    'Использовать, чтобы узнать состав проекта или кто модератор группы. ID группы берите из workgroups_list. ' +
    'Если группа закрыта для владельца интеграции или не существует — GROUP_ACCESS_DENIED (различить нельзя).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      groupId: idSchema.describe('ID группы или проекта'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    groupId: z.number(),
    items: z.array(
      z.object({
        userId: z.number(),
        name: z.string().nullable(),
        role: z.string(),
        roleCode: z.string(),
      }),
    ),
    returnedCount: z.number(),
    totalMembers: z.number(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    let totalMembers = 0;
    // Метод отдаёт весь состав одним ответом; страницы режутся на сервере MCP (смещение в курсоре).
    const page = await statefulPage<MembersState>(ctx, {
      tool: 'workgroup_members_list',
      bindingParts: { groupId: args.groupId, pageSize },
      cursor: args.cursor,
      initial: { offset: 0 },
      fetch: async (state) => {
        const all = await loadMembers(ctx, args.groupId);
        totalMembers = all.length;
        const items = all.slice(state.offset, state.offset + pageSize);
        const nextOffset = state.offset + pageSize;
        return { items, next: nextOffset < all.length ? { offset: nextOffset } : undefined };
      },
    });
    const members = page.items
      .filter(isObj)
      .map((m) => {
        const code = asText(m['ROLE']);
        return { userId: idOf(m['USER_ID']), roleCode: code, role: ROLES[code] ?? 'unknown' };
      })
      .filter((m): m is { userId: number; roleCode: string; role: string } => m.userId !== undefined);
    const warnings: string[] = [];
    let names = new Map<number, string>();
    try {
      names = await employeeNames(
        ctx,
        members.map((m) => m.userId),
      );
    } catch {
      warnings.push('Имена участников недоступны (scope user/права); показаны ID');
    }
    return ok(
      {
        groupId: args.groupId,
        items: members.map((m) => ({ ...m, name: names.get(m.userId) ?? null })),
        returnedCount: members.length,
        totalMembers,
      },
      pageMeta(ctx, 'sonet_group.user.get', page, 'legacy', warnings),
    );
  },
});

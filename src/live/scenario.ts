/**
 * Живой smoke-сценарий (ТЗ §10.3, §17.5, §19.1 «Live»): только явно включённый, только в согласованных
 * тестовых объектах, без автоматической очистки портала. Три режима:
 *  - read-only: connection info, profile через raw, capabilities MVP, 3–5 сделок, одна сделка, список задач,
 *    затем по одному безопасному чтению на каждый включённый модуль полной версии (без ID объектов);
 *  - prepare:   планы пяти записей с префиксом LIVE_TEST_PREFIX → operationId для подтверждения человеком;
 *  - execute:   те же аргументы с approvalId → объекты создаются один раз; повтор ключа → дубля нет.
 * Всё идёт через обычный диспетчер инструментов — тот же путь, что у MCP-клиента.
 */
import { randomUUID } from 'node:crypto';
import type { AppContainer } from '../app/container.js';
import type { AppConfig } from '../config/env.js';
import type { ModuleName } from '../config/modules.js';
import { AppError } from '../errors/app-error.js';
import { dispatch } from '../mcp/register-tools.js';
import type { Envelope } from '../mcp/result.js';
import { asText } from '../tools/crm/deal-fields.js';
import { methodBelongsToModule } from '../tools/system/capabilities.js';
import type { ToolDefinition } from '../tools/types.js';

export type LiveMode = 'read-only' | 'prepare' | 'execute';
export type StepStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
  ids?: Record<string, unknown>;
}

export interface PlannedWrite {
  tool: string;
  label: string;
  idempotencyKey: string;
  args: Record<string, unknown>;
  operationId?: string;
}

export interface LiveReport {
  version: 1;
  mode: LiveMode;
  startedAt: string;
  finishedAt?: string;
  portalOrigin: string;
  prefix: string;
  steps: StepResult[];
  writes: PlannedWrite[];
  createdIds: Record<string, unknown>;
}

export function assertLiveAllowed(config: AppConfig, mode: LiveMode): void {
  if (!config.live.enabled) {
    throw new AppError('CONFIG_INVALID', 'Живые тесты выключены: LIVE_TESTS_ENABLED=false', {
      field: 'LIVE_TESTS_ENABLED',
      nextAction: 'Включите LIVE_TESTS_ENABLED=true только для согласованного тестового портала',
    });
  }
  if (mode === 'read-only') return;
  if (config.policy.readOnlyMode) {
    throw new AppError('CONFIG_INVALID', 'Для записи нужен READ_ONLY_MODE=false', {
      field: 'READ_ONLY_MODE',
    });
  }
  const missing: string[] = [];
  if (!config.live.responsibleUserId) missing.push('TEST_RESPONSIBLE_USER_ID');
  if (!config.live.chatDialogId) missing.push('TEST_CHAT_DIALOG_ID');
  if (!config.live.diskFolderId) missing.push('TEST_DISK_FOLDER_ID');
  if (!config.live.calendarOwnerId) missing.push('TEST_CALENDAR_OWNER_ID');
  if (!config.live.calendarSectionId) missing.push('TEST_CALENDAR_SECTION_ID');
  if (missing.length) {
    throw new AppError('CONFIG_INVALID', `Не заданы тестовые цели: ${missing.join(', ')}`, {
      field: missing[0] ?? 'TEST_*',
      nextAction: 'Согласуйте тестовые объекты с владельцем портала и заполните .env (ТЗ §3.3, §13)',
    });
  }
}

function tool(app: AppContainer, name: string): ToolDefinition {
  const def = app.tools.find((t) => t.name === name);
  if (!def)
    throw new AppError('FEATURE_UNAVAILABLE', `Инструмент ${name} не включён (модуль выключен?)`, {
      field: 'ENABLED_MODULES',
    });
  return def;
}

async function run(app: AppContainer, name: string, args: Record<string, unknown>): Promise<Envelope> {
  return dispatch(tool(app, name), args, app);
}

function err(env: Envelope): { code: string; message: string; details: Record<string, unknown> } | undefined {
  return env.success
    ? undefined
    : (env.error as { code: string; message: string; details: Record<string, unknown> });
}

const MVP_MODULES = ['system', 'crm', 'tasks', 'chat', 'disk', 'calendar'];

/** Методы 11 инструментов MVP (§10.1) и их обязательных чтений: только их проверяет шаг 3. */
const MVP_METHODS = [
  'profile',
  'crm.deal.list',
  'crm.deal.get',
  'crm.deal.fields',
  'crm.deal.add',
  'crm.category.list',
  'crm.status.list',
  'tasks.task.getfields',
  'tasks.task.add',
  'tasks.task.get',
  'tasks.task.list',
  'im.message.add',
  'im.dialog.get',
  'disk.folder.get',
  'disk.folder.uploadfile',
  'disk.file.get',
  'calendar.section.get',
  'calendar.event.add',
  'calendar.event.getbyid',
];

export async function runReadOnly(app: AppContainer): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const push = (
    step: string,
    env: Envelope,
    detail: (data: Record<string, unknown>) => string,
    ids?: Record<string, unknown>,
  ) => {
    if (!env.success) {
      steps.push({ step, status: 'failed', detail: `${env.error.code}: ${env.error.message}` });
    } else {
      steps.push({
        step,
        status: 'passed',
        detail: detail(env.data as Record<string, unknown>),
        ...(ids ? { ids } : {}),
      });
    }
    return env;
  };

  const me = push('1. bitrix_connection_info', await run(app, 'bitrix_connection_info', {}), (d) => {
    const u = d['bitrixUser'] as { id: number; name: string; lastName: string };
    return `портал ${String(d['portalOrigin'])}, пользователь #${u.id} ${u.name} ${u.lastName}, scope: ${(d['scopes'] as string[]).join(',') || '—'}`;
  });
  push(
    '2. bitrix_rest_call profile',
    await run(app, 'bitrix_rest_call', { method: 'profile' }),
    (d) => `ID=${String((d['result'] as Record<string, unknown>)['ID'])}`,
  );

  const caps = await run(app, 'bitrix_capabilities', { refresh: true, methods: MVP_METHODS });
  if (caps.success) {
    const items = (
      caps.data as { items: { method: string; status: string; reason?: string }[] }
    ).items.filter((i) => MVP_MODULES.some((m) => methodBelongsToModule({ method: i.method } as never, m)));
    const bad = items.filter((i) => i.status === 'unavailable' || i.status === 'error');
    steps.push({
      step: '3. bitrix_capabilities (методы MVP)',
      status: bad.length ? 'blocked' : 'passed',
      detail: bad.length
        ? `недоступны: ${bad.map((b) => `${b.method} (${b.reason ?? b.status})`).join('; ')}`
        : `${items.length} методов доступны`,
    });
  } else push('3. bitrix_capabilities', caps, () => '');

  const deals = push(
    '4. crm_list_records (5 сделок)',
    await run(app, 'crm_list_records', { entityType: 'deal', pageSize: 5 }),
    (d) => `получено ${String(d['returnedCount'])}, всего в портале ${asText(d['upstreamTotal']) || '?'}`,
  );
  const firstId = deals.success ? Number((deals.data as { items: { ID: string }[] }).items[0]?.ID ?? 0) : 0;
  if (firstId > 0) {
    push(
      '5. crm_get_record',
      await run(app, 'crm_get_record', { entityType: 'deal', id: firstId }),
      (d) => `сделка #${String(d['id'])} «${asText((d['record'] as Record<string, unknown>)['TITLE'])}»`,
      { dealId: firstId },
    );
  } else steps.push({ step: '5. crm_get_record', status: 'skipped', detail: 'в списке нет сделок' });

  push(
    '6. task_list (5 задач)',
    await run(app, 'task_list', { pageSize: 5 }),
    (d) => `получено ${String(d['returnedCount'])}, всего ${asText(d['upstreamTotal']) || '?'}`,
  );
  const userId = Number(me.success ? (me.data as { bitrixUser?: { id?: number } }).bitrixUser?.id : 0) || 0;
  steps.push(...(await runModuleReads(app, userId)));
  return steps;
}

/**
 * Одно безопасное чтение на модуль полной версии (ТЗ §11: «read-only smoke» каждого модуля).
 * Не требует ID объектов портала. Отсутствие scope/модуля/тарифа — `blocked` (среда), иное — `failed`.
 */
export function moduleReadChecks(
  userId: number,
  now = new Date(),
): { module: ModuleName; tool: string; args: Record<string, unknown> }[] {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const checks: { module: ModuleName; tool: string; args: Record<string, unknown> }[] = [
    { module: 'crm', tool: 'crm_stages_and_statuses', args: { entityType: 'deal' } },
    { module: 'crm', tool: 'crm_list_records', args: { entityType: 'lead', pageSize: 3 } },
    { module: 'smartProcesses', tool: 'smart_process_types_list', args: { pageSize: 5 } },
    { module: 'invoices', tool: 'invoice_stages_list', args: {} },
    { module: 'invoices', tool: 'invoice_list', args: { pageSize: 3 } },
    { module: 'company', tool: 'company_departments_list', args: { pageSize: 5 } },
    { module: 'chat', tool: 'chat_recent_list', args: { pageSize: 5 } },
    {
      module: 'telephony',
      tool: 'telephony_calls_list',
      args: { from: weekAgo, to: now.toISOString(), pageSize: 5 },
    },
    { module: 'disk', tool: 'disk_storages_list', args: { pageSize: 5 } },
    { module: 'groups', tool: 'workgroups_list', args: { pageSize: 5 } },
    { module: 'catalog', tool: 'catalog_list', args: { pageSize: 5 } },
    { module: 'catalog', tool: 'warehouse_list', args: { pageSize: 5 } },
    { module: 'orders', tool: 'store_orders_list', args: { pageSize: 3 } },
    { module: 'feed', tool: 'feed_posts_list', args: { pageSize: 3 } },
    { module: 'knowledgeBase', tool: 'kb_legacy_bases_list', args: { scope: 'KNOWLEDGE', pageSize: 5 } },
    { module: 'knowledgeBase', tool: 'kb2_bases_list', args: { pageSize: 5 } },
    { module: 'openlines', tool: 'openlines_list', args: {} },
    { module: 'lists', tool: 'lists_list', args: { pageSize: 5 } },
    { module: 'crm', tool: 'crm_document_templates_list', args: {} },
  ];
  if (userId > 0)
    checks.push({ module: 'calendar', tool: 'calendar_list', args: { type: 'user', ownerId: userId } });
  return checks;
}

/** Коды, означающие ограничение среды (права, scope, модуль, тариф), а не дефект сервера. */
const ENVIRONMENT_CODES = new Set([
  'BITRIX_SCOPE_MISSING',
  'BITRIX_ACCESS_DENIED',
  'FEATURE_UNAVAILABLE',
  'BITRIX_APP_CONTEXT_REQUIRED',
]);

async function runModuleReads(app: AppContainer, userId: number): Promise<StepResult[]> {
  const out: StepResult[] = [];
  let n = 0;
  for (const c of moduleReadChecks(userId)) {
    if (!app.config.policy.enabledModules.has(c.module)) continue;
    n += 1;
    const step = `7.${String(n)} ${c.tool} (модуль ${c.module})`;
    const env = await run(app, c.tool, c.args);
    if (env.success) {
      const d = env.data as Record<string, unknown>;
      const count = Array.isArray(d['items']) ? `${String(d['items'].length)} записей` : 'ответ получен';
      out.push({ step, status: 'passed', detail: `${count}; полнота: ${env.meta.completeness}` });
    } else {
      out.push({
        step,
        status: ENVIRONMENT_CODES.has(env.error.code) ? 'blocked' : 'failed',
        detail: `${env.error.code}: ${env.error.message}`,
      });
    }
  }
  return out;
}

/** Пять записей §10.3 п.5 в согласованных областях, все с префиксом. */
export function buildWritePlans(config: AppConfig, now = new Date()): PlannedWrite[] {
  const prefix = config.live.prefix;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const from = new Date(
    Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 7, 0, 0),
  );
  const to = new Date(from.getTime() + 3_600_000);
  const live = config.live;
  const dealFields: Record<string, unknown> = { TITLE: `${prefix} Сделка smoke ${stamp}` };
  if (live.crmCategoryId !== undefined) dealFields['CATEGORY_ID'] = live.crmCategoryId;
  if (live.crmStageId) dealFields['STAGE_ID'] = live.crmStageId;
  if (live.responsibleUserId) dealFields['ASSIGNED_BY_ID'] = live.responsibleUserId;
  return [
    {
      tool: 'crm_create_record',
      label: 'сделка',
      idempotencyKey: randomUUID(),
      args: { entityType: 'deal', fields: dealFields },
    },
    {
      tool: 'task_create',
      label: 'задача',
      idempotencyKey: randomUUID(),
      args: {
        title: `${prefix} Задача smoke ${stamp}`,
        responsibleId: live.responsibleUserId,
        deadline: to.toISOString(),
        description: `${prefix} создано live-smoke`,
      },
    },
    {
      tool: 'chat_send_message',
      label: 'сообщение',
      idempotencyKey: randomUUID(),
      args: { dialogId: live.chatDialogId, message: `${prefix} smoke ${stamp}` },
    },
    {
      tool: 'disk_upload_file',
      label: 'файл',
      idempotencyKey: randomUUID(),
      args: {
        folderId: live.diskFolderId,
        inline: {
          fileName: `${prefix} smoke ${stamp}.txt`,
          contentBase64: Buffer.from(`${prefix} smoke ${stamp}\n`).toString('base64'),
        },
      },
    },
    {
      tool: 'calendar_create_event',
      label: 'событие',
      idempotencyKey: randomUUID(),
      args: {
        type: live.calendarType,
        ownerId: live.calendarOwnerId,
        sectionId: live.calendarSectionId,
        name: `${prefix} Событие smoke ${stamp}`,
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: config.bitrix.timezone,
      },
    },
  ];
}

export async function prepareWrites(app: AppContainer, plans: PlannedWrite[]): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  for (const p of plans) {
    const env = await run(app, p.tool, { ...p.args, idempotencyKey: p.idempotencyKey });
    const e = err(env);
    if (e?.code === 'APPROVAL_REQUIRED' && typeof e.details['operationId'] === 'string') {
      p.operationId = e.details['operationId'];
      steps.push({
        step: `план: ${p.label} (${p.tool})`,
        status: 'passed',
        detail: `operationId ${p.operationId}; подтвердите: npm run approval:review -- --id ${p.operationId}`,
        ids: { operationId: p.operationId },
      });
    } else {
      steps.push({
        step: `план: ${p.label} (${p.tool})`,
        status: 'failed',
        detail: e ? `${e.code}: ${e.message}` : 'неожиданный успех без подтверждения — ДЕФЕКТ',
      });
    }
  }
  return steps;
}

export async function executeWrites(
  app: AppContainer,
  plans: PlannedWrite[],
): Promise<{ steps: StepResult[]; createdIds: Record<string, unknown> }> {
  const steps: StepResult[] = [];
  const createdIds: Record<string, unknown> = {};
  for (const p of plans) {
    if (!p.operationId) {
      steps.push({
        step: `запись: ${p.label}`,
        status: 'skipped',
        detail: 'нет operationId (фаза prepare не пройдена)',
      });
      continue;
    }
    const args = { ...p.args, idempotencyKey: p.idempotencyKey, approvalId: p.operationId };
    const env = await run(app, p.tool, args);
    if (!env.success) {
      const e = env.error;
      steps.push({
        step: `запись: ${p.label}`,
        status: e.code === 'APPROVAL_REQUIRED' ? 'blocked' : 'failed',
        detail: `${e.code}: ${e.message}`,
      });
      continue;
    }
    const data = env.data as Record<string, unknown>;
    const id = data['id'] ?? data['messageId'] ?? data['eventId'] ?? data['fileId'] ?? null;
    createdIds[p.label] = id;
    const warnings = env.meta.warnings.length ? '; ' + env.meta.warnings.join('; ') : '';
    steps.push({
      step: `запись: ${p.label}`,
      status: 'passed',
      detail: `id=${JSON.stringify(id)}, verified=${String(data['verified'])}${warnings}`,
      ids: { id, operationId: p.operationId },
    });
    // §10.3 п.7: тот же ключ — дубль не появляется
    const again = await run(app, p.tool, args);
    const replayed = again.success && (again.data as Record<string, unknown>)['replayed'] === true;
    steps.push({
      step: `повтор ключа: ${p.label}`,
      status: replayed ? 'passed' : 'failed',
      detail: replayed
        ? 'возвращён сохранённый результат, второй записи нет'
        : 'ДЕФЕКТ: повтор не распознан как replay',
    });
  }
  return { steps, createdIds };
}

export function newReport(config: AppConfig, mode: LiveMode, portalOrigin: string): LiveReport {
  return {
    version: 1,
    mode,
    startedAt: new Date().toISOString(),
    portalOrigin,
    prefix: config.live.prefix,
    steps: [],
    writes: [],
    createdIds: {},
  };
}

/**
 * Неизменяемый allowlist REST-методов (ТЗ §12, §14.1).
 * Инструмент или raw-вызов может обратиться только к методу из этого реестра.
 * Доступность метода на портале НЕ равна разрешению его вызвать — это решает политика.
 *
 * Каждая запись сверена с официальной страницей метода (Приложение A ТЗ); ссылка в `source`.
 */
import { D, DOCS, type ApiVersion, type MethodDescriptor } from './registry/descriptor.js';
import { REGISTRY_GROUPS } from './registry/index.js';

export type { ApiVersion, MethodDescriptor, OperationKind, PaginationKind } from './registry/descriptor.js';

/**
 * Пять классических методов сущности CRM: fields/list/get — чтение (raw разрешён), add/update — запись.
 * Страницы: {DOCS}/api-reference/crm/<folder>/<page>-<op>.html (каждая сверена при добавлении).
 */
function classicCrmEntity(
  base: string,
  folder: string,
  page: string,
): readonly (readonly [string, MethodDescriptor])[] {
  const src = (op: string) => `${DOCS}/api-reference/crm/${folder}/${page}-${op}.html`;
  const common = {
    apiVersion: 'legacy' as const,
    scope: 'crm',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
  };
  return [
    D({
      ...common,
      method: `${base}.fields`,
      operation: 'read',
      pagination: 'none',
      rawCallable: true,
      source: src('fields'),
    }),
    D({
      ...common,
      method: `${base}.list`,
      operation: 'read',
      pagination: 'offset',
      rawCallable: true,
      source: src('list'),
    }),
    D({
      ...common,
      method: `${base}.get`,
      operation: 'read',
      pagination: 'none',
      rawCallable: true,
      source: src('get'),
    }),
    D({
      ...common,
      method: `${base}.add`,
      operation: 'create',
      pagination: 'none',
      rawCallable: false,
      source: src('add'),
    }),
    D({
      ...common,
      method: `${base}.update`,
      operation: 'update',
      pagination: 'none',
      rawCallable: false,
      source: src('update'),
    }),
  ];
}

const ENTRIES: readonly (readonly [string, MethodDescriptor])[] = [
  // --- базовые / диагностика (S07) ---
  D({
    method: 'profile',
    apiVersion: 'legacy',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/common/users/profile.html`,
  }),
  D({
    method: 'user.current',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'user_brief',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/user/user-current.html`,
  }),
  D({
    method: 'method.get',
    apiVersion: 'legacy',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/common/system/method-get.html`,
  }),
  D({
    method: 'scope',
    apiVersion: 'legacy',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/common/system/scope.html`,
  }),
  D({
    method: 'app.info',
    apiVersion: 'legacy',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: true,
    rawCallable: false,
    source: `${DOCS}/api-reference/common/system/app-info.html`,
  }),

  // --- пользователи (S19) ---
  D({
    method: 'user.search',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'user_brief',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/user/user-search.html`,
  }),
  D({
    method: 'user.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'user_brief',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/user/user-get.html`,
  }),

  // --- задачи: схема полей (S15). В документации метод пишется tasks.task.getFields;
  //     REST Bitrix24 регистрирует имена в нижнем регистре, реестр хранит канонический lowercase.
  D({
    method: 'tasks.task.getfields',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/tasks/tasks-task-get-fields.html`,
  }),

  // --- CRM сделки (S09) ---
  D({
    method: 'crm.deal.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-list.html`,
  }),
  D({
    method: 'crm.deal.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-get.html`,
  }),
  D({
    method: 'crm.deal.fields',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-fields.html`,
  }),
  D({
    method: 'crm.deal.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-add.html`,
  }),
  D({
    method: 'crm.category.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/universal/category/crm-category-list.html`,
  }),
  D({
    method: 'crm.status.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/status/crm-status-list.html`,
  }),
  D({
    method: 'crm.status.entity.types',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/status/crm-status-entity-types.html`,
  }),
  D({
    method: 'crm.deal.update',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/deals/crm-deal-update.html`,
  }),
  // --- CRM лиды/контакты/компании (S09; классические методы: страницы помечены «развитие остановлено,
  //     используйте crm.item.*» — работают и документированы; универсальный адаптер — отдельным срезом) ---
  ...classicCrmEntity('crm.lead', 'leads', 'crm-lead'),
  ...classicCrmEntity('crm.contact', 'contacts', 'crm-contact'),
  ...classicCrmEntity('crm.company', 'companies', 'crm-company'),
  D({
    method: 'crm.duplicate.findbycomm',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/duplicates/crm-duplicate-find-by-comm.html`,
  }),
  // --- CRM связанные данные (S09, S11; срез 11) ---
  D({
    method: 'crm.stagehistory.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/crm-stage-history-list.html`,
  }),
  D({
    method: 'crm.activity.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/timeline/activities/activity-base/crm-activity-list.html`,
  }),
  D({
    method: 'crm.timeline.comment.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/timeline/comments/crm-timeline-comment-list.html`,
  }),
  D({
    method: 'crm.timeline.comment.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/timeline/comments/crm-timeline-comment-get.html`,
  }),
  D({
    method: 'crm.timeline.comment.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/timeline/comments/crm-timeline-comment-add.html`,
  }),
  D({
    method: 'crm.item.productrow.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/universal/product-rows/crm-item-productrow-list.html`,
  }),
  D({
    method: 'crm.item.productrow.set',
    apiVersion: 'legacy',
    operation: 'update',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/crm/universal/product-rows/crm-item-productrow-set.html`,
  }),
  // Пользовательские поля: у разделов разные пути страниц — каждый сверен отдельно.
  D({
    method: 'crm.deal.userfield.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/deals/user-defined-fields/crm-deal-userfield-list.html`,
  }),
  D({
    method: 'crm.lead.userfield.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/leads/userfield/crm-lead-userfield-list.html`,
  }),
  D({
    method: 'crm.contact.userfield.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/contacts/userfield/crm-contact-userfield-list.html`,
  }),
  D({
    method: 'crm.company.userfield.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'crm',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/crm/companies/userfields/crm-company-userfield-list.html`,
  }),

  // --- задачи (S15): scope `task`, методы tasks.task.* ---
  D({
    method: 'tasks.task.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/tasks/tasks-task-add.html`,
  }),
  D({
    method: 'tasks.task.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'task',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/tasks/tasks-task-get.html`,
  }),
  D({
    method: 'tasks.task.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'task',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/tasks/tasks-task-list.html`,
  }),

  // --- чаты (S16) ---
  D({
    method: 'im.message.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'im',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/chats/messages/im-message-add.html`,
  }),
  D({
    method: 'im.dialog.messages.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'im',
    pagination: 'message-id',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/chats/messages/im-dialog-messages-get.html`,
  }),
  D({
    method: 'im.recent.list',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'im',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/chats/im-recent-list.html`,
  }),
  D({
    method: 'im.dialog.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'im',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/chats/im-dialog-get.html`,
  }),

  // --- Диск (S20) ---
  D({
    method: 'disk.storage.getlist',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'disk',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/disk/storage/disk-storage-get-list.html`,
  }),
  D({
    method: 'disk.folder.getchildren',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'disk',
    pagination: 'offset',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/disk/folder/disk-folder-get-children.html`,
  }),
  D({
    method: 'disk.folder.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'disk',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/disk/folder/disk-folder-get.html`,
  }),
  D({
    method: 'disk.folder.uploadfile',
    apiVersion: 'legacy',
    operation: 'upload',
    scope: 'disk',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/disk/folder/disk-folder-upload-file.html`,
  }),
  D({
    method: 'disk.file.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'disk',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/disk/file/disk-file-get.html`,
  }),

  // --- календарь (S08) ---
  D({
    method: 'calendar.section.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: true,
    source: `${DOCS}/api-reference/calendar/calendar-section-get.html`,
  }),
  D({
    method: 'calendar.event.get',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-event-get.html`,
  }),
  D({
    method: 'calendar.event.getbyid',
    apiVersion: 'legacy',
    operation: 'read',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-event-get-by-id.html`,
  }),
  D({
    method: 'calendar.event.add',
    apiVersion: 'legacy',
    operation: 'create',
    scope: 'calendar',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/calendar/calendar-event/calendar-event-add.html`,
  }),

  // --- REST 3.0 (S23): диагностика возможностей портала ---
  D({
    method: 'rest.scope.list',
    apiVersion: 'v3',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/rest-v3.html`,
  }),
  D({
    method: 'rest.documentation.openapi',
    apiVersion: 'v3',
    operation: 'admin/diagnostic',
    pagination: 'none',
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable: false,
    source: `${DOCS}/api-reference/rest-v3.html`,
  }),
];

/** Реестр: базовые записи + группы модулей (src/bitrix/registry/*). Дубль ключа — ошибка загрузки. */
function buildRegistry(): ReadonlyMap<string, MethodDescriptor> {
  const map = new Map<string, MethodDescriptor>();
  for (const [key, d] of [...ENTRIES, ...REGISTRY_GROUPS.flat()]) {
    if (map.has(key)) throw new Error(`Метод зарегистрирован дважды: ${key}`);
    map.set(key, d);
  }
  return map;
}

const REGISTRY: ReadonlyMap<string, MethodDescriptor> = buildRegistry();

/** Разрешённые символы имени метода; `/`, `?`, `#`, `%`, `..` исключены (ТЗ §14.1). */
const METHOD_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function isValidMethodName(name: string): boolean {
  return name.length <= 100 && METHOD_NAME_RE.test(name);
}

/** Точный поиск. Регистр не нормализуется: обход через casing запрещён. */
export function findMethod(apiVersion: ApiVersion, method: string): MethodDescriptor | undefined {
  if (!isValidMethodName(method)) return undefined;
  return REGISTRY.get(`${apiVersion}:${method}`);
}

export function requireMethod(apiVersion: ApiVersion, method: string): MethodDescriptor {
  const d = findMethod(apiVersion, method);
  if (!d) throw new Error(`Метод не зарегистрирован в реестре: ${apiVersion}:${method}`);
  return d;
}

export function listMethods(): readonly MethodDescriptor[] {
  return [...REGISTRY.values()];
}

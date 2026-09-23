/**
 * Неизменяемый allowlist REST-методов (ТЗ §12, §14.1).
 * Инструмент или raw-вызов может обратиться только к методу из этого реестра.
 * Доступность метода на портале НЕ равна разрешению его вызвать — это решает политика.
 *
 * Каждая запись сверена с официальной страницей метода (Приложение A ТЗ); ссылка в `source`.
 */
export type ApiVersion = 'legacy' | 'v3';
export type OperationKind = 'read' | 'create' | 'update' | 'delete' | 'upload' | 'admin/diagnostic';
export type PaginationKind = 'none' | 'offset' | 'cursor' | 'message-id' | 'first-page-only';

export interface MethodDescriptor {
  readonly method: string;
  readonly apiVersion: ApiVersion;
  readonly operation: OperationKind;
  /** Scope Bitrix24; undefined для базовых методов без отдельного scope (profile, method.get). */
  readonly scope?: string;
  readonly pagination: PaginationKind;
  readonly supportsNativeIdempotency: boolean;
  readonly applicationContextRequired: boolean;
  /** Разрешён ли метод для `bitrix_rest_call` в принципе (при наличии в policy allowlist). */
  readonly rawCallable: boolean;
  readonly source: string;
}

const D = (d: MethodDescriptor): readonly [string, MethodDescriptor] => [`${d.apiVersion}:${d.method}`, d];

const DOCS = 'https://apidocs.bitrix24.ru';

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
    pagination: 'first-page-only',
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

const REGISTRY: ReadonlyMap<string, MethodDescriptor> = new Map(ENTRIES);

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

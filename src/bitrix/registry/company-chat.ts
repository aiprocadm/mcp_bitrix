/**
 * Группа реестра REST-методов: Сотрудники и оргструктура, чаты, телефония, рабочие группы.
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Уже зарегистрированы в method-registry.ts и переиспользуются: user.search, user.get,
 * im.dialog.messages.get, im.recent.list, im.dialog.get, method.get.
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const common = {
  apiVersion: 'legacy' as const,
  supportsNativeIdempotency: false,
  applicationContextRequired: false,
};

export const companyChatMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // --- оргструктура (department.*, REST v2; S06/S07) ---
  D({
    ...common,
    method: 'department.get',
    operation: 'read',
    scope: 'department',
    pagination: 'offset',
    rawCallable: true,
    source: `${DOCS}/api-reference/departments/department-get.html`,
  }),
  D({
    ...common,
    method: 'department.add',
    operation: 'create',
    scope: 'department',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/departments/department-add.html`,
  }),
  D({
    ...common,
    method: 'department.update',
    operation: 'update',
    scope: 'department',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/departments/department-update.html`,
  }),
  D({
    ...common,
    method: 'department.delete',
    operation: 'delete',
    scope: 'department',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/departments/department-delete.html`,
  }),
  // --- пользователи: только UF_DEPARTMENT через инструмент (S19) ---
  D({
    ...common,
    method: 'user.update',
    operation: 'update',
    scope: 'user',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/user/user-update.html`,
  }),
  // --- чаты (S16) ---
  D({
    ...common,
    method: 'im.counters.get',
    operation: 'read',
    scope: 'im',
    pagination: 'none',
    rawCallable: true,
    source: `${DOCS}/api-reference/chats/im-counters-get.html`,
  }),
  // --- телефония (S16): ответ содержит ссылки на записи/логи, поэтому raw не разрешён ---
  D({
    ...common,
    method: 'voximplant.statistic.get',
    operation: 'read',
    scope: 'telephony',
    pagination: 'offset',
    rawCallable: false,
    source: `${DOCS}/api-reference/telephony/voximplant/voximplant-statistic-get.html`,
  }),
  // --- рабочие группы и проекты (S18). Страница метода ссылается на scope «sonet», но справочник scope
  //     (api-reference/scopes/permissions) уточняет: для рабочих групп выдаётся sonet_group ---
  D({
    ...common,
    method: 'sonet_group.get',
    operation: 'read',
    scope: 'sonet_group',
    pagination: 'offset',
    rawCallable: true,
    source: `${DOCS}/api-reference/sonet-group/sonet-group-get.html`,
  }),
  D({
    ...common,
    method: 'sonet_group.user.get',
    operation: 'read',
    scope: 'sonet_group',
    pagination: 'none',
    rawCallable: true,
    source: `${DOCS}/api-reference/sonet-group/members/sonet-group-user-get.html`,
  }),
];

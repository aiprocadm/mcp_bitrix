/**
 * Группа реестра REST-методов: дела CRM по всему порталу (привязки, расшифровка звонка) и бизнес-процессы (чтение).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 * Роботы стадий и триггеры (bizproc.robot.list, crm.automation.trigger.list) не регистрируются: живой портал
 * (2026-10-07) отвечает на них вебхуку «Application context required».
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

function read(
  method: string,
  scope: string,
  pagination: 'none' | 'offset',
  rawCallable: boolean,
  source: string,
): readonly [string, MethodDescriptor] {
  return D({
    method,
    apiVersion: 'legacy',
    operation: 'read',
    scope,
    pagination,
    supportsNativeIdempotency: false,
    applicationContextRequired: false,
    rawCallable,
    source,
  });
}

const ACT = `${DOCS}/api-reference/crm/timeline/activities`;
const BP = `${DOCS}/api-reference/bizproc`;

export const activitiesBizprocMethods: readonly (readonly [string, MethodDescriptor])[] = [
  read('crm.activity.binding.list', 'crm', 'none', true, `${ACT}/binding/crm-activity-binding-list.html`),
  // Текст расшифровки — содержимое разговора: только именованным инструментом с ограничением длины.
  // Документированное имя crm.activity.call.getTranscript; реестр хранит имена строчными (защита от обхода регистром),
  // живой портал (2026-10-07) принимает строчное имя.
  read(
    'crm.activity.call.gettranscript',
    'crm',
    'none',
    false,
    `${ACT}/activity-base/crm-activity-call-get-transcript.html`,
  ),
  // TEMPLATE содержит константы и параметры шаблона — raw закрыт, инструмент отдаёт только названия действий.
  read(
    'bizproc.workflow.template.list',
    'bizproc',
    'offset',
    false,
    `${BP}/template/bizproc-workflow-template-list.html`,
  ),
  read('bizproc.workflow.instances', 'bizproc', 'offset', true, `${BP}/bizproc-workflow-instances.html`),
];

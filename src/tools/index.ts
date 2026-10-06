/**
 * Полный список инструментов сервера. Модули включаются конфигурацией (ENABLED_MODULES),
 * а не форком; порядок — как в реестре ТЗ §9.
 */
import { crmCreateRecordTool } from './crm/create-record.js';
import { crmFieldsGetTool } from './crm/fields-get.js';
import { crmGetRecordTool } from './crm/get-record.js';
import { crmListRecordsTool } from './crm/list-records.js';
import {
  crmContactCompaniesListTool,
  crmContactCompanyAddTool,
  crmDealContactAddTool,
  crmDealContactsListTool,
} from './crm/links.js';
import { crmPipelineSummaryTool } from './crm/pipeline-summary.js';
import { crmPipelinesOverviewTool } from './crm/pipelines-overview.js';
import {
  crmDocumentCreateTool,
  crmDocumentGetTool,
  crmDocumentsListTool,
  crmDocumentTemplatesListTool,
} from './crm/documents.js';
import { listsTools } from './lists/lists.js';
import { openlinesTools } from './openlines/openlines.js';
import {
  crmActivitiesListTool,
  crmDealProductsGetTool,
  crmStageHistoryTool,
  crmTimelineCommentsListTool,
  crmUserfieldsListTool,
} from './crm/related-read.js';
import { crmDealProductsReplaceTool, crmTimelineCommentAddTool } from './crm/related-write.js';
import { crmSearchRecordsTool } from './crm/search-records.js';
import { crmStagesAndStatusesTool } from './crm/stages.js';
import { crmStatusCreateTool, crmStatusUpdateTool } from './crm/status-write.js';
import { crmUpdateRecordTool } from './crm/update-record.js';
import { capabilitiesTool } from './system/capabilities.js';
import { connectionInfoTool } from './system/connection-info.js';
import { operationStatusTool } from './system/operation-status.js';
import { restCallTool } from './system/rest-call.js';
import { serverVersionTool } from './system/server-version.js';
import { taskCreateTool } from './tasks/task-create.js';
import { taskGetTool } from './tasks/task-get.js';
import { taskListTool } from './tasks/task-list.js';
import { calendarCreateEventTool } from './calendar/create-event.js';
import { chatSendMessageTool } from './chat/send-message.js';
import { diskUploadFileTool } from './disk/upload-file.js';
import { calendarDiskTools } from './registry/calendar-disk.js';
import { catalogSaleTools } from './registry/catalog-sale.js';
import { companyChatTools } from './registry/company-chat.js';
import { crmItemsTools } from './registry/crm-items.js';
import { crmRequisitesTools } from './registry/crm-requisites.js';
import { feedLandingTools } from './registry/feed-landing.js';
import { noteTools } from './registry/note.js';
import { tasksTools } from './registry/tasks.js';
import type { ToolDefinition } from './types.js';

export function allTools(): readonly ToolDefinition[] {
  return [
    // §9.2 система
    connectionInfoTool,
    serverVersionTool,
    capabilitiesTool,
    restCallTool,
    operationStatusTool,
    // §9.4 CRM: классические сущности deal|lead|contact|company
    crmListRecordsTool,
    crmGetRecordTool,
    crmSearchRecordsTool,
    crmCreateRecordTool,
    crmUpdateRecordTool,
    crmFieldsGetTool,
    crmUserfieldsListTool,
    crmActivitiesListTool,
    crmPipelineSummaryTool,
    crmStageHistoryTool,
    crmStagesAndStatusesTool,
    crmTimelineCommentAddTool,
    crmTimelineCommentsListTool,
    crmDealProductsGetTool,
    crmDealProductsReplaceTool,
    // связи записей, справочники, сводка по всем воронкам (живой портал, 2026-10-06)
    crmDealContactsListTool,
    crmDealContactAddTool,
    crmContactCompaniesListTool,
    crmContactCompanyAddTool,
    crmStatusCreateTool,
    crmStatusUpdateTool,
    crmPipelinesOverviewTool,
    // генератор документов CRM (2026-10-06)
    crmDocumentTemplatesListTool,
    crmDocumentsListTool,
    crmDocumentGetTool,
    crmDocumentCreateTool,
    // §9.4 реквизиты и дела; §9.5/§9.7 универсальный crm.item.* (смарт-процессы, счета)
    ...crmRequisitesTools,
    ...crmItemsTools,
    // §9.8 задачи
    taskCreateTool,
    taskGetTool,
    taskListTool,
    ...tasksTools,
    // §9.3 календарь, §9.9 чаты, §9.12 диск
    calendarCreateEventTool,
    chatSendMessageTool,
    diskUploadFileTool,
    ...calendarDiskTools,
    // §9.2 сотрудники и оргструктура, §9.9 чаты и звонки, §9.11 группы
    ...companyChatTools,
    // §9.6 каталог, склады, заказы
    ...catalogSaleTools,
    // §9.10 лента, §9.13 классическая база знаний
    ...feedLandingTools,
    // §9.14 база знаний 2.0
    ...noteTools,
    // открытые линии и универсальные списки (2026-10-06)
    ...openlinesTools,
    ...listsTools,
  ];
}

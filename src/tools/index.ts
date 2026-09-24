/**
 * Полный список инструментов сервера. Модули включаются конфигурацией (ENABLED_MODULES),
 * а не форком; порядок — как в реестре ТЗ §9.
 */
import { crmCreateRecordTool } from './crm/create-record.js';
import { crmFieldsGetTool } from './crm/fields-get.js';
import { crmGetRecordTool } from './crm/get-record.js';
import { crmListRecordsTool } from './crm/list-records.js';
import { crmPipelineSummaryTool } from './crm/pipeline-summary.js';
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
    // §9.8 задачи (MVP)
    taskCreateTool,
    taskGetTool,
    taskListTool,
    // §9.3 / §9.9 / §9.12 (MVP)
    calendarCreateEventTool,
    chatSendMessageTool,
    diskUploadFileTool,
  ];
}

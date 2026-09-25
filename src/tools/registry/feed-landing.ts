/**
 * Инструменты группы: Лента новостей и классическая база знаний (landing).
 */
import type { ToolDefinition } from '../types.js';
import {
  feedCommentAddTool,
  feedCommentsListTool,
  feedPostCreateTool,
  feedPostsListTool,
  feedPostUpdateTool,
} from '../feed/feed-tools.js';
import {
  kbLegacyArticleGetTool,
  kbLegacyArticlesListTool,
  kbLegacyBasesListTool,
} from '../kb-legacy/kb-read.js';
import {
  kbLegacyArticleCreateTool,
  kbLegacyArticlePublishTool,
  kbLegacyArticleUpdateTool,
  kbLegacyBaseCreateTool,
  kbLegacySectionCreateTool,
} from '../kb-legacy/kb-write.js';

export const feedLandingTools: readonly ToolDefinition[] = [
  feedPostCreateTool,
  feedPostUpdateTool,
  feedPostsListTool,
  feedCommentAddTool,
  feedCommentsListTool,
  kbLegacyBasesListTool,
  kbLegacyBaseCreateTool,
  kbLegacySectionCreateTool,
  kbLegacyArticlesListTool,
  kbLegacyArticleGetTool,
  kbLegacyArticleCreateTool,
  kbLegacyArticleUpdateTool,
  kbLegacyArticlePublishTool,
];

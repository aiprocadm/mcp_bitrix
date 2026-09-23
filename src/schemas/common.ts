/**
 * Общие фрагменты схем инструментов (ТЗ §9.1, §15.2).
 * W — параметры записи: idempotencyKey обязателен при реальном изменении (не при dryRun),
 * approvalId — подтверждение человека, expectedStateHash — для update/delete.
 */
import { z } from 'zod';

export const writeArgsShape = {
  dryRun: z
    .boolean()
    .default(false)
    .describe('Только рассчитать план и проверки; ничего не записывать и не создавать подтверждение'),
  idempotencyKey: z
    .uuid()
    .optional()
    .describe('UUID, одинаковый при повторе того же намерения; обязателен, если dryRun=false'),
  approvalId: z
    .uuid()
    .optional()
    .describe('operationId, подтверждённый человеком через npm run approval:review'),
};

export const updateArgsShape = {
  ...writeArgsShape,
  expectedStateHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe('Хеш состояния объекта из предыдущего чтения; при расхождении — CONFLICT'),
};

export interface WriteArgs {
  dryRun: boolean;
  idempotencyKey?: string | undefined;
  approvalId?: string | undefined;
  expectedStateHash?: string | undefined;
}

/** Правило §15.2: без dryRun ключ идемпотентности обязателен. Дублируется сервером в исполнителе. */
export function requireIdempotencyUnlessDryRun(
  data: { dryRun: boolean; idempotencyKey?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (!data.dryRun && !data.idempotencyKey) {
    ctx.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'обязателен, когда dryRun=false' });
  }
}

/** Управляющие поля, не входящие в канонический хеш аргументов. */
export const CONTROL_FIELDS: ReadonlySet<string> = new Set(['dryRun', 'idempotencyKey', 'approvalId']);

export const pageArgsShape = {
  pageSize: z.number().int().min(1).max(50).optional().describe('1..50, по умолчанию DEFAULT_PAGE_SIZE'),
  cursor: z.string().min(1).max(200).optional().describe('Непрозрачный курсор из предыдущего ответа'),
};

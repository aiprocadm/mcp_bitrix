/**
 * disk_delete_file (ТЗ §9.12, §11 п.8, этап 14): удаление конкретного файла — перемещение в корзину.
 * Документация: disk.file.delete удаляет файл БЕЗВОЗВРАТНО, disk.file.markDeleted — в корзину с возможностью
 * восстановления (disk.file.restore). Выбран безопасный документированный вариант markDeleted; безвозвратное
 * удаление сервером не предоставляется.
 * Источник: https://apidocs.bitrix24.ru/api-reference/disk/file/disk-file-mark-deleted.html
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  asText,
  idOf,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  num,
  outcomeUnknown,
} from '../shared.js';
import { defineTool, DESTRUCTIVE_ANNOTATIONS, type ToolContext } from '../types.js';
import { fileStateHash, getFile } from './common.js';

async function folderName(ctx: ToolContext, folderId: number | undefined): Promise<string | null> {
  if (!folderId) return null;
  try {
    const r = await ctx.bitrix.call(
      'legacy',
      'disk.folder.get',
      { id: folderId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    return isObj(r.result) ? asText(r.result['NAME']) || null : null;
  } catch {
    return null; // название папки — только для плана; отсутствие не мешает
  }
}

const inTrash = (f: Record<string, unknown>): boolean => {
  const d = asText(f['DELETED_TYPE']);
  return d !== '' && d !== '0';
};

export const diskDeleteFileTool = defineTool({
  name: 'disk_delete_file',
  module: 'disk',
  title: 'Удалить файл Диска (в корзину)',
  description:
    'Удалить конкретный файл Диска Bitrix24, переместив его в корзину (disk.file.markDeleted); безвозвратное удаление не выполняется. ' +
    'Использовать, только когда пользователь явно просит удалить определённый файл по его ID (disk_children_list / disk_search_files). ' +
    'План показывает имя, размер, папку и дату изменения; expectedStateHash из dryRun защищает от удаления изменённого файла. ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId; после записи файл перечитывается (должен быть в корзине).',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      fileId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID файла'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    fileId: z.number(),
    ...mutationOutputShape,
    inTrash: z.boolean().optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    let file: Record<string, JsonValue> | undefined;
    let gone: AppError | undefined;
    try {
      file = await getFile(ctx, args.fileId);
      if (inTrash(file)) {
        gone = new AppError('VALIDATION_ERROR', 'Файл уже в корзине', {
          field: 'fileId',
          reason: 'ALREADY_IN_TRASH',
        });
      }
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
      gone = e;
    }
    if (gone || !file) {
      const err = gone ?? new AppError('NOT_FOUND', 'Файл не найден');
      if (!args.approvalId) throw err;
      // Повтор уже выполненного удаления: файл в корзине, ledger вернёт сохранённый результат без новой записи.
      const outcome = await ctx.mutations.execute({
        requestId: ctx.requestId,
        principal: mutationPrincipal(ctx),
        tool: 'disk_delete_file',
        operationKind: 'delete',
        args,
        expectedStateHash: args.expectedStateHash ?? null,
        summary: {
          action: `Переместить в корзину файл #${String(args.fileId)}`,
          target: `disk.file:${String(args.fileId)}`,
          portalOrigin: ctx.bitrix.auth.portalOrigin,
          details: { method: 'disk.file.markdeleted', fileId: args.fileId },
          risks: [],
        },
        precheck: () => Promise.reject(err),
        perform: () => Promise.reject(err),
      });
      return mutationResponse(ctx, outcome, {
        base: { fileId: args.fileId },
        method: 'disk.file.markdeleted',
        resultFields: ['inTrash'],
      });
    }
    const currentHash = fileStateHash(file);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Файл изменился после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Перечитайте файл (dryRun) и подготовьте новый план',
      });
    }
    const name = asText(file['NAME']) || `#${String(args.fileId)}`;
    const parentId = idOf(file['PARENT_ID']);
    const folder = await folderName(ctx, parentId);
    const risks = [
      'Файл исчезнет из папки у всех, кто имеет к ней доступ; ссылки на него перестанут открываться',
      'Файл попадёт в корзину Диска: восстановить можно из корзины (disk.file.restore) в пределах срока её хранения',
      'Безвозвратное удаление (disk.file.delete) не выполняется',
    ];
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если файл изменят до выполнения, удаление всё равно выполнится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'disk_delete_file',
      operationKind: 'delete',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Переместить в корзину файл «${name}» (#${String(args.fileId)})`,
        target: `disk.file:${String(args.fileId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'disk.file.markdeleted',
          mode: 'trash',
          fileId: args.fileId,
          stateHash: currentHash,
          impact: {
            name,
            size: num(file['SIZE']) ?? null,
            updateTime: asText(file['UPDATE_TIME']) || null,
            updatedBy: idOf(file['UPDATED_BY']) ?? null,
            folderId: parentId ?? null,
            folderName: folder,
            storageId: idOf(file['STORAGE_ID']) ?? null,
          },
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await getFile(ctx, args.fileId);
        if (inTrash(fresh)) {
          throw new AppError('CONFLICT', 'Файл уже удалён после подготовки плана', {
            reason: 'STATE_CHANGED',
          });
        }
        if (args.expectedStateHash && fileStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Файл изменился после подтверждения; удаление отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Перечитайте файл и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'disk.file.markdeleted',
          { id: args.fileId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (!isObj(r.result) || idOf(r.result['ID']) !== args.fileId) {
          throw outcomeUnknown(
            'disk.file.markdeleted',
            'legacy',
            'Проверьте корзину Диска: перемещён ли файл',
          );
        }
        return { id: args.fileId, result: { inTrash: inTrash(r.result) } };
      },
      verify: async () => {
        try {
          const f = await getFile(ctx, args.fileId);
          const gone = inTrash(f);
          return { verified: gone, warnings: gone ? [] : ['Файл после удаления не помечен как удалённый'] };
        } catch (e) {
          if (e instanceof AppError && e.code === 'NOT_FOUND') return { verified: true, warnings: [] };
          throw e;
        }
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { fileId: args.fileId },
      method: 'disk.file.markdeleted',
      resultFields: ['inTrash'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

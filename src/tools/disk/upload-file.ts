/**
 * disk_upload_file (ТЗ §8.5, §9.12, §10.1, §15.3): загрузка подготовленного файла в разрешённую папку.
 * Принимает fileToken (npm run file:stage) или маленький inline base64; произвольные пути/URL — нет.
 * Хеш файла входит в план и проверяется при подтверждении и перед отправкой (T26).
 * Публичные ссылки не выдаются; конфликт имени — ошибка либо явное переименование порталом.
 * Источник: https://apidocs.bitrix24.ru/api-reference/disk/folder/disk-folder-upload-file.html
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import type { FileManifest } from '../../files/staging.js';
import { sanitizeFileName } from '../../files/validation.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool, type ToolContext } from '../types.js';
import { asText } from '../crm/deal-fields.js';

const UPLOAD_ANNOTATIONS = { ...CREATE_ANNOTATIONS };

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

async function getFolder(ctx: ToolContext, folderId: number): Promise<{ name: string; storageId: string }> {
  const r = await ctx.bitrix.call(
    'legacy',
    'disk.folder.get',
    { id: folderId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const f = asObj(r.result);
  if (!f)
    throw new AppError('NOT_FOUND', 'Папка не найдена или недоступна', {
      field: 'folderId',
      method: 'disk.folder.get',
      apiVersion: 'legacy',
    });
  return { name: asText(f['NAME']) || `#${folderId}`, storageId: asText(f['STORAGE_ID']) };
}

async function nameExists(ctx: ToolContext, folderId: number, name: string): Promise<boolean> {
  const r = await ctx.bitrix.call(
    'legacy',
    'disk.folder.getchildren',
    { id: folderId, filter: { NAME: name } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const items = Array.isArray(r.result) ? (r.result as Record<string, unknown>[]) : [];
  return items.some((i) => asText(i['NAME']) === name);
}

export const diskUploadFileTool = defineTool({
  name: 'disk_upload_file',
  module: 'disk',
  title: 'Загрузить файл на Диск',
  description:
    'Загрузить подготовленный файл в папку Диска Bitrix24 (disk.folder.uploadFile). Использовать, когда пользователь просит положить файл в известную папку. Файл готовит человек: ' +
    '`npm run file:stage -- --path <файл в UPLOAD_ROOT>` даёт fileToken; для маленького тестового файла допустим inline base64 (до 256 КиБ). ' +
    'Пути на сервере и URL для скачивания не принимаются. conflictPolicy: error — при совпадении имени отказ; rename — портал добавит суффикс. ' +
    'Порядок: без approvalId — APPROVAL_REQUIRED с планом (папка, имя, размер, sha256); после подтверждения тот же вызов с approvalId загружает ровно один раз. ' +
    'Публичные ссылки не создаются.',
  operation: 'upload',
  annotations: UPLOAD_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      folderId: z
        .number()
        .int()
        .positive()
        .describe('ID папки Диска (disk.folder.getchildren / disk.storage.getlist)'),
      fileToken: z.string().min(16).max(64).optional().describe('Токен из npm run file:stage'),
      inline: z
        .object({
          fileName: z.string().min(1).max(200),
          contentBase64: z.string().min(4).max(400_000),
        })
        .strict()
        .optional()
        .describe('Маленький файл base64 (до MAX_INLINE_FILE_BYTES после декодирования)'),
      name: z.string().min(1).max(200).optional().describe('Имя файла на Диске; по умолчанию исходное'),
      conflictPolicy: z.enum(['error', 'rename']).default('error'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun)
    .superRefine((d, c) => {
      if ((d.fileToken ? 1 : 0) + (d.inline ? 1 : 0) !== 1) {
        c.addIssue({
          code: 'custom',
          path: ['fileToken'],
          message: 'укажите ровно одно: fileToken или inline',
        });
      }
    }),
  outputDataSchema: z.object({
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    fileId: z.number().nullable().optional(),
    name: z.string().optional(),
    size: z.number().optional(),
    detailUrl: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    // 1. Файл: манифест из staging (токен) либо inline → staging. Хеш — часть плана.
    const manifest: FileManifest = args.inline
      ? await ctx.files.stageInline(args.inline.contentBase64, args.inline.fileName, ctx.principal.id)
      : await ctx.files.resolve(args.fileToken ?? '', ctx.principal.id);
    const targetName = sanitizeFileName(args.name ?? manifest.originalName);
    // 2. Папка и конфликт имени — до плана.
    const folder = await getFolder(ctx, args.folderId);
    const exists = await nameExists(ctx, args.folderId, targetName);
    if (exists && args.conflictPolicy === 'error') {
      throw new AppError('CONFLICT', `В папке «${folder.name}» уже есть файл «${targetName}»`, {
        field: 'name',
        reason: 'NAME_CONFLICT',
        nextAction: 'Укажите другое имя или conflictPolicy=rename',
      });
    }
    // Аргументы для хеша/плана — по содержимому, а не по токену: повтор того же файла = тот же план.
    const hashArgs: Record<string, unknown> = {
      folderId: args.folderId,
      name: targetName,
      conflictPolicy: args.conflictPolicy,
      fileSha256: manifest.sha256,
      fileSize: manifest.size,
      dryRun: args.dryRun,
      idempotencyKey: args.idempotencyKey,
      approvalId: args.approvalId,
    };
    const risks = ['Файл станет виден всем, у кого есть доступ к папке'];
    if (exists)
      risks.push('Файл с таким именем уже есть: портал сохранит копию с суффиксом (conflictPolicy=rename)');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'disk_upload_file',
      operationKind: 'upload',
      args: hashArgs,
      fileHash: manifest.sha256,
      summary: {
        action: `Загрузить «${targetName}» (${manifest.size} байт) в папку «${folder.name}»`,
        target: `disk.folder:${args.folderId}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'disk.folder.uploadfile',
          folderId: args.folderId,
          folderName: folder.name,
          storageId: folder.storageId,
          name: targetName,
          originalName: manifest.originalName,
          mime: manifest.mime,
          size: manifest.size,
          sha256: manifest.sha256,
          conflictPolicy: args.conflictPolicy,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        // Имя могло появиться после подготовки плана (T15-подобная гонка).
        if (args.conflictPolicy === 'error' && (await nameExists(ctx, args.folderId, targetName))) {
          throw new AppError('CONFLICT', `Файл «${targetName}» появился в папке после подготовки плана`, {
            reason: 'NAME_CONFLICT',
          });
        }
      },
      perform: async () => {
        const bytes = ctx.files.readVerified(manifest); // T26: хеш сверяется перед отправкой
        const params: JsonObject = {
          id: args.folderId,
          data: { NAME: targetName },
          fileContent: [targetName, bytes.toString('base64')],
          ...(args.conflictPolicy === 'rename' ? { generateUniqueName: true } : {}),
        };
        const r = await ctx.bitrix.call('legacy', 'disk.folder.uploadfile', params, {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        const f = asObj(r.result);
        const id = Number(f?.['ID']);
        if (!f || !Number.isInteger(id) || id <= 0) {
          throw new AppError(
            'OPERATION_OUTCOME_UNKNOWN',
            'disk.folder.uploadFile вернул ответ без ID файла; исход неизвестен',
            {
              method: 'disk.folder.uploadfile',
              apiVersion: 'legacy',
              reason: 'outcome-unknown',
              nextAction: 'Проверьте папку в Bitrix24 перед повторной загрузкой',
            },
          );
        }
        return {
          id,
          result: {
            fileId: id,
            name: asText(f['NAME']) || targetName,
            size: Number(f['SIZE']) || manifest.size,
            detailUrl: asText(f['DETAIL_URL']),
          },
        };
      },
      verify: async (performed) => {
        const r = await ctx.bitrix.call(
          'legacy',
          'disk.file.get',
          { id: performed.id },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const f = asObj(r.result);
        if (!f) return { verified: false, warnings: ['Файл загружен, но не читается по ID'] };
        const warnings: string[] = [];
        const size = Number(f['SIZE']);
        if (size !== manifest.size)
          warnings.push(`Размер в портале ${size} байт, отправлено ${manifest.size}`);
        const name = asText(f['NAME']);
        if (name !== targetName) warnings.push(`Имя в портале: «${name}» (переименовано порталом)`);
        return { verified: size === manifest.size, warnings };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        { dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: файл не загружался, подтверждение не создано'],
        },
      );
    }
    const res = outcome.result as { fileId?: number; name?: string; size?: number; detailUrl?: string };
    return ok(
      {
        fileId: typeof outcome.id === 'number' ? outcome.id : null,
        ...(res.name ? { name: res.name } : {}),
        ...(typeof res.size === 'number' ? { size: res.size } : {}),
        ...(res.detailUrl ? { detailUrl: res.detailUrl } : {}),
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'disk.folder.uploadfile',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

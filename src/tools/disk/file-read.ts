/**
 * Чтение содержимого файлов портала (счета, выписки, акты): disk_file_read по ID файла Диска и crm_activity_files —
 * вложения дела CRM (письма). Скачивание — на сервере (BitrixClient.downloadFile, только host портала, без
 * перенаправлений, предел MAX_UPLOAD_BYTES); наружу выходит только извлечённый текст. DOWNLOAD_URL содержит
 * авторизацию (у вебхука — его код в пути, живой портал 2026-10-07) и никогда не выдаётся.
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { extractFileText, formatOf } from '../../files/extract-text.js';
import { ok } from '../../mcp/result.js';
import { asText, idOf, idSchema, isObj, num, upstreamShapeError } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';

export interface DiskFileMeta {
  id: number;
  name: string;
  size: number | null;
  downloadUrl: string;
}

export async function diskFile(ctx: ToolContext, id: number): Promise<DiskFileMeta> {
  const r = await ctx.bitrix.call(
    'legacy',
    'disk.file.get',
    { id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!isObj(r.result)) {
    throw new AppError('NOT_FOUND', 'Файл Диска не найден или недоступен', {
      method: 'disk.file.get',
      apiVersion: 'legacy',
    });
  }
  return {
    id,
    name: asText(r.result['NAME']),
    size: num(r.result['SIZE']) ?? null,
    downloadUrl: asText(r.result['DOWNLOAD_URL']),
  };
}

export const diskFileReadTool = defineTool({
  name: 'disk_file_read',
  module: 'disk',
  title: 'Прочитать файл',
  description:
    'Текст файла Диска или вложения CRM по ID файла: txt, csv, md, json, xml, html, pdf (текстовый слой), docx, xlsx (листы, ячейки через табуляцию). ' +
    'Использовать, чтобы прочитать счёт, выписку, акт или прайс, приложенные к сделке или письму; ID — из crm_activity_files, disk_children_list, disk_search_files. ' +
    'Файл скачивается на сервере, ссылка не выдаётся. Сканы без текстового слоя не распознаются. Длинный текст — частями: offset и maxChars.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      fileId: idSchema.describe('ID файла Диска'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('С какого символа отдавать текст (для продолжения)'),
      maxChars: z.number().int().min(500).max(100_000).default(20_000).describe('Сколько символов отдать'),
    })
    .strict(),
  outputDataSchema: z.object({
    fileId: z.number(),
    name: z.string(),
    size: z.number().nullable(),
    format: z.string(),
    pages: z.number().optional(),
    text: z.string(),
    offset: z.number(),
    length: z.number(),
    truncated: z.boolean(),
    nextOffset: z.number().nullable(),
  }),
  handler: async (args, ctx) => {
    const meta = await diskFile(ctx, args.fileId);
    // Формат проверяется до скачивания: неподдерживаемый файл не тянем.
    if (!formatOf(meta.name)) await extractFileText(meta.name, new Uint8Array());
    const limit = ctx.config.files.maxUploadBytes;
    if (meta.size !== null && meta.size > limit) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `Файл ${String(meta.size)} байт больше предела MAX_UPLOAD_BYTES=${String(limit)}`,
        {
          nextAction: 'Откройте файл в портале',
        },
      );
    }
    if (!meta.downloadUrl)
      throw upstreamShapeError('disk.file.get', 'legacy', 'Портал не вернул адрес скачивания');
    const { bytes } = await ctx.bitrix.downloadFile(meta.downloadUrl, {
      maxBytes: limit,
      requestId: ctx.requestId,
      signal: ctx.signal,
    });
    const extracted = await extractFileText(meta.name, bytes);
    const text = extracted.text.slice(args.offset, args.offset + args.maxChars);
    const end = args.offset + text.length;
    const truncated = end < extracted.text.length;
    return ok(
      {
        fileId: meta.id,
        name: meta.name,
        size: meta.size,
        format: extracted.format,
        ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
        text,
        offset: args.offset,
        length: extracted.text.length,
        truncated,
        nextOffset: truncated ? end : null,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'disk.file.get',
        apiVersion: 'legacy',
        completeness: truncated || args.offset > 0 ? 'partial' : 'complete',
        warnings: [
          ...extracted.warnings,
          ...(truncated
            ? [
                `Показаны символы ${String(args.offset)}–${String(end)} из ${String(extracted.text.length)}; продолжение — offset=${String(end)}`,
              ]
            : []),
        ],
      },
    );
  },
});

export const crmActivityFilesTool = defineTool({
  name: 'crm_activity_files',
  module: 'crm',
  title: 'Вложения дела CRM',
  description:
    'Файлы, приложенные к делу CRM (письму, звонку, делу): ID файла Диска, имя, размер, читается ли (crm.activity.get → FILES, disk.file.get). ' +
    'Использовать, чтобы найти счёт или выписку во вложениях письма; затем disk_file_read по fileId. Ссылки не выдаются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ activityId: idSchema.describe('ID дела') }).strict(),
  outputDataSchema: z.object({
    activityId: z.number(),
    subject: z.string(),
    items: z.array(
      z.object({ fileId: z.number(), name: z.string(), size: z.number().nullable(), readable: z.boolean() }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.activity.get',
      { id: args.activityId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    if (!isObj(r.result)) {
      throw new AppError('NOT_FOUND', 'Дело не найдено или недоступно', {
        method: 'crm.activity.get',
        apiVersion: 'legacy',
      });
    }
    // Живой портал: FILES — [{id, url}], id — ID файла Диска; url (crm_show_file.php) не используется.
    const raw = Array.isArray(r.result['FILES']) ? r.result['FILES'] : [];
    const ids = raw
      .filter(isObj)
      .map((f) => idOf(f['id']))
      .filter((x): x is number => x !== undefined)
      .slice(0, 20);
    const items = [];
    for (const id of ids) {
      try {
        const f = await diskFile(ctx, id);
        items.push({ fileId: id, name: f.name, size: f.size, readable: formatOf(f.name) !== undefined });
      } catch {
        items.push({ fileId: id, name: '', size: null, readable: false });
      }
    }
    return ok(
      {
        activityId: args.activityId,
        subject: asText(r.result['SUBJECT']),
        items,
        returnedCount: items.length,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.activity.get',
        apiVersion: 'legacy',
        completeness: raw.length > 20 ? 'partial' : 'complete',
        warnings: raw.length > 20 ? ['Показаны первые 20 вложений'] : [],
      },
    );
  },
});

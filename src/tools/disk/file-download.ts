/**
 * Скачивание файлов портала на диск сервера (single, DOWNLOAD_DIR): disk_file_download — один файл Диска по ID,
 * chat_files_download — все файлы диалога (из im.dialog.messages.get, как в chat_messages_get) с описью
 * «дата; кто прислал; имя». Портал только читается (disk.file.get + DOWNLOAD_URL сервером, как disk_file_read);
 * ссылка скачивания с кодом вебхука наружу не выходит, в ответе — только путь сохранённого файла.
 * Предел файла MAX_DOWNLOAD_BYTES; существующие файлы не перезаписываются, повтор продолжает с места остановки.
 */
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import {
  appendManifest,
  checkFolder,
  downloadRoot,
  ensureFolder,
  fileExists,
  safeFileName,
  saveNewFile,
} from '../../files/download-store.js';
import { ok } from '../../mcp/result.js';
import { fetchMessages, type Message } from '../chat/messages-get.js';
import { idSchema, upstreamShapeError } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { diskFile } from './file-read.js';

const DIALOG_RE = /^(chat\d{1,15}|sg\d{1,15}|\d{1,15})$/;
const PAGE = 50;
const MAX_SCAN_MESSAGES = 20_000;

const folderSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Подпапка внутри DOWNLOAD_DIR: до 3 частей через «/», например «переписка/Иванов»');

type Status = 'saved' | 'exists' | 'too_large' | 'failed';

/** Скачивает файл Диска в dir под именем target; ошибки портала по одному файлу не прерывают пакет. */
async function downloadOne(
  ctx: ToolContext,
  fileId: number,
  dir: string,
  target: (name: string) => string,
  knownName?: string,
): Promise<{ status: Status; name: string; size: number | null; savedAs: string | null }> {
  // Имя известно из сообщения чата — уже скачанный файл пропускается без обращения к порталу.
  if (knownName) {
    const savedAs = target(knownName);
    if (await fileExists(path.join(dir, savedAs)))
      return { status: 'exists', name: knownName, size: null, savedAs };
  }
  const meta = await diskFile(ctx, fileId);
  const savedAs = target(knownName?.length ? knownName : meta.name);
  const file = path.join(dir, savedAs);
  if (await fileExists(file)) return { status: 'exists', name: meta.name, size: meta.size, savedAs };
  const limit = ctx.config.files.maxDownloadBytes;
  if (meta.size !== null && meta.size > limit)
    return { status: 'too_large', name: meta.name, size: meta.size, savedAs: null };
  if (!meta.downloadUrl)
    throw upstreamShapeError('disk.file.get', 'legacy', 'Портал не вернул адрес скачивания');
  const { bytes } = await ctx.bitrix.downloadFile(meta.downloadUrl, {
    maxBytes: limit,
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  const saved = await saveNewFile(file, bytes);
  return { status: saved ? 'saved' : 'exists', name: meta.name, size: bytes.byteLength, savedAs };
}

/** Ошибка одного файла → строка для ответа; отмена вызова и сбой диска сервера прерывают весь пакет. */
function perFileError(e: unknown, ctx: ToolContext): { status: Status; error: string } {
  if (ctx.signal?.aborted) throw e;
  if (AppError.is(e)) {
    if (e.code === 'FILE_TOO_LARGE') return { status: 'too_large', error: e.code };
    return { status: 'failed', error: e.code };
  }
  throw e;
}

export const diskFileDownloadTool = defineTool({
  name: 'disk_file_download',
  module: 'disk',
  title: 'Скачать файл на сервер',
  description:
    'Сохранить сам файл Диска или вложения (любой формат: документ, таблица, картинка, запись звонка) в папку скачиваний сервера (DOWNLOAD_DIR). ' +
    'Использовать, когда пользователь просит забрать файл себе, а не прочитать текст; ID — из chat_messages_get (files[].id), crm_activity_files, disk_children_list. ' +
    'Портал не меняется. Уже скачанный файл не перезаписывается. Если DOWNLOAD_DIR не задан — FEATURE_UNAVAILABLE.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      fileId: idSchema.describe('ID файла Диска'),
      folder: folderSchema.default('files'),
    })
    .strict(),
  outputDataSchema: z.object({
    fileId: z.number(),
    name: z.string(),
    size: z.number().nullable(),
    status: z.enum(['saved', 'exists']),
    folder: z.string(),
    savedAs: z.string(),
    path: z.string(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const parts = checkFolder(args.folder);
    const dir = await ensureFolder(root, parts);
    const r = await downloadOne(
      ctx,
      args.fileId,
      dir,
      (n) => `${String(args.fileId)}_${safeFileName(n, 'file')}`,
    );
    if (r.status === 'too_large' || r.savedAs === null) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `Файл ${String(r.size)} байт больше предела MAX_DOWNLOAD_BYTES=${String(ctx.config.files.maxDownloadBytes)}`,
        { nextAction: 'Скачайте файл в портале или увеличьте MAX_DOWNLOAD_BYTES (до 100 МБ)' },
      );
    }
    return ok(
      {
        fileId: args.fileId,
        name: r.name,
        size: r.size,
        status: r.status === 'saved' ? 'saved' : 'exists',
        folder: parts.join('/'),
        savedAs: r.savedAs,
        path: path.join(dir, r.savedAs),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'disk.file.get',
        apiVersion: 'legacy',
        warnings: r.status === 'exists' ? ['Файл уже был скачан раньше — оставлен без изменений'] : [],
      },
    );
  },
});

interface ChatFile {
  fileId: number;
  messageId: number;
  date: string | null;
  authorName: string | null;
  name: string;
  size: number | null;
  status: Status;
  savedAs: string | null;
  error?: string;
}

const dayOf = (date: string | null) => (date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null);

export const chatFilesDownloadTool = defineTool({
  name: 'chat_files_download',
  module: 'chat',
  title: 'Скачать все файлы диалога',
  description:
    'Скачать на сервер (DOWNLOAD_DIR) все файлы из переписки: документы, таблицы, картинки, записи — от новых к старым, ' +
    'имя «дата_ID_имя», опись _список-файлов.csv (дата, кто прислал, имя). dialogId — как в chat_messages_get. ' +
    'Использовать, когда пользователь просит забрать себе файлы чата или сотрудника. Портал не меняется, сообщения не отмечаются прочитанными. ' +
    'За вызов — до maxFiles новых файлов и maxSeconds секунд; если ответ complete=false — повторить с beforeMessageId=nextBeforeMessageId ' +
    '(уже скачанные пропускаются).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      dialogId: z.string().regex(DIALOG_RE, 'ID сотрудника, chat<id> или sg<id>').describe('ID диалога'),
      folder: folderSchema.optional(),
      beforeMessageId: idSchema.optional().describe('Продолжить с сообщений старее этого ID'),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Сколько новых файлов скачать за вызов'),
      maxSeconds: z.number().int().min(10).max(600).default(50).describe('Сколько секунд работать за вызов'),
    })
    .strict(),
  outputDataSchema: z.object({
    dialogId: z.string(),
    folder: z.string(),
    path: z.string(),
    items: z.array(
      z.object({
        fileId: z.number(),
        messageId: z.number(),
        date: z.string().nullable(),
        authorName: z.string().nullable(),
        name: z.string(),
        size: z.number().nullable(),
        status: z.enum(['saved', 'exists', 'too_large', 'failed']),
        savedAs: z.string().nullable(),
        error: z.string().optional(),
      }),
    ),
    saved: z.number(),
    existed: z.number(),
    skipped: z.number(),
    bytesSaved: z.number(),
    scannedMessages: z.number(),
    complete: z.boolean(),
    nextBeforeMessageId: z.number().nullable(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const parts = checkFolder(args.folder ?? `chat-${args.dialogId}`);
    const dir = await ensureFolder(root, parts);
    const deadline = Date.now() + args.maxSeconds * 1000;
    const items: ChatFile[] = [];
    const seen = new Set<number>();
    let anchor: number | null = args.beforeMessageId ?? null;
    let scanned = 0;
    let downloaded = 0;
    let stopAt: number | null = null;
    let reachedStart = false;

    outer: while (scanned < MAX_SCAN_MESSAGES && Date.now() < deadline) {
      const got = await fetchMessages(ctx, args.dialogId, { direction: 'older', anchor }, PAGE);
      const before = anchor;
      const page: Message[] = before === null ? got.messages : got.messages.filter((m) => m.id < before);
      if (page.length === 0) {
        reachedStart = true;
        break;
      }
      scanned += page.length;
      for (const m of [...page].reverse()) {
        for (const f of m.files) {
          if (seen.has(f.id)) continue;
          if (downloaded >= args.maxFiles || Date.now() >= deadline) {
            // Продолжение — с этого же сообщения: его уже скачанные файлы пропустятся как exists.
            stopAt = m.id + 1;
            break outer;
          }
          seen.add(f.id);
          const day = dayOf(m.date);
          const base: Omit<ChatFile, 'status' | 'savedAs'> = {
            fileId: f.id,
            messageId: m.id,
            date: m.date,
            authorName: m.authorName,
            name: f.name,
            size: f.size,
          };
          try {
            const r = await downloadOne(
              ctx,
              f.id,
              dir,
              (n) => `${day ?? 'без-даты'}_${String(f.id)}_${safeFileName(n, 'file')}`,
              f.name,
            );
            items.push({
              ...base,
              name: r.name || f.name,
              size: r.size ?? f.size,
              status: r.status,
              savedAs: r.savedAs,
            });
            if (r.status === 'saved') downloaded++;
          } catch (e) {
            items.push({ ...base, savedAs: null, ...perFileError(e, ctx) });
          }
        }
      }
      anchor = page[0]?.id ?? null;
      if (got.messages.length < PAGE) {
        reachedStart = true;
        break;
      }
    }

    const saved = items.filter((i) => i.status === 'saved');
    await appendManifest(
      dir,
      ['дата', 'кто прислал', 'имя файла', 'сохранён как', 'размер, байт', 'ID файла', 'ID сообщения'],
      saved.map((i) => [i.date, i.authorName, i.name, i.savedAs, i.size, i.fileId, i.messageId]),
    );
    const complete = reachedStart && stopAt === null;
    const nextBeforeMessageId = complete ? null : (stopAt ?? anchor);
    const skipped = items.filter((i) => i.status === 'too_large' || i.status === 'failed').length;
    const warnings: string[] = [];
    if (!complete)
      warnings.push(
        `Скачаны не все файлы: повторите с beforeMessageId=${String(nextBeforeMessageId)} (уже скачанные пропустятся)`,
      );
    if (items.some((i) => i.status === 'too_large'))
      warnings.push(
        `Файлы больше MAX_DOWNLOAD_BYTES=${String(ctx.config.files.maxDownloadBytes)} пропущены — скачайте их в портале`,
      );
    if (items.some((i) => i.status === 'failed'))
      warnings.push('Часть файлов портал не отдал (удалены или нет доступа) — см. error у файла');
    return ok(
      {
        dialogId: args.dialogId,
        folder: parts.join('/'),
        path: dir,
        items,
        saved: saved.length,
        existed: items.filter((i) => i.status === 'exists').length,
        skipped,
        bytesSaved: saved.reduce((s, i) => s + (i.size ?? 0), 0),
        scannedMessages: scanned,
        complete,
        nextBeforeMessageId,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'im.dialog.messages.get',
        apiVersion: 'legacy',
        completeness: complete ? 'complete' : 'partial',
        warnings,
      },
    );
  },
});

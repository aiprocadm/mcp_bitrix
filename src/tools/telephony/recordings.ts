/**
 * calls_recordings_download (заявка 2026-10-13 «записи звонков», п. 2): записи разговоров за период одним вызовом —
 * «все записи менеджера N за неделю длиннее 30 секунд». Звонки берутся из voximplant.statistic.get с теми же
 * фильтрами, что у telephony_calls_list; файл записи — RECORD_FILE_ID звонка или файл дела-звонка CRM (внешние АТС).
 * Файлы сохраняются в DOWNLOAD_DIR (только single) с понятными именами «дата_время_сотрудник_вх|исх_длительность_call<ID>»
 * и описью _список-файлов.csv. Номер абонента в описи маскируется. Портал только читается; ссылки скачивания наружу
 * не выходят. Повтор того же вызова продолжает с места остановки: уже скачанные записи пропускаются без запросов к порталу.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import {
  appendManifest,
  checkFolder,
  downloadRoot,
  ensureFolder,
  safeFileName,
} from '../../files/download-store.js';
import { ok } from '../../mcp/result.js';
import { NameResolver } from '../crm/names.js';
import { downloadOne, perFileError, type Status } from '../disk/file-download.js';
import { idSchema, isoDateSchema } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  callFiltersShape,
  fetchAllCalls,
  fillRecordFiles,
  normalizeCall,
  passesCallFilters,
  periodFilter,
  type Call,
  type CallFilters,
} from './calls-list.js';

/** Префикс имени файла записи (без расширения): одинаковый при повторе — по нему пропускаются скачанные. */
export function recordingPrefix(c: Call, userName: string | null): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(c.startDate ?? '');
  const when = m ? `${m[1] ?? ''}_${m[2] ?? ''}${m[3] ?? ''}` : 'без-даты';
  const who = userName ?? (c.userId !== null ? `сотрудник-${String(c.userId)}` : 'без-сотрудника');
  const dir =
    c.type === 'outgoing' ? 'исх' : c.type.startsWith('incoming') || c.type === 'callback' ? 'вх' : 'др';
  return safeFileName(
    `${when}_${who}_${dir}_${String(c.durationSec)}с_call${String(c.id)}`,
    `call${String(c.id)}`,
  );
}

const itemOut = z.object({
  callId: z.number(),
  startDate: z.string().nullable(),
  userName: z.string().nullable(),
  type: z.string(),
  durationSec: z.number(),
  crmActivityId: z.number().nullable(),
  recordFileId: z.number().nullable(),
  status: z.enum(['saved', 'exists', 'too_large', 'failed', 'no_recording']),
  savedAs: z.string().nullable(),
  error: z.string().optional(),
});
type Item = z.infer<typeof itemOut>;

export const callsRecordingsDownloadTool = defineTool({
  name: 'calls_recordings_download',
  module: 'telephony',
  title: 'Скачать записи звонков за период',
  description:
    'Скачать на сервер (DOWNLOAD_DIR) записи разговоров за период одной командой: по сотруднику, направлению, длительности и другим фильтрам telephony_calls_list. ' +
    'Имена файлов: «дата_время_сотрудник_вх|исх_длительность_call<ID>», опись _список-файлов.csv (дата, сотрудник, направление, длительность, номер под маской, ID дела). ' +
    'Использовать, когда нужно прослушать или перевести в текст разговоры менеджера за неделю или месяц (затем call_transcribe по пути файла). ' +
    'Звонки без записи пропускаются. За вызов — до maxFiles новых файлов и maxSeconds секунд; если complete=false — повторить тот же вызов (скачанные пропустятся). Портал не меняется.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      from: isoDateSchema.describe('Начало периода (ISO 8601, со смещением зоны)'),
      to: isoDateSchema.describe('Конец периода (ISO 8601)'),
      userId: idSchema.optional().describe('Только звонки этого сотрудника'),
      ...callFiltersShape,
      folder: z
        .string()
        .min(1)
        .max(200)
        .default('звонки')
        .describe('Подпапка внутри DOWNLOAD_DIR: до 3 частей через «/»'),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(300)
        .default(50)
        .describe('Сколько новых записей скачать за вызов'),
      maxSeconds: z.number().int().min(10).max(600).default(120).describe('Сколько секунд работать за вызов'),
    })
    .strict()
    .refine((a) => Date.parse(a.from) <= Date.parse(a.to), {
      message: 'from должен быть не позже to',
      path: ['to'],
    }),
  outputDataSchema: z.object({
    folder: z.string(),
    path: z.string(),
    items: z.array(itemOut),
    calls: z.number(),
    saved: z.number(),
    existed: z.number(),
    withoutRecording: z.number(),
    failed: z.number(),
    bytesSaved: z.number(),
    complete: z.boolean(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    const parts = checkFolder(args.folder);
    const dir = await ensureFolder(root, parts);
    const deadline = ctx.startedAt + args.maxSeconds * 1000;
    const filters: CallFilters = { ...args, minDurationSec: args.minDurationSec ?? 1 };
    const all = await fetchAllCalls(ctx, {
      filter: periodFilter(args.from, args.to, args.userId),
      keep: (raw: JsonValue) => passesCallFilters(raw, filters),
      maxCalls: 20_000,
      deadline,
    });
    const calls = all.rows.map((r) => normalizeCall(r, false)).filter((c): c is Call => c !== undefined);
    const names = new NameResolver(ctx);
    await names.loadUsers(calls.map((c) => c.userId).filter((u): u is number => u !== null));

    const existing = new Set((await readdir(dir)).map((f) => f.replace(/\.[^.]*$/, '')));
    const items: Item[] = [];
    const manifest: (string | number | null)[][] = [];
    let saved = 0;
    let bytes = 0;
    let stopped = false;
    // Сначала уже скачанные — без запросов к порталу.
    const todo: Call[] = [];
    for (const c of calls) {
      const prefix = recordingPrefix(c, names.userName(c.userId));
      if (existing.has(prefix))
        items.push({
          callId: c.id,
          startDate: c.startDate,
          userName: names.userName(c.userId),
          type: c.type,
          durationSec: c.durationSec,
          crmActivityId: c.crmActivityId,
          recordFileId: c.recordFileId ?? null,
          status: 'exists',
          savedAs: null,
        });
      else todo.push(c);
    }
    for (let i = 0; i < todo.length; i += 50) {
      if (saved >= args.maxFiles || Date.now() >= deadline) {
        stopped = true;
        break;
      }
      const chunk = todo.slice(i, i + 50);
      await fillRecordFiles(ctx, chunk);
      for (const c of chunk) {
        const userName = names.userName(c.userId);
        const base = {
          callId: c.id,
          startDate: c.startDate,
          userName,
          type: c.type,
          durationSec: c.durationSec,
          crmActivityId: c.crmActivityId,
          recordFileId: c.recordFileId ?? null,
        };
        if (!c.recordFileId) {
          items.push({ ...base, status: 'no_recording', savedAs: null });
          continue;
        }
        if (saved >= args.maxFiles || Date.now() >= deadline) {
          stopped = true;
          break;
        }
        const prefix = recordingPrefix(c, userName);
        try {
          const r = await downloadOne(ctx, c.recordFileId, dir, (n) => {
            const ext = path.extname(n).slice(0, 8).toLowerCase();
            return `${prefix}${/^\.[a-z0-9]{1,7}$/.test(ext) ? ext : '.mp3'}`;
          });
          const status: Status = r.status;
          items.push({ ...base, status, savedAs: r.savedAs });
          if (status === 'saved') {
            saved++;
            bytes += r.size ?? 0;
            manifest.push([
              c.startDate,
              userName,
              c.type === 'outgoing' ? 'исходящий' : 'входящий',
              c.durationSec,
              c.phoneNumber,
              c.crm ? `${c.crm.entityType} ${String(c.crm.entityId ?? '')}` : null,
              c.crmActivityId,
              r.savedAs,
            ]);
          }
        } catch (e) {
          items.push({ ...base, savedAs: null, ...perFileError(e, ctx) });
        }
      }
      if (stopped) break;
    }
    await appendManifest(
      dir,
      ['дата', 'сотрудник', 'направление', 'длительность, с', 'номер', 'CRM', 'ID дела', 'файл'],
      manifest,
    );
    const complete = all.complete && !stopped;
    const warnings = [...names.warnings];
    if (!complete) warnings.push('Скачаны не все записи: повторите тот же вызов — уже скачанные пропустятся');
    if (items.some((i) => i.status === 'too_large'))
      warnings.push(
        `Записи больше MAX_DOWNLOAD_BYTES=${String(ctx.config.files.maxDownloadBytes)} пропущены`,
      );
    if (items.some((i) => i.status === 'failed'))
      warnings.push('Часть записей портал не отдал (удалены или нет доступа) — см. error');
    // В ответ — только новые и проблемные строки, чтобы не тратить контекст на уже скачанное.
    const shown = items.filter((i) => i.status !== 'exists' && i.status !== 'no_recording');
    return ok(
      {
        folder: parts.join('/'),
        path: dir,
        items: shown,
        calls: calls.length,
        saved,
        existed: items.filter((i) => i.status === 'exists').length,
        withoutRecording: items.filter((i) => i.status === 'no_recording').length,
        failed: items.filter((i) => i.status === 'failed' || i.status === 'too_large').length,
        bytesSaved: bytes,
        complete,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'voximplant.statistic.get',
        apiVersion: 'legacy',
        completeness: complete ? 'complete' : 'partial',
        warnings,
      },
    );
  },
});

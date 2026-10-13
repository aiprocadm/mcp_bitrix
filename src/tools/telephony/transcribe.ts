/**
 * call_transcribe (заявка 2026-10-13 «записи звонков», п. 3–5): перевод записи разговора в текст на этом сервере.
 * faster-whisper запускается отдельным процессом (scripts/transcribe/transcribe.py, python из TRANSCRIBE_PYTHON),
 * запись никуда не отправляется. Стерео-запись (стороны в разных каналах) делится на «собеседник 1 / собеседник 2».
 * Подсказка слов компании — TRANSCRIBE_HOTWORDS и параметр hotwords. Источник записи: дело-звонок CRM, файл Диска
 * или уже скачанный файл в DOWNLOAD_DIR. Текст сохраняется рядом с записью (`<запись>.transcript.json` и `.txt`);
 * повторный вызов берёт готовый текст без нового распознавания. В CRM ничего не пишется: сохранить текст
 * комментарием — отдельным инструментом crm_timeline_comment_add (через подтверждение человека).
 */
import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import {
  checkFolder,
  downloadRoot,
  ensureFolder,
  fileExists,
  safeFileName,
} from '../../files/download-store.js';
import { ok } from '../../mcp/result.js';
import { downloadOne } from '../disk/file-download.js';
import { asText, idOf, idSchema, isObj } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { recordFilesByActivity } from './calls-list.js';

const ENTITY_BY_TYPE_ID: Record<number, string> = { 1: 'lead', 2: 'deal', 3: 'contact', 4: 'company' };

interface Segment {
  start: number;
  end: number;
  speaker: number | null;
  text: string;
}
interface Transcript {
  duration: number;
  channels: number;
  segments: Segment[];
}

const DEFAULT_SCRIPT = fileURLToPath(new URL('../../../scripts/transcribe/transcribe.py', import.meta.url));

function transcribeUnavailable(): AppError {
  return new AppError('FEATURE_UNAVAILABLE', 'Расшифровка записей на сервере выключена', {
    reason: 'TRANSCRIBE_NOT_CONFIGURED',
    nextAction:
      'Администратор сервера ставит faster-whisper (pip install faster-whisper) и задаёт TRANSCRIBE_PYTHON и DOWNLOAD_DIR в .env (только single); ' +
      'либо crm_call_transcript, если на портале включена расшифровка ИИ Битрикс24',
  });
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function transcriptText(t: Transcript): string {
  const out: string[] = [];
  for (const s of t.segments) {
    const who = s.speaker === null ? '' : ` Собеседник ${String(s.speaker)}:`;
    const prev = out.length ? out[out.length - 1] : undefined;
    // Подряд идущие реплики одного собеседника — одной строкой.
    if (
      prev &&
      s.speaker !== null &&
      prev.includes(`Собеседник ${String(s.speaker)}:`) &&
      !prev.includes('\n')
    )
      out[out.length - 1] = `${prev} ${s.text}`;
    else out.push(`[${mmss(s.start)}]${who} ${s.text}`);
  }
  return out.join('\n');
}

function runScript(ctx: ToolContext, audio: string, hotwords: string): Promise<Transcript> {
  const cfg = ctx.config.files.transcribe;
  if (!cfg) throw transcribeUnavailable();
  const args = [cfg.script ?? DEFAULT_SCRIPT, audio, '--model', cfg.model, '--language', cfg.language];
  if (hotwords) args.push('--hotwords', hotwords);
  return new Promise((resolve, reject) => {
    execFile(
      cfg.python,
      args,
      {
        timeout: cfg.timeoutSeconds * 1000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        signal: ctx.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Текст ошибки процесса — в журнал сервера (stderr), в ответ — только код.
          ctx.logger.warn(
            { requestId: ctx.requestId, err: stderr.slice(-2000) },
            'call_transcribe: ошибка распознавания',
          );
          reject(
            new AppError('INTERNAL_ERROR', 'Распознавание речи не удалось', {
              reason: err.killed ? 'TRANSCRIBE_TIMEOUT' : 'TRANSCRIBE_FAILED',
              retryable: false,
              nextAction: err.killed
                ? 'Запись слишком длинная для TRANSCRIBE_TIMEOUT_SECONDS — увеличьте предел или выберите модель меньше'
                : 'Проверьте установку faster-whisper в TRANSCRIBE_PYTHON (журнал сервера) и формат файла',
            }),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!isObj(parsed) || !Array.isArray(parsed['segments'])) throw new Error('shape');
          resolve({
            duration: Number(parsed['duration']) || 0,
            channels: Number(parsed['channels']) || 1,
            segments: parsed['segments'].filter(isObj).map((s) => ({
              start: Number(s['start']) || 0,
              end: Number(s['end']) || 0,
              speaker: s['speaker'] === null ? null : Number(s['speaker']) || null,
              text: asText(s['text']),
            })),
          });
        } catch {
          reject(
            new AppError('INTERNAL_ERROR', 'Программа распознавания вернула неожиданный ответ', {
              reason: 'TRANSCRIBE_FAILED',
            }),
          );
        }
      },
    );
  });
}

/** Путь файла внутри DOWNLOAD_DIR из «папка/имя»; выход за корень → отказ. */
async function fileInRoot(root: string, rel: string): Promise<string> {
  const parts = rel.split('/');
  const name = parts.pop() ?? '';
  if (!name || safeFileName(name, '') !== name)
    throw new AppError('VALIDATION_ERROR', 'file: имя файла с недопустимыми символами', { field: 'file' });
  const dir = parts.length ? await ensureFolder(root, checkFolder(parts.join('/'))) : await realpath(root);
  const full = path.join(dir, name);
  if (!(await fileExists(full)))
    throw new AppError('NOT_FOUND', 'Файл не найден в папке скачиваний', { field: 'file' });
  return full;
}

export const callTranscribeTool = defineTool({
  name: 'call_transcribe',
  module: 'telephony',
  title: 'Расшифровать запись звонка',
  description:
    'Перевести запись разговора в текст на этом сервере (faster-whisper, запись никуда не отправляется): текст с отметками времени, ' +
    'для стерео-записей — по собеседникам («Собеседник 1/2» — каналы записи). Источник: activityId (дело-звонок, crmActivityId из telephony_calls_list), ' +
    'recordFileId (из telephony_calls_list) или file — путь в DOWNLOAD_DIR из calls_recordings_download («звонки/имя.mp3»). ' +
    'Использовать, когда нужно узнать, о чём говорили, что обещали, почему клиент не купил, а crm_call_transcript пуст. ' +
    'Текст сохраняется рядом с записью; повтор не распознаёт заново. Сохранить в CRM — crm_timeline_comment_add (crmTarget из ответа), с подтверждением. ' +
    'Выключено, пока администратор не задал TRANSCRIBE_PYTHON.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      activityId: idSchema.optional().describe('ID дела-звонка CRM'),
      recordFileId: idSchema.optional().describe('ID файла записи на Диске'),
      file: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('Уже скачанная запись: путь внутри DOWNLOAD_DIR, например «звонки/2026-10-13_1530_…mp3»'),
      hotwords: z
        .string()
        .max(500)
        .optional()
        .describe('Дополнительные слова для распознавания через запятую (фамилии, названия)'),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(100_000)
        .default(20_000)
        .describe('Предел длины текста в ответе'),
    })
    .strict()
    .refine((a) => [a.activityId, a.recordFileId, a.file].filter((x) => x !== undefined).length === 1, {
      message: 'укажите ровно одно: activityId, recordFileId или file',
      path: ['activityId'],
    }),
  outputDataSchema: z.object({
    file: z.string(),
    durationSec: z.number(),
    speakers: z.number(),
    text: z.string(),
    truncated: z.boolean(),
    transcriptFile: z.string(),
    cached: z.boolean(),
    crmTarget: z.object({ entityType: z.string(), recordId: z.number() }).nullable(),
  }),
  handler: async (args, ctx) => {
    const root = downloadRoot(ctx.config.files.downloadDir);
    if (!ctx.config.files.transcribe) throw transcribeUnavailable();
    let audio: string;
    let crmTarget: { entityType: string; recordId: number } | null = null;
    if (args.file) audio = await fileInRoot(root, args.file);
    else {
      let fileId = args.recordFileId;
      if (args.activityId !== undefined) {
        const r = await ctx.bitrix.call(
          'legacy',
          'crm.activity.get',
          { id: args.activityId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (isObj(r.result)) {
          const typeId = idOf(r.result['OWNER_TYPE_ID']);
          const ownerId = idOf(r.result['OWNER_ID']);
          const entityType = typeId !== undefined ? ENTITY_BY_TYPE_ID[typeId] : undefined;
          if (entityType && ownerId !== undefined) crmTarget = { entityType, recordId: ownerId };
        }
        fileId = (await recordFilesByActivity(ctx, [args.activityId])).get(args.activityId);
        if (fileId === undefined)
          throw new AppError('NOT_FOUND', 'У дела нет файла записи разговора', {
            nextAction:
              'Проверьте hasRecording в telephony_calls_list; запись могла не сохраниться на портале',
          });
      }
      const dir = await ensureFolder(root, ['звонки']);
      const id = fileId ?? 0;
      const r = await downloadOne(ctx, id, dir, (n) => `${String(id)}_${safeFileName(n, 'record.mp3')}`);
      if (r.savedAs === null)
        throw new AppError('FILE_TOO_LARGE', 'Запись больше MAX_DOWNLOAD_BYTES', {
          nextAction: 'Увеличьте MAX_DOWNLOAD_BYTES (до 100 МБ)',
        });
      audio = path.join(dir, r.savedAs);
    }
    const jsonFile = `${audio}.transcript.json`;
    let transcript: Transcript;
    let cached = false;
    if (await fileExists(jsonFile)) {
      transcript = JSON.parse(await readFile(jsonFile, 'utf8')) as Transcript;
      cached = true;
    } else {
      const hotwords = [ctx.config.files.transcribe.hotwords, args.hotwords].filter(Boolean).join(', ');
      transcript = await runScript(ctx, audio, hotwords);
      await writeFile(jsonFile, JSON.stringify(transcript), { mode: 0o600 });
      await writeFile(`${audio}.txt`, transcriptText(transcript) + '\n', { mode: 0o600 });
    }
    const text = transcriptText(transcript);
    const truncated = text.length > args.maxChars;
    const warnings: string[] = [];
    if (transcript.channels === 2)
      warnings.push(
        'Собеседник 1 — левый канал записи, 2 — правый; кто из них менеджер, видно по смыслу разговора',
      );
    if (truncated)
      warnings.push(`Текст обрезан до ${String(args.maxChars)} символов; полностью — в файле ${audio}.txt`);
    if (crmTarget && text.length > 10_000)
      warnings.push('Для комментария в CRM текст длиннее 10000 символов — сохраните сокращённую версию');
    return ok(
      {
        file: path.relative(await realpath(root), audio),
        durationSec: transcript.duration,
        speakers: transcript.channels === 2 ? 2 : 1,
        text: truncated ? text.slice(0, args.maxChars) : text,
        truncated,
        transcriptFile: `${audio}.txt`,
        cached,
        crmTarget,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.activity.get',
        apiVersion: 'legacy',
        completeness: truncated ? 'partial' : 'complete',
        warnings,
      },
    );
  },
});

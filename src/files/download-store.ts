/**
 * Сохранение скачанных с портала файлов на диск сервера (DOWNLOAD_DIR, только single).
 * Всё пишется строго внутри корня: подпапка — до 3 частей из безопасных символов, без «..»;
 * после создания папки корень и папка сверяются через realpath (символическая ссылка наружу → отказ).
 * Файл пишется во временный `.part` с флагом wx и переименовывается: прерванное скачивание не оставляет
 * «готового» обрезка. Существующий файл не перезаписывается — повторный запуск его пропускает.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors/app-error.js';

const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const MAX_NAME = 150;

/** Корень скачиваний или FEATURE_UNAVAILABLE, если DOWNLOAD_DIR не задан. */
export function downloadRoot(dir: string | undefined): string {
  if (!dir) {
    throw new AppError('FEATURE_UNAVAILABLE', 'Скачивание файлов на сервер выключено', {
      reason: 'DOWNLOAD_DIR_NOT_SET',
      nextAction:
        'Администратор сервера задаёт DOWNLOAD_DIR в .env (только DEPLOYMENT_MODE=single); прочитать текст можно disk_file_read',
    });
  }
  return dir;
}

/** Проверка подпапки, заданной пользователем: «a», «a/b», до 3 частей, без «..», «/» в начале и спецсимволов. */
export function checkFolder(folder: string): string[] {
  const parts = folder.split('/');
  if (parts.length > 3 || parts.some((p) => !SEGMENT_RE.test(p) || p.endsWith('.') || p.includes('..'))) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Подпапка: до 3 частей через «/», буквы, цифры, пробел, . _ ( ) -',
      {
        field: 'folder',
      },
    );
  }
  return parts;
}

/** Имя файла с портала → безопасное имя на диске: без путей и спецсимволов, до 150 символов с расширением. */
export function safeFileName(name: string, fallback: string): string {
  let n = name
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '_')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n) n = fallback;
  if (n.length <= MAX_NAME) return n;
  const ext = path.extname(n).slice(0, 16);
  return n.slice(0, MAX_NAME - ext.length) + ext;
}

/** Создаёт подпапку внутри корня и возвращает её настоящий путь; выход за корень → отказ. */
export async function ensureFolder(root: string, parts: string[]): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const dir = path.join(realRoot, ...parts);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const realDir = await realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new AppError('VALIDATION_ERROR', 'Подпапка указывает за пределы папки скачиваний', {
      field: 'folder',
    });
  }
  return realDir;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Атомарная запись нового файла; если файл уже есть — false и ничего не меняется. */
export async function saveNewFile(file: string, bytes: Uint8Array): Promise<boolean> {
  if (await fileExists(file)) return false;
  const tmp = `${file}.${randomUUID().slice(0, 8)}.part`;
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    if (await fileExists(file)) return false;
    await rename(tmp, file);
    return true;
  } finally {
    await rm(tmp, { force: true });
  }
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  // Защита от формул при открытии в Excel: ячейка, начинающаяся с = + - @, получает апостроф.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Дописывает строки в опись папки (CSV через «;», UTF-8 с BOM — открывается в Excel). */
export async function appendManifest(
  dir: string,
  header: string[],
  rows: (string | number | null)[][],
): Promise<void> {
  if (rows.length === 0) return;
  const file = path.join(dir, '_список-файлов.csv');
  const exists = await fileExists(file);
  const lines = rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  await appendFile(file, (exists ? '' : '﻿' + header.join(';') + '\r\n') + lines, { mode: 0o600 });
}

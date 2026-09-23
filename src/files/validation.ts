/**
 * Проверка файлов до загрузки (ТЗ §8.5): allowlist расширений, соответствие сигнатуры,
 * запрет служебных файлов, лимит размера. Архивы не распаковываем, макросы не выполняем.
 */
import path from 'node:path';
import { AppError } from '../errors/app-error.js';

export const ALLOWED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
]);

/** Имена, которые нельзя ставить в очередь ни при каких условиях: секреты и хранилища. */
const FORBIDDEN_NAME = /(^\.env($|\.)|\.key$|\.pem$|\.sqlite(-wal|-shm)?$|^master\.key$|token)/i;

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- намеренно вычищаем управляющие символы из имени
  const controlChars = /[\u0000-\u001f\u007f]/g;
  const base = path.basename(name).replace(controlChars, '').trim();
  if (!base || base === '.' || base === '..') {
    throw new AppError('UNSAFE_FILE', 'Недопустимое имя файла', { field: 'fileName' });
  }
  if (base.length > 200)
    throw new AppError('UNSAFE_FILE', 'Имя файла длиннее 200 символов', { field: 'fileName' });
  if (FORBIDDEN_NAME.test(base)) {
    throw new AppError('UNSAFE_FILE', 'Файлы конфигурации, ключей и хранилищ запрещены к загрузке', {
      field: 'fileName',
    });
  }
  return base;
}

export function extensionOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(
      'UNSAFE_FILE',
      `Расширение не входит в allowlist: ${[...ALLOWED_EXTENSIONS.keys()].join(', ')}`,
      {
        field: 'fileName',
      },
    );
  }
  return ext;
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  return bytes.every((b, i) => buf[i] === b);
}

/** Сигнатура содержимого должна соответствовать расширению; иначе UNSAFE_FILE. Возвращает MIME. */
export function detectMime(buf: Buffer, ext: string): string {
  const expected = ALLOWED_EXTENSIONS.get(ext);
  if (!expected) throw new AppError('UNSAFE_FILE', 'Неизвестное расширение', { field: 'fileName' });
  let ok: boolean;
  switch (ext) {
    case 'pdf':
      ok = buf.subarray(0, 5).toString('latin1') === '%PDF-';
      break;
    case 'png':
      ok = startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      break;
    case 'jpg':
    case 'jpeg':
      ok = startsWith(buf, [0xff, 0xd8, 0xff]);
      break;
    case 'docx':
    case 'xlsx':
      // OOXML — zip-контейнер; содержимое не распаковываем, проверяем только контейнер и отсутствие макросов по расширению.
      ok = startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
      break;
    case 'txt':
    case 'md':
    case 'csv':
      ok = isPlainText(buf);
      break;
    default:
      ok = false;
  }
  if (!ok) {
    throw new AppError('UNSAFE_FILE', `Содержимое файла не соответствует расширению .${ext}`, {
      field: 'fileName',
    });
  }
  return expected;
}

function isPlainText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function assertSize(size: number, maxBytes: number, what: string): void {
  if (size <= 0) throw new AppError('UNSAFE_FILE', `${what}: пустой файл`, { field: 'file' });
  if (size > maxBytes) {
    throw new AppError('FILE_TOO_LARGE', `${what}: ${size} байт превышает лимит ${maxBytes}`, {
      field: 'file',
    });
  }
}

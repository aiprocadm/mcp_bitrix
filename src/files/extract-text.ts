/**
 * Извлечение текста из файлов портала для чтения ИИ (счета, выписки, акты): txt/csv/tsv/md/json/xml/log, html,
 * pdf (unpdf — pdf.js без нативных зависимостей), docx и xlsx (fflate — распаковка zip в памяти).
 * Защита: распаковываются только нужные части архива, каждая не больше MAX_PART_BYTES (против zip-бомб);
 * текстовые файлы — UTF-8, при ошибке декодирования — Windows-1251 (выгрузки 1С).
 */
import { strFromU8, unzipSync } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import { AppError } from '../errors/app-error.js';
import { htmlToText } from '../tools/feed/sanitize.js';

export const READABLE_EXTENSIONS = [
  'txt',
  'csv',
  'tsv',
  'md',
  'json',
  'xml',
  'log',
  'html',
  'htm',
  'pdf',
  'docx',
  'xlsx',
] as const;
export type ReadableFormat = 'text' | 'html' | 'pdf' | 'docx' | 'xlsx';

/** Предел распакованного размера одной части docx/xlsx. */
const MAX_PART_BYTES = 20 * 1024 * 1024;
/** Предел строк одного листа xlsx. */
const MAX_SHEET_ROWS = 5000;

export function formatOf(fileName: string): ReadableFormat | undefined {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'log'].includes(ext)) return 'text';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx') return ext;
  return undefined;
}

export function decodeText(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1251').decode(body);
  }
}

const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

function unzipParts(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        if (f.originalSize > MAX_PART_BYTES) {
          throw new AppError('FILE_TOO_LARGE', `Часть архива ${f.name} после распаковки больше 20 МБ`);
        }
        return true;
      },
    });
  } catch (e) {
    if (AppError.is(e)) throw e;
    throw new AppError('VALIDATION_ERROR', 'Файл повреждён или не является документом Office', {
      reason: 'UNREADABLE_FILE',
    });
  }
}

/** docx: абзацы word/document.xml → строки; табуляции и разрывы сохраняются. */
export function docxToText(bytes: Uint8Array): string {
  const parts = unzipParts(bytes, (n) => n === 'word/document.xml');
  const xml = parts['word/document.xml'];
  if (!xml)
    throw new AppError('VALIDATION_ERROR', 'В docx нет word/document.xml', { reason: 'UNREADABLE_FILE' });
  return decodeXmlEntities(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Индекс столбца из ссылки ячейки «AB12» → 27. */
const colIndex = (ref: string): number =>
  (/^[A-Z]+/.exec(ref)?.[0] ?? 'A').split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** xlsx: каждый лист — «## Имя листа» и строки, ячейки через табуляцию (общие строки и числа). */
export function xlsxToText(bytes: Uint8Array): { text: string; truncatedRows: boolean } {
  const parts = unzipParts(
    bytes,
    (n) =>
      n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const shared: string[] = [];
  const ss = parts['xl/sharedStrings.xml'];
  if (ss) {
    for (const si of strFromU8(ss).match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(
        decodeXmlEntities(
          (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''),
        ),
      );
    }
  }
  const names = parts['xl/workbook.xml']
    ? [...strFromU8(parts['xl/workbook.xml']).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
        decodeXmlEntities(m[1] ?? ''),
      )
    : [];
  const sheets = Object.keys(parts)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1]) - Number(/(\d+)/.exec(b)?.[1]));
  let truncatedRows = false;
  const out: string[] = [];
  sheets.forEach((name, i) => {
    const xml = strFromU8(parts[name] ?? new Uint8Array());
    out.push(`## ${names[i] ?? `Лист ${String(i + 1)}`}`);
    const rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
    if (rows.length > MAX_SHEET_ROWS) truncatedRows = true;
    for (const row of rows.slice(0, MAX_SHEET_ROWS)) {
      const cells: string[] = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = /r="([A-Z]+)\d+"/.exec(c)?.[1] ?? '';
        const type = /t="([a-zA-Z]+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c)?.[1];
        const value =
          type === 's' && v !== undefined ? (shared[Number(v)] ?? '') : decodeXmlEntities(inline ?? v ?? '');
        cells[ref ? colIndex(ref) : cells.length] = value;
      }
      const line = Array.from(cells, (x) => x ?? '')
        .join('\t')
        .replace(/\t+$/, '');
      if (line !== '') out.push(line);
    }
    out.push('');
  });
  return { text: out.join('\n').trim(), truncatedRows };
}

export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return {
      text: pages.map((p, i) => `--- страница ${String(i + 1)} ---\n${p.trim()}`).join('\n\n'),
      pages: totalPages,
    };
  } catch {
    throw new AppError('VALIDATION_ERROR', 'PDF не читается (повреждён или защищён паролем)', {
      reason: 'UNREADABLE_FILE',
    });
  }
}

export interface ExtractedText {
  format: ReadableFormat;
  text: string;
  pages?: number;
  warnings: string[];
}

export async function extractFileText(fileName: string, bytes: Uint8Array): Promise<ExtractedText> {
  const format = formatOf(fileName);
  if (!format) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Формат файла не поддерживается для чтения: ${fileName.split('.').pop() ?? ''}`,
      {
        reason: 'UNSUPPORTED_FILE_TYPE',
        nextAction: `Поддерживаются: ${READABLE_EXTENSIONS.join(', ')}`,
      },
    );
  }
  switch (format) {
    case 'text':
      return { format, text: decodeText(bytes), warnings: [] };
    case 'html':
      return { format, text: htmlToText(decodeText(bytes)), warnings: [] };
    case 'docx':
      return { format, text: docxToText(bytes), warnings: [] };
    case 'xlsx': {
      const x = xlsxToText(bytes);
      return {
        format,
        text: x.text,
        warnings: x.truncatedRows ? [`В листе больше ${String(MAX_SHEET_ROWS)} строк: показаны первые`] : [],
      };
    }
    case 'pdf': {
      const p = await pdfToText(bytes);
      const warnings =
        p.text.replace(/--- страница \d+ ---/g, '').trim() === ''
          ? ['В PDF нет текстового слоя (скан): текст не извлечён, распознавание изображений не выполняется']
          : [];
      return { format, text: p.text, pages: p.pages, warnings };
    }
  }
}

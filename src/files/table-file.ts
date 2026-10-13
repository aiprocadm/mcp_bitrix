/**
 * Табличные файлы выгрузок в DOWNLOAD_DIR (заявка 2026-10-13, п. 1): CSV (через «;», UTF-8 с BOM — открывается
 * в Excel) или XLSX (один лист, строки как текст/числа). Пока выгрузка идёт по частям, строки копятся
 * в черновике `<имя>.part.jsonl` рядом с итоговым файлом; на последнем вызове черновик превращается в файл
 * и удаляется. Существующий файл не перезаписывается: к имени добавляется номер.
 */
import { appendFile, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { AppError } from '../errors/app-error.js';
import { csvCell, fileExists, safeFileName } from './download-store.js';

export type Cell = string | number | null;
export type TableFormat = 'csv' | 'xlsx';

/** Свободное имя итогового файла в папке: «имя.csv», «имя (2).csv»… */
export async function freeFileName(dir: string, base: string, ext: TableFormat | 'txt'): Promise<string> {
  const stem = safeFileName(base, 'выгрузка').replace(/\.(csv|xlsx|txt)$/i, '');
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${stem}.${ext}` : `${stem} (${String(i)}).${ext}`;
    if (
      !(await fileExists(path.join(dir, name))) &&
      !(await fileExists(path.join(dir, `${name}.part.jsonl`)))
    )
      return name;
  }
  throw new AppError('VALIDATION_ERROR', 'Не удалось подобрать свободное имя файла', { field: 'fileName' });
}

export const partPath = (dir: string, name: string) => path.join(dir, `${name}.part.jsonl`);

/** Дописывает строки в черновик выгрузки; возвращает число записанных байт. */
export async function appendPart(dir: string, name: string, rows: readonly Cell[][]): Promise<number> {
  if (rows.length === 0) return 0;
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(partPath(dir, name), text, { mode: 0o600 });
  return Buffer.byteLength(text);
}

/**
 * Возвращает черновик к длине, записанной в курсоре: если прошлый вызов упал после части записей,
 * повтор с тем же курсором не задвоит строки.
 */
export async function rewindPart(dir: string, name: string, bytes: number): Promise<void> {
  const file = partPath(dir, name);
  if (await fileExists(file)) await truncate(file, bytes);
  else if (bytes > 0)
    throw new AppError(
      'VALIDATION_ERROR',
      'Черновик выгрузки не найден: начните выгрузку заново без cursor',
      {
        field: 'cursor',
      },
    );
}

async function readPart(dir: string, name: string): Promise<Cell[][]> {
  const file = partPath(dir, name);
  if (!(await fileExists(file))) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Cell[]);
}

/** Первые строки черновика (для проверки в ответе). */
export async function previewPart(dir: string, name: string, n: number): Promise<Cell[][]> {
  return (await readPart(dir, name)).slice(0, n);
}

/** Черновик → итоговый файл; возвращает путь и число строк. Черновик удаляется. */
export async function finalizeTable(
  dir: string,
  name: string,
  header: readonly string[],
  format: TableFormat,
): Promise<{ path: string; rows: number; bytes: number }> {
  const rows = await readPart(dir, name);
  const bytes = format === 'csv' ? renderCsv(header, rows) : renderXlsx(header, rows);
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, target);
  await rm(partPath(dir, name), { force: true });
  return { path: target, rows: rows.length, bytes: bytes.byteLength };
}

export function renderCsv(header: readonly string[], rows: readonly Cell[][]): Uint8Array {
  const lines = [header.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))];
  return strToU8('\uFEFF' + lines.join('\r\n') + '\r\n');
}

// ---------- XLSX ----------

const xmlEscape = (s: string) =>
  s
    // Символы, недопустимые в XML 1.0, Excel не откроет.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function columnRef(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(value: Cell, ref: string, bold = false): string {
  if (value === null || value === '') return '';
  const style = bold ? ' s="1"' : '';
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${ref}"${style}><v>${String(value)}</v></c>`;
  // Текст до 32767 символов — предел ячейки Excel.
  const text = xmlEscape(String(value).slice(0, 32_767));
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
}

export function renderXlsx(header: readonly string[], rows: readonly Cell[][]): Uint8Array {
  const sheetRows = [header as Cell[], ...rows].map((r, i) => {
    const cells = r.map((v, j) => cellXml(v, `${columnRef(j)}${String(i + 1)}`, i === 0)).join('');
    return `<row r="${String(i + 1)}">${cells}</row>`;
  });
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    (header.length
      ? `<autoFilter ref="A1:${columnRef(header.length - 1)}${String(rows.length + 1)}"/>`
      : '') +
    '</worksheet>';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Выгрузка" sheetId="1" r:id="rId1"/></sheets>' +
        (header.length
          ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Выгрузка'!$A$1:$${columnRef(header.length - 1)}$${String(rows.length + 1)}</definedName></definedNames>`
          : '') +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return zipSync(files, { level: 6 });
}

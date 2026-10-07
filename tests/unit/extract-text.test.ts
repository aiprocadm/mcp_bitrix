/**
 * Извлечение текста из файлов портала: docx/xlsx (собираются в тесте через fflate), минимальный PDF (собирается
 * вручную с таблицей xref), cp1251 (выгрузки 1С), защита от zip-бомб, неподдерживаемые форматы.
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import {
  decodeText,
  docxToText,
  extractFileText,
  formatOf,
  xlsxToText,
} from '../../src/files/extract-text.js';
import { makeDocx, makePdf, makeXlsx } from '../helpers/office-fixtures.js';

describe('extract-text', () => {
  it('формат по расширению; неподдерживаемый — UNSUPPORTED_FILE_TYPE', async () => {
    expect(formatOf('Выписка.CSV')).toBe('text');
    expect(formatOf('акт.pdf')).toBe('pdf');
    expect(formatOf('фото.jpg')).toBeUndefined();
    await expect(extractFileText('фото.jpg', new Uint8Array())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'UNSUPPORTED_FILE_TYPE' },
    });
  });

  it('текст: UTF-8 с BOM и Windows-1251 (выгрузка 1С)', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('Оплата')]))).toBe('Оплата');
    // «Счёт» в cp1251
    expect(decodeText(new Uint8Array([0xd1, 0xf7, 0xb8, 0xf2]))).toBe('Счёт');
  });

  it('docx: абзацы в строки, сущности XML раскрыты', () => {
    expect(docxToText(makeDocx(['Акт № 15', 'Сумма: 16 320 ₽ & НДС']))).toBe(
      'Акт № 15\nСумма: 16 320 ₽ & НДС',
    );
  });

  it('xlsx: листы с именами, общие строки (в т. ч. из нескольких фрагментов), пропуски столбцов, inline-строки', () => {
    expect(xlsxToText(makeXlsx()).text).toBe(
      '## Счета\nНомер\tСумма\nСчёт 15\t\t16320.5\n\n## Итог\nИтого & всё',
    );
  });

  it('pdf: текст по страницам', async () => {
    const r = await extractFileText('invoice.pdf', makePdf('Invoice 15 paid 16320'));
    expect(r.pages).toBe(1);
    expect(r.text).toContain('--- страница 1 ---');
    expect(r.text).toContain('Invoice 15 paid 16320');
    expect(r.warnings).toEqual([]);
  });

  it('повреждённые docx и pdf — UNREADABLE_FILE, не падение', async () => {
    await expect(extractFileText('a.docx', strToU8('не zip'))).rejects.toMatchObject({
      details: { reason: 'UNREADABLE_FILE' },
    });
    await expect(extractFileText('a.pdf', strToU8('%PDF-1.4 мусор'))).rejects.toMatchObject({
      details: { reason: 'UNREADABLE_FILE' },
    });
  });

  it('zip-бомба: часть больше 20 МБ после распаковки — FILE_TOO_LARGE до распаковки', () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(21 * 1024 * 1024) }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    let err: unknown;
    try {
      docxToText(bomb);
    } catch (e) {
      err = e;
    }
    expect(AppError.is(err) && err.code).toBe('FILE_TOO_LARGE');
  });
});

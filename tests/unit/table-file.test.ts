/** Табличные файлы выгрузок (заявка 2026-10-13): XLSX читается, формулы и спецсимволы — текст; CSV защищён от формул. */
import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { xlsxToText } from '../../src/files/extract-text.js';
import { columnRef, renderCsv, renderXlsx } from '../../src/files/table-file.js';
import { dateKey } from '../../src/tools/crm/count.js';
import { passesLocal, splitNotContains } from '../../src/tools/crm/bulk.js';
import { channelOf } from '../../src/tools/openlines/dialogs.js';
import { transcriptText } from '../../src/tools/telephony/transcribe.js';

describe('table-file', () => {
  it('XLSX: спецсимволы и формулы остаются текстом, числа — числами', () => {
    const text = xlsxToText(
      renderXlsx(
        ['A', 'B'],
        [
          ['=1+1', 5],
          ['<b>&"', null],
        ],
      ),
    ).text;
    expect(text).toContain('=1+1');
    expect(text).toContain('<b>&"');
    expect(text).toContain('5');
  });
  it('CSV: BOM, «;», формула экранируется апострофом', () => {
    const bytes = renderCsv(['a', 'b'], [['=SUM(A1)', 'x;y']]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = strFromU8(bytes);
    expect(csv.startsWith('a;b\r\n')).toBe(true);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('"x;y"');
  });
  it('буквы колонок', () => {
    expect([0, 25, 26, 701, 702].map(columnRef)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});

describe('подсчёты и фильтры', () => {
  it('ключ даты: день, ISO-неделя, месяц, год', () => {
    const d = '2026-01-01T10:00:00+03:00';
    expect(dateKey(d, 'day')).toBe('2026-01-01');
    expect(dateKey(d, 'week')).toBe('2026-W01');
    expect(dateKey('2027-01-01T00:00:00+03:00', 'week')).toBe('2026-W53');
    expect(dateKey(d, 'month')).toBe('2026-01');
    expect(dateKey(d, 'year')).toBe('2026');
    expect(dateKey('', 'month')).toBe('');
  });
  it('«!%» отделяется от фильтра портала и проверяется без учёта регистра, в т. ч. по мультиполю', () => {
    const { upstream, local } = splitNotContains({ '!%TITLE': 'ТЕСТ', '%TITLE': 'ооо', '!%EMAIL': ['spam'] });
    expect(upstream).toEqual({ '%TITLE': 'ооо' });
    expect(passesLocal({ TITLE: 'ООО Тестовая' }, local)).toBe(false);
    expect(passesLocal({ TITLE: 'ООО Ромашка', EMAIL: [{ VALUE: 'a@spam.example' }] }, local)).toBe(false);
    expect(passesLocal({ TITLE: 'ООО Ромашка', EMAIL: [{ VALUE: 'a@b.example' }] }, local)).toBe(true);
  });
});

describe('открытые линии и расшифровка', () => {
  it('канал по ID коннектора', () => {
    expect(channelOf('wz_whatsapp_abc')).toBe('WhatsApp');
    expect(channelOf('telegrambot')).toBe('Telegram');
    expect(channelOf('wz_max_1')).toBe('Max');
    expect(channelOf('livechat')).toBe('Онлайн-чат сайта');
    expect(channelOf('')).toBe('неизвестно');
  });
  it('текст расшифровки: время, собеседники, склейка подряд идущих реплик', () => {
    const text = transcriptText({
      duration: 30,
      channels: 2,
      segments: [
        { start: 0.5, end: 2, speaker: 1, text: 'Добрый день.' },
        { start: 2.5, end: 4, speaker: 1, text: 'Компания слушает.' },
        { start: 65, end: 70, speaker: 2, text: 'Здравствуйте.' },
      ],
    });
    expect(text).toBe(
      '[00:00] Собеседник 1: Добрый день. Компания слушает.\n[01:05] Собеседник 2: Здравствуйте.',
    );
  });
});

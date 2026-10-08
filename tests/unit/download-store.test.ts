/** Имена и подпапки скачиваемых файлов: ничего не выходит за DOWNLOAD_DIR. */
import { describe, expect, it } from 'vitest';
import { checkFolder, safeFileName } from '../../src/files/download-store.js';

describe('safeFileName', () => {
  it('убирает пути и спецсимволы, режет длину с сохранением расширения', () => {
    expect(safeFileName('../../etc/passwd', 'f')).toBe('_.._etc_passwd');
    expect(safeFileName('a\u0000b:c?.txt', 'f')).toBe('a_b_c_.txt');
    expect(safeFileName('...', 'f')).toBe('f');
    const long = safeFileName(`${'я'.repeat(300)}.pdf`, 'f');
    expect(long).toHaveLength(150);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('checkFolder', () => {
  it('до трёх безопасных частей; «..», абсолютный путь, скрытая папка и пустая часть — отказ', () => {
    expect(checkFolder('переписка/Иванов И.И. (2026)')).toEqual(['переписка', 'Иванов И.И. (2026)']);
    for (const bad of ['..', 'a/..', '/abs', '.hidden', 'a//b', 'a/b/c/d', 'a\\b', 'a.', 'x..y'])
      expect(() => checkFolder(bad)).toThrow();
  });
});

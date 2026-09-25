/** Адаптер PostgreSQL: `?` → `$n` только вне строк и идентификаторов в кавычках. */
import { describe, expect, it } from 'vitest';
import { toPgPlaceholders } from '../../src/storage/postgres-db.js';

describe('toPgPlaceholders', () => {
  it('нумерует параметры по порядку', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)',
    );
  });
  it('не трогает ? в строковых литералах и идентификаторах', () => {
    expect(toPgPlaceholders("SELECT '?', \"col?\" FROM t WHERE x = ? AND y = 'it''s ?'")).toBe(
      "SELECT '?', \"col?\" FROM t WHERE x = $1 AND y = 'it''s ?'",
    );
  });
});

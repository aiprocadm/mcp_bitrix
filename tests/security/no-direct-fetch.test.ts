/** ТЗ §15.1 п.7: прямой fetch из инструментов запрещён — единственное место сетевого вызова: bitrix/client.ts. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_ENV } from '../helpers/app.js';

const SRC = path.resolve(MOCK_ENV, '..', '..', '..', 'src');
const ALLOWED = new Set([
  'bitrix/client.ts',
  'app/container.ts',
  'cli/mcp-smoke.ts',
  // S4: загрузка Client ID Metadata Document (https, публичные адреса, без редиректов, лимит размера).
  'saas/oauth/cimd-fetch.ts',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('архитектурное правило: нет прямого fetch', () => {
  it('fetch( встречается только в разрешённых файлах', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replaceAll('\\', '/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      // исключаем комментарии и типы: ищем именно вызов
      if (/(^|[^A-Za-z_.])fetch\(/m.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

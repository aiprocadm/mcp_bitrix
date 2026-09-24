/**
 * npm run backup -- --out <файл>            зашифрованная копия SQLite + политик (ключ и .env — отдельно)
 * npm run backup -- --restore <файл> --to <новая папка>   расшифровать и проверить, не трогая живую базу
 * ТЗ §8.6, §17.7, T45. Перед копией на VPS остановите новые записи (READ_ONLY_MODE=true или стоп сервера).
 */
import path from 'node:path';
import { ensureMasterKey } from '../security/crypto.js';
import { createBackup, restoreBackup } from '../ops/backup.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

function main(): void {
  const args = cliArgs(process.argv.slice(2), {
    out: { kind: 'string' },
    restore: { kind: 'string' },
    to: { kind: 'string' },
  });
  const config = cliConfig(args);
  const key = ensureMasterKey(config.storage.secretsKeyFile, { create: false }).key;
  try {
    if (args.values['restore']) {
      const to = args.values['to'];
      if (!to) fail(new Error('Укажите --to <новая папка для восстановления>'));
      const r = restoreBackup(key, path.resolve(args.values['restore']), path.resolve(to));
      out(`Копия от ${r.createdAt} (сервер ${r.serverVersion}) расшифрована в ${r.dir}`);
      out(`База: ${r.sqliteFile} (${r.sqliteBytes} байт), политики: ${r.policies.join(', ') || 'нет'}`);
      const pending = Object.entries(r.pendingOperations);
      out(
        pending.length
          ? `Незавершённые операции в копии: ${pending.map(([s, n]) => `${s}=${n}`).join(', ')} — автоматически НЕ исполняются`
          : 'Незавершённых операций в копии нет',
      );
      out(
        'Дальше: остановите сервер, замените data/mcp.sqlite и policies/*.json файлами из этой папки, запустите doctor.',
      );
      return;
    }
    const outFile = path.resolve(
      args.values['out'] ??
        path.join(
          config.storage.dataDir,
          'backups',
          `mcp-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.enc`,
        ),
    );
    const s = createBackup(config, key, outFile);
    out(`Копия создана: ${s.file}`);
    out(
      `База ${s.sqliteBytes} байт (sha256 ${s.sqliteSha256.slice(0, 16)}…), политики: ${s.policies.join(', ') || 'нет'}, зашифровано ${s.encryptedBytes} символов`,
    );
    out(
      'Ключ шифрования (SECRETS_KEY_FILE) и .env в копию не входят — сохраните их отдельно и в другом месте.',
    );
  } catch (e) {
    fail(e, 1);
  }
}

main();

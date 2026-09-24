/**
 * Резервная копия и восстановление (ТЗ §8.6, §17.7, T45).
 * Снимок: согласованная копия SQLite (VACUUM INTO) + рабочие политики, всё в одном файле,
 * зашифрованном AES-256-GCM ключом из SECRETS_KEY_FILE. Ключ в копию НЕ входит и хранится отдельно —
 * без него копия бесполезна. `.env` (секрет вебхука) в копию тоже не включается: его восстанавливают
 * из менеджера паролей владельца, а не из архива.
 * Восстановление пишет в ОТДЕЛЬНУЮ папку, не поверх живой базы: замену делает человек при остановленном сервере.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { SecretBox } from '../security/crypto.js';
import { SERVER_VERSION } from '../version.js';

const FORMAT = 'bitrix24-mcp-backup';
const FORMAT_VERSION = 1;
const AAD = `${FORMAT}:${FORMAT_VERSION}`;

interface Bundle {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  createdAt: string;
  serverVersion: string;
  sqlite: { base64: string; sha256: string; bytes: number };
  policies: Record<string, string>;
  note: string;
}

export interface BackupSummary {
  file: string;
  createdAt: string;
  sqliteBytes: number;
  sqliteSha256: string;
  policies: string[];
  encryptedBytes: number;
}

function assertSafePath(p: string): void {
  if (p.includes("'") || p.includes('\0'))
    throw new AppError('VALIDATION_ERROR', 'Недопустимый путь', { field: 'path' });
}

/** Согласованный снимок SQLite независимо от WAL: VACUUM INTO во временный файл. */
function snapshotSqlite(databasePath: string, tmpDir: string): Buffer {
  if (!existsSync(databasePath)) {
    throw new AppError('CONFIG_INVALID', 'База данных не найдена; нечего копировать', {
      field: 'DATABASE_URL',
    });
  }
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const snap = path.join(tmpDir, `snapshot-${process.pid}-${Date.now()}.sqlite`);
  assertSafePath(snap);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${snap}'`);
  } finally {
    db.close();
  }
  try {
    return readFileSync(snap);
  } finally {
    rmSync(snap, { force: true });
  }
}

export function createBackup(config: AppConfig, key: Buffer, outFile: string): BackupSummary {
  const box = new SecretBox(key);
  const sqlite = snapshotSqlite(config.storage.databasePath, path.join(config.storage.dataDir, 'tmp'));
  const policies: Record<string, string> = {};
  for (const [name, file] of Object.entries({
    'methods.json': config.policy.methodPolicyFile,
    'access.json': config.policy.accessPolicyFile,
    'output.json': config.policy.outputPolicyFile,
  })) {
    if (existsSync(file)) policies[name] = readFileSync(file, 'utf8');
  }
  const bundle: Bundle = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    sqlite: {
      base64: sqlite.toString('base64'),
      sha256: createHash('sha256').update(sqlite).digest('hex'),
      bytes: sqlite.length,
    },
    policies,
    note: 'Ключ шифрования и .env в копию не входят намеренно: храните их отдельно.',
  };
  const encrypted = box.encrypt(JSON.stringify(bundle), AAD);
  mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writeFileSync(outFile, `${FORMAT}/${FORMAT_VERSION}\n${encrypted}\n`, { mode: 0o600, flag: 'wx' });
  return {
    file: outFile,
    createdAt: bundle.createdAt,
    sqliteBytes: sqlite.length,
    sqliteSha256: bundle.sqlite.sha256,
    policies: Object.keys(policies),
    encryptedBytes: encrypted.length,
  };
}

export interface RestoreSummary {
  dir: string;
  createdAt: string;
  serverVersion: string;
  sqliteFile: string;
  sqliteBytes: number;
  policies: string[];
  /** Сколько операций в копии ждут решения/сверки — они НЕ исполняются автоматически (T45). */
  pendingOperations: Record<string, number>;
}

/** Расшифровывает копию в отдельную папку и проверяет целостность и читаемость базы. */
export function restoreBackup(key: Buffer, backupFile: string, targetDir: string): RestoreSummary {
  if (!existsSync(backupFile))
    throw new AppError('NOT_FOUND', 'Файл резервной копии не найден', { field: 'file' });
  const [header, payload] = readFileSync(backupFile, 'utf8').split('\n');
  if (header !== `${FORMAT}/${FORMAT_VERSION}` || !payload) {
    throw new AppError('VALIDATION_ERROR', 'Это не файл резервной копии bitrix24-mcp-server', {
      field: 'file',
    });
  }
  const box = new SecretBox(key);
  let bundle: Bundle;
  try {
    bundle = JSON.parse(box.decrypt(payload, AAD)) as Bundle;
  } catch {
    throw new AppError(
      'ACCESS_DENIED',
      'Не удалось расшифровать копию: ключ не подходит или файл повреждён',
      {
        nextAction: 'Используйте тот же SECRETS_KEY_FILE, что был при создании копии',
      },
    );
  }
  const sqlite = Buffer.from(bundle.sqlite.base64, 'base64');
  const sha = createHash('sha256').update(sqlite).digest('hex');
  if (sha !== bundle.sqlite.sha256 || sqlite.length !== bundle.sqlite.bytes) {
    throw new AppError('VALIDATION_ERROR', 'Контрольная сумма базы в копии не совпадает', { field: 'file' });
  }
  if (existsSync(targetDir)) {
    throw new AppError(
      'CONFLICT',
      'Папка восстановления уже существует; укажите новую, поверх ничего не пишем',
      { field: 'to' },
    );
  }
  mkdirSync(path.join(targetDir, 'policies'), { recursive: true, mode: 0o700 });
  const sqliteFile = path.join(targetDir, 'mcp.sqlite');
  writeFileSync(sqliteFile, sqlite, { mode: 0o600, flag: 'wx' });
  for (const [name, text] of Object.entries(bundle.policies)) {
    writeFileSync(path.join(targetDir, 'policies', name), text, { mode: 0o600, flag: 'wx' });
  }
  // Проверка восстановления: база читается, миграции на месте, незавершённые операции посчитаны.
  const db = new DatabaseSync(sqliteFile, { readOnly: true });
  let pending: Record<string, number>;
  try {
    const rows = db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM operations WHERE status IN ('prepared','approved','executing','unknown') GROUP BY status",
      )
      .all() as { status: string; n: number }[];
    pending = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  } finally {
    db.close();
  }
  return {
    dir: targetDir,
    createdAt: bundle.createdAt,
    serverVersion: bundle.serverVersion,
    sqliteFile,
    sqliteBytes: sqlite.length,
    policies: Object.keys(bundle.policies),
    pendingOperations: pending,
  };
}

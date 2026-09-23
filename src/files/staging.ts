/**
 * Staging файлов (ТЗ §8.5): человек кладёт файл в UPLOAD_ROOT и получает непрозрачный fileToken;
 * либо инструмент принимает маленький base64. Файл копируется в закрытый STAGING_DIR,
 * фиксируются SHA-256/размер/имя/MIME/TTL; перед отправкой хеш сверяется заново (T26).
 * Произвольные пути сервера и URL для скачивания не принимаются.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors/app-error.js';
import type { AppLogger } from '../logging/logger.js';
import type { Database } from '../storage/database.js';
import { assertSize, detectMime, extensionOf, sanitizeFileName } from './validation.js';

export interface FileManifest {
  token: string;
  principalId: string;
  sha256: string;
  size: number;
  originalName: string;
  mime: string;
  stagingPath: string;
  createdAt: string;
  expiresAt: string;
}

interface ManifestRow {
  token: string;
  principal_id: string;
  sha256: string;
  size: number;
  original_name: string;
  mime: string;
  staging_path: string;
  created_at: string;
  expires_at: string;
}

export interface FileStagingOptions {
  uploadRoot: string;
  stagingDir: string;
  maxUploadBytes: number;
  maxInlineFileBytes: number;
  ttlSeconds: number;
  scanRequired: boolean;
}

export class FileStaging {
  constructor(
    private readonly db: Database,
    private readonly opts: FileStagingOptions,
    private readonly logger: AppLogger,
  ) {}

  /** CLI file:stage: только внутри UPLOAD_ROOT, без симлинков и traversal, с проверкой до чтения. */
  stageFromPath(inputPath: string, principalId: string): FileManifest {
    if (!path.isAbsolute(inputPath)) {
      throw new AppError('UNSAFE_FILE', 'Укажите абсолютный путь к файлу внутри UPLOAD_ROOT', {
        field: 'path',
      });
    }
    const root = this.realRoot();
    let real: string;
    try {
      real = realpathSync(inputPath);
    } catch {
      throw new AppError('NOT_FOUND', 'Файл не найден', { field: 'path' });
    }
    if (!isInside(real, root)) {
      throw new AppError('UNSAFE_FILE', 'Файл вне UPLOAD_ROOT; положите его в разрешённую папку', {
        field: 'path',
      });
    }
    // Симлинк внутри root, ведущий наружу, отсекает realpath; симлинк на файл внутри — тоже запрещаем.
    if (lstatSync(inputPath).isSymbolicLink()) {
      throw new AppError('UNSAFE_FILE', 'Символические ссылки не принимаются', { field: 'path' });
    }
    const st = statSync(real);
    if (!st.isFile()) throw new AppError('UNSAFE_FILE', 'Путь не является обычным файлом', { field: 'path' });
    const name = sanitizeFileName(real);
    const ext = extensionOf(name);
    assertSize(st.size, this.opts.maxUploadBytes, name);
    const buf = readFileSync(real);
    assertSize(buf.length, this.opts.maxUploadBytes, name);
    return this.stageBuffer(buf, name, ext, principalId);
  }

  /** Inline base64 для маленьких тестовых файлов (лимит MAX_INLINE_FILE_BYTES по декодированным байтам). */
  stageInline(base64: string, fileName: string, principalId: string): FileManifest {
    const name = sanitizeFileName(fileName);
    const ext = extensionOf(name);
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
      throw new AppError('UNSAFE_FILE', 'Невалидный base64', { field: 'contentBase64' });
    }
    const buf = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
    if (
      buf.length === 0 ||
      buf.toString('base64').replace(/=+$/, '') !== base64.replace(/\s+/g, '').replace(/=+$/, '')
    ) {
      throw new AppError('UNSAFE_FILE', 'Невалидный base64', { field: 'contentBase64' });
    }
    assertSize(buf.length, this.opts.maxInlineFileBytes, name);
    return this.stageBuffer(buf, name, ext, principalId);
  }

  private stageBuffer(buf: Buffer, name: string, ext: string, principalId: string): FileManifest {
    const mime = detectMime(buf, ext);
    if (this.opts.scanRequired) {
      // Сканер подключается на удалённом этапе; пока он недоступен — загрузка заблокирована, а не «проверена».
      throw new AppError(
        'UNSAFE_FILE',
        'UPLOAD_SCAN_REQUIRED=true, но антивирусный сканер ещё не интегрирован; загрузка заблокирована',
        {
          nextAction:
            'Отключите UPLOAD_SCAN_REQUIRED для локального профиля или дождитесь этапа удалённого подключения',
        },
      );
    }
    mkdirSync(this.opts.stagingDir, { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString('base64url');
    const stagingPath = path.join(this.opts.stagingDir, `${token}.${ext}`);
    writeFileSync(stagingPath, buf, { mode: 0o600, flag: 'wx' });
    try {
      chmodSync(stagingPath, 0o600);
    } catch {
      // Windows
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const now = Date.now();
    const manifest: FileManifest = {
      token,
      principalId,
      sha256,
      size: buf.length,
      originalName: name,
      mime,
      stagingPath,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.ttlSeconds * 1000).toISOString(),
    };
    this.db.run(
      'INSERT INTO file_manifests (token, principal_id, sha256, size, original_name, mime, staging_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      manifest.token,
      manifest.principalId,
      manifest.sha256,
      manifest.size,
      manifest.originalName,
      manifest.mime,
      manifest.stagingPath,
      manifest.createdAt,
      manifest.expiresAt,
    );
    this.logger.info({ token, size: buf.length, mime }, 'file staged');
    return manifest;
  }

  /** Манифест по токену: только свой, не истёкший. Путь наружу не отдаётся. */
  resolve(token: string, principalId: string): FileManifest {
    const row = this.db.get<ManifestRow>('SELECT * FROM file_manifests WHERE token = ?', token);
    const invalid = () =>
      new AppError('NOT_FOUND', 'fileToken не найден, истёк или принадлежит другому оператору', {
        field: 'fileToken',
        nextAction: 'Подготовьте файл заново: npm run file:stage -- --path <файл в UPLOAD_ROOT>',
      });
    if (row?.principal_id !== principalId) throw invalid();
    if (Date.parse(row.expires_at) < Date.now()) {
      this.remove(row.token, row.staging_path);
      throw invalid();
    }
    return {
      token: row.token,
      principalId: row.principal_id,
      sha256: row.sha256,
      size: row.size,
      originalName: row.original_name,
      mime: row.mime,
      stagingPath: row.staging_path,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Читает staged-копию и сверяет хеш/размер с манифестом (T26). */
  readVerified(manifest: FileManifest): Buffer {
    let buf: Buffer;
    try {
      buf = readFileSync(manifest.stagingPath);
    } catch {
      throw new AppError('UNSAFE_FILE', 'Подготовленный файл недоступен; подготовьте заново', {
        field: 'fileToken',
      });
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (sha256 !== manifest.sha256 || buf.length !== manifest.size) {
      throw new AppError(
        'UNSAFE_FILE',
        'Содержимое подготовленного файла изменилось после подтверждения; загрузка отменена',
        {
          field: 'fileToken',
          nextAction: 'Подготовьте файл заново и получите новое подтверждение',
        },
      );
    }
    return buf;
  }

  cleanupExpired(): number {
    const rows = this.db.all<{ token: string; staging_path: string }>(
      'SELECT token, staging_path FROM file_manifests WHERE expires_at < ?',
      new Date().toISOString(),
    );
    for (const r of rows) this.remove(r.token, r.staging_path);
    return rows.length;
  }

  private remove(token: string, stagingPath: string): void {
    try {
      rmSync(stagingPath, { force: true });
    } catch {
      // уже удалён
    }
    this.db.run('DELETE FROM file_manifests WHERE token = ?', token);
  }

  private realRoot(): string {
    mkdirSync(this.opts.uploadRoot, { recursive: true, mode: 0o700 });
    return realpathSync(this.opts.uploadRoot);
  }
}

function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

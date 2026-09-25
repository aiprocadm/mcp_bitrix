/**
 * Staging файлов (ТЗ §8.5): человек кладёт файл в UPLOAD_ROOT (CLI file:stage) или загружает через
 * панель /admin/uploads и получает непрозрачный fileToken; либо инструмент принимает маленький base64.
 * Файл копируется в закрытый STAGING_DIR, фиксируются SHA-256/размер/имя/MIME/TTL/вердикт сканера;
 * перед отправкой хеш сверяется заново (T26). При UPLOAD_SCAN_REQUIRED=true файл сохраняется только
 * после вердикта «clean»; сканер недоступен — загрузка заблокирована (T27), временных данных не остаётся.
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
import { toNumber, type SqlDb } from '../storage/sql.js';
import { ScannerUnavailableError, type FileScanner } from './scanner.js';
import { assertSize, detectMime, extensionOf, sanitizeFileName } from './validation.js';

export type ScanStatus = 'clean' | 'skipped';

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
  scanStatus: ScanStatus;
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
  scan_status: ScanStatus;
}

export interface FileStagingOptions {
  uploadRoot: string;
  stagingDir: string;
  maxUploadBytes: number;
  maxInlineFileBytes: number;
  ttlSeconds: number;
  scanRequired: boolean;
  scanner?: FileScanner | undefined;
}

/** Сводка для панели/CLI: без пути в staging. */
export interface StagedFileInfo {
  token: string;
  originalName: string;
  size: number;
  mime: string;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  scanStatus: ScanStatus;
}

function toManifest(row: ManifestRow): FileManifest {
  return {
    token: row.token,
    principalId: row.principal_id,
    sha256: row.sha256,
    size: toNumber(row.size),
    originalName: row.original_name,
    mime: row.mime,
    stagingPath: row.staging_path,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    scanStatus: row.scan_status,
  };
}

export class FileStaging {
  constructor(
    private readonly db: SqlDb,
    private readonly opts: FileStagingOptions,
    private readonly logger: AppLogger,
    /** Арендатор (SaaS-ТЗ §6.2): манифесты и fileToken видны только внутри него. */
    readonly tenantId: string,
  ) {}

  /** Тот же staging, привязанный к другому арендатору (общие каталоги и сканер, свои манифесты). */
  forTenant(tenantId: string): FileStaging {
    return new FileStaging(this.db, this.opts, this.logger, tenantId);
  }

  /** CLI file:stage: только внутри UPLOAD_ROOT, без симлинков и traversal, с проверкой до чтения. */
  async stageFromPath(inputPath: string, principalId: string): Promise<FileManifest> {
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
  async stageInline(base64: string, fileName: string, principalId: string): Promise<FileManifest> {
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

  /** Web-upload из панели (ТЗ §4.5 /admin/uploads): те же проверки, лимит MAX_UPLOAD_BYTES. */
  async stageUpload(buf: Buffer, fileName: string, principalId: string): Promise<FileManifest> {
    const name = sanitizeFileName(fileName);
    const ext = extensionOf(name);
    if (buf.length === 0) throw new AppError('UNSAFE_FILE', 'Пустой файл', { field: 'file' });
    assertSize(buf.length, this.opts.maxUploadBytes, name);
    return this.stageBuffer(buf, name, ext, principalId);
  }

  private async stageBuffer(
    buf: Buffer,
    name: string,
    ext: string,
    principalId: string,
  ): Promise<FileManifest> {
    const mime = detectMime(buf, ext);
    const scanStatus = await this.scanOrBlock(buf, name);
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
      scanStatus,
    };
    await this.db.withTenant(this.tenantId, (x) =>
      x.run(
        'INSERT INTO file_manifests (token, tenant_id, principal_id, sha256, size, original_name, mime, staging_path, created_at, expires_at, scan_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        manifest.token,
        this.tenantId,
        manifest.principalId,
        manifest.sha256,
        manifest.size,
        manifest.originalName,
        manifest.mime,
        manifest.stagingPath,
        manifest.createdAt,
        manifest.expiresAt,
        manifest.scanStatus,
      ),
    );
    this.logger.info({ token, size: buf.length, mime, scanStatus }, 'file staged');
    return manifest;
  }

  /** T27: без сканера при UPLOAD_SCAN_REQUIRED=true файл не сохраняется; вердикт «infected» — отказ. */
  private async scanOrBlock(buf: Buffer, name: string): Promise<ScanStatus> {
    if (!this.opts.scanRequired) return 'skipped';
    const scanner = this.opts.scanner;
    if (!scanner) {
      throw new AppError(
        'FEATURE_UNAVAILABLE',
        'UPLOAD_SCAN_REQUIRED=true, но сканер не настроен (UPLOAD_SCANNER_URL); загрузка заблокирована',
        { nextAction: 'Укажите UPLOAD_SCANNER_URL=clamd://host:port и проверьте npm run doctor' },
      );
    }
    let verdict;
    try {
      verdict = await scanner.scan(buf);
    } catch (e) {
      const reason = e instanceof ScannerUnavailableError ? e.message : 'ошибка сканера';
      this.logger.warn({ scanner: scanner.name, reason }, 'file scan unavailable');
      throw new AppError(
        'FEATURE_UNAVAILABLE',
        'Антивирусный сканер недоступен; загрузка заблокирована, файл не сохранён',
        { nextAction: 'Проверьте службу clamd и UPLOAD_SCANNER_URL (npm run doctor), затем повторите' },
      );
    }
    if (verdict.status === 'infected') {
      this.logger.warn({ scanner: scanner.name, signature: verdict.signature }, 'file rejected by scanner');
      throw new AppError('UNSAFE_FILE', `Файл «${name}» отклонён антивирусом: ${verdict.signature}`, {
        field: 'file',
      });
    }
    return 'clean';
  }

  /** Манифест по токену: только свой, не истёкший. Путь наружу не отдаётся. */
  async resolve(token: string, principalId: string): Promise<FileManifest> {
    const row = await this.db.withTenant(this.tenantId, (x) =>
      x.get<ManifestRow>(
        'SELECT * FROM file_manifests WHERE tenant_id = ? AND token = ?',
        this.tenantId,
        token,
      ),
    );
    const invalid = () =>
      new AppError('NOT_FOUND', 'fileToken не найден, истёк или принадлежит другому оператору', {
        field: 'fileToken',
        nextAction: 'Подготовьте файл заново: npm run file:stage -- --path <файл в UPLOAD_ROOT>',
      });
    if (row?.principal_id !== principalId) throw invalid();
    if (Date.parse(row.expires_at) < Date.now()) {
      await this.remove(row.token, row.staging_path);
      throw invalid();
    }
    return toManifest(row);
  }

  /** Свои подготовленные файлы (панель), без путей. */
  async listOwn(principalId: string): Promise<StagedFileInfo[]> {
    const rows = await this.db.withTenant(this.tenantId, (x) =>
      x.all<ManifestRow>(
        'SELECT * FROM file_manifests WHERE tenant_id = ? AND principal_id = ? AND expires_at >= ? ORDER BY created_at DESC',
        this.tenantId,
        principalId,
        new Date().toISOString(),
      ),
    );
    return rows.map((r) => ({
      token: r.token,
      originalName: r.original_name,
      size: toNumber(r.size),
      mime: r.mime,
      sha256: r.sha256,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      scanStatus: r.scan_status,
    }));
  }

  /** Читает staged-копию и сверяет хеш/размер с манифестом (T26); при обязательном сканере — только clean. */
  readVerified(manifest: FileManifest): Buffer {
    if (this.opts.scanRequired && manifest.scanStatus !== 'clean') {
      throw new AppError('UNSAFE_FILE', 'Файл не прошёл антивирусную проверку; подготовьте его заново', {
        field: 'fileToken',
      });
    }
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

  async cleanupExpired(): Promise<number> {
    const rows = await this.db.withTenant(this.tenantId, (x) =>
      x.all<{ token: string; staging_path: string }>(
        'SELECT token, staging_path FROM file_manifests WHERE tenant_id = ? AND expires_at < ?',
        this.tenantId,
        new Date().toISOString(),
      ),
    );
    for (const r of rows) await this.remove(r.token, r.staging_path);
    return rows.length;
  }

  /** Удаление всех подготовленных файлов арендатора (удаление данных арендатора, SaaS-ТЗ §14). */
  async purgeAll(): Promise<number> {
    const rows = await this.db.withTenant(this.tenantId, (x) =>
      x.all<{ token: string; staging_path: string }>(
        'SELECT token, staging_path FROM file_manifests WHERE tenant_id = ?',
        this.tenantId,
      ),
    );
    for (const r of rows) await this.remove(r.token, r.staging_path);
    return rows.length;
  }

  private async remove(token: string, stagingPath: string): Promise<void> {
    try {
      rmSync(stagingPath, { force: true });
    } catch {
      // уже удалён
    }
    await this.db.withTenant(this.tenantId, (x) =>
      x.run('DELETE FROM file_manifests WHERE tenant_id = ? AND token = ?', this.tenantId, token),
    );
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

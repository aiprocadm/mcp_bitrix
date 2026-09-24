/**
 * Антивирусный сканер staged-файлов (ТЗ §8.5, §12 files/scanner.ts, T27).
 * Поддерживается демон ClamAV (clamd) по протоколу INSTREAM: `clamd://host:port` или
 * `clamd+unix:///var/run/clamav/clamd.ctl`. Сканер недоступен → загрузка БЛОКИРУЕТСЯ, а не помечается
 * проверенной. Сетевой вызов идёт только по явно настроенному UPLOAD_SCANNER_URL (это не fetch и не Bitrix).
 */
import { connect, type NetConnectOpts, type Socket } from 'node:net';
import { AppError } from '../errors/app-error.js';

export type ScanVerdict = { status: 'clean' } | { status: 'infected'; signature: string };

export interface FileScanner {
  readonly name: string;
  /** Проверяет содержимое. Бросает ScannerUnavailableError, если проверить не удалось. */
  scan(buf: Buffer): Promise<ScanVerdict>;
  /** Проверка связи (doctor). */
  ping(): Promise<void>;
}

export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

export interface ScannerTarget {
  readonly kind: 'clamd';
  readonly connect: NetConnectOpts;
  readonly label: string;
}

/** Разбор UPLOAD_SCANNER_URL: только clamd; ошибка — CONFIG_INVALID. */
export function parseScannerUrl(value: string): ScannerTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('CONFIG_INVALID', 'UPLOAD_SCANNER_URL не является URL', {
      field: 'UPLOAD_SCANNER_URL',
    });
  }
  if (url.protocol === 'clamd:') {
    const port = url.port ? Number(url.port) : 3310;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError('CONFIG_INVALID', 'UPLOAD_SCANNER_URL: ожидается clamd://host:port', {
        field: 'UPLOAD_SCANNER_URL',
      });
    }
    return {
      kind: 'clamd',
      connect: { host: url.hostname, port },
      label: `clamd://${url.hostname}:${String(port)}`,
    };
  }
  if (url.protocol === 'clamd+unix:') {
    const socketPath = decodeURIComponent(url.pathname);
    if (!socketPath) {
      throw new AppError('CONFIG_INVALID', 'UPLOAD_SCANNER_URL: ожидается clamd+unix:///путь/к/сокету', {
        field: 'UPLOAD_SCANNER_URL',
      });
    }
    return { kind: 'clamd', connect: { path: socketPath }, label: `clamd+unix://${socketPath}` };
  }
  throw new AppError(
    'CONFIG_INVALID',
    'UPLOAD_SCANNER_URL: поддерживаются clamd://host:port и clamd+unix:///путь (ClamAV)',
    { field: 'UPLOAD_SCANNER_URL' },
  );
}

export interface ClamdOptions {
  timeoutMs?: number;
  chunkSize?: number;
}

/** Один запрос к clamd: команда в z-формате (терминатор \0), ответ до \0. */
function clamdRequest(
  target: ScannerTarget,
  timeoutMs: number,
  write: (socket: Socket) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(target.connect);
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (err?: Error, value?: string): void => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? '');
    };
    socket.setTimeout(timeoutMs, () => finish(new ScannerUnavailableError('таймаут ответа сканера')));
    socket.on('error', (e) => finish(new ScannerUnavailableError(`сканер недоступен: ${e.message}`)));
    socket.on('connect', () => {
      try {
        write(socket);
      } catch (e) {
        finish(new ScannerUnavailableError(`ошибка передачи файла сканеру: ${(e as Error).message}`));
      }
    });
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const nul = all.indexOf(0);
      if (nul >= 0) finish(undefined, all.subarray(0, nul).toString('utf8').trim());
    });
    socket.on('close', () => {
      const all = Buffer.concat(chunks).toString('utf8').trim();
      if (all) finish(undefined, all.replace(/\0+$/, ''));
      else finish(new ScannerUnavailableError('сканер закрыл соединение без ответа'));
    });
  });
}

export class ClamdScanner implements FileScanner {
  readonly name: string;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;

  constructor(
    private readonly target: ScannerTarget,
    opts: ClamdOptions = {},
  ) {
    this.name = target.label;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.chunkSize = opts.chunkSize ?? 65_536;
  }

  async ping(): Promise<void> {
    const reply = await clamdRequest(this.target, this.timeoutMs, (s) => s.write('zPING\0'));
    if (reply !== 'PONG')
      throw new ScannerUnavailableError(`неожиданный ответ на PING: ${reply.slice(0, 40)}`);
  }

  async scan(buf: Buffer): Promise<ScanVerdict> {
    const reply = await clamdRequest(this.target, this.timeoutMs, (s) => {
      s.write('zINSTREAM\0');
      for (let off = 0; off < buf.length; off += this.chunkSize) {
        const chunk = buf.subarray(off, Math.min(off + this.chunkSize, buf.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        s.write(len);
        s.write(chunk);
      }
      s.write(Buffer.alloc(4, 0));
    });
    if (/^stream: OK$/.test(reply)) return { status: 'clean' };
    const found = /^stream: (.+) FOUND$/.exec(reply);
    if (found?.[1]) return { status: 'infected', signature: found[1] };
    // «size limit exceeded», «ERROR» и прочее — не вердикт, а отказ проверки.
    throw new ScannerUnavailableError(`сканер не дал вердикта: ${reply.slice(0, 80)}`);
  }
}

export function createScanner(url: string | undefined, opts?: ClamdOptions): FileScanner | undefined {
  if (!url) return undefined;
  return new ClamdScanner(parseScannerUrl(url), opts);
}

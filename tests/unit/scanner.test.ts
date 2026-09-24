/** Сканер clamd (ТЗ §8.5, T27): протокол INSTREAM/PING против фальшивого демона на loopback. */
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClamdScanner, parseScannerUrl, ScannerUnavailableError } from '../../src/files/scanner.js';

type Mode = 'normal' | 'garbage' | 'hang';
let server: Server;
let port = 0;
let mode: Mode = 'normal';
const seen: Buffer[] = [];
const HEADER = 'zINSTREAM\0';

/** Собирает содержимое из блоков INSTREAM ([len BE32][data]...[0]); undefined — терминатора ещё нет. */
function assemble(buf: Buffer): Buffer | undefined {
  const parts: Buffer[] = [];
  let off = HEADER.length;
  for (;;) {
    if (buf.length < off + 4) return undefined;
    const len = buf.readUInt32BE(off);
    off += 4;
    if (len === 0) return Buffer.concat(parts);
    if (buf.length < off + len) return undefined;
    parts.push(buf.subarray(off, off + len));
    off += len;
  }
}

function handle(socket: Socket): void {
  let buf = Buffer.alloc(0);
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    seen.push(d);
    if (mode === 'hang') return;
    const text = buf.toString('latin1');
    if (text.startsWith('zPING\0')) {
      socket.end('PONG\0');
      return;
    }
    if (!text.startsWith(HEADER)) {
      socket.end('UNKNOWN COMMAND\0');
      return;
    }
    const payload = assemble(buf);
    if (!payload) return;
    if (mode === 'garbage') {
      socket.end('INSTREAM size limit exceeded. ERROR\0');
      return;
    }
    socket.end(payload.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const scanner = () =>
  new ClamdScanner(parseScannerUrl(`clamd://127.0.0.1:${String(port)}`), { timeoutMs: 300, chunkSize: 5 });

describe('parseScannerUrl', () => {
  it('принимает clamd:// и clamd+unix://, отвергает остальное', () => {
    expect(parseScannerUrl('clamd://10.0.0.5').connect).toEqual({ host: '10.0.0.5', port: 3310 });
    expect(parseScannerUrl('clamd://localhost:3311').label).toBe('clamd://localhost:3311');
    expect(parseScannerUrl('clamd+unix:///var/run/clamav/clamd.ctl').connect).toEqual({
      path: '/var/run/clamav/clamd.ctl',
    });
    for (const bad of ['http://scan.example/scan', 'clamd://', 'clamd://h:99999', 'not a url']) {
      expect(() => parseScannerUrl(bad)).toThrow(/UPLOAD_SCANNER_URL/);
    }
  });
});

describe('ClamdScanner', () => {
  it('PING → PONG; чистый файл → clean; EICAR → infected с сигнатурой; файл передаётся кусками с длинами', async () => {
    mode = 'normal';
    await expect(scanner().ping()).resolves.toBeUndefined();
    await expect(scanner().scan(Buffer.from('обычный текст документа'))).resolves.toEqual({
      status: 'clean',
    });
    seen.length = 0;
    await expect(scanner().scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD'))).resolves.toEqual(
      { status: 'infected', signature: 'Eicar-Test-Signature' },
    );
    const raw = Buffer.concat(seen);
    expect(raw.subarray(0, 10).toString('latin1')).toBe(HEADER);
    expect(raw.readUInt32BE(10)).toBe(5); // первый блок длиной chunkSize
  });

  it('ответ без вердикта, таймаут и закрытый порт → ScannerUnavailableError (загрузка блокируется, не «проверена»)', async () => {
    mode = 'garbage';
    await expect(scanner().scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
    mode = 'hang';
    await expect(scanner().scan(Buffer.from('x'))).rejects.toThrow(/таймаут/);
    mode = 'normal';
    const dead = new ClamdScanner(parseScannerUrl('clamd://127.0.0.1:1'), { timeoutMs: 300 });
    await expect(dead.scan(Buffer.from('x'))).rejects.toThrow(/недоступен/);
    await expect(dead.ping()).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

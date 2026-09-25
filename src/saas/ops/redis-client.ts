/**
 * Минимальный клиент Redis поверх node:net / node:tls (SaaS-ТЗ §5.1, §13; этап S8). Единственное место сетевого
 * обмена с Redis в проекте; npm-пакеты для Redis не используются.
 *
 * Протокол — RESP (REdis Serialization Protocol), официальная спецификация:
 *   https://redis.io/docs/latest/develop/reference/protocol-spec/
 * Команды отправляются массивом bulk-строк (`*N\r\n$len\r\n...\r\n`). Разбор ответов понимает все типы RESP2
 * (`+ - : $ *`) и RESP3 (`_ , # ! = ( % ~ > |`), хотя по умолчанию соединение работает в RESP2 (HELLO не шлётся;
 * `protocol: 3` включает `HELLO 3 [AUTH user pass]`). Используемые команды и их семантика —
 * https://redis.io/docs/latest/commands/ (AUTH, HELLO, SELECT, SET NX PX, GET, DEL, GETDEL (≥ 6.2), INCRBY,
 * PEXPIRE, SCAN, EVAL/EVALSHA, SCRIPT, PUBLISH, SUBSCRIBE/UNSUBSCRIBE, PING).
 *
 * Надёжность:
 *  - таймаут подключения и таймаут каждой команды; просроченная уже отправленная команда разрывает соединение
 *    (иначе поздний ответ сдвинул бы очередь ответов), все отправленные команды получают ошибку;
 *  - переподключение с экспоненциальной задержкой; команды, поданные без соединения, ждут в очереди (они ещё не
 *    отправлены — повтор безопасен) не дольше своего таймаута;
 *  - ОТПРАВЛЕННЫЕ команды при обрыве НЕ повторяются: INCRBY/EVAL не идемпотентны, повтор дал бы двойной счёт (S16);
 *  - подписчик (SUBSCRIBE) — отдельное соединение; после переподключения каналы подписываются заново.
 * Секреты: пароль из URL не попадает в сообщения ошибок и логи (адрес в ошибках — только host:port).
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export type RedisReply = string | number | boolean | null | RedisReplyError | RedisReply[];

/** Ошибка, которую вернул сервер (`-ERR ...`, `-NOSCRIPT ...`, `-WRONGPASS ...`). */
export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisReplyError';
  }
}

/** Нет соединения / обрыв / таймаут: исход отправленной команды неизвестен. */
export class RedisConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConnectionError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Кодирование и разбор RESP
// ---------------------------------------------------------------------------------------------------------------

export type RedisArg = string | number | Buffer;

export function encodeCommand(args: readonly RedisArg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(typeof a === 'number' ? String(a) : a, 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Сообщение RESP3 типа push (`>`): отделяется от ответов на команды. */
export interface RedisPush {
  readonly push: RedisReply[];
}

type Parsed = { value: RedisReply | RedisPush; next: number } | undefined;
const INCOMPLETE: Parsed = undefined;

/** Потоковый разборщик RESP2/RESP3: копит байты и отдаёт полностью полученные ответы. */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): (RedisReply | RedisPush)[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: (RedisReply | RedisPush)[] = [];
    let pos = 0;
    for (;;) {
      const r = this.parse(pos);
      if (!r) break;
      out.push(r.value);
      pos = r.next;
    }
    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(pos);
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  private line(pos: number): { text: string; next: number } | undefined {
    const end = this.buf.indexOf('\r\n', pos, 'latin1');
    if (end < 0) return undefined;
    return { text: this.buf.toString('utf8', pos, end), next: end + 2 };
  }

  private blob(pos: number, len: number): { text: string; next: number } | undefined {
    if (this.buf.length < pos + len + 2) return undefined;
    return { text: this.buf.toString('utf8', pos, pos + len), next: pos + len + 2 };
  }

  private aggregate(pos: number, count: number): { items: RedisReply[]; next: number } | undefined {
    const items: RedisReply[] = [];
    let p = pos;
    for (let i = 0; i < count; i++) {
      const r = this.parse(p);
      if (!r) return undefined;
      items.push(isPush(r.value) ? r.value.push : r.value);
      p = r.next;
    }
    return { items, next: p };
  }

  private parse(pos: number): Parsed {
    if (pos >= this.buf.length) return INCOMPLETE;
    const type = String.fromCharCode(this.buf[pos] ?? 0);
    const head = this.line(pos + 1);
    if (!head) return INCOMPLETE;
    const { text, next } = head;
    switch (type) {
      case '+':
        return { value: text, next };
      case '-':
        return { value: new RedisReplyError(text), next };
      case ':':
        return { value: Number(text), next };
      case ',': // RESP3 double
        return { value: text === 'inf' ? Infinity : text === '-inf' ? -Infinity : Number(text), next };
      case '(': // RESP3 big number — строкой, без потери точности
        return { value: text, next };
      case '#':
        return { value: text === 't', next };
      case '_':
        return { value: null, next };
      case '$':
      case '!':
      case '=': {
        const len = Number(text);
        if (len < 0) return { value: null, next };
        const b = this.blob(next, len);
        if (!b) return INCOMPLETE;
        if (type === '!') return { value: new RedisReplyError(b.text), next: b.next };
        // verbatim string: первые 4 байта — формат ("txt:")
        return { value: type === '=' ? b.text.slice(4) : b.text, next: b.next };
      }
      case '*':
      case '~':
      case '>':
      case '%':
      case '|': {
        const n = Number(text);
        if (n < 0) return { value: null, next };
        const count = type === '%' || type === '|' ? n * 2 : n;
        const agg = this.aggregate(next, count);
        if (!agg) return INCOMPLETE;
        // атрибуты (|) — метаданные к следующему ответу: пропускаем их
        if (type === '|') return this.parse(agg.next);
        if (type === '>') return { value: { push: agg.items }, next: agg.next };
        return { value: agg.items, next: agg.next };
      }
      default:
        throw new RedisConnectionError(
          `Нарушение протокола RESP: неизвестный тип ответа 0x${type.charCodeAt(0).toString(16)}`,
        );
    }
  }
}

function isPush(v: RedisReply | RedisPush): v is RedisPush {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Error) && 'push' in v;
}

// ---------------------------------------------------------------------------------------------------------------
// Разбор адреса
// ---------------------------------------------------------------------------------------------------------------

export interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly db: number;
}

/** redis://[user[:pass]@]host[:port][/db] и rediss:// (TLS). Пароль не выводится в ошибках. */
export function parseRedisUrl(url: string): RedisEndpoint {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('REDIS_URL: неверный адрес');
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:')
    throw new Error('REDIS_URL: схема должна быть redis: или rediss:');
  if (!u.hostname) throw new Error('REDIS_URL: не указан хост');
  const dbText = u.pathname.replace(/^\//, '');
  const db = dbText === '' ? 0 : Number(dbText);
  if (!Number.isInteger(db) || db < 0) throw new Error('REDIS_URL: номер базы должен быть целым ≥ 0');
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 6379,
    tls: u.protocol === 'rediss:',
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Соединение
// ---------------------------------------------------------------------------------------------------------------

export interface RedisClientOptions {
  /** REDIS_URL (секрет: может содержать пароль). */
  readonly url: string;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly reconnectMinDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Сколько команд может ждать соединения. */
  readonly maxOfflineQueue?: number;
  /** 2 (по умолчанию) или 3 — `HELLO 3`. */
  readonly protocol?: 2 | 3;
  /** Доп. параметры TLS для rediss:// (ca, servername). Проверка сертификата не отключается. */
  readonly tls?: Pick<tls.ConnectionOptions, 'ca' | 'servername' | 'cert' | 'key'>;
  /** Сообщение о проблеме соединения (без секретов) — для логгера/метрик. */
  readonly onConnectionError?: (message: string) => void;
}

interface Pending {
  readonly payload: Buffer;
  readonly resolve: (v: RedisReply) => void;
  readonly reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  sent: boolean;
}

const SUB_KINDS = new Set(['message', 'subscribe', 'unsubscribe', 'pmessage', 'psubscribe', 'punsubscribe']);

class RedisConnection {
  readonly endpoint: RedisEndpoint;
  private socket: net.Socket | undefined;
  private state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
  private readonly parser = new RespParser();
  private readonly inflight: Pending[] = [];
  private readonly offline: Pending[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private readonly where: string;

  constructor(
    private readonly o: RedisClientOptions,
    private readonly subscriberMode: boolean,
    private readonly onPush: (msg: RedisReply[]) => void,
    /** Команды, выполняемые сразу после подключения/переподключения (подписки). */
    private readonly afterConnect: () => RedisArg[][],
  ) {
    this.endpoint = parseRedisUrl(o.url);
    this.where = `${this.endpoint.host}:${String(this.endpoint.port)}`;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  private get commandTimeout(): number {
    return this.o.commandTimeoutMs ?? 5000;
  }

  /** Дождаться готовности (подключается при необходимости). */
  ready(timeoutMs = this.o.connectTimeoutMs ?? 5000): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new RedisConnectionError('Клиент Redis закрыт'));
    if (this.state === 'ready') return Promise.resolve();
    this.kick();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new RedisConnectionError(`Redis ${this.where}: нет соединения за ${String(timeoutMs)} мс`));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.readyWaiters.push(waiter);
    });
  }

  send(args: readonly RedisArg[], timeoutMs = this.commandTimeout): Promise<RedisReply> {
    if (this.state === 'closed') return Promise.reject(new RedisConnectionError('Клиент Redis закрыт'));
    return new Promise<RedisReply>((resolve, reject) => {
      const p: Pending = { payload: encodeCommand(args), resolve, reject, timer: undefined, sent: false };
      p.timer = setTimeout(() => this.onTimeout(p), timeoutMs);
      if (this.state === 'ready' && this.socket) {
        this.writePending(p);
      } else {
        if (this.offline.length >= (this.o.maxOfflineQueue ?? 1000)) {
          clearTimeout(p.timer);
          reject(new RedisConnectionError(`Redis ${this.where}: очередь команд без соединения переполнена`));
          return;
        }
        this.offline.push(p);
        this.kick();
      }
    });
  }

  /** Запись без ожидания ответа (режим подписчика: подтверждения приходят как push-сообщения). */
  sendRaw(args: readonly RedisArg[]): void {
    if (this.state === 'ready' && this.socket) this.socket.write(encodeCommand(args));
  }

  private writePending(p: Pending): void {
    p.sent = true;
    this.inflight.push(p);
    this.socket?.write(p.payload);
  }

  private onTimeout(p: Pending): void {
    const oi = this.offline.indexOf(p);
    if (oi >= 0) {
      this.offline.splice(oi, 1);
      p.reject(
        new RedisConnectionError(`Redis ${this.where}: нет соединения, команда не отправлена (таймаут)`),
      );
      return;
    }
    if (this.inflight.includes(p)) {
      // Поздний ответ сдвинул бы очередь: рвём соединение, все отправленные команды получают ошибку.
      this.teardown(new RedisConnectionError(`Redis ${this.where}: таймаут ответа на команду`));
    }
  }

  private kick(): void {
    if (this.state === 'idle' && !this.reconnectTimer) void this.connect();
  }

  private async connect(): Promise<void> {
    this.state = 'connecting';
    const ep = this.endpoint;
    const socket = ep.tls
      ? tls.connect({
          host: ep.host,
          port: ep.port,
          servername: net.isIP(ep.host) ? undefined : ep.host,
          ...this.o.tls,
        })
      : net.connect({ host: ep.host, port: ep.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const connectTimer = setTimeout(() => {
      socket.destroy(new RedisConnectionError(`Redis ${this.where}: таймаут подключения`));
    }, this.o.connectTimeoutMs ?? 5000);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => {
      // подробности (без адреса с паролем) — в 'close'
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket === socket) this.onClose();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once(ep.tls ? 'secureConnect' : 'connect', () => resolve());
        socket.once('close', () =>
          reject(new RedisConnectionError(`Redis ${this.where}: соединение не установлено`)),
        );
      });
      clearTimeout(connectTimer);
      await this.handshake();
      if (this.socket !== socket) return;
      this.state = 'ready';
      this.attempt = 0;
      for (const cmd of this.afterConnect()) socket.write(encodeCommand(cmd));
      for (const p of this.offline.splice(0)) this.writePending(p);
      for (const w of this.readyWaiters.splice(0)) w.resolve();
    } catch (e) {
      const msg =
        e instanceof RedisReplyError ? `Redis ${this.where}: отказ при подключении: ${e.message}` : undefined;
      if (msg) this.o.onConnectionError?.(msg);
      socket.destroy();
    }
  }

  /** AUTH/HELLO/SELECT — до признания соединения готовым (отправляются мимо очереди ожидания). */
  private async handshake(): Promise<void> {
    const ep = this.endpoint;
    const direct = (args: RedisArg[]) =>
      new Promise<RedisReply>((resolve, reject) => {
        const p: Pending = { payload: encodeCommand(args), resolve, reject, timer: undefined, sent: false };
        p.timer = setTimeout(() => this.onTimeout(p), this.commandTimeout);
        this.writePending(p);
      });
    if (this.o.protocol === 3) {
      const args: RedisArg[] = ['HELLO', 3];
      if (ep.password !== undefined) args.push('AUTH', ep.username ?? 'default', ep.password);
      await direct(args);
    } else if (ep.password !== undefined) {
      await direct(ep.username ? ['AUTH', ep.username, ep.password] : ['AUTH', ep.password]);
    }
    if (ep.db !== 0) await direct(['SELECT', ep.db]);
  }

  private onData(chunk: Buffer): void {
    let replies: (RedisReply | RedisPush)[];
    try {
      replies = this.parser.feed(chunk);
    } catch (e) {
      this.teardown(e instanceof Error ? e : new RedisConnectionError('Нарушение протокола RESP'));
      return;
    }
    for (const r of replies) {
      if (isPush(r)) {
        this.onPush(r.push);
        continue;
      }
      if (
        this.subscriberMode &&
        Array.isArray(r) &&
        typeof r[0] === 'string' &&
        SUB_KINDS.has(r[0].toLowerCase())
      ) {
        this.onPush(r);
        continue;
      }
      const p = this.inflight.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      if (r instanceof RedisReplyError) p.reject(r);
      else p.resolve(r);
    }
  }

  private teardown(err: Error): void {
    const s = this.socket;
    this.failInflight(err);
    s?.destroy();
  }

  private failInflight(err: Error): void {
    for (const p of this.inflight.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private onClose(): void {
    this.socket = undefined;
    this.parser.reset();
    this.failInflight(
      new RedisConnectionError(`Redis ${this.where}: соединение потеряно, исход команды неизвестен`),
    );
    if (this.state === 'closed') return;
    if (this.state === 'ready') this.o.onConnectionError?.(`Redis ${this.where}: соединение потеряно`);
    this.state = 'idle';
    // Переподключение с экспоненциальной задержкой и джиттером.
    const min = this.o.reconnectMinDelayMs ?? 50;
    const max = this.o.reconnectMaxDelayMs ?? 2000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 16));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        if (this.state === 'idle') void this.connect();
      },
      Math.round(delay * (0.75 + Math.random() * 0.5)),
    );
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const s = this.socket;
    const wasReady = this.state === 'ready';
    this.state = 'closed';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const err = new RedisConnectionError('Клиент Redis закрыт');
    for (const p of this.offline.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    if (s && wasReady) {
      // QUIT вежливо закрывает соединение; не ждём дольше 500 мс.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        s.once('close', () => {
          clearTimeout(t);
          resolve();
        });
        s.end(encodeCommand(['QUIT']));
      });
    }
    this.failInflight(err);
    s?.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Клиент команд
// ---------------------------------------------------------------------------------------------------------------

/** Lua-скрипт с кэшированным SHA1 для EVALSHA (https://redis.io/docs/latest/commands/evalsha/). */
export class RedisScript {
  readonly sha1: string;
  constructor(readonly source: string) {
    this.sha1 = createHash('sha1').update(source).digest('hex');
  }
}

export class RedisClient {
  private readonly conn: RedisConnection;

  constructor(private readonly o: RedisClientOptions) {
    this.conn = new RedisConnection(
      o,
      false,
      () => undefined,
      () => [],
    );
  }

  /** Подключиться сейчас (иначе — при первой команде). */
  connect(): Promise<void> {
    return this.conn.ready();
  }

  get isReady(): boolean {
    return this.conn.isReady;
  }

  command(args: readonly RedisArg[], timeoutMs?: number): Promise<RedisReply> {
    return this.conn.send(args, timeoutMs);
  }

  async ping(): Promise<boolean> {
    return (await this.command(['PING'])) === 'PONG';
  }

  async get(key: string): Promise<string | null> {
    return asStringOrNull(await this.command(['GET', key]));
  }

  /** SET key value [NX] [PX ms] → true, если записано (при NX — если ключа не было). */
  async set(key: string, value: string, opts: { nx?: boolean; pxMs?: number } = {}): Promise<boolean> {
    const args: RedisArg[] = ['SET', key, value];
    if (opts.nx) args.push('NX');
    if (opts.pxMs !== undefined) args.push('PX', Math.max(1, Math.round(opts.pxMs)));
    return (await this.command(args)) === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return asNumber(await this.command(['DEL', ...keys]));
  }

  async getdel(key: string): Promise<string | null> {
    return asStringOrNull(await this.command(['GETDEL', key]));
  }

  async incrby(key: string, by: number): Promise<number> {
    return asNumber(await this.command(['INCRBY', key, Math.trunc(by)]));
  }

  async pexpire(key: string, ms: number): Promise<boolean> {
    return asNumber(await this.command(['PEXPIRE', key, Math.max(1, Math.round(ms))])) === 1;
  }

  /** Один шаг SCAN: [следующий курсор, ключи]. Курсор "0" — конец обхода. */
  async scan(cursor: string, match: string, count = 500): Promise<[string, string[]]> {
    const r = await this.command(['SCAN', cursor, 'MATCH', match, 'COUNT', count]);
    if (!Array.isArray(r) || r.length !== 2 || !Array.isArray(r[1]))
      throw new RedisReplyError('Неожиданный ответ SCAN');
    return [String(r[0]), r[1].map((k) => String(k))];
  }

  async publish(channel: string, message: string): Promise<number> {
    return asNumber(await this.command(['PUBLISH', channel, message]));
  }

  /** EVALSHA, при NOSCRIPT (скрипт выгружен/новый сервер) — EVAL с исходником. */
  async eval(script: RedisScript, keys: readonly string[], args: readonly RedisArg[]): Promise<RedisReply> {
    try {
      return await this.command(['EVALSHA', script.sha1, keys.length, ...keys, ...args]);
    } catch (e) {
      if (e instanceof RedisReplyError && e.message.startsWith('NOSCRIPT')) {
        return this.command(['EVAL', script.source, keys.length, ...keys, ...args]);
      }
      throw e;
    }
  }

  /** Отдельное соединение для подписок (в режиме SUBSCRIBE соединение не принимает обычные команды). */
  subscriber(): RedisSubscriber {
    return new RedisSubscriber(this.o);
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}

export class RedisSubscriber {
  private readonly conn: RedisConnection;
  private readonly handlers = new Map<string, Set<(message: string) => void>>();
  private readonly acks = new Map<string, (() => void)[]>();

  constructor(o: RedisClientOptions) {
    this.conn = new RedisConnection(
      o,
      true,
      (msg) => this.onPush(msg),
      // после (пере)подключения — подписка на все каналы заново
      () => [...this.handlers.keys()].map((ch) => ['SUBSCRIBE', ch]),
    );
  }

  private onPush(msg: RedisReply[]): void {
    const kind = typeof msg[0] === 'string' ? msg[0].toLowerCase() : '';
    const channel = typeof msg[1] === 'string' ? msg[1] : '';
    if (kind === 'message') {
      const payload = typeof msg[2] === 'string' ? msg[2] : '';
      for (const h of this.handlers.get(channel) ?? []) {
        try {
          h(payload);
        } catch {
          // ошибка обработчика не должна рвать соединение подписчика
        }
      }
    } else if (kind === 'subscribe') {
      for (const r of this.acks.get(channel) ?? []) r();
      this.acks.delete(channel);
    }
  }

  /** Подписаться; промис завершается после подтверждения сервером. Возвращает функцию отписки. */
  async subscribe(
    channel: string,
    handler: (message: string) => void,
    timeoutMs = 5000,
  ): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (first) {
      const acked = new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new RedisConnectionError('Redis: нет подтверждения SUBSCRIBE')),
          timeoutMs,
        );
        const list = this.acks.get(channel) ?? [];
        list.push(() => {
          clearTimeout(t);
          resolve();
        });
        this.acks.set(channel, list);
      });
      if (this.conn.isReady) this.conn.sendRaw(['SUBSCRIBE', channel]);
      else await this.conn.ready(timeoutMs); // SUBSCRIBE уйдёт из afterConnect
      await acked;
    }
    const s = set;
    return () => {
      s.delete(handler);
      if (s.size === 0 && this.handlers.get(channel) === s) {
        this.handlers.delete(channel);
        this.conn.sendRaw(['UNSUBSCRIBE', channel]);
      }
      return Promise.resolve();
    };
  }

  close(): Promise<void> {
    this.handlers.clear();
    return this.conn.close();
  }
}

function asNumber(r: RedisReply): number {
  if (typeof r === 'number') return r;
  if (typeof r === 'string' && /^-?\d+$/.test(r)) return Number(r);
  throw new RedisReplyError('Неожиданный ответ Redis: ожидалось число');
}

function asStringOrNull(r: RedisReply): string | null {
  if (r === null) return null;
  if (typeof r === 'string') return r;
  if (typeof r === 'number') return String(r);
  throw new RedisReplyError('Неожиданный ответ Redis: ожидалась строка');
}

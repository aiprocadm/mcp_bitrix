/**
 * Настоящий redis-server для тестов этапа S8 (без имитаций): временный экземпляр на случайном порту,
 * без сохранения на диск. Нет бинарника — тесты помечаются skip явно (describe.skipIf), а не «проходят» на подделке.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';

function findRedis(): string | undefined {
  const r = spawnSync('sh', ['-c', 'command -v redis-server'], { encoding: 'utf8' });
  const p = r.stdout.trim();
  return r.status === 0 && p ? p : undefined;
}

const BIN = findRedis();
export const REDIS_AVAILABLE = BIN !== undefined;

export interface TestRedis {
  readonly port: number;
  /** redis://[:пароль@]127.0.0.1:port */
  readonly url: string;
  /** Остановить процесс (для проверки переподключения). */
  kill(): Promise<void>;
  /** Запустить снова на том же порту. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`redis-server не поднялся на порту ${String(port)}`));
        else setTimeout(attempt, 30);
      });
    };
    attempt();
  });
}

export async function startTestRedis(opts: { password?: string } = {}): Promise<TestRedis> {
  if (!BIN) throw new Error('redis-server не установлен');
  const bin = BIN;
  const port = 20000 + Math.floor(Math.random() * 20000);
  let proc: ChildProcess | undefined;
  const args = ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'];
  if (opts.password) args.push('--requirepass', opts.password);
  const launch = async () => {
    proc = spawn(bin, args, { stdio: 'ignore' });
    await waitPort(port, 5000);
  };
  const kill = () =>
    new Promise<void>((resolve) => {
      const p = proc;
      proc = undefined;
      if (p?.exitCode !== null) {
        resolve();
        return;
      }
      p.once('exit', () => resolve());
      p.kill('SIGKILL');
    });
  await launch();
  const auth = opts.password ? `:${encodeURIComponent(opts.password)}@` : '';
  return {
    port,
    url: `redis://${auth}127.0.0.1:${String(port)}`,
    kill,
    restart: launch,
    stop: kill,
  };
}

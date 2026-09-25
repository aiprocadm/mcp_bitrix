/**
 * Учётные записи панели владельца `/owner` (SaaS-ТЗ §11.3): только режим saas, PostgreSQL из DATABASE_URL,
 * KEK из KEK_FILE.
 *
 *   npm run owner -- create --email <email> [--role service_owner|support]
 *   npm run owner -- reset-password --email <email>
 *   npm run owner -- reset-totp --email <email>
 *   npm run owner -- disable --email <email> | enable --email <email>
 *   npm run owner -- list
 *
 * Пароль: в терминале — скрытый ввод дважды; без терминала — первая строка stdin (для автоматизации).
 * Секрет TOTP и otpauth-URI печатаются ОДИН раз и только в stderr, подключённый к терминалу: если stderr
 * перенаправлен (в файл/журнал), команда отказывает до создания записи. В логи и stdout секреты не попадают.
 */
import { AppError } from '../errors/app-error.js';
import { base32Encode } from '../saas/owner/totp.js';
import {
  OWNER_PASSWORD_MIN_LENGTH,
  OwnerAccounts,
  ownerSecretsBox,
  readKekFile,
} from '../saas/owner/accounts.js';
import { PostgresSqlDb } from '../storage/postgres-db.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          reject(new AppError('ACCESS_DENIED', 'Ввод прерван'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > 4096) throw new AppError('VALIDATION_ERROR', 'Слишком длинный ввод', { field: 'password' });
    chunks.push(b);
  }
  return (Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '').replace(/\r$/, '');
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const p1 = await readHidden('Пароль: ');
    const p2 = await readHidden('Повторите пароль: ');
    if (p1 !== p2) throw new AppError('VALIDATION_ERROR', 'Пароли не совпадают', { field: 'password' });
    return p1;
  }
  return readStdinLine();
}

function requireTtyForSecret(): void {
  if (!process.stderr.isTTY)
    throw new AppError(
      'ACCESS_DENIED',
      'Секрет TOTP показывается только в терминале: stderr перенаправлен (в файл или журнал)',
      { nextAction: 'Запустите команду в интерактивном терминале без перенаправления stderr' },
    );
}

function printSecret(email: string, secret: Buffer, uri: string): void {
  process.stderr.write(
    [
      '',
      `Секрет TOTP для ${email} (показывается один раз; сохраните в приложении-аутентификаторе):`,
      `  ключ:  ${base32Encode(secret)}`,
      `  URI:   ${uri}`,
      '  Параметры: TOTP, SHA-1, 6 цифр, 30 секунд.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), { email: { kind: 'string' }, role: { kind: 'string' } });
  const command = args.positional[0] ?? '';
  const config = cliConfig(args);
  const d = config.deployment;
  if (d.mode !== 'saas' || !d.postgresUrl || !d.files.kek)
    throw new AppError(
      'CONFIG_INVALID',
      'Панель владельца есть только в режиме saas (DEPLOYMENT_MODE=saas)',
      {
        field: 'DEPLOYMENT_MODE',
      },
    );
  const email = args.values['email'];
  const needEmail = (): string => {
    if (!email) throw new AppError('VALIDATION_ERROR', 'Укажите --email <email>', { field: 'email' });
    return email;
  };
  if (command === 'create' || command === 'reset-totp') requireTtyForSecret();
  const kek = readKekFile(d.files.kek);
  const db = await PostgresSqlDb.open({ connectionString: d.postgresUrl, maxConnections: 2 });
  const accounts = new OwnerAccounts({ db, secrets: ownerSecretsBox(kek) });
  try {
    switch (command) {
      case 'create': {
        const e = needEmail();
        const roleRaw = args.values['role'] ?? 'service_owner';
        if (roleRaw !== 'service_owner' && roleRaw !== 'support')
          throw new AppError('VALIDATION_ERROR', '--role: service_owner или support', { field: 'role' });
        out(
          `Учётная запись ${e} (${roleRaw}). Пароль — не короче ${String(OWNER_PASSWORD_MIN_LENGTH)} символов.`,
        );
        const password = await readPassword();
        const r = await accounts.create({ email: e, role: roleRaw, password });
        printSecret(r.name, r.secret, r.otpauthUri);
        out(`Готово: ${r.name}. Вход: <PUBLIC_BASE_URL>/owner/login (email, пароль, код TOTP).`);
        return;
      }
      case 'reset-password': {
        const e = needEmail();
        out(`Новый пароль для ${e}. Все сессии будут закрыты.`);
        await accounts.resetPassword(e, await readPassword());
        out('Пароль изменён, блокировка снята, сессии закрыты.');
        return;
      }
      case 'reset-totp': {
        const e = needEmail();
        const r = await accounts.resetTotp(e);
        printSecret(e.trim().toLowerCase(), r.secret, r.otpauthUri);
        out('Секрет TOTP заменён, сессии закрыты.');
        return;
      }
      case 'disable':
      case 'enable':
        await accounts.setDisabled(needEmail(), command === 'disable');
        out(command === 'disable' ? 'Учётная запись отключена, сессии закрыты.' : 'Учётная запись включена.');
        return;
      case 'list': {
        const list = await accounts.list();
        if (list.length === 0) out('Учётных записей владельца нет.');
        // Email учётных записей владельца выводится как есть (редактор скрыл бы его как ПДн): это список
        // собственных учётных записей владельца в его терминале; секретов в строке нет.
        for (const a of list)
          process.stdout.write(
            `  ${a.name.padEnd(32)} ${a.role.padEnd(14)} ${a.disabled ? 'отключена' : 'активна'}${a.lockedUntil && Date.parse(a.lockedUntil) > Date.now() ? `, заблокирована до ${a.lockedUntil}` : ''}; вход ${a.lastLoginAt ?? '—'}\n`,
          );
        return;
      }
      default:
        throw new AppError(
          'VALIDATION_ERROR',
          'Команда: create | reset-password | reset-totp | disable | enable | list',
          { field: 'command' },
        );
    }
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => fail(e, 1));

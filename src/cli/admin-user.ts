/**
 * npm run admin:user -- --name <имя> --principal <principalId> | --list | --remove <имя>
 * Пользователь панели /admin (ТЗ §4.5). Пароль вводится скрыто в терминале; через pipe команда
 * отказывает — как approval:review. Пароль нигде не печатается и не логируется.
 */
import { createApp } from '../app/container.js';
import { AppError } from '../errors/app-error.js';
import { ADMIN_PASSWORD_MIN_LENGTH } from '../http/admin-auth.js';
import { createSilentLogger } from '../logging/logger.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

/** Скрытый ввод: raw-режим терминала, символы не отображаются. */
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

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), {
    name: { kind: 'string' },
    principal: { kind: 'string' },
    remove: { kind: 'string' },
    list: { kind: 'boolean' },
  });
  const config = cliConfig(args);
  const app = createApp(config, { logger: createSilentLogger() });
  try {
    if (args.flags['list']) {
      const users = app.admin.list();
      if (users.length === 0) out('Пользователей панели нет.');
      for (const u of users)
        out(
          `  ${u.name.padEnd(20)} principal=${u.principalId.padEnd(16)} роль=${app.admin.role(u)}  создан ${u.createdAt}`,
        );
      return;
    }
    const toRemove = args.values['remove'];
    if (toRemove) {
      out(
        app.admin.remove(toRemove)
          ? `Пользователь ${toRemove} удалён, сессии закрыты.`
          : `Пользователь ${toRemove} не найден.`,
      );
      return;
    }
    const name = args.values['name'];
    const principal = args.values['principal'] ?? app.principal.id;
    if (!name)
      throw new AppError(
        'VALIDATION_ERROR',
        'Укажите --name <имя> (и при необходимости --principal <principalId>)',
      );
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new AppError('ACCESS_DENIED', 'Пароль вводится только в интерактивном терминале; pipe запрещён', {
        nextAction: 'Запустите команду вручную в терминале',
      });
    }
    out(
      `Пользователь панели: ${name} → principal ${principal}. Пароль: не короче ${String(ADMIN_PASSWORD_MIN_LENGTH)} символов.`,
    );
    const p1 = await readHidden('Пароль: ');
    const p2 = await readHidden('Повторите пароль: ');
    if (p1 !== p2) throw new AppError('VALIDATION_ERROR', 'Пароли не совпадают', { field: 'password' });
    const user = app.admin.upsert(name, principal, p1);
    out(`Готово: ${user.name} (роль ${app.admin.role(user)}). Вход: <публичный адрес>/admin/login`);
  } finally {
    app.close();
  }
}

main().catch((e: unknown) => fail(e, 1));

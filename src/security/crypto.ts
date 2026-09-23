/**
 * Ключ шифрования и AES-256-GCM (ТЗ §4.4, §8.1).
 * Ключ лежит в отдельном файле с правами 0600 и никогда не печатается.
 * Им шифруются планы записи и OAuth-токены в SQLite.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors/app-error.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';

export interface MasterKey {
  readonly key: Buffer;
  readonly createdNow: boolean;
}

export function ensureMasterKey(filePath: string, opts: { create: boolean }): MasterKey {
  if (existsSync(filePath)) {
    const hex = readFileSync(filePath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new AppError('CONFIG_INVALID', 'Файл ключа шифрования повреждён (ожидается 64 hex-символа)', {
        field: 'SECRETS_KEY_FILE',
        nextAction: 'Восстановите ключ из резервной копии; без него зашифрованные данные не читаются',
      });
    }
    return { key: Buffer.from(hex, 'hex'), createdNow: false };
  }
  if (!opts.create) {
    throw new AppError('CONFIG_INVALID', 'Ключ шифрования не найден; выполните npm run setup', {
      field: 'SECRETS_KEY_FILE',
      nextAction: 'npm run setup',
    });
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(filePath, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows: chmod не поддерживается, ACL ограничивает пользователь (ТЗ §8.1)
  }
  return { key, createdNow: true };
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new AppError('INTERNAL_ERROR', 'Неверная длина ключа шифрования');
  }

  encrypt(plaintext: string, aad = ''): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }

  decrypt(payload: string, aad = ''): string {
    const [version, ivB64, tagB64, ctB64] = payload.split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
      throw new AppError('INTERNAL_ERROR', 'Неверный формат зашифрованных данных');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new AppError(
        'INTERNAL_ERROR',
        'Не удалось расшифровать данные: ключ не совпадает или данные повреждены',
      );
    }
  }
}

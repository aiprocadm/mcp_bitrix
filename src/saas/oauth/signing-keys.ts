/**
 * Ключи подписи access token (SaaS-ТЗ §7.1: «ротация, публикация JWKS; старый ключ живёт до истечения выданных
 * токенов»). Хранилище — каталог OAUTH_SIGNING_KEYS_DIR (0700, файлы 0600), общий для всех экземпляров web:
 *  - `jwt-<kid>.json` — закрытый JWK (ES256 или EdDSA/Ed25519), дата создания и дата вывода из оборота;
 *  - `state.key` — 32 байта для запечатывания состояния авторизации и CSRF (см. crypto.ts).
 * kid = отпечаток JWK (RFC 7638). Активный ключ — самый новый не выведенный; после ротации прежний ключ остаётся
 * в JWKS на срок access token + запас на расхождение часов, затем файл удаляется.
 * Закрытые ключи не печатаются и не попадают в JWKS (там только открытая часть).
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  calculateJwkThumbprint,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AppError } from '../../errors/app-error.js';
import type { OAuthServerSettings, SigningAlg } from './settings.js';

interface StoredKeyFile {
  kid: string;
  alg: SigningAlg;
  createdAt: string;
  retiredAt: string | null;
  privateJwk: JWK;
}

interface LoadedKey {
  readonly file: StoredKeyFile;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly publicKey: CryptoKey;
}

/** Запас на расхождение часов при удалении выведенного ключа, с. */
const CLOCK_SKEW_SEC = 60;
/** Повторное чтение каталога при неизвестном kid — не чаще, мс. */
const RELOAD_COOLDOWN_MS = 5000;

function writePrivate(file: string, content: string | Buffer): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: права задаёт ACL каталога.
  }
  renameSync(tmp, file);
}

const PUBLIC_MEMBERS = ['kty', 'crv', 'x', 'y'] as const;

export class SigningKeyStore {
  private keys: LoadedKey[] = [];
  private lastReload = 0;

  private constructor(
    private readonly settings: OAuthServerSettings,
    private readonly secret: Buffer,
    private readonly now: () => number,
  ) {}

  /** Открыть каталог ключей: создать при отсутствии, загрузить ключи, при необходимости выпустить первый. */
  static async open(settings: OAuthServerSettings, now: () => number = Date.now): Promise<SigningKeyStore> {
    const dir = settings.signingKeysDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const statePath = path.join(dir, 'state.key');
    if (!existsSync(statePath)) {
      try {
        writeFileSync(statePath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
      } catch (e) {
        // Другой экземпляр создал файл одновременно — читаем его.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    const hex = readFileSync(statePath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new AppError('CONFIG_INVALID', 'Файл state.key в каталоге ключей сервера авторизации повреждён', {
        field: 'OAUTH_SIGNING_KEYS_DIR',
      });
    }
    const store = new SigningKeyStore(settings, Buffer.from(hex, 'hex'), now);
    await store.reload();
    if (!store.activeKey()) await store.rotate();
    return store;
  }

  /** Секрет для запечатывания состояния авторизации (32 байта). */
  stateSecret(): Buffer {
    return this.secret;
  }

  /** Перечитать каталог (другой экземпляр мог выпустить ключ) и удалить выведенные ключи с истёкшим сроком. */
  async reload(): Promise<void> {
    const dir = this.settings.signingKeysDir;
    const loaded: LoadedKey[] = [];
    const nowMs = this.now();
    for (const name of readdirSync(dir)) {
      if (!/^jwt-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const full = path.join(dir, name);
      let file: StoredKeyFile;
      try {
        file = JSON.parse(readFileSync(full, 'utf8')) as StoredKeyFile;
      } catch {
        continue; // файл в процессе записи другим экземпляром — прочитаем в следующий раз
      }
      if (file.retiredAt) {
        const expires =
          Date.parse(file.retiredAt) + (this.settings.accessTokenTtlSec + CLOCK_SKEW_SEC) * 1000;
        if (expires <= nowMs) {
          rmSync(full, { force: true });
          continue;
        }
      }
      loaded.push(await SigningKeyStore.load(file));
    }
    loaded.sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt));
    this.keys = loaded;
    this.lastReload = nowMs;
  }

  private static async load(file: StoredKeyFile): Promise<LoadedKey> {
    const privateKey = (await importJWK(file.privateJwk, file.alg)) as CryptoKey;
    const publicJwk: JWK = {};
    for (const m of PUBLIC_MEMBERS) {
      const v = file.privateJwk[m];
      if (typeof v === 'string') publicJwk[m] = v;
    }
    Object.assign(publicJwk, { kid: file.kid, alg: file.alg, use: 'sig' });
    const publicKey = (await importJWK(publicJwk, file.alg)) as CryptoKey;
    return { file, privateKey, publicJwk, publicKey };
  }

  private activeKey(): LoadedKey | undefined {
    return this.keys.find((k) => !k.file.retiredAt);
  }

  /** Выпустить новый ключ и вывести из оборота прежние (они остаются в JWKS до истечения выданных токенов). */
  async rotate(): Promise<string> {
    const alg = this.settings.signingAlg;
    const { privateKey } = await generateKeyPair(alg === 'EdDSA' ? 'Ed25519' : 'ES256', {
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(privateJwk);
    const createdAt = new Date(this.now()).toISOString();
    const dir = this.settings.signingKeysDir;
    writePrivate(
      path.join(dir, `jwt-${kid}.json`),
      JSON.stringify({ kid, alg, createdAt, retiredAt: null, privateJwk } satisfies StoredKeyFile),
    );
    for (const k of this.keys) {
      if (k.file.retiredAt) continue;
      writePrivate(
        path.join(dir, `jwt-${k.file.kid}.json`),
        JSON.stringify({ ...k.file, retiredAt: createdAt } satisfies StoredKeyFile),
      );
    }
    await this.reload();
    return kid;
  }

  /** Автоматическая ротация по возрасту активного ключа (вызывается при подписи и worker). */
  async rotateIfDue(): Promise<boolean> {
    const active = this.activeKey();
    if (active && Date.parse(active.file.createdAt) + this.settings.signingKeyRotationSec * 1000 > this.now())
      return false;
    await this.reload(); // возможно, другой экземпляр уже выпустил новый ключ
    const fresh = this.activeKey();
    if (fresh && Date.parse(fresh.file.createdAt) + this.settings.signingKeyRotationSec * 1000 > this.now())
      return false;
    await this.rotate();
    return true;
  }

  async sign(claims: JWTPayload, ttlSec: number): Promise<string> {
    await this.rotateIfDue();
    const key = this.activeKey();
    if (!key) throw new AppError('INTERNAL_ERROR', 'Нет активного ключа подписи');
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: key.file.alg, kid: key.file.kid, typ: 'at+jwt' })
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlSec)
      .sign(key.privateKey);
  }

  /** Документ JWKS (RFC 7517): только открытые части действующих ключей. */
  jwks(): { keys: JWK[] } {
    return { keys: this.keys.map((k) => ({ ...k.publicJwk })) };
  }

  /** Выбор ключа проверки по kid; неизвестный kid — однократное перечитывание каталога. */
  readonly getKey: JWTVerifyGetKey = async (header) => {
    const find = () => this.keys.find((k) => k.file.kid === header.kid && k.file.alg === header.alg);
    let key = find();
    if (!key && this.now() - this.lastReload > RELOAD_COOLDOWN_MS) {
      await this.reload();
      key = find();
    }
    if (!key) throw new joseErrors.JWKSNoMatchingKey();
    return key.publicKey;
  };

  /** kid текущего активного ключа (для тестов и диагностики). */
  activeKid(): string | undefined {
    return this.activeKey()?.file.kid;
  }
}

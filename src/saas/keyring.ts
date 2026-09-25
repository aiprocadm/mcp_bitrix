/**
 * Конвертное шифрование (SaaS-ТЗ D7, §12 п.3): у каждого арендатора свой ключ данных (DEK, 32 байта),
 * он хранится в tenants.dek_encrypted зашифрованным главным ключом (KEK) с привязкой AAD к арендатору.
 * Токены Bitrix24, планы и результаты операций арендатора шифруются его DEK.
 * Криптоудаление: dek_encrypted = NULL — все зашифрованные данные арендатора становятся нечитаемыми.
 * KEK — вне БД и бэкапов (файл 0600 или KMS), в БД не попадает никогда.
 */
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { SecretBox } from '../security/crypto.js';
import type { SqlExecutor } from '../storage/sql.js';

const aad = (tenantId: string) => `tenant-dek:${tenantId}`;

export class TenantKeyRing {
  private readonly kek: SecretBox;
  private readonly cache = new Map<string, SecretBox>();

  constructor(kek: Buffer) {
    if (kek.length !== 32)
      throw new AppError('CONFIG_INVALID', 'KEK должен быть 32 байта', { field: 'KEK_FILE' });
    this.kek = new SecretBox(kek);
  }

  /** Новый DEK для создаваемого арендатора: значение для tenants.dek_encrypted. */
  newWrappedDek(tenantId: string): string {
    return this.kek.encrypt(randomBytes(32).toString('base64'), aad(tenantId));
  }

  /** SecretBox арендатора из его обёрнутого DEK (кэш в памяти процесса). */
  boxFromWrapped(tenantId: string, wrapped: string | null): SecretBox {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    if (!wrapped) {
      throw new AppError('NOT_FOUND', 'Данные арендатора удалены (ключ уничтожен)', {
        reason: 'TENANT_KEY_DESTROYED',
      });
    }
    const dek = Buffer.from(this.kek.decrypt(wrapped, aad(tenantId)), 'base64');
    const box = new SecretBox(dek);
    this.cache.set(tenantId, box);
    return box;
  }

  /** Загрузка DEK из БД (таблица tenants — каталог без RLS). */
  async boxFor(x: SqlExecutor, tenantId: string): Promise<SecretBox> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const row = await x.get<{ dek_encrypted: string | null }>(
      'SELECT dek_encrypted FROM tenants WHERE id = ?',
      tenantId,
    );
    if (!row) throw new AppError('NOT_FOUND', 'Арендатор не найден', { reason: 'TENANT_NOT_FOUND' });
    return this.boxFromWrapped(tenantId, row.dek_encrypted);
  }

  /** Криптоудаление: ключ стирается в БД и в кэше; расшифровать данные арендатора больше нельзя. */
  async destroy(x: SqlExecutor, tenantId: string): Promise<void> {
    await x.run(
      'UPDATE tenants SET dek_encrypted = NULL, updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      tenantId,
    );
    this.cache.delete(tenantId);
  }

  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

/**
 * Обработчик событий приложения Bitrix24 (SaaS-ТЗ §8, §4 сценарий 6, §7.4, тест S04).
 *
 * `ONAPPUNINSTALL` (api-reference/common/events/on-app-uninstall.md): токенов в событии нет — «comparing
 * application_token with the retained value becomes the only way to make sure that the event handler was called by
 * Bitrix24» (api-reference/events/safe-event-handlers.md). Несовпадение → 403 и никаких изменений.
 * Верное событие → арендатор `uninstalled`, все токены Bitrix24 арендатора удалены, поколение всех пользователей +1
 * (выданные MCP-токены сервиса отклоняются), неисполненные операции аннулированы, кэши контекстов сброшены.
 * Данные арендатора удаляются по регламенту §6.3/§14 (не здесь); флаг CLEAN из события возвращается вызывающему.
 */
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import type { SqlDb } from '../../storage/sql.js';
import type { Coordination } from '../coordination.js';
import type { TenantsRepo } from '../repos/tenants.js';
import { parseEventPayload, type BitrixEventPayload } from './event-payload.js';
import { appTokenMatches, type BitrixInstallService, type InstallResult } from './install-service.js';
import { publishInvalidate } from './invalidation.js';

export interface UninstallResult {
  readonly tenantId: string;
  readonly tokensDeleted: number;
  readonly usersRevoked: number;
  readonly operationsDenied: number;
  /** Пользователь выбрал «Очистить данные приложения» (data.CLEAN = 1). */
  readonly cleanRequested: boolean;
}

export type EventResult =
  | { readonly event: 'ONAPPINSTALL'; readonly install: InstallResult }
  | { readonly event: 'ONAPPUNINSTALL'; readonly uninstall: UninstallResult }
  | { readonly event: 'ONAPPUPDATE'; readonly tenantId: string; readonly eventsBound: readonly string[] }
  | { readonly event: string; readonly ignored: true };

export interface BitrixEventsServiceDeps {
  readonly db: SqlDb;
  readonly tenants: TenantsRepo;
  readonly install: BitrixInstallService;
  readonly coordination: Coordination;
  readonly logger: AppLogger;
}

const forged = () =>
  new AppError('ACCESS_DENIED', 'Событие не подтверждено подписью приложения', {
    reason: 'APP_TOKEN_MISMATCH',
  });

export class BitrixEventsService {
  constructor(private readonly d: BitrixEventsServiceDeps) {}

  /** Единая точка для маршрута обработчика событий: тело запроса как есть (форма или JSON). */
  async handle(body: string | URLSearchParams | Record<string, unknown>): Promise<EventResult> {
    const p = parseEventPayload(body);
    switch (p.event) {
      case 'ONAPPINSTALL':
        return { event: p.event, install: await this.d.install.handleInstallEvent(p) };
      case 'ONAPPUNINSTALL':
        return { event: p.event, uninstall: await this.handleUninstall(p) };
      case 'ONAPPUPDATE':
        return { event: p.event, ...(await this.d.install.handleUpdateEvent(p)) };
      default:
        // ONAPPUSERREADY и прочие: подпись проверяется, содержимое сервису не нужно (D3: системный пользователь не используется).
        await this.verify(p);
        return { event: p.event, ignored: true };
    }
  }

  /** Подлинность события работающего/удалённого арендатора; чужой портал = как подделка (не раскрываем). */
  private async verify(p: BitrixEventPayload): Promise<string> {
    const tenant = await this.d.tenants.getByMemberId(p.auth.memberId);
    if (!tenant) throw forged();
    const stored = await this.d.tenants.appTokenHash(tenant.id);
    if (!appTokenMatches(stored, p.auth.applicationToken)) throw forged();
    return tenant.id;
  }

  async handleUninstall(p: BitrixEventPayload): Promise<UninstallResult> {
    if (p.event !== 'ONAPPUNINSTALL')
      throw new AppError('VALIDATION_ERROR', 'Ожидалось событие ONAPPUNINSTALL');
    const tenantId = await this.verify(p);
    const now = new Date().toISOString();
    // Одна транзакция: либо арендатор отключён целиком (статус, токены, поколения, операции), либо ничего.
    const { tokensDeleted, usersRevoked, operationsDenied } = await this.d.db.withTenant(
      tenantId,
      async (x) => {
        await x.run(
          "UPDATE tenants SET status = 'uninstalled', uninstalled_at = ?, updated_at = ? WHERE id = ? AND status IN ('active','suspended')",
          now,
          now,
          tenantId,
        );
        const tokensDeleted = await x.run('DELETE FROM bitrix_tokens WHERE tenant_id = ?', tenantId);
        const usersRevoked = await x.run(
          'UPDATE tenant_users SET token_generation = token_generation + 1, updated_at = ? WHERE tenant_id = ?',
          now,
          tenantId,
        );
        const operationsDenied = await x.run(
          "UPDATE operations SET status = 'denied', finished_at = ? WHERE tenant_id = ? AND status IN ('prepared','approved')",
          now,
          tenantId,
        );
        return { tokensDeleted, usersRevoked, operationsDenied };
      },
    );
    await publishInvalidate(this.d.coordination, tenantId);
    const clean = p.data['CLEAN'];
    const result = {
      tenantId,
      tokensDeleted,
      usersRevoked,
      operationsDenied,
      cleanRequested: clean === 1 || clean === '1',
    };
    this.d.logger.info({ ...result }, 'bitrix app uninstalled');
    return result;
  }
}

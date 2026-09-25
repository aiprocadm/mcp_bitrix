/**
 * Сборка веб-приложения режима saas из частей (SaaS-ТЗ §5.1, §11): MCP + сервер авторизации (src/saas/http.ts),
 * кабинет клиента `/app` (S5) и, если передана, панель владельца `/owner` (S9) — через `extraRoutes`.
 * Обратный вызов Bitrix24 с `state` кабинета уходит кабинету; с `state` сервера авторизации — серверу авторизации.
 */
import type { FastifyInstance } from 'fastify';
import { createCabinet, type Cabinet } from './cabinet/index.js';
import type { CabinetDeps } from './cabinet/types.js';
import type { SaasHttpOptions } from './http.js';
import type { SaasRuntime } from './runtime.js';
import { TenantDataDeletion } from './tenant-deletion.js';

/** Зависимости кабинета из собранного runtime: тот же ApprovalService и ключ планов, что исполняют вызовы MCP. */
export function cabinetDepsFromRuntime(rt: SaasRuntime): CabinetDeps {
  const revokeTenant = (tenantId: string) => rt.oauth.server.revokeTenant(tenantId);
  const deletion = new TenantDataDeletion({
    db: rt.db,
    keys: rt.keyring,
    fileStaging: rt.fileStaging,
    revokeTenant,
    coordination: rt.coordination,
    logger: rt.logger,
  });
  const files = rt.config.files;
  return {
    publicBaseUrl: rt.publicBaseUrl,
    db: rt.db,
    keys: rt.keyring,
    tenants: rt.repos.tenants,
    users: rt.repos.users,
    settings: rt.repos.tenantSettings,
    plans: rt.repos.plans,
    subscriptions: rt.repos.subscriptions,
    login: rt.bitrix.login,
    scopeFor: (tenantId, userId) => rt.scopeFor(tenantId, userId),
    audit: rt.audit,
    usage: rt.billing.usage,
    billing: rt.billing.subscriptions,
    revokeUser: (tenantId, userId) => rt.oauth.server.revokeUser(tenantId, userId),
    revokeTenant,
    deleteTenantData: (tenantId, req) => deletion.deleteAll(tenantId, req),
    fileStaging: rt.fileStaging,
    files: {
      maxUploadBytes: files.maxUploadBytes,
      uploadTtlSeconds: files.uploadTtlSeconds,
      scanRequired: files.scanRequired,
    },
    coordination: rt.coordination,
    logger: rt.logger,
  };
}

export interface SaasWebOptions {
  /** Дополнительные разделы (панель владельца `/owner`) — регистрируются рядом с кабинетом. */
  readonly extraRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Для тестов: готовый кабинет вместо собранного из runtime. */
  readonly cabinet?: Cabinet;
}

/** Опции HTTP-приложения saas с подключённым кабинетом. */
export function saasWebHttpOptions(rt: SaasRuntime, opts: SaasWebOptions = {}): SaasHttpOptions {
  const cabinet = opts.cabinet ?? createCabinet(cabinetDepsFromRuntime(rt));
  const extra = opts.extraRoutes;
  return {
    cabinetCallback: (req, reply) => cabinet.replyBitrixCallback(req, reply),
    extraRoutes: async (app) => {
      cabinet.register(app);
      if (extra) await extra(app);
    },
  };
}

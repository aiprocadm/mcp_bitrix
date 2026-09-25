/**
 * Сборка веб-приложения режима saas из частей (SaaS-ТЗ §5.1, §11): MCP + сервер авторизации (src/saas/http.ts),
 * кабинет клиента `/app` (S5) и панель владельца `/owner` (S9) — через `extraRoutes`.
 * Обратный вызов Bitrix24 с `state` кабинета уходит кабинету; с `state` сервера авторизации — серверу авторизации.
 */
import type { FastifyInstance } from 'fastify';
import { createCabinet, type Cabinet } from './cabinet/index.js';
import type { CabinetDeps } from './cabinet/types.js';
import type { SaasHttpOptions } from './http.js';
import { registerOwnerPanel, type OwnerPanelDeps } from './owner/index.js';
import type { SaasRuntime } from './runtime.js';
import { tenantDeletionFromRuntime } from './tenant-deletion.js';

/** Зависимости кабинета из собранного runtime: тот же ApprovalService и ключ планов, что исполняют вызовы MCP. */
export function cabinetDepsFromRuntime(rt: SaasRuntime): CabinetDeps {
  const revokeTenant = (tenantId: string) => rt.oauth.server.revokeTenant(tenantId);
  const deletion = tenantDeletionFromRuntime(rt);
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

/** Зависимости панели владельца из runtime: данные арендаторов не читает, только сводки и биллинг. */
export function ownerDepsFromRuntime(rt: SaasRuntime): OwnerPanelDeps {
  return {
    db: rt.db,
    ownerSecrets: rt.ownerSecrets,
    tenants: rt.repos.tenants,
    plans: rt.repos.plans,
    subscriptions: rt.repos.subscriptions,
    billing: rt.billing.subscriptions,
    coordination: rt.coordination,
    revokeTenant: (tenantId) => rt.oauth.server.revokeTenant(tenantId),
    entitlements: rt.billing.entitlements,
    metrics: rt.metrics.registry,
    logger: rt.logger,
    publicOrigin: new URL(rt.publicBaseUrl).origin,
  };
}

export interface SaasWebOptions {
  /** false — не регистрировать панель владельца `/owner` на этом экземпляре. */
  readonly ownerPanel?: boolean;
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
      if (opts.ownerPanel !== false) registerOwnerPanel(app, ownerDepsFromRuntime(rt));
      if (extra) await extra(app);
    },
  };
}

/** Панель владельца `/owner` (SaaS-ТЗ §11.3, этап S9). Подключение — `registerOwnerPanel(app, deps)`. */
export { registerOwnerPanel, type OwnerPanelDeps } from './panel.js';
export {
  OwnerAccounts,
  ownerSecretsBox,
  readKekFile,
  normalizeOwnerEmail,
  assertOwnerPasswordPolicy,
  OWNER_PASSWORD_MIN_LENGTH,
  type OwnerRole,
  type OwnerUser,
  type OwnerSession,
} from './accounts.js';
export { OwnerService, type MetricsSummary, type TenantOverview, type TenantDetail } from './service.js';
export { Announcements, type Announcement, type AnnouncementLevel } from './announcements.js';
export { base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUri } from './totp.js';

/** Сервер авторизации MCP режима saas (этап S4): публичный интерфейс модуля. */
export {
  AuthorizationServer,
  isAuthServerState,
  OAUTH_ROUTES,
  REVOCATION_CHANNEL,
  type AuthorizationServerDeps,
  type OAuthRequest,
  type OAuthResponse,
} from './server.js';
export { SaasTokenVerifier, requireScope, saasWwwAuthenticate, type SaasPrincipal } from './verifier.js';
export { SigningKeyStore } from './signing-keys.js';
export {
  mcpResource,
  OAUTH_DEFAULTS,
  OAUTH_SCOPES,
  protectedResourceMetadataUrl,
  resolveOAuthSettings,
  type OAuthScope,
  type OAuthServerSettings,
  type SigningAlg,
} from './settings.js';
export { PORTAL_NOT_INSTALLED, type BitrixLoginGateway, type BitrixLoginIdentity } from './gateway.js';
export { AuthCodesRepo, ConsentsRepo, OAuthClientsRepo, RefreshTokensRepo } from './stores.js';

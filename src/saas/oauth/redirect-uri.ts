/**
 * Правила redirect_uri (спецификация MCP 2026-07-28, basic/authorization/security-considerations.mdx:
 * «All redirect URIs MUST be either localhost or use HTTPS», «Authorization servers MUST validate exact redirect
 * URIs against pre-registered values»; OAuth 2.1 draft-13 §8.4.2 «Loopback Interface Redirection»: для loopback IP
 * AS обязан принимать любой порт, указанный в момент запроса).
 *
 * - Регистрация: абсолютный URI без fragment и учётных данных; https или http на loopback (localhost, 127.0.0.1, [::1]).
 *   Прочие схемы (javascript:, data:, собственные схемы приложений) отклоняются.
 * - Сверка в /authorize и /token: точное совпадение строк; единственное исключение — http на loopback IP
 *   (127.0.0.1, [::1]), где порт не сравнивается (схема, хост, путь и query — точно).
 *   Для `localhost` порт сравнивается точно: OAuth 2.1 распространяет исключение только на IP-литералы.
 */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_IPS = new Set(['127.0.0.1', '[::1]']);

export const MAX_REDIRECT_URI_LENGTH = 2000;

/** Проверка URI при регистрации клиента; причина отказа — для error_description. */
export function redirectUriProblem(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || uri.length === 0) return 'redirect_uri должен быть непустой строкой';
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return 'redirect_uri слишком длинный';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'redirect_uri не является абсолютным URI';
  }
  if (url.hash || uri.includes('#')) return 'redirect_uri не должен содержать fragment';
  if (url.username || url.password) return 'redirect_uri не должен содержать учётные данные';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOOPBACK_NAMES.has(url.hostname)) return undefined;
  return 'redirect_uri должен использовать https (http допустим только для localhost/127.0.0.1/[::1])';
}

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_NAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Совпадает ли URI из запроса с одним из зарегистрированных. */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !LOOPBACK_IPS.has(req.hostname) || req.hash) return false;
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return (
      reg.protocol === 'http:' &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search &&
      !reg.username &&
      !req.username &&
      !req.password
    );
  });
}

/** Хост redirect_uri для экрана согласия (спецификация: «MUST clearly display the redirect URI hostname»). */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

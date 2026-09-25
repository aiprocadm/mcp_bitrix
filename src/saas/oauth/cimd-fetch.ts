/**
 * Единственный сетевой адаптер сервера авторизации: загрузка Client ID Metadata Document по URL client_id
 * (спецификация MCP 2026-07-28, basic/authorization/client-registration.mdx «Client ID Metadata Documents»;
 * защита от SSRF — security-considerations.mdx «Authorization Server Abuse Protection» и
 * docs/2026-07-28/tutorials/security/security_best_practices.mdx «Server-Side Request Forgery»).
 *
 * Меры: только https и порт 443; хост — доменное имя (IP-литералы и localhost отклоняются); все адреса имени
 * должны быть публичными (частные, loopback, link-local, CGNAT, multicast, зарезервированные, в т.ч. в виде
 * IPv4-mapped IPv6 — отказ; проверка через net.BlockList, без ручного разбора); без следования редиректам;
 * таймаут; лимит размера тела. Функция fetch внедряется (тесты — без сети).
 * Остаточный риск: DNS rebinding между проверкой имени и соединением fetch (описан в docs/saas/s4-oauth.md).
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { FetchLike } from '../../bitrix/client.js';

export type HostResolver = (host: string) => Promise<string[]>;

export const defaultResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, 'ipv4');
  if (family === 6) return !BLOCKED.check(ip, 'ipv6');
  return false;
}

export class CimdFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CimdFetchError';
  }
}

export interface CimdFetchOptions {
  readonly fetch: FetchLike;
  readonly resolve: HostResolver;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface CimdFetchResult {
  readonly body: string;
  readonly cacheControl: string | null;
}

export async function fetchClientMetadataDocument(
  url: URL,
  opts: CimdFetchOptions,
): Promise<CimdFetchResult> {
  if (url.protocol !== 'https:' || (url.port && url.port !== '443'))
    throw new CimdFetchError('допустим только https на порту 443');
  const host = url.hostname;
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host === 'localhost' || host.endsWith('.localhost'))
    throw new CimdFetchError('хост client_id должен быть публичным доменным именем');
  let addresses: string[];
  try {
    addresses = await opts.resolve(host);
  } catch {
    throw new CimdFetchError('имя хоста client_id не разрешается');
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress))
    throw new CimdFetchError('хост client_id разрешается в непубличный адрес');

  let res: Response;
  try {
    res = await opts.fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch {
    throw new CimdFetchError('документ метаданных клиента недоступен');
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new CimdFetchError(`документ метаданных клиента вернул HTTP ${String(res.status)}`);
  }
  if (!res.body) throw new CimdFetchError('пустой ответ');
  const chunks: Uint8Array[] = [];
  let size = 0;
  // ReadableStream в Node — async-итерируемый; выход из цикла отменяет поток (как в src/bitrix/client.ts).
  for await (const value of res.body as AsyncIterable<Uint8Array>) {
    size += value.byteLength;
    if (size > opts.maxBytes)
      throw new CimdFetchError('документ метаданных клиента превышает допустимый размер');
    chunks.push(value);
  }
  return {
    body: Buffer.concat(chunks).toString('utf8'),
    cacheControl: res.headers.get('cache-control'),
  };
}

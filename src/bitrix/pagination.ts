/**
 * Пагинация (ТЗ §14.3).
 *  - Курсор — случайный ключ к серверному состоянию в SQLite с TTL, привязанный к
 *    principal/portal/tool/filter/order/select (T21).
 *  - Legacy start/next: остаток upstream-страницы (50) буферизуется, чтобы при pageSize=20
 *    не потерять 30 записей (T20). Буфер шифруется.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import type { SecretBox } from '../security/crypto.js';
import type { SqlDb } from '../storage/sql.js';
import type { JsonValue } from './legacy-adapter.js';

export interface CursorBinding {
  readonly principalId: string;
  readonly portalKey: string;
  readonly tool: string;
  /** Канонический JSON фильтра/порядка/выборки/pageSize. */
  readonly bindingHash: string;
}

export function bindingHash(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Курсоры арендатора (SaaS-ТЗ §6.2): курсор другого арендатора неотличим от несуществующего. */
export class CursorStore {
  constructor(
    private readonly db: SqlDb,
    private readonly box: SecretBox,
    private readonly ttlSeconds: number,
    readonly tenantId: string,
  ) {}

  async create(binding: CursorBinding, state: unknown): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    await this.db.withTenant(this.tenantId, (x) =>
      x.run(
        'INSERT INTO cursors (id, tenant_id, principal_id, portal_key, tool, binding_hash, state_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        this.tenantId,
        binding.principalId,
        binding.portalKey,
        binding.tool,
        binding.bindingHash,
        this.box.encrypt(JSON.stringify(state), id),
        new Date(now).toISOString(),
        new Date(now + this.ttlSeconds * 1000).toISOString(),
      ),
    );
    return id;
  }

  /** Загружает и удаляет курсор (одноразовый). Несовпадение привязки — ошибка без чтения состояния. */
  async consume<T>(id: string, binding: CursorBinding): Promise<T> {
    const state = await this.peek<T>(id, binding);
    await this.discard(id);
    return state;
  }

  /**
   * Загружает курсор, не расходуя его: страница читается до удаления, чтобы временная ошибка портала
   * не лишала продолжения. После успешной загрузки вызывающий обязан вызвать discard().
   */
  async peek<T>(id: string, binding: CursorBinding): Promise<T> {
    const row = await this.db.withTenant(this.tenantId, (x) =>
      x.get<{
        principal_id: string;
        portal_key: string;
        tool: string;
        binding_hash: string;
        state_json: string;
        expires_at: string;
      }>(
        'SELECT principal_id, portal_key, tool, binding_hash, state_json, expires_at FROM cursors WHERE tenant_id = ? AND id = ?',
        this.tenantId,
        id,
      ),
    );
    const invalid = () =>
      new AppError(
        'VALIDATION_ERROR',
        'Курсор недействителен: истёк, уже использован или не соответствует запросу',
        {
          field: 'cursor',
          nextAction: 'Повторите запрос без cursor с теми же фильтрами',
        },
      );
    if (!row) throw invalid();
    if (
      row.principal_id !== binding.principalId ||
      row.portal_key !== binding.portalKey ||
      row.tool !== binding.tool ||
      row.binding_hash !== binding.bindingHash
    ) {
      throw invalid();
    }
    if (Date.parse(row.expires_at) < Date.now()) {
      await this.discard(id);
      throw invalid();
    }
    return JSON.parse(this.box.decrypt(row.state_json, id)) as T;
  }

  async discard(id: string): Promise<void> {
    await this.db.withTenant(this.tenantId, (x) =>
      x.run('DELETE FROM cursors WHERE tenant_id = ? AND id = ?', this.tenantId, id),
    );
  }

  async cleanupExpired(): Promise<void> {
    await this.db.withTenant(this.tenantId, (x) =>
      x.run(
        'DELETE FROM cursors WHERE tenant_id = ? AND expires_at < ?',
        this.tenantId,
        new Date().toISOString(),
      ),
    );
  }
}

export interface LegacyPageState {
  /** Смещение следующей upstream-страницы; undefined = страниц больше нет. */
  start: number | undefined;
  /** Ещё не отданные элементы из последней upstream-страницы. */
  buffer: JsonValue[];
}

export interface UpstreamPage {
  items: JsonValue[];
  next: number | undefined;
  total: number | undefined;
}

export interface PageResult {
  items: JsonValue[];
  nextCursor: string | null;
  hasMore: boolean;
  upstreamTotal: number | undefined;
  upstreamCalls: number;
}

/**
 * Собирает страницу из pageSize элементов, буферизуя остаток upstream-страницы.
 * За один вызов делает не более `maxUpstreamCalls` запросов.
 */
export async function paginateLegacy(opts: {
  store: CursorStore;
  binding: CursorBinding;
  cursor: string | undefined;
  pageSize: number;
  maxUpstreamCalls?: number;
  fetchPage: (start: number) => Promise<UpstreamPage>;
}): Promise<PageResult> {
  const maxCalls = opts.maxUpstreamCalls ?? 2;
  let state: LegacyPageState = opts.cursor
    ? await opts.store.peek<LegacyPageState>(opts.cursor, opts.binding)
    : { start: 0, buffer: [] };
  let items: JsonValue[] = [...state.buffer];
  let upstreamTotal: number | undefined;
  let calls = 0;
  while (items.length < opts.pageSize && state.start !== undefined && calls < maxCalls) {
    const page = await opts.fetchPage(state.start);
    calls += 1;
    items = items.concat(page.items);
    upstreamTotal = page.total;
    // Только фактический `next`; отсутствие next = страниц больше нет.
    state = { start: page.next, buffer: [] };
    if (page.items.length === 0) state = { start: undefined, buffer: [] };
  }
  // Курсор расходуется только после успешной загрузки: сбой портала выше оставляет его рабочим.
  if (opts.cursor) await opts.store.discard(opts.cursor);
  const pageItems = items.slice(0, opts.pageSize);
  const remainder = items.slice(opts.pageSize);
  const hasMore = remainder.length > 0 || state.start !== undefined;
  const nextCursor = hasMore
    ? await opts.store.create(opts.binding, {
        start: state.start,
        buffer: remainder,
      } satisfies LegacyPageState)
    : null;
  return { items: pageItems, nextCursor, hasMore, upstreamTotal, upstreamCalls: calls };
}

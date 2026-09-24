/**
 * Панель /admin (ТЗ §4.5, §8.2 п.3, §8.5): отдельный вход, cookie-сессия, CSRF, решение словом,
 * права по ролям, web-upload с fileToken. MCP-токен панель не открывает; без панели маршрутов нет.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/principal.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import { startHttp, type HttpHandle } from '../../src/mcp/http.js';
import type { Envelope } from '../../src/mcp/result.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { makeFakeCreateTool, type FakeWriteHooks } from '../helpers/fake-write-tool.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

const PASSWORD = 'correct horse battery staple';
const KEY1 = randomUUID();
const KEY2 = randomUUID();
const KEY3 = randomUUID();
const OP: Principal = { id: 'op', role: 'operator', source: 'oauth' };
const OWNER: Principal = { id: 'owner', role: 'administrator', source: 'local' };
const defOf = (app: TestApp) => {
  const d = app.app.tools.find((x) => x.name === 'test_create');
  if (!d) throw new Error('tool missing');
  return d;
};

describe('панель /admin', () => {
  let t: TestApp;
  let handle: HttpHandle;
  let base: string;
  let policyDir: string;
  let hooks: FakeWriteHooks;

  const opId = (env: Envelope): string => {
    const id = env.success ? undefined : env.error.details.operationId;
    if (typeof id !== 'string') throw new Error(`ожидался operationId: ${JSON.stringify(env)}`);
    return id;
  };
  const prepare = async (principal: Principal, title: string, key: string) => {
    const def = t.app.tools.find((x) => x.name === 'test_create');
    if (!def) throw new Error('tool missing');
    return dispatch(def, { title, idempotencyKey: key }, t.app, undefined, principal);
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const post = (p: string, body: string | FormData, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...(typeof body === 'string' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        origin: base,
        ...headers,
      },
      body,
    });
  const get = (p: string, cookie?: string) =>
    fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const login = async (name: string, password = PASSWORD): Promise<{ cookie: string; csrf: string }> => {
    const r = await post('/admin/login', form({ name, password }));
    expect(r.status).toBe(303);
    const setCookie = r.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    const pageHtml = await (await get('/admin/operations', cookie)).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(pageHtml)?.[1] ?? '';
    expect(csrf).not.toBe('');
    return { cookie, csrf };
  };

  beforeAll(async () => {
    policyDir = mkdtempSync(path.join(tmpdir(), 'mcp-admin-'));
    const accessFile = path.join(policyDir, 'access.json');
    writeFileSync(
      accessFile,
      JSON.stringify({
        version: 'test',
        principals: { owner: { role: 'administrator' }, op: { role: 'operator' }, ro: { role: 'reader' } },
        deniedTools: {},
      }),
    );
    hooks = { performCalls: 0, verifyCalls: 0, precheckCalls: 0 };
    t = createTestApp(
      {
        MCP_TRANSPORT: 'http',
        MCP_HOST: '127.0.0.1',
        ADMIN_PANEL_ENABLED: 'true',
        ACCESS_POLICY_FILE: accessFile,
        READ_ONLY_MODE: 'false',
        CONFIRM_ALL_WRITES: 'true',
      },
      [makeFakeCreateTool(hooks)],
    );
    t.bitrix.on('crm.deal.add', legacyOk(101));
    t.app.admin.upsert('boss', 'owner', PASSWORD);
    t.app.admin.upsert('op1', 'op', PASSWORD);
    t.app.admin.upsert('viewer', 'ro', PASSWORD);
    handle = await startHttp(t.app, { host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${String(handle.port)}`;
  });
  afterAll(async () => {
    await handle.close();
    t.app.close();
    rmSync(policyDir, { recursive: true, force: true });
  });

  it('без панели маршрутов /admin нет; с панелью — без сессии редирект на вход, POST без сессии 401', async () => {
    const off = createTestApp({ MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1' });
    const h = await startHttp(off.app, { host: '127.0.0.1', port: 0 });
    try {
      expect((await fetch(`http://127.0.0.1:${String(h.port)}/admin/login`)).status).toBe(404);
    } finally {
      await h.close();
      off.app.close();
    }
    const r = await get('/admin/operations');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/login');
    expect((await post('/admin/logout', form({ _csrf: 'x' }))).status).toBe(401);
    const login = await get('/admin/login');
    expect(login.status).toBe(200);
    expect(login.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(login.headers.get('cache-control')).toBe('no-store');
  });

  it('вход: пароль по scrypt, неверный → 401, шесть попыток → 429, чужой Origin → 403; cookie HttpOnly+SameSite=Strict', async () => {
    expect((await post('/admin/login', form({ name: 'boss', password: 'wrong-password-123' }))).status).toBe(
      401,
    );
    for (let i = 0; i < 5; i += 1)
      await post('/admin/login', form({ name: 'nobody', password: 'x'.repeat(12) }));
    expect((await post('/admin/login', form({ name: 'nobody', password: 'x'.repeat(12) }))).status).toBe(429);
    expect(
      (
        await post('/admin/login', form({ name: 'boss', password: PASSWORD }), {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    const ok = await post('/admin/login', form({ name: 'boss', password: PASSWORD }));
    expect(ok.status).toBe(303);
    const sc = ok.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/^mcp_admin=[A-Za-z0-9_-]+; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=28800$/);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_sessions')?.n).toBeGreaterThanOrEqual(
      1,
    );
    // В БД — только хеш cookie
    const raw = sc.split(';')[0]?.split('=')[1] ?? '';
    expect(t.app.db.get('SELECT 1 AS x FROM admin_sessions WHERE id_hash = ?', raw)).toBeUndefined();
  });

  it('операции: план оператора op виден владельцу; CSRF/Origin/слово проверяются; подтверждение → повтор вызова с approvalId выполняет запись один раз', async () => {
    const prep = await prepare(OP, '[MCP TEST] панель', KEY1);
    const id = opId(prep);
    const boss = await login('boss');
    const list = await (await get('/admin/operations', boss.cookie)).text();
    expect(list).toContain(id.slice(0, 8));
    expect(list).toContain('<code>op</code>');
    const detail = await (await get(`/admin/operations/${id}`, boss.cookie)).text();
    expect(detail).toContain('[MCP TEST] панель');
    expect(detail).toContain('Могут сработать роботы');
    // без Origin → 403 (Sec-Fetch-Site/Referer тоже нет)
    const noOrigin = await fetch(`${base}/admin/operations/${id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: boss.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ _csrf: boss.csrf, decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
    });
    expect(noOrigin.status).toBe(403);
    expect(
      (
        await post(
          `/admin/operations/${id}`,
          form({ _csrf: 'stale', decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
          { cookie: boss.cookie },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(`/admin/operations/${id}`, form({ _csrf: boss.csrf, decision: 'approve', word: 'да' }), {
          cookie: boss.cookie,
        })
      ).status,
    ).toBe(400);
    expect(t.app.operations.view(id, 'op', t.app.auth.portalKey)?.status).toBe('prepared');
    expect(hooks.performCalls).toBe(0);
    const approve = await post(
      `/admin/operations/${id}`,
      form({ _csrf: boss.csrf, decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
      { cookie: boss.cookie },
    );
    expect(approve.status).toBe(303);
    expect(approve.headers.get('location')).toBe(`/admin/operations/${id}?done=approved`);
    expect(t.app.operations.view(id, 'op', t.app.auth.portalKey)?.status).toBe('approved');
    const done = await prepare(OP, '[MCP TEST] панель', KEY1);
    const withApproval = await dispatch(
      defOf(t),
      { title: '[MCP TEST] панель', idempotencyKey: KEY1, approvalId: id },
      t.app,
      undefined,
      OP,
    );
    expect(done.success).toBe(false); // без approvalId — снова план/replay, не запись
    expect(withApproval.success).toBe(true);
    expect(hooks.performCalls).toBe(1);
    // повторное решение по той же операции невозможно
    expect(
      (
        await post(
          `/admin/operations/${id}`,
          form({ _csrf: boss.csrf, decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
          { cookie: boss.cookie },
        )
      ).status,
    ).toBe(409);
    const auditRows = t.app.db.all<{ operation_kind: string; outcome: string }>(
      "SELECT operation_kind, outcome FROM audit WHERE tool = 'admin_panel'",
    );
    expect(auditRows).toContainEqual({ operation_kind: 'approve', outcome: 'success' });
  });

  it('права: operator решает только свои планы (чужой → 403), reader — ничего; отклонение словом ОТКЛОНЯЮ', async () => {
    const ownerPlan = opId(await prepare(OWNER, '[MCP TEST] владельца', KEY2));
    const opPlan = opId(await prepare(OP, '[MCP TEST] оператора', KEY3));
    const op1 = await login('op1');
    const foreign = await post(
      `/admin/operations/${ownerPlan}`,
      form({ _csrf: op1.csrf, decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
      { cookie: op1.cookie },
    );
    expect(foreign.status).toBe(403);
    expect(t.app.operations.view(ownerPlan, 'owner', t.app.auth.portalKey)?.status).toBe('prepared');
    const deny = await post(
      `/admin/operations/${opPlan}`,
      form({ _csrf: op1.csrf, decision: 'deny', word: 'ОТКЛОНЯЮ' }),
      { cookie: op1.cookie },
    );
    expect(deny.status).toBe(303);
    expect(t.app.operations.view(opPlan, 'op', t.app.auth.portalKey)?.status).toBe('denied');
    const viewer = await login('viewer');
    const ro = await post(
      `/admin/operations/${ownerPlan}`,
      form({ _csrf: viewer.csrf, decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
      { cookie: viewer.cookie },
    );
    expect(ro.status).toBe(403);
    expect((await get('/admin/operations/not-a-uuid', viewer.cookie)).status).toBe(404);
  });

  it('web-upload: txt → fileToken для своего principal; exe → 400; без CSRF → 403; reader → 403; выход закрывает сессию', async () => {
    const boss = await login('boss');
    const fd = new FormData();
    fd.append('_csrf', boss.csrf);
    fd.append('file', new Blob(['привет из панели\n'], { type: 'text/plain' }), 'panel-note.txt');
    const r = await post('/admin/uploads', fd, { cookie: boss.cookie });
    expect(r.status).toBe(200);
    const html = await r.text();
    const token = /fileToken: <code>([^<]+)<\/code>/.exec(html)?.[1] ?? '';
    expect(token).not.toBe('');
    const m = t.app.files.resolve(token, 'owner');
    expect(m.originalName).toBe('panel-note.txt');
    expect(t.app.files.readVerified(m).toString()).toBe('привет из панели\n');
    expect(() => t.app.files.resolve(token, 'op')).toThrow(/не найден/);
    const bad = new FormData();
    bad.append('_csrf', boss.csrf);
    bad.append('file', new Blob(['MZ']), 'evil.exe');
    expect((await post('/admin/uploads', bad, { cookie: boss.cookie })).status).toBe(400);
    const noCsrf = new FormData();
    noCsrf.append('file', new Blob(['x']), 'a.txt');
    expect((await post('/admin/uploads', noCsrf, { cookie: boss.cookie })).status).toBe(403);
    const viewer = await login('viewer');
    const ro = new FormData();
    ro.append('_csrf', viewer.csrf);
    ro.append('file', new Blob(['x']), 'a.txt');
    expect((await post('/admin/uploads', ro, { cookie: viewer.cookie })).status).toBe(403);
    const logout = await post('/admin/logout', form({ _csrf: boss.csrf }), { cookie: boss.cookie });
    expect(logout.status).toBe(303);
    expect((await get('/admin/operations', boss.cookie)).status).toBe(303);
  });

  it('MCP bearer-токен или чужая cookie не открывают панель', async () => {
    expect(
      (
        await fetch(`${base}/admin/operations`, {
          redirect: 'manual',
          headers: { authorization: 'Bearer abc' },
        })
      ).status,
    ).toBe(303);
    expect((await get('/admin/operations', 'mcp_admin=' + 'A'.repeat(43))).status).toBe(303);
  });
});

/**
 * Контур подтверждений и дедупликации (ТЗ §8.2, §14.2): T08, T09, T12, T13, T14, T15, T16.
 * Ни один сценарий не должен привести к записи в Bitrix без approved-плана.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import type { Envelope } from '../../src/mcp/result.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { makeFakeCreateTool, type FakeWriteHooks } from '../helpers/fake-write-tool.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

let hooks: FakeWriteHooks;
let t: TestApp;
const tool = () => t.app.tools.find((x) => x.name === 'test_create');
const errorOf = (env: Envelope) => (env.success ? undefined : env.error);
/** operationId из ответа APPROVAL_REQUIRED; падает с понятным сообщением, если его нет. */
function opId(env: Envelope): string {
  const id = errorOf(env)?.details.operationId;
  if (typeof id !== 'string') throw new Error(`ожидался operationId, получено: ${JSON.stringify(env)}`);
  return id;
}

async function call(args: Record<string, unknown>): Promise<Envelope> {
  const def = tool();
  if (!def) throw new Error('tool missing');
  return dispatch(def, args, t.app);
}

/** Полный путь: prepare → approve (как CLI) → execute. */
async function approveAndRun(args: Record<string, unknown>): Promise<{ env: Envelope; operationId: string }> {
  const prep = await call(args);
  const operationId = opId(prep);
  await t.app.approvals.approve(operationId, t.app.principal.id, t.app.auth.portalKey);
  const env = await call({ ...args, approvalId: operationId });
  return { env, operationId };
}

beforeEach(() => {
  hooks = { performCalls: 0, verifyCalls: 0, precheckCalls: 0 };
  t = createTestApp({ READ_ONLY_MODE: 'false' }, [makeFakeCreateTool(hooks)]);
  t.bitrix.on('crm.deal.add', legacyOk(101));
});
afterEach(() => t.app.close());

describe('подтверждения (ТЗ §8.2)', () => {
  it('без approvalId: план подготовлен, APPROVAL_REQUIRED с operationId и планом, записи нет', async () => {
    const key = randomUUID();
    const env = await call({ title: '[MCP TEST] сделка', idempotencyKey: key });
    expect(env.success).toBe(false);
    const err = errorOf(env);
    expect(err?.code).toBe('APPROVAL_REQUIRED');
    expect(err?.details.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(err?.details.plan).toMatchObject({
      action: 'Создать тестовую сделку',
      details: { TITLE: '[MCP TEST] сделка' },
    });
    expect(err?.details.nextAction).toContain('approval:review');
    expect(hooks.performCalls).toBe(0);
    expect(t.bitrix.calls).toHaveLength(0);
    const view = await t.app.operations.view(opId(env), 'owner', t.app.auth.portalKey);
    expect(view?.status).toBe('prepared');
  });

  it('dryRun: план без ledger, без ключа и без записи', async () => {
    const env = await call({ title: 'x', dryRun: true });
    expect(env.success).toBe(true);
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(hooks.performCalls).toBe(0);
  });

  it('без dryRun и без idempotencyKey — VALIDATION_ERROR ещё на схеме', async () => {
    const env = await call({ title: 'x' });
    expect(errorOf(env)?.code).toBe('VALIDATION_ERROR');
    expect(errorOf(env)?.details.field).toBe('idempotencyKey');
  });

  it('T12: approvalId без подготовленной операции / confirm-подобные поля не принимаются', async () => {
    const env = await call({ title: 'x', idempotencyKey: randomUUID(), approvalId: randomUUID() });
    expect(errorOf(env)?.code).toBe('APPROVAL_MISMATCH');
    expect(hooks.performCalls).toBe(0);
    const extra = await call({ title: 'x', idempotencyKey: randomUUID(), confirm: true });
    expect(errorOf(extra)?.code).toBe('VALIDATION_ERROR');
  });

  it('подготовленный, но не подтверждённый план не исполняется с approvalId', async () => {
    const key = randomUUID();
    const prep = await call({ title: 'x', idempotencyKey: key });
    const operationId = opId(prep);
    const env = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(env)?.code).toBe('APPROVAL_REQUIRED');
    expect(hooks.performCalls).toBe(0);
  });

  it('после подтверждения человеком запись выполняется ровно один раз с верификацией', async () => {
    const key = randomUUID();
    const { env, operationId } = await approveAndRun({ title: '[MCP TEST] сделка', idempotencyKey: key });
    expect(env.success).toBe(true);
    if (env.success)
      expect(env.data).toMatchObject({ id: 101, operationId, verified: true, replayed: false });
    expect(hooks.performCalls).toBe(1);
    expect(hooks.verifyCalls).toBe(1);
    expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
    expect((await t.app.operations.view(operationId, 'owner', t.app.auth.portalKey))?.status).toBe(
      'succeeded',
    );
    const audit = await t.app.db.all<{ outcome: string; approval_id: string | null }>(
      'SELECT outcome, approval_id FROM audit WHERE approval_id IS NOT NULL',
    );
    expect(audit.map((a) => a.outcome)).toEqual(['prepared', 'success']);
  });

  it('T13: повтор approvalId после успеха возвращает сохранённый результат, второй записи нет', async () => {
    const key = randomUUID();
    const args = { title: 'x', idempotencyKey: key };
    const { operationId } = await approveAndRun(args);
    const again = await call({ ...args, approvalId: operationId });
    expect(again.success).toBe(true);
    if (again.success) {
      expect(again.data).toMatchObject({ id: 101, replayed: true });
      expect(again.meta.warnings[0]).toContain('Повтор');
    }
    const noApproval = await call(args);
    expect(noApproval.success).toBe(true);
    if (noApproval.success) expect(noApproval.data).toMatchObject({ replayed: true });
    expect(hooks.performCalls).toBe(1);
  });

  it('T14: другие аргументы, другой principal, другой инструмент с тем же approvalId — отказ', async () => {
    const key = randomUUID();
    const prep = await call({ title: 'x', idempotencyKey: key });
    const operationId = opId(prep);
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const changed = await call({ title: 'ДРУГОЙ ТЕКСТ', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(changed)?.code).toBe('IDEMPOTENCY_CONFLICT');
    const otherKey = await call({ title: 'x', idempotencyKey: randomUUID(), approvalId: operationId });
    expect(errorOf(otherKey)?.code).toBe('APPROVAL_MISMATCH');
    await expect(t.app.approvals.readPlan(operationId, 'intruder', t.app.auth.portalKey)).rejects.toThrow(
      AppError,
    );
    expect(hooks.performCalls).toBe(0);
    // подтверждение осталось в силе для верных параметров
    const okEnv = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(okEnv.success).toBe(true);
  });

  it('T09: тот же idempotencyKey с другим телом → IDEMPOTENCY_CONFLICT', async () => {
    const key = randomUUID();
    await call({ title: 'первая', idempotencyKey: key });
    const env = await call({ title: 'вторая', idempotencyKey: key });
    expect(errorOf(env)?.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('T08: два одновременных вызова с одним ключом → один upstream write, одинаковый результат', async () => {
    const key = randomUUID();
    const args = { title: 'x', idempotencyKey: key };
    const prep = await call(args);
    const operationId = opId(prep);
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const [a, b] = await Promise.all([
      call({ ...args, approvalId: operationId }),
      call({ ...args, approvalId: operationId }),
    ]);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect((a.data as { id: number }).id).toBe((b.data as { id: number }).id);
    expect(hooks.performCalls).toBe(1);
    expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
  });

  it('истёкшее подтверждение → APPROVAL_EXPIRED и не исполняется', async () => {
    const t2 = createTestApp({ READ_ONLY_MODE: 'false', APPROVAL_TTL_SECONDS: '30' }, [
      makeFakeCreateTool(hooks),
    ]);
    const key = randomUUID();
    const def = t2.app.tools.find((x) => x.name === 'test_create');
    if (!def) throw new Error('tool');
    const prep = await dispatch(def, { title: 'x', idempotencyKey: key }, t2.app);
    const operationId = opId(prep);
    await t2.app.db.run(
      "UPDATE operations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      operationId,
    );
    await expect(t2.app.approvals.approve(operationId, 'owner', t2.app.auth.portalKey)).rejects.toThrow(
      AppError,
    );
    const env = await dispatch(def, { title: 'x', idempotencyKey: key, approvalId: operationId }, t2.app);
    expect(errorOf(env)?.code).toBe('APPROVAL_EXPIRED');
    expect(hooks.performCalls).toBe(0);
    t2.app.close();
  });

  it('отклонённый человеком план не исполняется; тот же ключ можно подготовить заново', async () => {
    const key = randomUUID();
    const prep = await call({ title: 'x', idempotencyKey: key });
    const operationId = opId(prep);
    await t.app.approvals.deny(operationId, 'owner', t.app.auth.portalKey);
    const env = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(env)?.code).toBe('ACCESS_DENIED');
    const again = await call({ title: 'x', idempotencyKey: key });
    expect(errorOf(again)?.code).toBe('APPROVAL_REQUIRED');
    expect(errorOf(again)?.details.operationId).not.toBe(operationId);
    expect(hooks.performCalls).toBe(0);
  });

  it('T15: precheck обнаружил изменение объекта → CONFLICT, операция failed, старое подтверждение мертво', async () => {
    hooks.failPrecheckWith = new AppError('CONFLICT', 'объект изменился');
    const key = randomUUID();
    const { env, operationId } = await approveAndRun({ title: 'x', idempotencyKey: key });
    expect(errorOf(env)?.code).toBe('CONFLICT');
    expect(hooks.performCalls).toBe(0);
    expect((await t.app.operations.view(operationId, 'owner', t.app.auth.portalKey))?.status).toBe('failed');
    hooks.failPrecheckWith = undefined;
    const retry = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(retry)?.code).toBe('CONFLICT');
    expect(hooks.performCalls).toBe(0);
  });

  it('§8.2 п.4: план при выполнении отличается от подтверждённого (портал изменился, expectedStateHash нет) → CONFLICT PLAN_CHANGED, записи нет', async () => {
    hooks.portalState = { mode: 'create' };
    const key = randomUUID();
    const prep = await call({ title: 'x', idempotencyKey: key });
    const operationId = opId(prep);
    await t.app.approvals.approve(operationId, t.app.principal.id, t.app.auth.portalKey);
    hooks.portalState = { mode: 'update', priceId: 5 };
    const env = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(env)?.code).toBe('CONFLICT');
    expect(errorOf(env)?.details['reason']).toBe('PLAN_CHANGED');
    expect(hooks.performCalls).toBe(0);
    expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(0);
    expect((await t.app.operations.view(operationId, 'owner', t.app.auth.portalKey))?.status).toBe('failed');
    // состояние вернулось — старое подтверждение всё равно мертво, нужен новый план
    hooks.portalState = { mode: 'create' };
    const retry = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(retry)?.code).toBe('CONFLICT');
    expect(hooks.performCalls).toBe(0);
  });

  it('потеря ответа при записи → OPERATION_OUTCOME_UNKNOWN, статус unknown, повтор не создаёт дубль', async () => {
    t.bitrix.on('crm.deal.add', { networkError: 'socket hang up' });
    const key = randomUUID();
    const { env, operationId } = await approveAndRun({ title: 'x', idempotencyKey: key });
    expect(errorOf(env)?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect((await t.app.operations.view(operationId, 'owner', t.app.auth.portalKey))?.status).toBe('unknown');
    t.bitrix.on('crm.deal.add', legacyOk(102));
    const retry = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(retry)?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const retryNoApproval = await call({ title: 'x', idempotencyKey: key });
    expect(errorOf(retryNoApproval)?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(hooks.performCalls).toBe(1);
    expect(t.bitrix.callsTo('crm.deal.add')).toHaveLength(1);
    const status = await dispatch(
      t.app.tools.find((x) => x.name === 'operation_status') as never,
      { operationId },
      t.app,
    );
    expect(status.success && (status.data as { status: string }).status).toBe('unknown');
  });

  it('T16: рестарт во время executing → unknown, автоматического повтора нет', async () => {
    const key = randomUUID();
    const prep = await call({ title: 'x', idempotencyKey: key });
    const operationId = opId(prep);
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    expect(await t.app.operations.tryStartExecuting(operationId)).toBe(true);
    expect(await t.app.operations.recoverAfterRestart()).toBe(1);
    expect((await t.app.operations.view(operationId, 'owner', t.app.auth.portalKey))?.status).toBe('unknown');
    const env = await call({ title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(errorOf(env)?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(hooks.performCalls).toBe(0);
  });

  it('неудачная сверка после записи не создаёт объект повторно: success с warning и verified=false', async () => {
    hooks.failVerify = true;
    const { env } = await approveAndRun({ title: 'x', idempotencyKey: randomUUID() });
    expect(env.success).toBe(true);
    if (env.success) {
      expect(env.data).toMatchObject({ id: 101, verified: false });
      expect(env.meta.warnings[0]).toContain('проверка не завершена');
    }
    expect(hooks.performCalls).toBe(1);
  });

  it('T44 для записи: недоступный журнал аудита запрещает подготовку (AUDIT_UNAVAILABLE), чтение работает', async () => {
    await t.app.db.run('DROP TABLE audit');
    const env = await call({ title: 'x', idempotencyKey: randomUUID() });
    expect(errorOf(env)?.code).toBe('AUDIT_UNAVAILABLE');
    expect(await t.app.operations.countByStatus()).toEqual({});
    const read = await dispatch(
      t.app.tools.find((x) => x.name === 'bitrix_server_version') as never,
      {},
      t.app,
    );
    expect(read.success).toBe(true);
  });

  it('лимит подготовок: 11-й план за минуту → RATE_LIMITED', async () => {
    for (let i = 0; i < 10; i += 1) {
      const env = await call({ title: `x${i}`, idempotencyKey: randomUUID() });
      expect(errorOf(env)?.code).toBe('APPROVAL_REQUIRED');
    }
    const env = await call({ title: 'x11', idempotencyKey: randomUUID() });
    expect(errorOf(env)?.code).toBe('RATE_LIMITED');
  });

  it('CLI-список ожидающих и просмотр плана расшифровывают только свои операции', async () => {
    const key = randomUUID();
    const prep = await call({ title: 'секретный текст плана', idempotencyKey: key });
    const operationId = opId(prep);
    const pending = await t.app.approvals.listPending('owner', t.app.auth.portalKey);
    expect(pending.map((p) => p.operationId)).toEqual([operationId]);
    const { plan } = await t.app.approvals.readPlan(operationId, 'owner', t.app.auth.portalKey);
    expect(plan.summary.details).toEqual({ TITLE: 'секретный текст плана' });
    const row = await t.app.db.get<{ plan_encrypted: string }>(
      'SELECT plan_encrypted FROM operations WHERE id = ?',
      operationId,
    );
    expect(row?.plan_encrypted).not.toContain('секретный');
  });

  it('через MCP-клиент: write-инструмент виден при READ_ONLY_MODE=false и отвечает APPROVAL_REQUIRED с isError', async () => {
    const c = await connectInMemory(t.app);
    const names = (await c.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('test_create');
    const r = await c.client.callTool({
      name: 'test_create',
      arguments: { title: 'x', idempotencyKey: randomUUID() },
    });
    expect(r.isError).toBe(true);
    expect(structured<Envelope>(r).success).toBe(false);
    expect(errorOf(structured<Envelope>(r))?.code).toBe('APPROVAL_REQUIRED');
    await c.close();
  });
});

/**
 * Живой портал (2026-10-05): method.get отвечает isAvailable=false для legacy tasks.task.*, хотя вызовы работают.
 * Для этих методов доступность решает scope; для остальных method.get по-прежнему окончательный.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { methodGetUnreliable } from '../../src/bitrix/capabilities.js';
import { listMethods, requireMethod } from '../../src/bitrix/method-registry.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.app.close();
  t = undefined;
});

function portal(scopes: string[]) {
  t = createTestApp();
  t.bitrix.on('scope', legacyOk(scopes)).on('method.get', (c) => {
    const name = String(c.body['name']);
    return legacyOk({
      isExisting: true,
      isAvailable: !name.startsWith('tasks.task.') && name !== 'im.message.add',
    });
  });
  return t.app.capabilities;
}

describe('bitrix_capabilities: method.get и tasks.task.*', () => {
  it('scope task выдан → tasks.task.list supported, хотя method.get говорит «недоступен»', async () => {
    const caps = portal(['crm', 'task', 'im']);
    const r = await caps.probe(requireMethod('legacy', 'tasks.task.list'), 'req-1', true);
    expect(r.status).toBe('supported');
    expect(r.reason).toContain('scope task');
  });

  it('scope task не выдан → tasks.task.list unavailable с причиной «нет scope»', async () => {
    const caps = portal(['crm', 'im']);
    const r = await caps.probe(requireMethod('legacy', 'tasks.task.list'), 'req-2', true);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('нет scope task');
  });

  it('остальные методы: method.get остаётся окончательным даже при выданном scope', async () => {
    const caps = portal(['crm', 'task', 'im']);
    const r = await caps.probe(requireMethod('legacy', 'im.message.add'), 'req-3', true);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('метод недоступен текущей авторизации (scope/права)');
  });

  it('исключение узкое: ровно семь legacy tasks.task.* реестра, без чек-листов и комментариев', () => {
    const quirky = listMethods()
      .filter(methodGetUnreliable)
      .map((d) => d.method)
      .sort();
    expect(quirky).toEqual([
      'tasks.task.add',
      'tasks.task.complete',
      'tasks.task.delete',
      'tasks.task.get',
      'tasks.task.getfields',
      'tasks.task.list',
      'tasks.task.update',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import {
  assertDateTimeWithZone,
  CRM_BINDING_RE,
  parseTaskFieldsResult,
  taskStatusName,
  validateTaskFieldsForWrite,
  validateTaskFilter,
  validateTaskOrder,
  validateTaskSelect,
} from '../../src/tools/tasks/task-fields.js';
import { compareTask } from '../../src/tools/tasks/task-service.js';
import { TASK_FIELDS, taskRecord } from '../helpers/mock-bitrix.js';

const meta = parseTaskFieldsResult(TASK_FIELDS);

function errOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (AppError.is(e)) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

describe('валидатор задач (ТЗ §9.8)', () => {
  it('разбирает getfields: primary → read-only, required, enum values, серверные поля', () => {
    expect(meta['ID']?.isReadOnly).toBe(true);
    expect(meta['CREATED_DATE']?.isReadOnly).toBe(true);
    expect(meta['TITLE']?.isRequired).toBe(true);
    expect(meta['RESPONSIBLE_ID']?.isRequired).toBe(true);
    expect(meta['STATUS']?.items?.map((i) => i.ID)).toEqual(['2', '3', '4', '5', '6']);
    expect(meta['AUDITORS']?.isMultiple).toBe(true);
    expect(() => parseTaskFieldsResult({ fields: { ID: { type: 'integer' } } })).toThrow(AppError);
    expect(() => parseTaskFieldsResult({})).toThrow(AppError);
  });

  it('запись: нормализация, неизвестные/серверные поля, обязательные', () => {
    const out = validateTaskFieldsForWrite(
      {
        TITLE: 'x',
        RESPONSIBLE_ID: '7',
        DEADLINE: '2026-10-01T18:00:00+03:00',
        AUDITORS: [1, '2'],
        ALLOW_CHANGE_DEADLINE: true,
        PRIORITY: 2,
        UF_CRM_TASK: ['D_5'],
      },
      meta,
    );
    expect(out).toEqual({
      TITLE: 'x',
      RESPONSIBLE_ID: 7,
      DEADLINE: '2026-10-01T18:00:00+03:00',
      AUDITORS: [1, 2],
      ALLOW_CHANGE_DEADLINE: 'Y',
      PRIORITY: 2,
      UF_CRM_TASK: ['D_5'],
    });
    expect(
      errOf(() =>
        validateTaskFieldsForWrite({ TITLE: 'x', RESPONSIBLE_ID: 7, CREATED_DATE: '2026-01-01' }, meta),
      ).details.reason,
    ).toBe('READ_ONLY_FIELD');
    expect(
      errOf(() => validateTaskFieldsForWrite({ TITLE: 'x', RESPONSIBLE_ID: 7, UF_NOPE: 1 }, meta)).details
        .reason,
    ).toBe('UNKNOWN_FIELD');
    expect(errOf(() => validateTaskFieldsForWrite({ TITLE: 'x' }, meta)).details.field).toBe(
      'RESPONSIBLE_ID',
    );
    expect(
      errOf(() => validateTaskFieldsForWrite({ TITLE: 'x', RESPONSIBLE_ID: 'Иван' }, meta)).details.field,
    ).toBe('RESPONSIBLE_ID');
    expect(
      errOf(() => validateTaskFieldsForWrite({ TITLE: 'x', RESPONSIBLE_ID: 7, PRIORITY: 9 }, meta)).details
        .field,
    ).toBe('PRIORITY');
  });

  it('дата-время требует явную зону (T28)', () => {
    expect(assertDateTimeWithZone('DEADLINE', '2026-10-01T18:00:00+03:00')).toBe('2026-10-01T18:00:00+03:00');
    expect(assertDateTimeWithZone('DEADLINE', '2026-10-01T15:00:00Z')).toBe('2026-10-01T15:00:00Z');
    expect(errOf(() => assertDateTimeWithZone('DEADLINE', '2026-10-01T18:00:00')).details.reason).toBe(
      'TIMEZONE_REQUIRED',
    );
    expect(errOf(() => assertDateTimeWithZone('DEADLINE', '2026-10-01')).details.reason).toBe(
      'TIMEZONE_REQUIRED',
    );
    expect(() => assertDateTimeWithZone('DEADLINE', 'завтра')).toThrow(AppError);
  });

  it('filter/order/select — только известные поля, статус по коду', () => {
    expect(
      validateTaskFilter(
        { RESPONSIBLE_ID: 7, '<DEADLINE': '2026-10-01T00:00:00+03:00', '@STATUS': [2, 3] },
        meta,
      ),
    ).toEqual({
      RESPONSIBLE_ID: 7,
      '<DEADLINE': '2026-10-01T00:00:00+03:00',
      '@STATUS': [2, 3],
    });
    expect(() => validateTaskFilter({ responsibleId: 7 }, meta)).toThrow(AppError);
    expect(() => validateTaskFilter({ 'TITLE; DROP': 'x' }, meta)).toThrow(AppError);
    expect(validateTaskOrder({ DEADLINE: 'ASC' }, meta)).toEqual({ DEADLINE: 'asc' });
    expect(() => validateTaskOrder({ NOPE: 'asc' }, meta)).toThrow(AppError);
    expect(validateTaskSelect(['ID', 'TITLE'], meta)).toEqual(['ID', 'TITLE']);
    expect(() => validateTaskSelect(['title'], meta)).toThrow(AppError);
    expect(taskStatusName('5')).toBe('completed');
    expect(taskStatusName('9')).toBeUndefined();
  });

  it('привязки CRM в формате Bitrix', () => {
    for (const ok of ['D_1', 'L_22', 'C_3', 'CO_44']) expect(CRM_BINDING_RE.test(ok)).toBe(true);
    for (const bad of ['deal_1', 'D1', 'X_1', 'D_', 'D_1; drop'])
      expect(CRM_BINDING_RE.test(bad)).toBe(false);
  });

  it('сверка §15.3: ответственный и срок как момент времени, название', () => {
    const req = { TITLE: 'x', RESPONSIBLE_ID: 7, DEADLINE: '2026-10-01T18:00:00+03:00' };
    expect(
      compareTask(req, taskRecord(1, { title: 'x', responsibleId: '7', deadline: '2026-10-01T15:00:00Z' })),
    ).toEqual({ verified: true, warnings: [] });
    const r = compareTask(
      req,
      taskRecord(1, { title: 'x', responsibleId: '9', deadline: '2026-10-02T18:00:00+03:00' }),
    );
    expect(r.verified).toBe(false);
    expect(r.warnings).toHaveLength(2);
  });
});

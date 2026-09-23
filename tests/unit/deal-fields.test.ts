import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import {
  parseFieldsResult,
  validateFieldsForWrite,
  validateFilter,
  validateOrder,
  validateSelect,
} from '../../src/tools/crm/deal-fields.js';
import { DEAL_FIELDS, DEAL_FIELDS_WITH_REQUIRED_UF } from '../helpers/mock-bitrix.js';

const meta = parseFieldsResult(DEAL_FIELDS);

function errOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (AppError.is(e)) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

describe('metadata-validator сделки (ТЗ §15.1 п.2, §9.4)', () => {
  it('разбирает crm.deal.fields и требует ID/TITLE', () => {
    expect(meta['TITLE']?.isRequired).toBe(true);
    expect(meta['ID']?.isReadOnly).toBe(true);
    expect(meta['UF_CRM_PRIORITY']?.items?.map((i) => i.ID)).toEqual(['11', '12']);
    expect(() => parseFieldsResult({ FOO: { type: 'string' } })).toThrow(AppError);
    expect(() => parseFieldsResult([])).toThrow(AppError);
  });

  it('create: нормализует типы, отклоняет неизвестные/read-only поля и неверные типы', () => {
    const out = validateFieldsForWrite(
      {
        TITLE: 'x',
        ASSIGNED_BY_ID: '7',
        OPPORTUNITY: '1 500,50'.replace(' ', ''),
        CLOSED: false,
        BEGINDATE: '2026-10-01',
        UF_CRM_PRIORITY: 12,
        CONTACT_IDS: [1, '2'],
      },
      meta,
      'create',
    );
    expect(out).toEqual({
      TITLE: 'x',
      ASSIGNED_BY_ID: 7,
      OPPORTUNITY: '1500.50',
      CLOSED: 'N',
      BEGINDATE: '2026-10-01',
      UF_CRM_PRIORITY: '12',
      CONTACT_IDS: [1, 2],
    });
    expect(
      errOf(() => validateFieldsForWrite({ TITLE: 'x', title: 'y' }, meta, 'create')).details.reason,
    ).toBe('UNKNOWN_FIELD');
    expect(errOf(() => validateFieldsForWrite({ TITLE: 'x', ID: 5 }, meta, 'create')).details.reason).toBe(
      'READ_ONLY_FIELD',
    );
    expect(
      errOf(() => validateFieldsForWrite({ TITLE: 'x', ASSIGNED_BY_ID: 'Иван' }, meta, 'create')).details
        .field,
    ).toBe('ASSIGNED_BY_ID');
    expect(
      errOf(() => validateFieldsForWrite({ TITLE: 'x', UF_CRM_PRIORITY: '99' }, meta, 'create')).details
        .field,
    ).toBe('UF_CRM_PRIORITY');
    expect(
      errOf(() => validateFieldsForWrite({ TITLE: 'x', BEGINDATE: 'вчера' }, meta, 'create')).details.field,
    ).toBe('BEGINDATE');
    expect(
      errOf(() => validateFieldsForWrite({ TITLE: 'x', CONTACT_IDS: 5 }, meta, 'create')).details.field,
    ).toBe('CONTACT_IDS');
    expect(errOf(() => validateFieldsForWrite({ TITLE: ['a'] }, meta, 'create')).details.field).toBe('TITLE');
  });

  it('T31: обязательное пользовательское поле → понятная ошибка с именем поля', () => {
    const metaReq = parseFieldsResult(DEAL_FIELDS_WITH_REQUIRED_UF);
    const err = errOf(() => validateFieldsForWrite({ TITLE: 'x' }, metaReq, 'create'));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details.field).toBe('UF_CRM_SOURCE_DOC');
    expect(err.details.reason).toBe('REQUIRED_FIELD_MISSING');
    expect(err.message).toContain('Документ-основание');
    expect(validateFieldsForWrite({ TITLE: 'x', UF_CRM_SOURCE_DOC: 'д-1' }, metaReq, 'create')).toEqual({
      TITLE: 'x',
      UF_CRM_SOURCE_DOC: 'д-1',
    });
  });

  it('update: неизменяемое поле нельзя менять; обязательные не требуются', () => {
    expect(errOf(() => validateFieldsForWrite({ CATEGORY_ID: 1 }, meta, 'update')).details.reason).toBe(
      'IMMUTABLE_FIELD',
    );
    expect(validateFieldsForWrite({ COMMENTS: 'ok' }, meta, 'update')).toEqual({ COMMENTS: 'ok' });
  });

  it('filter: префиксы Bitrix, только известные поля, без формул и объектов', () => {
    expect(
      validateFilter(
        {
          '>=DATE_CREATE': '2026-09-01',
          '%TITLE': 'договор',
          '@STAGE_ID': ['NEW', 'WON'],
          ASSIGNED_BY_ID: 7,
        },
        meta,
      ),
    ).toEqual({
      '>=DATE_CREATE': '2026-09-01',
      '%TITLE': 'договор',
      '@STAGE_ID': ['NEW', 'WON'],
      ASSIGNED_BY_ID: 7,
    });
    for (const badFilter of [
      { 'TITLE; DROP TABLE': 'x' },
      { title: 'x' },
      { NOPE: 'x' },
      { '@STAGE_ID': 'NEW' },
      { '><OPPORTUNITY': [1] as unknown },
      { TITLE: { nested: 1 } },
      { '=TITLE': 'x'.repeat(501) },
      { '=ID': [] },
    ]) {
      expect(
        () => validateFilter(badFilter as Record<string, unknown>, meta),
        JSON.stringify(badFilter),
      ).toThrow(AppError);
    }
  });

  it('order и select проверяются по схеме', () => {
    expect(validateOrder({ DATE_CREATE: 'desc', ID: 'ASC' }, meta)).toEqual({
      DATE_CREATE: 'DESC',
      ID: 'ASC',
    });
    expect(() => validateOrder({ TITLE: 'RANDOM' }, meta)).toThrow(AppError);
    expect(() => validateOrder({ FOO: 'ASC' }, meta)).toThrow(AppError);
    expect(validateSelect(['ID', 'TITLE', 'UF_*'], meta)).toEqual(['ID', 'TITLE', 'UF_*']);
    expect(() => validateSelect(['ID', 'SECRET'], meta)).toThrow(AppError);
  });
});

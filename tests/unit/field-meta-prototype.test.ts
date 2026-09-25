/** Проверки «поле известно порталу» не принимают прототипные ключи объекта (constructor, toString). */
import { describe, expect, it } from 'vitest';
import {
  parseFieldsResult,
  validateFieldsForWrite,
  validateFilter,
} from '../../src/tools/crm/deal-fields.js';
import {
  parseItemFieldsResult,
  validateItemFieldsForWrite,
  validateItemFilter,
  validateItemSelect,
} from '../../src/tools/crm/item-fields.js';
import { DEAL_FIELDS } from '../helpers/mock-bitrix.js';

const ITEM_FIELDS = {
  fields: {
    id: {
      type: 'integer',
      isRequired: false,
      isReadOnly: true,
      isImmutable: false,
      isMultiple: false,
      title: 'ID',
    },
    title: {
      type: 'string',
      isRequired: false,
      isReadOnly: false,
      isImmutable: false,
      isMultiple: false,
      title: 'Название',
    },
  },
};

describe('прототипные ключи не считаются полями портала', () => {
  const itemMeta = parseItemFieldsResult(ITEM_FIELDS);
  const dealMeta = parseFieldsResult(DEAL_FIELDS);

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'crm.item: %s → UNKNOWN_FIELD',
    (key) => {
      expect(() => validateItemFieldsForWrite({ [key]: 'x' }, itemMeta, 'create')).toThrow(
        /неизвест|UNKNOWN/i,
      );
      expect(() => validateItemFilter({ [`%${key}`]: 'a' }, itemMeta)).toThrow();
      expect(() => validateItemSelect([key], itemMeta)).toThrow();
    },
  );

  it('классическая схема: constructor/toString отклоняются', () => {
    expect(() => validateFieldsForWrite({ constructor: 'x' }, dealMeta, 'create')).toThrow();
    expect(() => validateFilter({ toString: 'x' }, dealMeta)).toThrow();
  });

  it('обычное поле по-прежнему проходит', () => {
    expect(validateItemFieldsForWrite({ title: 'Счёт' }, itemMeta, 'create')).toEqual({ title: 'Счёт' });
  });
});

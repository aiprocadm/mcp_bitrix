/**
 * Группа реестра REST-методов: База знаний 2.0 (note.*, REST 3.0).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 */
import type { MethodDescriptor } from './descriptor.js';

export const noteMethods: readonly (readonly [string, MethodDescriptor])[] = [];

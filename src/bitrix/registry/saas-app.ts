/**
 * Группа реестра REST-методов: служебные методы тиражного приложения SaaS (SaaS-ТЗ §8, этап S3).
 * Вызываются только ядром сервиса (установка приложения, подписка на события), НЕ инструментами и НЕ raw-вызовом
 * (`rawCallable: false`). Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 *
 * Уже есть в базовом реестре (method-registry.ts) и переиспользуются S3: `profile`, `user.current`, `app.info`.
 *
 * Обе записи — методы контекста приложения: «The method works only within the context of application authorization»
 * (event.bind, event.get) — вебхук их не вызовет, OAuth-токен приложения вызовет.
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const EVENTS = `${DOCS}/api-reference/events`;

/** event.bind: регистрация обработчика события; ответ `{"result": true}`. Запись → без повторов (мутация). */
export const EVENT_BIND: MethodDescriptor = {
  method: 'event.bind',
  apiVersion: 'legacy',
  operation: 'create',
  pagination: 'none',
  supportsNativeIdempotency: false,
  applicationContextRequired: true,
  rawCallable: false,
  source: `${EVENTS}/event-bind.html`,
};

/** event.get: обработчики событий приложения; ответ `{"result": [{event, handler, auth_type, offline}]}`. */
export const EVENT_GET: MethodDescriptor = {
  method: 'event.get',
  apiVersion: 'legacy',
  operation: 'read',
  pagination: 'none',
  supportsNativeIdempotency: false,
  applicationContextRequired: true,
  rawCallable: false,
  source: `${EVENTS}/event-get.html`,
};

export const saasAppMethods: readonly (readonly [string, MethodDescriptor])[] = [D(EVENT_BIND), D(EVENT_GET)];

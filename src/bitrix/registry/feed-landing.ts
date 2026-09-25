/**
 * Группа реестра REST-методов: Лента новостей и классическая база знаний (landing).
 * Каждая запись сверена с официальной страницей метода; ссылка — в `source`.
 *
 * Имена landing-методов записаны в нижнем регистре (landing.site.getlist и т. п.): REST Bitrix24 не различает
 * регистр имени метода, а реестр сервера допускает только строчные имена (METHOD_NAME_RE).
 * Внутренний параметр landing `scope` (KNOWLEDGE/GROUP) — это НЕ REST-scope `landing` (см. landing/types).
 */
import { D, DOCS, type MethodDescriptor } from './descriptor.js';

const log = {
  apiVersion: 'legacy',
  scope: 'log',
  supportsNativeIdempotency: false,
  applicationContextRequired: false,
} as const;

const landing = {
  apiVersion: 'legacy',
  scope: 'landing',
  supportsNativeIdempotency: false,
  applicationContextRequired: false,
} as const;

export const feedLandingMethods: readonly (readonly [string, MethodDescriptor])[] = [
  // ---------- Лента (log) ----------
  D({
    ...log,
    method: 'log.blogpost.add',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/log/log-blogpost-add.html`,
  }),
  D({
    ...log,
    method: 'log.blogpost.update',
    operation: 'update',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/log/log-blogpost-update.html`,
  }),
  D({
    ...log,
    method: 'log.blogpost.get',
    operation: 'read',
    pagination: 'offset',
    rawCallable: true,
    source: `${DOCS}/api-reference/log/log-blogpost-get.html`,
  }),
  D({
    ...log,
    method: 'log.blogcomment.add',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/log/blogcomment/log-blogcomment-add.html`,
  }),
  D({
    ...log,
    method: 'log.blogcomment.user.get',
    operation: 'read',
    pagination: 'cursor',
    rawCallable: true,
    source: `${DOCS}/api-reference/log/blogcomment/log-blogcomment-user-get.html`,
  }),

  // ---------- Классическая база знаний (landing) ----------
  D({
    ...landing,
    method: 'landing.site.getlist',
    operation: 'read',
    pagination: 'offset',
    rawCallable: true,
    source: `${DOCS}/api-reference/landing/site/landing-site-get-list.html`,
  }),
  D({
    ...landing,
    method: 'landing.site.add',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/site/landing-site-add.html`,
  }),
  D({
    ...landing,
    method: 'landing.site.addfolder',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/site/landing-site-add-folder.html`,
  }),
  D({
    ...landing,
    method: 'landing.site.getfolders',
    operation: 'read',
    pagination: 'none',
    rawCallable: true,
    source: `${DOCS}/api-reference/landing/site/landing-site-get-folders.html`,
  }),
  D({
    ...landing,
    method: 'landing.landing.getlist',
    operation: 'read',
    pagination: 'offset',
    rawCallable: true,
    source: `${DOCS}/api-reference/landing/page/methods/landing-landing-get-list.html`,
  }),
  D({
    ...landing,
    method: 'landing.landing.add',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/page/methods/landing-landing-add.html`,
  }),
  D({
    ...landing,
    method: 'landing.landing.update',
    operation: 'update',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/page/methods/landing-landing-update.html`,
  }),
  D({
    ...landing,
    method: 'landing.landing.publication',
    operation: 'update',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/page/methods/landing-landing-publication.html`,
  }),
  D({
    ...landing,
    method: 'landing.landing.addblock',
    operation: 'create',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/page/block-methods/landing-landing-add-block.html`,
  }),
  D({
    ...landing,
    method: 'landing.block.getlist',
    operation: 'read',
    pagination: 'none',
    rawCallable: true,
    source: `${DOCS}/api-reference/landing/block/methods/landing-block-get-list.html`,
  }),
  D({
    ...landing,
    method: 'landing.block.updatecontent',
    operation: 'update',
    pagination: 'none',
    rawCallable: false,
    source: `${DOCS}/api-reference/landing/block/methods/landing-block-update-content.html`,
  }),
  D({
    ...landing,
    method: 'landing.block.getrepository',
    operation: 'read',
    pagination: 'none',
    rawCallable: true,
    source: `${DOCS}/api-reference/landing/block/methods/landing-block-get-repository.html`,
  }),
];

/**
 * Администрирование арендатора в кабинете (SaaS-ТЗ §11.1 п.5, §4 сценарий 7, §9.3, §10, §14): пользователи и роли,
 * отключение (немедленный отзыв доступа), модули, политика подтверждений, лимит на пользователя, output policy,
 * подписка и оплата (смена тарифа, отмена/возобновление, счёт юрлицу), удаление всех данных.
 * Все действия — только роль administrator, POST с CSRF и Origin; удаление данных — свежий вход + слово ПОДТВЕРЖДАЮ.
 */
import type { FastifyInstance } from 'fastify';
import type { Role } from '../../config/policy.js';
import { ALL_MODULES, isModuleName } from '../../config/modules.js';
import { POLICY_SCHEMAS } from '../../config/policy.js';
import { AppError } from '../../errors/app-error.js';
import { ENTITLEMENTS_CHANNEL } from '../billing/entitlements.js';
import { publishInvalidate } from '../bitrix/invalidation.js';
import { planAllowsModule } from '../repos/plans.js';
import type { TenantDeletionReport, TenantDeletionRequest } from '../tenant-deletion.js';
import { CONFIRM_WORD } from './approval-link.js';
import { card, esc, fmtTime, hiddenCsrf, layout, rub } from './html.js';
import { CSP_EXTERNAL_FORM, errorText, field, fields, type Ctx, type Kit } from './kit.js';

const ROLES: readonly Role[] = ['reader', 'operator', 'administrator'];
const ROLE_TEXT: Record<Role, string> = {
  reader: 'чтение',
  operator: 'оператор (запись с подтверждением)',
  administrator: 'администратор',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT_POLICY_BYTES = 32 * 1024;

export type DeleteTenantData = (
  tenantId: string,
  req: TenantDeletionRequest,
) => Promise<TenantDeletionReport>;

const isRole = (v: string | undefined): v is Role =>
  v !== undefined && (ROLES as readonly string[]).includes(v);

/** Проверка output policy арендатора: схема базового ТЗ, корректные и ограниченные по длине regex. */
export function validateTenantOutputPolicy(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (Buffer.byteLength(text) > MAX_OUTPUT_POLICY_BYTES)
    throw new AppError('VALIDATION_ERROR', 'Политика слишком большая (больше 32 КиБ)', {
      field: 'outputPolicy',
    });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Политика — не JSON', { field: 'outputPolicy' });
  }
  const parsed = POLICY_SCHEMAS.OutputPolicySchema.safeParse(json);
  if (!parsed.success)
    throw new AppError('VALIDATION_ERROR', 'Политика не соответствует схеме output policy', {
      field: 'outputPolicy',
    });
  if (parsed.data.deniedFieldPatterns.length > 100)
    throw new AppError('VALIDATION_ERROR', 'Не больше 100 шаблонов deniedFieldPatterns', {
      field: 'outputPolicy',
    });
  for (const p of parsed.data.deniedFieldPatterns) {
    if (p.length > 200)
      throw new AppError('VALIDATION_ERROR', 'Шаблон длиннее 200 символов', { field: 'outputPolicy' });
    try {
      new RegExp(p);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Неверное регулярное выражение в deniedFieldPatterns', {
        field: 'outputPolicy',
      });
    }
  }
  return JSON.stringify(parsed.data);
}

export function registerTenantAdminRoutes(
  scope: FastifyInstance,
  kit: Kit,
  deleteData: DeleteTenantData,
): void {
  const { deps } = kit;

  const adminCtx = async (
    req: Parameters<Kit['requireCtx']>[0],
    reply: Parameters<Kit['requireCtx']>[1],
    post: boolean,
  ): Promise<Ctx | undefined> => {
    const ctx = await kit.requireCtx(req, reply);
    if (!ctx) return undefined;
    if (post && !kit.requireCsrf(req, reply, ctx, field(req.body, '_csrf'))) return undefined;
    if (!kit.requireAdmin(reply, ctx)) return undefined;
    return ctx;
  };

  const invalidate = async (tenantId: string, userId?: string) => {
    await publishInvalidate(deps.coordination, tenantId, userId);
    await deps.coordination.publish(ENTITLEMENTS_CHANNEL, tenantId);
  };

  const done = (path: string, msg: string) => `${path}?ok=${encodeURIComponent(msg)}`;
  const okNotice = (q: unknown) => {
    const v = (q as Record<string, unknown>)['ok'];
    return typeof v === 'string' && v.length < 200 ? `<p class="ok">${esc(v)}</p>` : '';
  };

  // ───────────────────────────── пользователи и настройки ─────────────────────────────

  scope.get('/admin', async (req, reply) => {
    const ctx = await adminCtx(req, reply, false);
    if (!ctx) return reply;
    const users = await deps.users.list(ctx.tenant.id);
    const settings = await deps.settings.get(ctx.tenant.id);
    const sub = await deps.subscriptions.get(ctx.tenant.id);
    const plan = sub ? await deps.plans.get(sub.planCode) : undefined;
    const csrf = hiddenCsrf(ctx.session.csrf);
    const userRows = users
      .map((u) => {
        const self = u.id === ctx.user.id;
        const roleForm = `<form method="post" action="/app/admin/users/${esc(u.id)}/role" class="inline">${csrf}
<select name="role">${ROLES.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(ROLE_TEXT[r])}</option>`).join('')}</select> <button class="plain">Сохранить</button></form>`;
        const statusForm = self
          ? '<span class="muted">это вы</span>'
          : u.status === 'disabled'
            ? `<form method="post" action="/app/admin/users/${esc(u.id)}/status" class="inline">${csrf}<input type="hidden" name="status" value="active"><button class="plain">Включить</button></form>`
            : `<form method="post" action="/app/admin/users/${esc(u.id)}/status" class="inline">${csrf}<input type="hidden" name="status" value="disabled"><button class="danger">Отключить</button></form>`;
        return `<tr><td>${esc(u.displayName || '—')}${self ? ' (вы)' : ''}</td><td>${String(u.bitrixUserId)}</td><td>${roleForm}</td><td>${esc(u.status)}</td><td>${esc(fmtTime(u.lastLoginAt))}</td><td>${statusForm}</td></tr>`;
      })
      .join('');
    const planModules = ALL_MODULES.filter((m) => m !== 'system' && (!plan || planAllowsModule(plan, m)));
    const moduleBoxes = planModules
      .map(
        (m) =>
          `<label><input type="checkbox" name="modules" value="${m}"${settings.modules.length === 0 || settings.modules.includes(m) ? ' checked' : ''}> ${m}</label>`,
      )
      .join(' ');
    const body =
      okNotice(req.query) +
      card(`<h2>Пользователи портала</h2>
<p class="muted">Пользователь появляется здесь после первого входа через Bitrix24. Роль сервиса только сужает права Bitrix24. Отключение сразу отзывает MCP-токены сотрудника и аннулирует его неисполненные подтверждения.</p>
<table><tr><th>Имя</th><th>ID Bitrix24</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th></th></tr>${userRows}</table>`) +
      card(`<h2>Модули и подтверждения</h2>
<form method="post" action="/app/admin/settings">${csrf}
<p><strong>Модули</strong> (в пределах тарифа${plan ? ` «${esc(plan.name)}»` : ''}; «system» — всегда):<br>${moduleBoxes}</p>
<p><strong>Кто подтверждает записи</strong><br>
<label><input type="radio" name="approvalPolicy" value="self"${settings.approvalPolicy === 'self' ? ' checked' : ''}> сам пользователь</label><br>
<label><input type="radio" name="approvalPolicy" value="admin_for_high_risk"${settings.approvalPolicy === 'admin_for_high_risk' ? ' checked' : ''}> удаления и массовые замены — администратор</label></p>
<p><label>Лимит вызовов на пользователя в сутки (пусто — без лимита)<br><input type="number" name="userDailyCallLimit" min="1" max="1000000" value="${settings.userDailyCallLimit ?? ''}"></label></p>
<p><label>Роль нового пользователя<br><select name="defaultRole">${ROLES.map((r) => `<option value="${r}"${r === settings.defaultRole ? ' selected' : ''}>${esc(ROLE_TEXT[r])}</option>`).join('')}</select></label></p>
<p><button>Сохранить настройки</button></p></form>`) +
      card(`<h2>Output policy (профили полей)</h2>
<p class="muted">JSON в формате policies/output.example.json: поля, которые сервис вырезает из ответов модели. Пусто — политика сервиса по умолчанию.</p>
<form method="post" action="/app/admin/output-policy">${csrf}
<p><textarea name="outputPolicy" spellcheck="false">${esc(settings.outputPolicyJson ? JSON.stringify(JSON.parse(settings.outputPolicyJson), null, 2) : '')}</textarea></p>
<p><button>Сохранить политику</button></p></form>`) +
      card(`<h2>Подписка, оплата, данные</h2>
<p><a href="/app/admin/billing">Подписка и оплата, счета</a></p>
<p><a href="/app/admin/delete" class="err">Удалить все данные портала в сервисе</a></p>`);
    return kit.html(reply, 200, kit.page('Администрирование', body, ctx));
  });

  scope.post<{ Params: { userId: string } }>('/admin/users/:userId/role', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const role = field(req.body, 'role');
    const target = UUID_RE.test(req.params.userId)
      ? await deps.users.get(ctx.tenant.id, req.params.userId)
      : undefined;
    if (!target) return kit.message(reply, 404, 'Пользователь', 'Пользователь не найден.', ctx);
    if (!isRole(role)) return kit.message(reply, 400, 'Пользователь', 'Неизвестная роль.', ctx);
    if (target.role === 'administrator' && role !== 'administrator') {
      const admins = (await deps.users.list(ctx.tenant.id)).filter(
        (u) => u.role === 'administrator' && u.status === 'active',
      );
      if (admins.length <= 1 && admins[0]?.id === target.id)
        return kit.message(
          reply,
          409,
          'Пользователь',
          'Нельзя снять роль с последнего администратора арендатора.',
          ctx,
        );
    }
    await deps.users.setRole(ctx.tenant.id, target.id, role);
    await invalidate(ctx.tenant.id, target.id);
    await kit.audit(ctx, 'admin_user_role', 'success');
    return reply.redirect(done('/app/admin', 'Роль сохранена'), 303);
  });

  scope.post<{ Params: { userId: string } }>('/admin/users/:userId/status', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const status = field(req.body, 'status');
    const target = UUID_RE.test(req.params.userId)
      ? await deps.users.get(ctx.tenant.id, req.params.userId)
      : undefined;
    if (!target) return kit.message(reply, 404, 'Пользователь', 'Пользователь не найден.', ctx);
    if (target.id === ctx.user.id)
      return kit.message(reply, 409, 'Пользователь', 'Нельзя отключить самого себя.', ctx);
    if (status === 'disabled') {
      await deps.users.setStatus(ctx.tenant.id, target.id, 'disabled');
      await deps.revokeUser(ctx.tenant.id, target.id);
      await kit.sessions.closeAllForUser(ctx.tenant.id, target.id);
      await invalidate(ctx.tenant.id, target.id);
      await kit.audit(ctx, 'admin_user_disable', 'success');
      deps.logger.info({ tenantId: ctx.tenant.id }, 'cabinet user disabled');
      return reply.redirect(done('/app/admin', 'Пользователь отключён, доступ отозван'), 303);
    }
    if (status === 'active') {
      const sub = await deps.subscriptions.get(ctx.tenant.id);
      const plan = sub ? await deps.plans.get(sub.planCode) : undefined;
      if (plan && (await deps.users.countActive(ctx.tenant.id)) >= plan.limits.users)
        return kit.message(
          reply,
          409,
          'Пользователь',
          `Все места тарифа заняты (${String(plan.limits.users)}). Отключите другого пользователя или смените тариф.`,
          ctx,
        );
      await deps.users.setStatus(ctx.tenant.id, target.id, 'active');
      await invalidate(ctx.tenant.id, target.id);
      await kit.audit(ctx, 'admin_user_enable', 'success');
      return reply.redirect(done('/app/admin', 'Пользователь включён'), 303);
    }
    return kit.message(reply, 400, 'Пользователь', 'Неизвестный статус.', ctx);
  });

  scope.post('/admin/settings', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const current = await deps.settings.get(ctx.tenant.id);
    const sub = await deps.subscriptions.get(ctx.tenant.id);
    const plan = sub ? await deps.plans.get(sub.planCode) : undefined;
    const planModules: string[] = ALL_MODULES.filter((m) => m !== 'system').filter(
      (m) => !plan || planAllowsModule(plan, m),
    );
    const chosen = fields(req.body, 'modules');
    if (!chosen.every((m): boolean => isModuleName(m) && m !== 'system'))
      return kit.message(reply, 400, 'Настройки', 'Неизвестный модуль.', ctx);
    if (chosen.length === 0)
      return kit.message(reply, 400, 'Настройки', 'Выберите хотя бы один модуль.', ctx);
    const policy = field(req.body, 'approvalPolicy');
    if (policy !== 'self' && policy !== 'admin_for_high_risk')
      return kit.message(reply, 400, 'Настройки', 'Неизвестная политика подтверждений.', ctx);
    const limitRaw = (field(req.body, 'userDailyCallLimit') ?? '').trim();
    let limit: number | null = null;
    if (limitRaw) {
      if (!/^\d{1,7}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 1_000_000)
        return kit.message(reply, 400, 'Настройки', 'Лимит — целое число от 1 до 1 000 000.', ctx);
      limit = Number(limitRaw);
    }
    const defaultRole = field(req.body, 'defaultRole');
    if (!isRole(defaultRole)) return kit.message(reply, 400, 'Настройки', 'Неизвестная роль.', ctx);
    // Все модули тарифа выбраны → пустой список («все модули тарифа», в том числе добавленные тарифом позже).
    const all = planModules.every((m) => chosen.includes(m));
    await deps.settings.save({
      ...current,
      modules: all ? [] : ['system', ...chosen.filter((m) => planModules.includes(m))],
      approvalPolicy: policy,
      userDailyCallLimit: limit,
      defaultRole,
    });
    await invalidate(ctx.tenant.id);
    await kit.audit(ctx, 'admin_settings', 'success');
    return reply.redirect(done('/app/admin', 'Настройки сохранены'), 303);
  });

  scope.post('/admin/output-policy', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    let json: string | null;
    try {
      json = validateTenantOutputPolicy(field(req.body, 'outputPolicy') ?? '');
    } catch (e) {
      return kit.message(reply, 400, 'Output policy', esc(errorText(e)), ctx);
    }
    const current = await deps.settings.get(ctx.tenant.id);
    await deps.settings.save({ ...current, outputPolicyJson: json });
    await invalidate(ctx.tenant.id);
    await kit.audit(ctx, 'admin_output_policy', 'success');
    return reply.redirect(done('/app/admin', 'Политика сохранена'), 303);
  });

  // ───────────────────────────── подписка и оплата ─────────────────────────────

  scope.get('/admin/billing', async (req, reply) => {
    const ctx = await adminCtx(req, reply, false);
    if (!ctx) return reply;
    const csrf = hiddenCsrf(ctx.session.csrf);
    const sub = await deps.subscriptions.get(ctx.tenant.id);
    const plan = sub ? await deps.plans.get(sub.planCode) : undefined;
    const plans = (await deps.plans.list({ publicOnly: true })).filter((p) => p.active && p.priceKopecks > 0);
    const planOptions = plans
      .map(
        (p) =>
          `<option value="${esc(p.code)}">${esc(p.name)} — ${rub(p.priceKopecks)} за ${p.periodMonths === 12 ? 'год' : 'месяц'}</option>`,
      )
      .join('');
    let notice = okNotice(req.query);
    const paymentId = (req.query as Record<string, unknown>)['payment'];
    const billing = deps.billing;
    if (billing && typeof paymentId === 'string' && UUID_RE.test(paymentId)) {
      try {
        const st = await billing.syncPayment(ctx.tenant.id, paymentId);
        notice += `<p class="${st === 'succeeded' ? 'ok' : 'muted'}">Платёж: ${esc(st === 'succeeded' ? 'оплачен' : st === 'canceled' ? 'отменён' : 'ожидает подтверждения провайдера')}.</p>`;
      } catch (e) {
        notice += `<p class="err">${esc(errorText(e))}</p>`;
      }
    }
    const subBlock = sub
      ? `<p>Тариф: <strong>${esc(plan?.name ?? sub.planCode)}</strong>; статус: <strong>${esc(sub.status)}</strong>${sub.cancelAtPeriodEnd ? ' (отменена, действует до конца периода)' : ''}.</p>
<p>Период: ${esc(fmtTime(sub.periodStart))} — ${esc(fmtTime(sub.periodEnd))}${sub.pendingPlanCode ? `; со следующего периода — тариф ${esc(sub.pendingPlanCode)}` : ''}.</p>
<p>Способ оплаты: ${esc(sub.paymentMethodTitle ?? (sub.hasPaymentMethod ? 'сохранён' : 'не сохранён'))}.</p>`
      : '<p>Подписка не оформлена.</p>';
    if (!billing) {
      return kit.html(
        reply,
        200,
        kit.page(
          'Подписка',
          card(
            `<h2>Подписка</h2>${subBlock}<p class="err">Оплата в этом развёртывании не настроена. Обратитесь к владельцу сервиса.</p>`,
          ),
          ctx,
        ),
      );
    }
    const actions: string[] = [];
    if (sub?.status === 'active' && !sub.cancelAtPeriodEnd)
      actions.push(
        `<form method="post" action="/app/admin/billing/cancel" class="inline">${csrf}<button class="danger">Отменить подписку (действует до конца периода)</button></form>`,
      );
    if (sub?.status === 'active' && sub.cancelAtPeriodEnd)
      actions.push(
        `<form method="post" action="/app/admin/billing/resume" class="inline">${csrf}<button>Возобновить подписку</button></form>`,
      );
    if (sub?.status === 'past_due')
      actions.push(
        `<form method="post" action="/app/admin/billing/cancel" class="inline">${csrf}<button class="danger">Отменить подписку</button></form>`,
      );
    const payments = await billing.payments(ctx.tenant.id, 20);
    const invoices = await billing.invoices(ctx.tenant.id);
    const body =
      notice +
      card(`<h2>Подписка</h2>${subBlock}${actions.join(' ')}`) +
      card(`<h3>Оплатить картой или СБП</h3>
<form method="post" action="/app/admin/billing/checkout">${csrf}
<p><label>Тариф<br><select name="planCode">${planOptions}</select></label></p>
<p><label>Email для чека (54-ФЗ)<br><input type="email" name="email" required maxlength="254"></label></p>
<p><label><input type="checkbox" name="saveMethod" value="yes"> Согласен на автоматическое списание за следующие периоды сохранённым способом оплаты</label></p>
<p><button>Перейти к оплате</button></p></form>
<p class="muted">Оплата проходит на странице платёжного провайдера; сервис не получает данные карты.</p>`) +
      (sub?.status === 'active'
        ? card(`<h3>Сменить тариф</h3>
<form method="post" action="/app/admin/billing/change-plan">${csrf}
<p><label>Новый тариф<br><select name="planCode">${planOptions}</select></label></p>
<p class="muted">Повышение — сразу, с доплатой за остаток периода; понижение — со следующего периода.</p>
<p><button>Сменить тариф</button></p></form>`)
        : '') +
      card(`<h3>Счёт для юрлица или ИП</h3>
<form method="post" action="/app/admin/billing/invoice">${csrf}
<p><label>Тариф<br><select name="planCode">${planOptions}</select></label></p>
<p><label>Наименование покупателя<br><input type="text" name="name" required maxlength="300"></label></p>
<p><label>ИНН<br><input type="text" name="inn" required maxlength="12" inputmode="numeric"></label></p>
<p><label>КПП (для юрлиц)<br><input type="text" name="kpp" maxlength="9" inputmode="numeric"></label></p>
<p><label>Адрес<br><input type="text" name="address" maxlength="500"></label></p>
<p><label>Email бухгалтерии<br><input type="email" name="email" maxlength="254"></label></p>
<p><button>Выставить счёт</button></p></form>
<p class="muted">Оплата по счёту отмечается владельцем сервиса вручную после поступления денег.</p>`) +
      card(
        `<h3>Платежи</h3>${
          payments.length
            ? `<table><tr><th>Дата</th><th>Назначение</th><th>Тариф</th><th>Сумма</th><th>Статус</th></tr>${payments
                .map(
                  (p) =>
                    `<tr><td>${esc(fmtTime(p.createdAt))}</td><td>${esc(p.purpose)}</td><td>${esc(p.planCode)}</td><td>${rub(p.amountKopecks)}</td><td>${esc(p.status)}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">Платежей нет.</p>'
        }`,
      ) +
      card(
        `<h3>Счета</h3>${
          invoices.length
            ? `<table><tr><th>Номер</th><th>Дата</th><th>Тариф</th><th>Сумма</th><th>Статус</th></tr>${invoices
                .map(
                  (i) =>
                    `<tr><td><a href="/app/admin/billing/invoices/${esc(i.id)}">${esc(i.number)}</a></td><td>${esc(fmtTime(i.createdAt))}</td><td>${esc(i.planCode)}</td><td>${rub(i.amountKopecks)}</td><td>${esc(i.status)}</td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">Счетов нет.</p>'
        }`,
      );
    return kit.html(reply, 200, kit.page('Подписка и оплата', body, ctx), CSP_EXTERNAL_FORM);
  });

  const billingOrFail = (ctx: Ctx, reply: Parameters<Kit['message']>[0]) => {
    if (deps.billing) return deps.billing;
    void kit.message(reply, 503, 'Оплата', 'Оплата в этом развёртывании не настроена.', ctx);
    return undefined;
  };

  scope.post('/admin/billing/checkout', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const billing = billingOrFail(ctx, reply);
    if (!billing) return reply;
    try {
      const r = await billing.checkout(ctx.tenant.id, {
        planCode: field(req.body, 'planCode') ?? '',
        contact: { email: (field(req.body, 'email') ?? '').trim() },
        savePaymentMethod: field(req.body, 'saveMethod') === 'yes',
      });
      await kit.audit(ctx, 'billing_checkout', 'success');
      if (r.confirmationUrl) {
        const url = new URL(r.confirmationUrl);
        if (url.protocol !== 'https:')
          throw new AppError('INTERNAL_ERROR', 'Некорректный адрес страницы оплаты');
        return await reply.header('Content-Security-Policy', CSP_EXTERNAL_FORM).redirect(url.toString(), 303);
      }
      return await reply.redirect(`/app/admin/billing?payment=${encodeURIComponent(r.paymentId)}`, 303);
    } catch (e) {
      await kit.audit(ctx, 'billing_checkout', 'error', { errorCode: AppError.from(e).code });
      return kit.message(reply, 400, 'Оплата', esc(errorText(e)), ctx);
    }
  });

  scope.post('/admin/billing/change-plan', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const billing = billingOrFail(ctx, reply);
    if (!billing) return reply;
    try {
      const r = await billing.changePlan(ctx.tenant.id, field(req.body, 'planCode') ?? '');
      await kit.audit(ctx, 'billing_change_plan', 'success');
      if (r.kind === 'payment_pending' && r.confirmationUrl?.startsWith('https://'))
        return await reply
          .header('Content-Security-Policy', CSP_EXTERNAL_FORM)
          .redirect(r.confirmationUrl, 303);
      const msg =
        r.kind === 'upgraded'
          ? `Тариф повышен${r.surchargeKopecks ? `, доплата ${rub(r.surchargeKopecks)}` : ''}`
          : r.kind === 'scheduled'
            ? `Тариф сменится ${fmtTime(r.effectiveAt)}${r.warnings.length ? `. Внимание: ${r.warnings.join('; ')}` : ''}`
            : r.kind === 'payment_failed'
              ? 'Доплата не прошла; тариф не изменён'
              : 'Доплата ожидает подтверждения';
      return await reply.redirect(done('/app/admin/billing', msg.slice(0, 190)), 303);
    } catch (e) {
      return kit.message(reply, 400, 'Смена тарифа', esc(errorText(e)), ctx);
    }
  });

  for (const action of ['cancel', 'resume'] as const) {
    scope.post(`/admin/billing/${action}`, async (req, reply) => {
      const ctx = await adminCtx(req, reply, true);
      if (!ctx) return reply;
      const billing = billingOrFail(ctx, reply);
      if (!billing) return reply;
      try {
        await (action === 'cancel' ? billing.cancel(ctx.tenant.id) : billing.resume(ctx.tenant.id));
        await kit.audit(ctx, `billing_${action}`, 'success');
        return await reply.redirect(
          done('/app/admin/billing', action === 'cancel' ? 'Подписка отменена' : 'Подписка возобновлена'),
          303,
        );
      } catch (e) {
        return kit.message(reply, 400, 'Подписка', esc(errorText(e)), ctx);
      }
    });
  }

  scope.post('/admin/billing/invoice', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    const billing = billingOrFail(ctx, reply);
    if (!billing) return reply;
    const opt = (name: string) => {
      const v = (field(req.body, name) ?? '').trim();
      return v ? { [name]: v } : {};
    };
    try {
      const inv = await billing.issueInvoice(ctx.tenant.id, field(req.body, 'planCode') ?? '', {
        name: (field(req.body, 'name') ?? '').trim(),
        inn: (field(req.body, 'inn') ?? '').trim(),
        ...opt('kpp'),
        ...opt('address'),
        ...opt('email'),
      });
      await kit.audit(ctx, 'billing_invoice', 'success');
      return await reply.redirect(`/app/admin/billing/invoices/${inv.id}`, 303);
    } catch (e) {
      return kit.message(reply, 400, 'Счёт', esc(errorText(e)), ctx);
    }
  });

  scope.get<{ Params: { id: string } }>('/admin/billing/invoices/:id', async (req, reply) => {
    const ctx = await adminCtx(req, reply, false);
    if (!ctx) return reply;
    const billing = billingOrFail(ctx, reply);
    if (!billing) return reply;
    const inv = (await billing.invoices(ctx.tenant.id)).find((i) => i.id === req.params.id);
    if (!inv) return kit.message(reply, 404, 'Счёт', 'Счёт не найден.', ctx);
    const plan = await deps.plans.get(inv.planCode);
    const body = card(`<h2>Счёт № ${esc(inv.number)} от ${esc(fmtTime(inv.createdAt).slice(0, 10))}</h2>
<table><tr><th>Покупатель</th><td>${esc(inv.buyer.name)}, ИНН ${esc(inv.buyer.inn)}${inv.buyer.kpp ? `, КПП ${esc(inv.buyer.kpp)}` : ''}${inv.buyer.address ? `, ${esc(inv.buyer.address)}` : ''}</td></tr>
<tr><th>Услуга</th><td>Доступ к сервису MCP для Bitrix24, тариф «${esc(plan?.name ?? inv.planCode)}», портал ${esc(ctx.tenant.domain)}</td></tr>
<tr><th>Сумма</th><td><strong>${rub(inv.amountKopecks)}</strong></td></tr>
<tr><th>Статус</th><td>${esc(inv.status === 'paid' ? 'оплачен' : inv.status === 'canceled' ? 'отменён' : 'выставлен')}</td></tr></table>
<p class="muted">Реквизиты продавца и печатная форма (PDF) — у владельца сервиса; распечатайте страницу или запросите PDF в поддержке.</p>`);
    return kit.html(reply, 200, kit.page('Счёт', body, ctx));
  });

  // ───────────────────────────── удаление всех данных ─────────────────────────────

  scope.get('/admin/delete', async (req, reply) => {
    const ctx = await adminCtx(req, reply, false);
    if (!ctx) return reply;
    const fresh = kit.fresh(ctx);
    const body = card(`<h2>Удалить все данные портала ${esc(ctx.tenant.domain)} в сервисе</h2>
<p class="err">Действие необратимо.</p><ul>
<li>Все MCP-подключения сотрудников отключаются сразу, неисполненные подтверждения аннулируются.</li>
<li>Ключ шифрования данных портала уничтожается: токены Bitrix24, планы операций и другие зашифрованные данные становятся нечитаемыми.</li>
<li>Удаляются пользователи сервиса, настройки, операции, журнал, подготовленные файлы, учёт использования.</li>
<li>Платёжные документы (платежи, счета) сохраняются отдельно по требованиям бухучёта.</li>
<li>Данные в самом Bitrix24 не затрагиваются. Приложение на портале удалите в Bitrix24 отдельно.</li></ul>
${
  fresh
    ? `<form method="post" action="/app/admin/delete">${hiddenCsrf(ctx.session.csrf)}
<p><label>Email для подтверждения удаления (необязательно)<br><input type="email" name="email" maxlength="254"></label></p>
<p><label>Введите слово <code>${CONFIRM_WORD}</code><br><input type="text" name="word" autocomplete="off" required></label></p>
<p><button class="danger">Удалить все данные</button></p></form>`
    : `<p class="banner">Нужен свежий вход (не старше 15 минут). <a href="${esc(kit.reloginLink('/app/admin/delete'))}">Войти заново через Bitrix24</a></p>`
}`);
    return kit.html(reply, 200, kit.page('Удаление данных', body, ctx));
  });

  scope.post('/admin/delete', async (req, reply) => {
    const ctx = await adminCtx(req, reply, true);
    if (!ctx) return reply;
    if (!kit.fresh(ctx))
      return kit.message(
        reply,
        403,
        'Нужен свежий вход',
        `Удаление данных — только после входа не старше 15 минут. <a href="${esc(kit.reloginLink('/app/admin/delete'))}">Войти заново</a>`,
        ctx,
      );
    if ((field(req.body, 'word') ?? '').trim() !== CONFIRM_WORD)
      return kit.message(
        reply,
        400,
        'Удаление не выполнено',
        `Введите ровно <code>${CONFIRM_WORD}</code>.`,
        ctx,
      );
    const emailRaw = (field(req.body, 'email') ?? '').trim();
    const email = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/.test(emailRaw) ? emailRaw : null;
    const report = await deleteData(ctx.tenant.id, {
      actor: 'tenant_admin',
      reason: 'Запрос администратора арендатора из кабинета (SaaS-ТЗ §14)',
    });
    if (deps.notifier) {
      try {
        await deps.notifier.tenantDataDeleted({
          tenantId: ctx.tenant.id,
          domain: ctx.tenant.domain,
          email,
          at: report.deletedAt,
        });
      } catch (e) {
        deps.logger.warn({ reason: e instanceof Error ? e.name : 'unknown' }, 'deletion notice failed');
      }
    }
    return kit.html(
      reply.header('Set-Cookie', kit.cookie(kit.sessionCookie, '', 0)),
      200,
      layout(
        'Данные удалены',
        card(`<h2>Данные портала ${esc(ctx.tenant.domain)} удалены</h2>
<p>Доступ отозван, ключ шифрования уничтожен, данные удалены ${esc(fmtTime(report.deletedAt))}.${email && deps.notifier ? ` Подтверждение отправлено на ${esc(email)}.` : ''}</p>
<p>Платёжные документы сохранены по требованиям бухучёта. Приложение на портале Bitrix24 удалите в настройках портала.</p>`),
      ),
    );
  });
}

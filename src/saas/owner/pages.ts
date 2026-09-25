/**
 * HTML панели владельца (SaaS-ТЗ §11.3): серверный рендер без JavaScript, стили — внешним файлом
 * (`/owner/static/owner.css`), чтобы CSP была `default-src 'self'` без 'unsafe-inline'. Всё, что пришло из БД,
 * экранируется `esc`. Токенов, секретов, способа оплаты и данных порталов в модели страниц нет (D15).
 */
import { kopecksToAmount } from '../billing/money.js';
import type { Plan } from '../repos/plans.js';
import type { OwnerSession } from './accounts.js';
import type { Announcement } from './announcements.js';
import type {
  ErrorCount,
  InvoiceView,
  MetricsSummary,
  PaymentView,
  SupportActionView,
  TenantDetail,
  TenantOverview,
} from './service.js';

export const OWNER_CSS = `body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}
header{background:#1f2933;color:#fff;padding:.6rem 1rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:center}
header a{color:#cfe3ff;text-decoration:none}header form{margin:0}.who{margin-left:auto}
main{max-width:76rem;margin:1rem auto;padding:0 1rem}
.card{background:#fff;border:1px solid #d9dde3;border-radius:6px;padding:1rem;margin-bottom:1rem;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e6ea;padding:.35rem .5rem;text-align:left;vertical-align:top}
input[type=text],input[type=password],input[type=email],input[type=number],input[type=datetime-local],select,textarea{padding:.35rem;border:1px solid #b9c0c9;border-radius:4px;max-width:100%}
textarea{width:100%;min-height:5rem}.wide{width:26rem}.narrow{width:7rem}
button{padding:.4rem .8rem;border-radius:4px;border:1px solid #2c5282;background:#2b6cb0;color:#fff;cursor:pointer}
button.danger{background:#c53030;border-color:#9b2c2c}.muted{color:#5f6b7a}.err{color:#c53030}.ok{color:#2f855a}
.inline{display:inline-flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:.2rem 0}
.badge{display:inline-block;padding:0 .4rem;border-radius:3px;background:#e2e8f0}.b-suspended,.b-critical{background:#fed7d7}
.b-active{background:#c6f6d5}.b-warning,.b-past_due{background:#feebc8}
code{background:#eef1f4;padding:.05rem .3rem;border-radius:3px}
@media (max-width:40rem){.wide{width:100%}}`;

export function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const rub = (kopecks: number): string => `${kopecksToAmount(Math.max(0, kopecks))} ₽`;

export function dt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const badge = (v: string | null | undefined) =>
  v ? `<span class="badge b-${esc(v)}">${esc(v)}</span>` : '<span class="muted">—</span>';

const csrfField = (s: OwnerSession) => `<input type="hidden" name="_csrf" value="${esc(s.csrf)}">`;

export function layout(title: string, body: string, session?: OwnerSession): string {
  const nav = session
    ? `<a href="/owner/tenants">Арендаторы</a><a href="/owner/payments">Платежи</a><a href="/owner/plans">Тарифы</a>
<a href="/owner/announcements">Объявления</a><a href="/owner/metrics">Метрики</a><a href="/owner/journal">Журнал</a>
<span class="who">${esc(session.owner.name)} (${esc(session.owner.role)})</span>
<form method="post" action="/owner/logout">${csrfField(session)}<button>Выйти</button></form>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} — владелец MCP для Bitrix24</title>
<link rel="stylesheet" href="/owner/static/owner.css"></head><body>
<header><strong>MCP для Bitrix24 · панель владельца</strong>${nav}</header><main>${body}
<p class="muted">Панель показывает только метаданные арендаторов: содержимое порталов, токены и данные сотрудников здесь недоступны.</p>
</main></body></html>`;
}

export function loginPage(message = ''): string {
  return layout(
    'Вход',
    `<div class="card"><h2>Вход владельца сервиса</h2>${message}
<form method="post" action="/owner/login">
<p><label>Email<br><input class="wide" type="email" name="email" autocomplete="username" required></label></p>
<p><label>Пароль<br><input class="wide" type="password" name="password" autocomplete="current-password" required></label></p>
<p><label>Код из приложения-аутентификатора (6 цифр)<br><input class="narrow" type="text" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" required></label></p>
<p><button>Войти</button></p></form>
<p class="muted">Учётная запись владельца создаётся на сервере: <code>npm run owner -- create --email &lt;email&gt;</code>. Это не вход Bitrix24.</p></div>`,
  );
}

export function messagePage(title: string, text: string, session?: OwnerSession, back?: string): string {
  return layout(
    title,
    `<div class="card"><p class="err">${esc(text)}</p>${back ? `<p><a href="${esc(back)}">Назад</a></p>` : ''}</div>`,
    session,
  );
}

const errorsCell = (errs: ErrorCount[]) =>
  errs.length
    ? errs
        .slice(0, 5)
        .map((e) => `<code>${esc(e.code)}</code>&nbsp;${String(e.count)}`)
        .join(', ')
    : '<span class="muted">нет</span>';

export function tenantsPage(
  session: OwnerSession,
  rows: TenantOverview[],
  filter: { status?: string | undefined; q?: string | undefined },
  offset: number,
  limit: number,
): string {
  const statuses = ['', 'active', 'suspended', 'uninstalled', 'deleted'];
  const table = rows.length
    ? `<table><tr><th>Портал</th><th>Статус</th><th>Тариф</th><th>Подписка</th><th>Период до</th><th>Польз.</th><th>Вызовы / записи (мес.)</th><th>Ошибки 7 дн.</th></tr>${rows
        .map(
          (r) =>
            `<tr><td><a href="/owner/tenants/${esc(r.id)}">${esc(r.domain)}</a></td><td>${badge(r.status)}</td><td>${esc(r.planName ?? r.planCode ?? '—')}</td><td>${badge(r.subscriptionStatus)}</td><td>${dt(r.periodEnd)}</td><td>${String(r.activeUsers)}</td><td>${String(r.callsMonth)} / ${String(r.writesMonth)}</td><td>${errorsCell(r.errors7d)}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">Арендаторов не найдено.</p>';
  const q = new URLSearchParams();
  if (filter.status) q.set('status', filter.status);
  if (filter.q) q.set('q', filter.q);
  const pager = (o: number) => {
    const p = new URLSearchParams(q);
    p.set('offset', String(o));
    return `/owner/tenants?${p.toString()}`;
  };
  return layout(
    'Арендаторы',
    `<div class="card"><h2>Арендаторы</h2>
<form method="get" action="/owner/tenants" class="inline"><label>Статус <select name="status">${statuses
      .map(
        (s) =>
          `<option value="${esc(s)}"${s === (filter.status ?? '') ? ' selected' : ''}>${esc(s || 'все')}</option>`,
      )
      .join('')}</select></label>
<label>Домен <input type="text" name="q" value="${esc(filter.q ?? '')}"></label><button>Показать</button></form>
${table}
<p>${offset > 0 ? `<a href="${esc(pager(Math.max(0, offset - limit)))}">← назад</a> ` : ''}${rows.length === limit ? `<a href="${esc(pager(offset + limit))}">дальше →</a>` : ''}</p>
<p class="muted">Использование — из PostgreSQL (задержка до 1 минуты). Ошибки — только коды из журнала аудита, без содержимого вызовов.</p></div>`,
    session,
  );
}

function paymentsTable(
  session: OwnerSession,
  payments: PaymentView[] | TenantDetail['payments'],
  canAct: boolean,
) {
  if (!payments.length) return '<p class="muted">Платежей нет.</p>';
  return `<table><tr><th>Создан</th>${'domain' in (payments[0] ?? {}) ? '<th>Портал</th>' : ''}<th>Назначение</th><th>Тариф</th><th>Сумма</th><th>Возвращено</th><th>Статус</th><th>Провайдер</th>${canAct ? '<th>Возврат</th>' : ''}</tr>${payments
    .map((p) => {
      const domain =
        'domain' in p
          ? `<td>${p.domain ? `<a href="/owner/tenants/${esc(p.tenantId)}">${esc(p.domain)}</a>` : '—'}</td>`
          : '';
      const left = p.amountKopecks - p.refundedKopecks;
      const refund =
        canAct && p.status === 'succeeded' && left > 0
          ? `<form method="post" action="/owner/payments/${esc(p.id)}/refund" class="inline">${csrfField(session)}
<input class="narrow" type="text" name="amount" value="${esc(kopecksToAmount(left))}" required aria-label="Сумма, ₽">
<input type="text" name="reason" placeholder="основание" required aria-label="Основание"><button class="danger">Вернуть</button></form>`
          : '';
      return `<tr><td>${dt(p.createdAt)}</td>${domain}<td>${esc(p.purpose)}</td><td>${esc(p.planCode)}</td><td>${rub(p.amountKopecks)}</td><td>${p.refundedKopecks ? rub(p.refundedKopecks) : '—'}</td><td>${badge(p.status)}</td><td>${esc(p.provider)}</td>${canAct ? `<td>${refund}</td>` : ''}</tr>`;
    })
    .join('')}</table>`;
}

function invoicesTable(session: OwnerSession, invoices: InvoiceView[], canAct: boolean): string {
  if (!invoices.length) return '<p class="muted">Счетов нет.</p>';
  return `<table><tr><th>Номер</th><th>Портал</th><th>Покупатель</th><th>Тариф</th><th>Сумма</th><th>Статус</th><th>Оплата</th></tr>${invoices
    .map((i) => {
      const act =
        i.status === 'issued' && canAct
          ? `<form method="post" action="/owner/invoices/${esc(i.id)}/mark-paid" class="inline">${csrfField(session)}
<input type="text" name="reason" placeholder="п/п №, дата" required aria-label="Основание"><button>Отметить оплату</button></form>`
          : i.paidAt
            ? `${dt(i.paidAt)} (${esc(i.markedBy ?? '')})`
            : '—';
      return `<tr><td>${esc(i.number)}</td><td>${i.domain ? `<a href="/owner/tenants/${esc(i.tenantId)}">${esc(i.domain)}</a>` : '—'}</td><td>${esc(i.buyerName)}, ИНН ${esc(i.buyerInn)}</td><td>${esc(i.planCode)}</td><td>${rub(i.amountKopecks)}</td><td>${badge(i.status)}</td><td>${act}</td></tr>`;
    })
    .join('')}</table>`;
}

function actionsTable(actions: SupportActionView[], withTenant: boolean): string {
  if (!actions.length) return '<p class="muted">Записей нет.</p>';
  return `<table><tr><th>Когда</th><th>Кто</th>${withTenant ? '<th>Портал</th>' : ''}<th>Действие</th><th>Основание</th><th>Подробности</th></tr>${actions
    .map(
      (a) =>
        `<tr><td>${dt(a.createdAt)}</td><td>${esc(a.actor)}</td>${withTenant ? `<td>${a.tenantId ? `<a href="/owner/tenants/${esc(a.tenantId)}">${esc(a.domain ?? a.tenantId)}</a>` : '—'}</td>` : ''}<td><code>${esc(a.action)}</code></td><td>${esc(a.reason)}</td><td><code>${esc(JSON.stringify(a.details))}</code></td></tr>`,
    )
    .join('')}</table>`;
}

export function tenantDetailPage(session: OwnerSession, d: TenantDetail, notice: string): string {
  const owner = session.owner.role === 'service_owner';
  const t = d.tenant;
  const s = d.subscription;
  const canExtend =
    s && (s.status === 'trialing' || (s.status === 'suspended' && d.plan?.priceKopecks === 0));
  const extend = canExtend
    ? `<form method="post" action="/owner/tenants/${esc(t.id)}/extend-trial" class="inline">${csrfField(session)}
<label>Продлить пробный период на <input class="narrow" type="number" name="days" min="1" max="90" value="7" required> дн.</label>
<input class="wide" type="text" name="reason" placeholder="основание (обязательно)" required><button>Продлить</button></form>`
    : '<p class="muted">Продление доступно только для пробного периода.</p>';
  const block = !owner
    ? ''
    : t.status === 'active'
      ? `<form method="post" action="/owner/tenants/${esc(t.id)}/block" class="inline">${csrfField(session)}
<input class="wide" type="text" name="reason" placeholder="причина блокировки (обязательно)" required>
<label>Введите домен портала для подтверждения <input type="text" name="confirm" required></label>
<button class="danger">Заблокировать</button></form>
<p class="muted">Блокировка: доступ MCP закрывается сразу, refresh-токены сервиса отзываются, неисполненные операции аннулируются. Данные не удаляются.</p>`
      : t.status === 'suspended'
        ? `<form method="post" action="/owner/tenants/${esc(t.id)}/unblock" class="inline">${csrfField(session)}
<input class="wide" type="text" name="reason" placeholder="основание (обязательно)" required><button>Разблокировать</button></form>`
        : '';
  return layout(
    t.domain,
    `<div class="card"><h2>${esc(t.domain)} ${badge(t.status)}</h2>${notice}
<table><tr><th>ID арендатора</th><td><code>${esc(t.id)}</code></td></tr>
<tr><th>Установлено</th><td>${dt(t.installedAt)}</td></tr>
<tr><th>Удалено с портала</th><td>${dt(t.uninstalledAt)}</td></tr>
<tr><th>Пробный период использован</th><td>${t.trialUsed ? 'да' : 'нет'}</td></tr>
<tr><th>Пользователи</th><td>активных ${String(d.users.active)}, отключённых ${String(d.users.disabled)}, нужен вход ${String(d.users.reauth)}</td></tr>
<tr><th>Использование ${esc(d.usage.month)}</th><td>вызовов ${String(d.usage.calls)}${d.plan ? ` из ${String(d.plan.limits.callsPerMonth)}` : ''}, записей ${String(d.usage.writes)}${d.plan ? ` из ${String(d.plan.limits.writesPerMonth)}` : ''}</td></tr>
<tr><th>Ошибки за 7 дней</th><td>${errorsCell(d.errors7d)}</td></tr>
<tr><th>Ошибки за 30 дней</th><td>${errorsCell(d.errors30d)}</td></tr></table></div>
<div class="card"><h3>Подписка</h3>${
      s
        ? `<table><tr><th>Тариф</th><td>${esc(d.plan?.name ?? s.planCode)} (<code>${esc(s.planCode)}</code>)${s.pendingPlanCode ? `, со следующего периода — <code>${esc(s.pendingPlanCode)}</code>` : ''}</td></tr>
<tr><th>Статус</th><td>${badge(s.status)}${s.cancelAtPeriodEnd ? ' (отменена с конца периода)' : ''}</td></tr>
<tr><th>Период</th><td>${dt(s.periodStart)} — ${dt(s.periodEnd)}</td></tr>
<tr><th>Автосписание</th><td>${s.hasPaymentMethod ? 'способ оплаты сохранён' : 'нет'}</td></tr>
<tr><th>Попытки списания</th><td>${String(s.retryCount)}${s.nextRetryAt ? `, следующая ${dt(s.nextRetryAt)}` : ''}</td></tr></table>`
        : '<p class="muted">Подписки нет.</p>'
    }
${extend}</div>
${owner ? `<div class="card"><h3>Блокировка</h3>${block || '<p class="muted">Недоступно в текущем статусе.</p>'}</div>` : ''}
<div class="card"><h3>Платежи</h3>${paymentsTable(session, d.payments, owner)}</div>
<div class="card"><h3>Счета юрлицам</h3>${invoicesTable(session, d.invoices, owner)}</div>
<div class="card"><h3>Журнал действий поддержки</h3>${actionsTable(d.actions, false)}</div>`,
    session,
  );
}

export function paymentsPage(
  session: OwnerSession,
  payments: PaymentView[],
  invoices: InvoiceView[],
  notice: string,
): string {
  const owner = session.owner.role === 'service_owner';
  return layout(
    'Платежи',
    `<div class="card"><h2>Счета юрлицам</h2>${notice}${invoicesTable(session, invoices, owner)}</div>
<div class="card"><h2>Платежи (последние)</h2>${paymentsTable(session, payments, owner)}
<p class="muted">Возврат — только вручную, через API провайдера; сумма в рублях («990.00»). Статус платежа берётся из API провайдера.</p></div>`,
    session,
  );
}

function planForm(session: OwnerSession, p: Plan | undefined): string {
  const v = (x: string | number | undefined) => esc(x ?? '');
  const checked = (b: boolean | undefined) => (b ? ' checked' : '');
  const code = p
    ? `<input type="hidden" name="code" value="${v(p.code)}"><code>${v(p.code)}</code>`
    : '<label>Код <input class="narrow" type="text" name="code" pattern="[a-z][a-z0-9_-]{1,31}" required></label>';
  return `<form method="post" action="/owner/plans" class="inline">${csrfField(session)}${code}
<label>Название <input type="text" name="name" value="${v(p?.name)}" required></label>
<label>Цена, ₽ <input class="narrow" type="text" name="price" value="${p ? esc(kopecksToAmount(p.priceKopecks)) : ''}" required></label>
<label>Период <select name="periodMonths"><option value="1"${p?.periodMonths === 12 ? '' : ' selected'}>1 мес.</option><option value="12"${p?.periodMonths === 12 ? ' selected' : ''}>12 мес.</option></select></label>
<label>Пробных дней <input class="narrow" type="number" name="trialDays" min="0" max="365" value="${v(p?.trialDays ?? 0)}"></label>
<label>Пользователей <input class="narrow" type="number" name="users" min="0" value="${v(p?.limits.users)}" required></label>
<label>Вызовов/мес. <input class="narrow" type="number" name="calls" min="0" value="${v(p?.limits.callsPerMonth)}" required></label>
<label>Записей/мес. <input class="narrow" type="number" name="writes" min="0" value="${v(p?.limits.writesPerMonth)}" required></label>
<label>Модули <input type="text" name="modules" value="${v(p?.modules.join(','))}" placeholder="* или crm,tasks" required></label>
<label><input type="checkbox" name="destructive" value="1"${checked(p?.destructiveAllowed)}> удаления</label>
<label><input type="checkbox" name="public" value="1"${checked(p?.public ?? true)}> публичный</label>
<label><input type="checkbox" name="active" value="1"${checked(p?.active ?? true)}> активен</label>
<label>Порядок <input class="narrow" type="number" name="sort" value="${v(p?.sort ?? 100)}"></label>
<input type="text" name="reason" placeholder="основание изменения" required><button>Сохранить</button></form>`;
}

export function plansPage(session: OwnerSession, plans: Plan[], notice: string): string {
  const owner = session.owner.role === 'service_owner';
  const rows = plans
    .map(
      (p) =>
        `<tr><td><code>${esc(p.code)}</code></td><td>${esc(p.name)}</td><td>${rub(p.priceKopecks)} / ${String(p.periodMonths)} мес.</td><td>${String(p.limits.users)}</td><td>${String(p.limits.callsPerMonth)}</td><td>${String(p.limits.writesPerMonth)}</td><td>${esc(p.modules.join(', '))}</td><td>${p.destructiveAllowed ? 'да' : 'нет'}</td><td>${p.public ? 'да' : 'нет'} / ${p.active ? 'да' : 'нет'}</td></tr>`,
    )
    .join('');
  const forms = owner
    ? `<div class="card"><h3>Изменить тариф</h3>${plans.map((p) => `<div class="card">${planForm(session, p)}</div>`).join('')}
<h3>Новый тариф</h3><div class="card">${planForm(session, undefined)}</div>
<p class="muted">Изменение цены действует для новых оплат и продлений; лимиты и модули — сразу (кэш экземпляров сбрасывается событием).</p></div>`
    : '';
  return layout(
    'Тарифы',
    `<div class="card"><h2>Тарифы</h2>${notice}<table><tr><th>Код</th><th>Название</th><th>Цена</th><th>Польз.</th><th>Вызовы/мес.</th><th>Записи/мес.</th><th>Модули</th><th>Удаления</th><th>Публичный / активен</th></tr>${rows}</table></div>${forms}`,
    session,
  );
}

export function announcementsPage(session: OwnerSession, list: Announcement[], notice: string): string {
  const owner = session.owner.role === 'service_owner';
  const rows = list.length
    ? `<table><tr><th>Создано</th><th>Уровень</th><th>Кому</th><th>Заголовок</th><th>Показ</th><th>Статус</th><th></th></tr>${list
        .map(
          (a) =>
            `<tr><td>${dt(a.createdAt)}<br><span class="muted">${esc(a.createdBy)}</span></td><td>${badge(a.level)}</td><td>${a.tenantId ? `<a href="/owner/tenants/${esc(a.tenantId)}">арендатор</a>` : 'все'}</td><td><strong>${esc(a.title)}</strong><br>${esc(a.body)}</td><td>${dt(a.startsAt)} — ${dt(a.endsAt)}</td><td>${a.active ? 'показывается' : 'снято'}</td><td>${
              owner && a.active
                ? `<form method="post" action="/owner/announcements/${String(a.id)}/deactivate">${csrfField(session)}<button class="danger">Снять</button></form>`
                : ''
            }</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">Объявлений нет.</p>';
  const form = owner
    ? `<div class="card"><h3>Новое объявление в кабинете</h3><form method="post" action="/owner/announcements">${csrfField(session)}
<p class="inline"><label>Уровень <select name="level"><option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option></select></label>
<label>ID арендатора (пусто — всем) <input class="wide" type="text" name="tenantId"></label></p>
<p><label>Заголовок<br><input class="wide" type="text" name="title" maxlength="200" required></label></p>
<p><label>Текст<br><textarea name="body" maxlength="4000" required></textarea></label></p>
<p class="inline"><label>Начало (UTC, пусто — сейчас) <input type="datetime-local" name="startsAt"></label>
<label>Окончание (UTC, пусто — бессрочно) <input type="datetime-local" name="endsAt"></label></p>
<p><button>Опубликовать</button></p></form></div>`
    : '';
  return layout('Объявления', `<div class="card"><h2>Объявления</h2>${notice}${rows}</div>${form}`, session);
}

export function metricsPage(session: OwnerSession, m: MetricsSummary): string {
  const kv = (r: Record<string, number>) =>
    Object.keys(r).length
      ? Object.entries(r)
          .map(([k, v]) => `${badge(k)} ${String(v)}`)
          .join(' ')
      : '<span class="muted">нет</span>';
  const pay = m.payments30d.length
    ? `<table><tr><th>Статус</th><th>Платежей</th><th>Сумма</th><th>Возвращено</th></tr>${m.payments30d
        .map(
          (p) =>
            `<tr><td>${badge(p.status)}</td><td>${String(p.count)}</td><td>${rub(p.amountKopecks)}</td><td>${rub(p.refundedKopecks)}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">Платежей за 30 дней нет.</p>';
  const proc = m.process
    ? `<table><tr><th>Вызовы инструментов по исходу (этот процесс)</th><td>${
        m.process.toolCallsByOutcome.length
          ? m.process.toolCallsByOutcome
              .map((o) => `<code>${esc(o.outcome)}</code>&nbsp;${String(o.count)}`)
              .join(', ')
          : '<span class="muted">нет</span>'
      }</td></tr>
<tr><th>HTTP 5xx</th><td>${String(m.process.http5xx)}</td></tr>
<tr><th>Продления</th><td>${kv(m.process.renewals)}</td></tr></table>
<p class="muted">Счётчики процесса с момента его запуска; сводка по кластеру — в Prometheus (<code>/metrics</code>).</p>`
    : '<p class="muted">Реестр метрик процесса не подключён.</p>';
  return layout(
    'Метрики',
    `<div class="card"><h2>Метрики сервиса</h2><p class="muted">На ${dt(m.generatedAt)}</p>
<table><tr><th>Арендаторы</th><td>${kv(m.tenantsByStatus)}</td></tr>
<tr><th>Подписки</th><td>${kv(m.subscriptionsByStatus)}</td></tr>
<tr><th>Ежемесячная выручка (active/past_due)</th><td>${rub(m.mrrKopecks)}</td></tr>
<tr><th>Неоплаченные счета</th><td>${String(m.invoicesIssued)}</td></tr>
<tr><th>Использование ${esc(m.usageMonth.month)}</th><td>вызовов ${String(m.usageMonth.calls)}, записей ${String(m.usageMonth.writes)}</td></tr></table></div>
<div class="card"><h3>Платежи за 30 дней</h3>${pay}</div>
<div class="card"><h3>Процесс</h3>${proc}</div>`,
    session,
  );
}

export function journalPage(session: OwnerSession, actions: SupportActionView[]): string {
  return layout(
    'Журнал',
    `<div class="card"><h2>Журнал действий владельца и поддержки</h2>${actionsTable(actions, true)}</div>`,
    session,
  );
}

/**
 * Страницы сервера авторизации (SaaS-ТЗ §7.2): серверный HTML без JavaScript, всё экранируется.
 * Экран согласия по docs/2026-07-28/tutorials/security/security_best_practices.mdx «Consent UI Requirements»:
 * имя клиента, запрашиваемые права, адрес возврата (хост redirect_uri), CSRF, запрет встраивания во фрейм.
 */
import type { OAuthScope } from './settings.js';

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SCOPE_TEXT: Record<OAuthScope, string> = {
  'mcp:read': 'Чтение данных Bitrix24 в пределах ваших прав (CRM, задачи, календарь, диск и др.)',
  'mcp:write':
    'Подготовка изменений в Bitrix24 от вашего имени (каждую запись вы подтверждаете отдельно в кабинете)',
};

const STYLE = `body{font-family:system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}
h1{font-size:1.4rem}.box{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
.warn{background:#fff4e5;border-color:#f0a020}.err{background:#fdecea;border-color:#d93025}
button{font-size:1rem;padding:.6rem 1.2rem;margin:.3rem .3rem 0 0;border-radius:6px;border:1px solid #888;cursor:pointer}
button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}input{font-size:1rem;padding:.5rem;width:100%;box-sizing:border-box}
code{word-break:break-all}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    `<h1>${esc(title)}</h1><div class="box err"><p>${esc(message)}</p></div><p>Вернитесь в приложение (Claude, ChatGPT и др.) и начните подключение заново.</p>`,
  );
}

export function portalPage(input: {
  clientName: string;
  sealed: string;
  csrf: string;
  portal: string;
  error?: string | undefined;
}): string {
  return layout(
    'Вход через Bitrix24',
    `<h1>Подключение «${esc(input.clientName)}» к MCP для Bitrix24</h1>
${input.error ? `<div class="box err"><p>${esc(input.error)}</p></div>` : ''}
<form method="post" action="/oauth/login">
<input type="hidden" name="request" value="${esc(input.sealed)}">
<input type="hidden" name="csrf" value="${esc(input.csrf)}">
<p><label for="portal">Адрес вашего портала Bitrix24</label></p>
<p><input id="portal" name="portal" required maxlength="253" placeholder="company.bitrix24.ru" value="${esc(input.portal)}"></p>
<p><button class="primary" type="submit">Войти через Bitrix24</button></p>
</form>
<p>Пароль Bitrix24 вводится только на странице вашего портала; сервис его не получает.</p>`,
  );
}

export function installPage(portal: string): string {
  return layout(
    'Приложение не установлено',
    `<h1>Приложение не установлено на портале</h1>
<div class="box warn"><p>На портале <b>${esc(portal)}</b> не установлено приложение «MCP для Bitrix24» (или оно было удалено).</p></div>
<p>Попросите администратора портала установить приложение из Маркета Bitrix24, затем начните подключение заново.</p>`,
  );
}

export function consentPage(input: {
  clientName: string;
  clientId: string;
  redirectHost: string;
  loopbackOnly: boolean;
  scopes: readonly OAuthScope[];
  portal: string;
  userName: string;
  sealed: string;
  csrf: string;
}): string {
  const scopes = input.scopes.map((s) => `<li><b>${esc(s)}</b> — ${esc(SCOPE_TEXT[s])}</li>`).join('');
  const warn = input.loopbackOnly
    ? `<div class="box warn"><p>Ответ будет отправлен программе на этом компьютере (<code>${esc(input.redirectHost)}</code>). Разрешайте, только если вы сами сейчас подключаете приложение на этом устройстве.</p></div>`
    : '';
  return layout(
    'Разрешение доступа',
    `<h1>Разрешить доступ к Bitrix24?</h1>
<div class="box">
<p>Приложение <b>${esc(input.clientName)}</b> запрашивает доступ к порталу <b>${esc(input.portal)}</b> от имени пользователя <b>${esc(input.userName)}</b>.</p>
<p>Идентификатор клиента: <code>${esc(input.clientId)}</code></p>
<p>Ответ будет отправлен на: <code>${esc(input.redirectHost)}</code></p>
<p>Запрашиваемые права:</p><ul>${scopes}</ul>
</div>
${warn}
<form method="post" action="/oauth/consent">
<input type="hidden" name="consent" value="${esc(input.sealed)}">
<input type="hidden" name="csrf" value="${esc(input.csrf)}">
<button class="primary" type="submit" name="decision" value="approve">Разрешить</button>
<button type="submit" name="decision" value="deny">Отклонить</button>
</form>
<p>Отозвать доступ можно в кабинете сервиса или у администратора портала.</p>`,
  );
}

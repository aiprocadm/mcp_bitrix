/**
 * Очистка текста для Ленты и HTML-блоков классической базы знаний (ТЗ §9.10, §9.13, §8.4).
 * Без внешних зависимостей: allowlist тегов и атрибутов, удаление исполняемого содержимого
 * (script/iframe/object/…), обработчиков on*, style и опасных URL (javascript:, vbscript:, data:).
 * Это защитный слой нашего сервера; портал дополнительно чистит HTML сам (landing.landing.addblock CONTENT).
 */

/** Элементы, удаляемые вместе с содержимым. */
const DROP_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'svg',
  'math',
  'xml',
  'textarea',
  'select',
];

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'sub',
  'sup',
  'small',
  'mark',
  'abbr',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'a',
  'img',
  'span',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'figure',
  'figcaption',
]);

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  '*': ['class', 'title'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
};

const URL_ATTRS = new Set(['href', 'src']);

export interface SanitizeResult {
  /** Очищенный текст/HTML. */
  readonly value: string;
  /** Что было удалено (для плана и предупреждений); пусто — текст не менялся. */
  readonly removed: readonly string[];
}

const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Безопасный URL: http(s), mailto, tel, относительный путь или якорь. */
export function isSafeUrl(raw: string): boolean {
  // Управляющие символы и пробелы внутри схемы — классический обход (java\tscript:)
  let v = '';
  for (const ch of decodeEntities(raw)) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x20 && !(c >= 0x7f && c <= 0x9f)) v += ch.toLowerCase();
  }
  if (v === '') return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!scheme) return true; // относительный путь, #якорь, ?query
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1] ?? '');
}

/** Удаляет опасные элементы вместе с содержимым и HTML-комментарии. Повторяет до устойчивости (вложенные обходы). */
function dropDangerous(input: string, removed: Set<string>): string {
  let s = input;
  for (let i = 0; i < 10; i++) {
    const before = s;
    s = s.replace(/<!--[\s\S]*?(-->|$)/g, () => {
      removed.add('HTML-комментарии');
      return '';
    });
    for (const tag of DROP_WITH_CONTENT) {
      const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
      s = s.replace(paired, () => {
        removed.add(tag);
        return '';
      });
      // Незакрытый/одиночный опасный тег: удаляем сам тег (и всё до конца для незакрытого script/style)
      const open = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
      s = s.replace(open, () => {
        removed.add(tag);
        return '';
      });
    }
    if (s === before) break;
  }
  return s;
}

/**
 * HTML → безопасный HTML: allowlist тегов/атрибутов, запрет on*, style, опасных URL.
 * Незнакомые теги удаляются, их текст остаётся; одиночные «<» экранируются.
 */
export function sanitizeHtml(input: string): SanitizeResult {
  const removed = new Set<string>();
  const s = dropDangerous(input, removed);
  let out = '';
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(s); m; m = TAG_RE.exec(s)) {
    out += escapeStrayText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      removed.add(`тег <${tag}>`);
      continue;
    }
    if (closing) {
      if (tag !== 'br' && tag !== 'hr' && tag !== 'img') out += `</${tag}>`;
      continue;
    }
    out += `<${tag}${cleanAttrs(tag, m[3] ?? '', removed)}>`;
  }
  out += escapeStrayText(s.slice(last));
  return { value: out, removed: [...removed] };
}

function escapeStrayText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanAttrs(tag: string, raw: string, removed: Set<string>): string {
  const allowed = new Set([...(ALLOWED_ATTRS['*'] ?? []), ...(ALLOWED_ATTRS[tag] ?? [])]);
  let out = '';
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m; m = ATTR_RE.exec(raw)) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on')) {
      removed.add('on*-атрибуты');
      continue;
    }
    if (!allowed.has(name)) {
      removed.add(`атрибут ${name}`);
      continue;
    }
    if (URL_ATTRS.has(name) && !isSafeUrl(value)) {
      removed.add('опасный URL (javascript:/data:/…)');
      continue;
    }
    if (name === 'target' && value !== '_blank') continue;
    out += ` ${name}="${escapeAttr(decodeEntities(value))}"`;
  }
  if (tag === 'a' && out.includes('target="_blank"') && !/\brel=/.test(out))
    out += ' rel="noopener noreferrer"';
  return out;
}

/**
 * Текст новости/комментария Ленты (BBCode или обычный текст): удаляются опасные HTML-элементы
 * вместе с содержимым, любые HTML-теги (текст остаётся), BBCode-ссылки/картинки с опасными URL.
 * Одиночные «<» в обычном тексте не трогаются.
 */
export function sanitizeFeedText(input: string): SanitizeResult {
  const removed = new Set<string>();
  let s = dropDangerous(input, removed);
  TAG_RE.lastIndex = 0;
  s = s.replace(TAG_RE, (_all, _c, tag: string, attrs: string) => {
    if (/\son[a-z]+\s*=/i.test(` ${attrs}`)) removed.add('on*-атрибуты');
    removed.add(`HTML-тег <${tag.toLowerCase()}>`);
    return '';
  });
  // [url=javascript:…]текст[/url] → текст; [url]javascript:…[/url] и [img]…[/img] с опасным URL → удалить
  s = s.replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, (all, url: string, text: string) => {
    if (isSafeUrl(url.replace(/^["']|["']$/g, ''))) return all;
    removed.add('опасный URL (javascript:/data:/…)');
    return text;
  });
  s = s.replace(/\[(url|img)\]([\s\S]*?)\[\/\1\]/gi, (all, _t, url: string) => {
    if (isSafeUrl(url.trim())) return all;
    removed.add('опасный URL (javascript:/data:/…)');
    return '';
  });
  return { value: s, removed: [...removed] };
}

/** Обычный текст → HTML: абзацы по пустой строке, переносы строк → <br>, всё экранируется. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * HTML блока → читаемый текст с сохранением структуры: заголовки (#), абзацы, пункты списков (-),
 * строки таблиц, переносы. Опасное содержимое удаляется до преобразования.
 */
export function htmlToText(html: string): string {
  const s = dropDangerous(html, new Set())
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|blockquote|pre|ul|ol|table|figure)>/gi, '\n\n')
    .replace(/<\/(tr|dt|dd|caption)>/gi, '\n')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?=[^-#])/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

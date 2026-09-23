/**
 * npm run check:secrets — проверка отслеживаемых Git файлов на секреты (ТЗ §17.3).
 * Находит: секретные URL вебхуков, приватные ключи, токены. Код выхода 1 при находках.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'webhook url with secret', re: /https?:\/\/[^\s"'`]+\/rest\/\d+\/[A-Za-z0-9_-]{8,}\/?/ },
  { name: 'webhook env with value', re: /BITRIX_WEBHOOK_BASE_URL\s*=\s*\S+/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'oauth token env with value', re: /BITRIX_(?:ACCESS|REFRESH)_TOKEN\s*=\s*\S+/ },
  { name: 'client secret env with value', re: /BITRIX_CLIENT_SECRET\s*=\s*\S+/ },
  { name: 'aws key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

const SKIP = [/^docs\/TZ\.md$/, /^package-lock\.json$/, /^scripts\/check-secrets\.ts$/];

/** Учебные значения: зарезервированные домены (RFC 2606) и явные плейсхолдеры из x/<...>. */
const PLACEHOLDER = /(\.invalid|\.example|example\.(com|org|net)|\/rest\/\d+\/x{6,}|<[^>]+>)/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings: string[] = [];
for (const file of files) {
  if (SKIP.some((re) => re.test(file))) continue;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (PLACEHOLDER.test(line)) return;
    for (const p of PATTERNS) {
      if (p.re.test(line)) findings.push(`${file}:${i + 1}: ${p.name}`);
    }
  });
}

if (findings.length) {
  process.stdout.write(findings.join('\n') + '\n');
  process.stdout.write(`Найдено потенциальных секретов: ${findings.length}\n`);
  process.exit(1);
}
process.stdout.write(`Проверено файлов: ${files.length}, секретов не найдено\n`);

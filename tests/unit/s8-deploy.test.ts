/**
 * S8: статическая проверка деплой-файлов deploy/saas (Docker в среде разработки нет — compose НЕ запускался).
 * YAML разбирается python3+PyYAML, если он есть (иначе этот тест — skip); скрипты — `bash -n`/`sh -n`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_ENV } from '../helpers/app.js';

const DEPLOY = path.resolve(MOCK_ENV, '..', '..', '..', 'deploy', 'saas');
const read = (f: string) => readFileSync(path.join(DEPLOY, f), 'utf8');
const PYYAML = spawnSync('python3', ['-c', 'import yaml']).status === 0;

interface Service {
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  networks?: string[];
  command?: string[];
  secrets?: string[];
  volumes?: string[];
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
  secrets: Record<string, { file: string }>;
}

function loadCompose(): Compose {
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import sys,yaml,json; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)',
      path.join(DEPLOY, 'docker-compose.yml'),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`YAML не разобран: ${r.stderr}`);
  return JSON.parse(r.stdout) as Compose;
}

describe('deploy/saas', () => {
  it.skipIf(!PYYAML)(
    'compose: web ×2 + worker + postgres 16 + redis 7 + nginx; наружу — только nginx',
    () => {
      const c = loadCompose();
      expect(Object.keys(c.services).sort()).toEqual([
        'nginx',
        'postgres',
        'redis',
        'web1',
        'web2',
        'worker',
      ]);
      expect(c.services['web1']?.environment?.['PROCESS_ROLE']).toBe('web');
      expect(c.services['web2']?.environment?.['PROCESS_ROLE']).toBe('web');
      expect(c.services['worker']?.environment?.['PROCESS_ROLE']).toBe('worker');
      expect(c.services['postgres']?.image).toMatch(/^postgres:16/);
      expect(c.services['redis']?.image).toMatch(/^redis:7/);
      for (const [name, s] of Object.entries(c.services)) {
        if (name !== 'nginx') expect(s.ports ?? []).toEqual([]);
      }
      expect(c.services['nginx']?.ports).toEqual(['80:80', '443:443']);
      // PostgreSQL и Redis — только во внутренней сети
      expect(c.networks['backend']?.internal).toBe(true);
      expect(c.services['postgres']?.networks).toEqual(['backend']);
      expect(c.services['redis']?.networks).toEqual(['backend']);
      // Redis: пароль из секрета (не в аргументах), AOF
      const redisCmd = (c.services['redis']?.command ?? []).join(' ');
      expect(redisCmd).toContain('/run/secrets/redis_password');
      expect(redisCmd).toContain('appendonly yes');
      expect(redisCmd).not.toContain('--requirepass');
      // секреты — только файлами
      for (const s of Object.values(c.secrets)) expect(s.file).toMatch(/^\.\/secrets\//);
      expect(c.services['worker']?.secrets).toContain('kek');
    },
  );

  it.skipIf(!PYYAML)('правила алертов: YAML корректен, метрики — из реестра сервиса', () => {
    const r = spawnSync(
      'python3',
      [
        '-c',
        'import sys,yaml,json; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)',
        path.join(DEPLOY, 'prometheus-alerts.example.yml'),
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { groups: { rules: { alert: string; expr: string }[] }[] };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    for (const rule of rules) {
      const names = rule.expr.match(/\b(mcp_[a-z_]+)/g) ?? [];
      for (const n of names)
        expect(n).toMatch(
          /^mcp_(http_responses|worker_leader|worker_task_runs|billing_renewals|redis_errors|bitrix_limiter_queue|tool_calls)_?(total)?$/,
        );
    }
  });

  it('в файлах нет секретов: только плейсхолдеры', () => {
    const compose = read('docker-compose.yml');
    expect(compose).not.toMatch(/PASSWORD:\s*[^\s/]/);
    const env = read('saas.env.example');
    for (const line of env.split('\n').filter((l) => /^(DATABASE_URL|REDIS_URL)=/.test(l))) {
      expect(line).toMatch(/<[^>]+>/);
    }
    expect(read('.gitignore')).toMatch(/^saas\.env$/m);
    expect(read('.gitignore')).toMatch(/^secrets\/$/m);
  });

  it('saas.env.example: переменные SaaS-ТЗ §15', () => {
    const env = read('saas.env.example');
    for (const v of [
      'DEPLOYMENT_MODE',
      'PUBLIC_BASE_URL',
      'DATABASE_URL',
      'REDIS_URL',
      'KEK_FILE',
      'B24_APP_CLIENT_ID',
      'B24_APP_CLIENT_SECRET_FILE',
      'OAUTH_SIGNING_KEYS_DIR',
      'YOOKASSA_SHOP_ID',
      'YOOKASSA_SECRET_KEY_FILE',
      'SELLER_INN',
      'SMTP_URL',
      'MAIL_FROM',
      'WORKER_LEASE_TTL_MS',
    ]) {
      expect(env).toMatch(new RegExp(`^${v}=`, 'm'));
    }
  });

  it('init PostgreSQL: роль сервиса без SUPERUSER/BYPASSRLS, BYPASSRLS — только у роли бэкапа', () => {
    const sql = read('postgres-init/10-roles.sh');
    expect(sql).toMatch(/CREATE ROLE :"app_role" .*NOSUPERUSER NOBYPASSRLS/);
    expect(sql).toMatch(/CREATE ROLE :"backup_role" .*NOSUPERUSER BYPASSRLS/);
    expect(sql).toContain('pg_read_all_data');
  });

  it('nginx: два web в upstream, HSTS, /metrics и /readyz наружу не публикуются', () => {
    const conf = read('nginx.conf.example');
    expect(conf).toMatch(/server web1:3000/);
    expect(conf).toMatch(/server web2:3000/);
    expect(conf).toContain('Strict-Transport-Security');
    expect(conf).not.toMatch(/location[^{]*\/metrics/);
    expect(conf).not.toMatch(/location[^{]*\/readyz/);
    // фигурные скобки сбалансированы
    expect(conf.split('{').length).toBe(conf.split('}').length);
  });

  it('скрипты синтаксически корректны', () => {
    for (const [sh, f] of [
      ['bash', 'pg-backup.sh'],
      ['bash', 'pg-restore-check.sh'],
      ['sh', 'postgres-init/10-roles.sh'],
    ] as const) {
      const r = spawnSync(sh, ['-n', path.join(DEPLOY, f)], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });
});

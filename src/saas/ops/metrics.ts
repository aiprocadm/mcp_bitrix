/**
 * Метрики процесса (SaaS-ТЗ §13 «Мониторинг»; этап S8): счётчики, датчики и гистограммы в памяти и экспорт в
 * текстовом формате Prometheus без внешних пакетов.
 * Формат: https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format (версия 0.0.4):
 * `# HELP`, `# TYPE`, строки `имя{метка="значение"} число`; гистограмма — `_bucket{le="…"}` (накопительно, с `+Inf`),
 * `_sum`, `_count`. Экранирование значений меток: `\\`, `\"`, `\n`.
 *
 * ПДн и секреты в метки не попадают: инструмент и код ошибки — из закрытых наборов, портал — псевдоним
 * (`portalAlias`: усечённый SHA-256 от ключа портала), пользователи и тела запросов не учитываются.
 * Число рядов каждой метрики ограничено (защита памяти от взрыва кардинальности); лишние ряды считаются в
 * `mcp_metrics_series_dropped_total`.
 */
import { createHash } from 'node:crypto';

export type Labels = Readonly<Record<string, string>>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABEL_VALUE = 80;

/** Значение метки — только безопасный короткий идентификатор; всё прочее заменяется на `other`. */
export function safeLabelValue(v: string): string {
  return v.length > 0 && v.length <= MAX_LABEL_VALUE && /^[A-Za-z0-9_.:/-]+$/.test(v) ? v : 'other';
}

/** Псевдоним портала для меток: одинаков на всех экземплярах, не раскрывает домен/member_id. */
export function portalAlias(portalKey: string): string {
  return createHash('sha256').update(`portal:${portalKey}`).digest('hex').slice(0, 12);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

abstract class Metric {
  protected readonly series = new Map<string, { labels: Labels; value: unknown }>();

  constructor(
    protected readonly registry: MetricsRegistry,
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {
    if (!NAME_RE.test(name)) throw new Error(`Недопустимое имя метрики: ${name}`);
    for (const l of labelNames)
      if (!LABEL_RE.test(l) || l === 'le') throw new Error(`Недопустимая метка: ${l}`);
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  protected keyOf(labels: Labels): { key: string; clean: Labels } {
    const clean: Record<string, string> = {};
    for (const l of this.labelNames) clean[l] = safeLabelValue(labels[l] ?? '');
    return { key: this.labelNames.map((l) => clean[l]).join('\u0000'), clean };
  }

  /** Найти или создать ряд; null — лимит рядов исчерпан. */
  protected slot<V>(labels: Labels, init: () => V): { value: V } | null {
    const { key, clean } = this.keyOf(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= this.registry.maxSeriesPerMetric) {
        this.registry.dropped();
        return null;
      }
      s = { labels: clean, value: init() };
      this.series.set(key, s);
    }
    return s as { value: V };
  }

  protected static labelText(labels: Labels, extra?: [string, string]): string {
    const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
    return parts.length ? `{${parts.join(',')}}` : '';
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    for (const s of this.series.values()) lines.push(...this.renderSeries(s.labels, s.value));
    return lines;
  }

  protected abstract renderSeries(labels: Labels, value: unknown): string[];

  reset(): void {
    this.series.clear();
  }
}

export class Counter extends Metric {
  readonly type = 'counter' as const;

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) throw new Error('Счётчик только растёт');
    const s = this.slot(labels, () => ({ n: 0 }));
    if (s) s.value.n += by;
  }

  get(labels: Labels = {}): number {
    return (this.series.get(this.keyOf(labels).key)?.value as { n: number } | undefined)?.n ?? 0;
  }

  protected renderSeries(labels: Labels, value: unknown): string[] {
    return [`${this.name}${Metric.labelText(labels)} ${formatNumber((value as { n: number }).n)}`];
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;

  set(labels: Labels, v: number): void {
    const s = this.slot(labels, () => ({ n: 0 }));
    if (s) s.value.n = v;
  }

  add(labels: Labels, by: number): void {
    const s = this.slot(labels, () => ({ n: 0 }));
    if (s) s.value.n += by;
  }

  get(labels: Labels = {}): number {
    return (this.series.get(this.keyOf(labels).key)?.value as { n: number } | undefined)?.n ?? 0;
  }

  protected renderSeries(labels: Labels, value: unknown): string[] {
    return [`${this.name}${Metric.labelText(labels)} ${formatNumber((value as { n: number }).n)}`];
  }
}

interface HistValue {
  counts: number[];
  sum: number;
  count: number;
}

/** Границы по умолчанию (секунды) — от 5 мс до 10 с: собственная обработка и ожидание лимитера. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  readonly buckets: readonly number[];

  constructor(
    registry: MetricsRegistry,
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    super(registry, name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, v: number): void {
    const s = this.slot<HistValue>(labels, () => ({ counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    if (!s) return;
    this.buckets.forEach((b, i) => {
      if (v <= b) s.value.counts[i] = (s.value.counts[i] ?? 0) + 1;
    });
    s.value.sum += v;
    s.value.count += 1;
  }

  /** Замер длительности: вызвать возвращённую функцию по окончании. */
  startTimer(labels: Labels, now: () => number = () => performance.now()): () => number {
    const start = now();
    return () => {
      const sec = (now() - start) / 1000;
      this.observe(labels, sec);
      return sec;
    };
  }

  snapshot(labels: Labels = {}): HistValue | undefined {
    return this.series.get(this.keyOf(labels).key)?.value as HistValue | undefined;
  }

  protected renderSeries(labels: Labels, value: unknown): string[] {
    const h = value as HistValue;
    const lines = this.buckets.map(
      (b, i) =>
        `${this.name}_bucket${Metric.labelText(labels, ['le', formatNumber(b)])} ${formatNumber(h.counts[i] ?? 0)}`,
    );
    lines.push(`${this.name}_bucket${Metric.labelText(labels, ['le', '+Inf'])} ${formatNumber(h.count)}`);
    lines.push(`${this.name}_sum${Metric.labelText(labels)} ${formatNumber(h.sum)}`);
    lines.push(`${this.name}_count${Metric.labelText(labels)} ${formatNumber(h.count)}`);
    return lines;
  }
}

/** Реестр метрик процесса. Эндпоинт подключается снаружи: `res.type(PROMETHEUS_CONTENT_TYPE).send(registry.render())`. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private droppedSeries = 0;

  constructor(readonly maxSeriesPerMetric = 5000) {}

  private add<M extends Metric>(m: M): M {
    const existing = this.metrics.get(m.name);
    if (existing) {
      if (existing.type !== m.type) throw new Error(`Метрика ${m.name} уже зарегистрирована с другим типом`);
      return existing as M;
    }
    this.metrics.set(m.name, m);
    return m;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(this, name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(this, name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): Histogram {
    return this.add(new Histogram(this, name, help, labelNames, buckets));
  }

  dropped(): void {
    this.droppedSeries += 1;
  }

  /** Текст для `GET /metrics` (Prometheus text format 0.0.4). */
  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) lines.push(...m.render());
    lines.push(
      '# HELP mcp_metrics_series_dropped_total Ряды метрик, отброшенные из-за лимита кардинальности',
      '# TYPE mcp_metrics_series_dropped_total counter',
      `mcp_metrics_series_dropped_total ${String(this.droppedSeries)}`,
    );
    return lines.join('\n') + '\n';
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Функция рендера для эндпоинта `/metrics` (подключает сборка режима saas). */
export function renderPrometheus(registry: MetricsRegistry): { contentType: string; body: string } {
  return { contentType: PROMETHEUS_CONTENT_TYPE, body: registry.render() };
}

// ---------------------------------------------------------------------------------------------------------------
// Метрики сервиса SaaS (§13): единые имена для всех модулей
// ---------------------------------------------------------------------------------------------------------------

/** Интерфейс для биллинга (S7): продления и платежи. Деньги — целые копейки. */
export interface BillingMetrics {
  renewal(result: 'succeeded' | 'failed' | 'skipped'): void;
  payment(status: 'succeeded' | 'canceled' | 'pending' | 'refunded', amountKopecks: number): void;
}

export interface SaasMetrics {
  readonly registry: MetricsRegistry;
  /** Вызов инструмента: outcome — `ok` или код ошибки (ErrorCode). */
  toolCall(tool: string, outcome: string, durationSec: number): void;
  /** HTTP-ответы (для алерта по 5xx): класс статуса. */
  httpResponse(route: string, status: number): void;
  readonly limiterQueue: Gauge;
  readonly limiterWait: Histogram;
  readonly limiterRejected: Counter;
  readonly redisErrors: Counter;
  readonly workerRuns: Counter;
  readonly workerDuration: Histogram;
  readonly workerLeader: Gauge;
  readonly billing: BillingMetrics;
}

export function createSaasMetrics(registry = new MetricsRegistry()): SaasMetrics {
  const calls = registry.counter(
    'mcp_tool_calls_total',
    'Вызовы инструментов по исходу (ok или код ошибки)',
    ['tool', 'outcome'],
  );
  const dur = registry.histogram(
    'mcp_tool_duration_seconds',
    'Длительность собственной обработки вызова инструмента (без ожидания Bitrix24 не отделяется: полная)',
    ['tool'],
  );
  const http = registry.counter('mcp_http_responses_total', 'HTTP-ответы по маршруту и классу статуса', [
    'route',
    'class',
  ]);
  const renewals = registry.counter('mcp_billing_renewals_total', 'Попытки продления подписок', ['result']);
  const payments = registry.counter('mcp_billing_payments_total', 'Платежи по статусу', ['status']);
  const amount = registry.counter(
    'mcp_billing_payments_kopecks_total',
    'Сумма платежей по статусу, копейки',
    ['status'],
  );
  return {
    registry,
    toolCall(tool, outcome, durationSec) {
      calls.inc({ tool, outcome });
      dur.observe({ tool }, durationSec);
    },
    httpResponse(route, status) {
      http.inc({ route, class: `${String(Math.floor(status / 100))}xx` });
    },
    limiterQueue: registry.gauge(
      'mcp_bitrix_limiter_queue',
      'Запросы к порталу в очереди лимитера этого экземпляра',
      ['portal'],
    ),
    limiterWait: registry.histogram(
      'mcp_bitrix_limiter_wait_seconds',
      'Ожидание места в общем лимите портала',
      ['portal'],
    ),
    limiterRejected: registry.counter(
      'mcp_bitrix_limiter_rejected_total',
      'Отказы лимитера (переполнение очереди, отмена)',
      ['portal', 'reason'],
    ),
    redisErrors: registry.counter('mcp_redis_errors_total', 'Ошибки обращения к Redis по месту', ['where']),
    workerRuns: registry.counter('mcp_worker_task_runs_total', 'Запуски задач worker по результату', [
      'task',
      'result',
    ]),
    workerDuration: registry.histogram(
      'mcp_worker_task_duration_seconds',
      'Длительность задач worker',
      ['task'],
      [0.1, 0.5, 1, 5, 15, 60, 300, 900],
    ),
    workerLeader: registry.gauge('mcp_worker_leader', '1 — этот процесс держит аренду лидера worker'),
    billing: {
      renewal(result) {
        renewals.inc({ result });
      },
      payment(status, amountKopecks) {
        if (!Number.isSafeInteger(amountKopecks) || amountKopecks < 0)
          throw new Error('Сумма — целые копейки ≥ 0');
        payments.inc({ status });
        amount.inc({ status }, amountKopecks);
      },
    },
  };
}

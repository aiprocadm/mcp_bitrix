/**
 * ЮKassa — реализация `PaymentProvider` (SaaS-ТЗ §10.1, D8). ЕДИНСТВЕННЫЙ сетевой файл модуля биллинга:
 * внедряемый fetch (`FetchLike`), allowlist хоста API, таймаут, повтор только с тем же Idempotence-Key.
 *
 * Источник контракта — официальный SDK yookassa-python (github.com/yoomoney/yookassa-sdk-python, коммит bde5a27):
 *  - адрес API `https://api.yookassa.ru/v3` — src/yookassa/configuration.py (Configuration.api_url);
 *  - Basic-авторизация shopId:secretKey, `Content-type: application/json` — src/yookassa/client.py
 *    (prepare_request_headers); повтор POST при HTTP 202 — client.py (Retry status_forcelist=[202]);
 *  - `POST /payments`, `GET /payments/{id}`, заголовок `Idempotence-Key` — src/yookassa/payment.py;
 *  - `POST /refunds` с `Idempotence-Key` — src/yookassa/refund.py;
 *  - тело платежа: amount{value,currency}, capture, confirmation{type:"redirect",return_url}, description (≤128),
 *    save_payment_method, payment_method_id, metadata, receipt — src/yookassa/domain/request/payment_request.py,
 *    domain/models/confirmation/request/confirmation_redirect.py; пример — docs/examples/02-payments.md;
 *  - чек: receipt{customer{full_name,inn,email,phone}, items[{description,quantity,amount,vat_code,payment_mode,
 *    payment_subject}], tax_system_code}; в чеке обязателен email или phone покупателя, а при отсутствии
 *    tax_system_code — vat_code у каждой позиции — domain/models/receipt.py, receipt_customer.py, receipt_item.py,
 *    PaymentRequest.validate();
 *  - ответ: id, status, paid, amount, test, confirmation.confirmation_url, payment_method{id,saved,title,type},
 *    metadata, cancellation_details{party,reason} — domain/response/payment_response.py,
 *    domain/models/payment_data/payment_data.py (ResponsePaymentData), domain/models/cancellation_details.py;
 *  - уведомление: {type:"notification", event:"payment.succeeded"|…, object{…}} —
 *    domain/notification/webhook_notification.py, webhook_notification_types.py;
 *  - адреса отправителей уведомлений — domain/common/security_helper.py (YOOKASSA_NETWORKS), использование —
 *    docs/examples/01-configuration.md «Входящие уведомления»; https://yookassa.ru/developers/using-api/webhooks.
 * Описание API: https://yookassa.ru/developers/api (create_payment, get_payment, create_refund).
 */
import { BlockList, isIP } from 'node:net';
import { AppError, configError } from '../../errors/app-error.js';
import type { FetchLike } from '../../bitrix/client.js';
import { amountToKopecks, kopecksToAmount } from './money.js';
import type {
  ChargeSavedInput,
  CheckoutInput,
  CreatePaymentInput,
  PaymentProvider,
  ProviderNotification,
  ProviderPayment,
  ProviderPaymentStatus,
  ProviderRefund,
  RefundInput,
} from './payment-provider.js';
import type { SellerSettings, YooKassaSettings } from './settings.js';

/** Хосты API ЮKassa, на которые разрешены исходящие запросы (§12 п.4, SSRF). */
export const YOOKASSA_API_HOSTS: readonly string[] = ['api.yookassa.ru'];

/** security_helper.py YOOKASSA_NETWORKS (SDK). */
export const YOOKASSA_NETWORKS: readonly string[] = [
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '185.71.76.0/27',
  '185.71.77.0/27',
  '2a02:5180:0:1509::/64',
  '2a02:5180:0:2655::/64',
  '2a02:5180:0:1533::/64',
  '2a02:5180:0:2669::/64',
];

const DESCRIPTION_MAX = 128; // payment_request.py DESCRIPTION_MAX_LENGTH
const STATUSES: readonly ProviderPaymentStatus[] = [
  'pending',
  'waiting_for_capture',
  'succeeded',
  'canceled',
];

function buildTrustedList(): BlockList {
  const list = new BlockList();
  for (const net of YOOKASSA_NETWORKS) {
    const [addr, prefix] = net.split('/');
    if (!addr) continue;
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (prefix) list.addSubnet(addr, Number(prefix), type);
    else list.addAddress(addr, type);
  }
  return list;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export interface YooKassaOptions {
  readonly settings: YooKassaSettings;
  readonly seller: SellerSettings;
  readonly fetch: FetchLike;
  readonly maxAttempts?: number;
  /** Пауза между повторами (тесты подменяют). */
  readonly sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

export class YooKassaProvider implements PaymentProvider {
  readonly name = 'yookassa';
  private readonly base: string;
  private readonly auth: string;
  private readonly trusted = buildTrustedList();
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: YooKassaOptions) {
    let url: URL;
    try {
      url = new URL(o.settings.apiUrl);
    } catch {
      throw configError('YOOKASSA_API_URL', 'некорректный адрес');
    }
    if (url.protocol !== 'https:' || !YOOKASSA_API_HOSTS.includes(url.hostname) || url.port !== '')
      throw configError('YOOKASSA_API_URL', `разрешён только https://${YOOKASSA_API_HOSTS.join(', ')}`);
    this.base = url.href.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${o.settings.shopId}:${o.settings.secretKey}`, 'utf8').toString('base64')}`;
    this.maxAttempts = o.maxAttempts ?? 3;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Тело платежа по модели PaymentRequest SDK. */
  private paymentBody(input: CreatePaymentInput): Json {
    const s = this.o.seller;
    const r = input.receipt;
    const customer: Json = {};
    if (r.customerFullName) customer['full_name'] = r.customerFullName;
    if (r.customerInn) customer['inn'] = r.customerInn;
    if (r.customerContact.email) customer['email'] = r.customerContact.email;
    if (r.customerContact.phone) customer['phone'] = r.customerContact.phone;
    if (!customer['email'] && !customer['phone'])
      throw new AppError('VALIDATION_ERROR', 'Для чека нужен email или телефон покупателя', {
        field: 'receipt.customer',
      });
    const amount = { value: kopecksToAmount(input.amountKopecks), currency: 'RUB' };
    if (input.amountKopecks <= 0)
      throw new AppError('VALIDATION_ERROR', 'Сумма платежа должна быть больше нуля', { field: 'amount' });
    return {
      amount,
      capture: true,
      description: truncate(input.description, DESCRIPTION_MAX),
      metadata: { ...input.metadata },
      receipt: {
        customer,
        items: [
          {
            description: truncate(r.itemDescription, DESCRIPTION_MAX),
            quantity: '1.00',
            amount,
            vat_code: s.vatCode,
            payment_mode: s.paymentMode,
            payment_subject: s.paymentSubject,
          },
        ],
        tax_system_code: s.taxSystemCode,
      },
    };
  }

  async createPayment(input: CheckoutInput): Promise<ProviderPayment> {
    const body = {
      ...this.paymentBody(input),
      confirmation: { type: 'redirect', return_url: input.returnUrl },
      save_payment_method: input.savePaymentMethod,
    };
    return toPayment(await this.request('POST', '/payments', body, input.idempotenceKey));
  }

  async chargeSaved(input: ChargeSavedInput): Promise<ProviderPayment> {
    if (!input.paymentMethodId)
      throw new AppError('VALIDATION_ERROR', 'Нет сохранённого способа оплаты', { field: 'paymentMethodId' });
    const body = { ...this.paymentBody(input), payment_method_id: input.paymentMethodId };
    return toPayment(await this.request('POST', '/payments', body, input.idempotenceKey));
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
      throw new AppError('NOT_FOUND', 'Платёж не найден', { reason: 'PAYMENT_NOT_FOUND' });
    return toPayment(await this.request('GET', `/payments/${id}`, undefined, undefined));
  }

  async refund(input: RefundInput): Promise<ProviderRefund> {
    const body: Json = {
      payment_id: input.paymentId,
      amount: { value: kopecksToAmount(input.amountKopecks), currency: 'RUB' },
      description: truncate(input.description, 250),
    };
    const r = await this.request('POST', '/refunds', body, input.idempotenceKey);
    const status = r['status'];
    if (
      typeof r['id'] !== 'string' ||
      typeof r['payment_id'] !== 'string' ||
      (status !== 'pending' && status !== 'succeeded' && status !== 'canceled')
    )
      throw malformed();
    return {
      id: r['id'],
      paymentId: r['payment_id'],
      status,
      amountKopecks: amountToKopecks((r['amount'] as Json | undefined)?.['value']),
    };
  }

  isTrustedSource(ip: string): boolean {
    const clean = ip.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
    const v = isIP(clean);
    if (v === 0) return false;
    return this.trusted.check(clean, v === 6 ? 'ipv6' : 'ipv4');
  }

  parseNotification(body: unknown): ProviderNotification | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const b = body as Json;
    const obj = b['object'] as Json | undefined;
    if (
      b['type'] !== 'notification' ||
      typeof b['event'] !== 'string' ||
      !obj ||
      typeof obj['id'] !== 'string'
    )
      return undefined;
    const event = b['event'];
    const objectType = event.startsWith('payment.')
      ? 'payment'
      : event.startsWith('refund.')
        ? 'refund'
        : undefined;
    if (!objectType || !/^[A-Za-z0-9-]{1,64}$/.test(obj['id'])) return undefined;
    return { event, objectType, objectId: obj['id'] };
  }

  /**
   * Запрос к API. Повтор (до maxAttempts) при HTTP 202 (как SDK), 500 и сетевой ошибке — с ТЕМ ЖЕ
   * Idempotence-Key: ЮKassa вернёт тот же объект, второго списания не будет. Тело ответа и секрет в ошибки не
   * копируются.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Json | undefined,
    idempotenceKey: string | undefined,
  ): Promise<Json> {
    if (method === 'POST' && (!idempotenceKey || idempotenceKey.length > 64))
      throw new AppError('INTERNAL_ERROR', 'Нужен ключ идемпотентности длиной до 64 символов');
    const headers: Record<string, string> = {
      Authorization: this.auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
    const init: RequestInit = { method, headers };
    if (body) init.body = JSON.stringify(body);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.o.fetch(`${this.base}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.o.settings.timeoutMs),
        });
      } catch {
        lastStatus = 0;
        if (attempt < this.maxAttempts) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw new AppError('INTERNAL_ERROR', 'Платёжный провайдер недоступен', {
          reason: 'PAYMENT_PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      }
      lastStatus = res.status;
      if (res.status === 200) {
        const json = await res.json().catch(() => undefined);
        if (!json || typeof json !== 'object') throw malformed();
        return json as Json;
      }
      if ((res.status === 202 || res.status >= 500) && attempt < this.maxAttempts) {
        await res.body?.cancel().catch(() => undefined);
        const retryAfter = Number(res.headers.get('Retry-After'));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30_000) : 1000 * attempt,
        );
        continue;
      }
      const err = (await res.json().catch(() => undefined)) as Json | undefined;
      const code = typeof err?.['code'] === 'string' ? err['code'] : undefined;
      throw providerError(res.status, code);
    }
    throw providerError(lastStatus, undefined);
  }
}

function malformed(): AppError {
  return new AppError('INTERNAL_ERROR', 'Неожиданный ответ платёжного провайдера', {
    reason: 'PAYMENT_PROVIDER_MALFORMED',
  });
}

function providerError(status: number, code: string | undefined): AppError {
  const upstream = code && /^[a-z_]{1,64}$/.test(code) ? { upstreamCode: code } : {};
  if (status === 404)
    return new AppError('NOT_FOUND', 'Платёж не найден', { reason: 'PAYMENT_NOT_FOUND', ...upstream });
  if (status === 400)
    return new AppError('VALIDATION_ERROR', 'Платёжный провайдер отклонил запрос', {
      reason: 'PAYMENT_PROVIDER_BAD_REQUEST',
      httpStatus: status,
      ...upstream,
    });
  if (status === 401 || status === 403)
    return new AppError('CONFIG_INVALID', 'Платёжный провайдер отклонил учётные данные магазина', {
      field: 'YOOKASSA_SHOP_ID',
      httpStatus: status,
      nextAction: 'Проверьте YOOKASSA_SHOP_ID и файл секретного ключа (значения не показываются)',
    });
  if (status === 429)
    return new AppError('RATE_LIMITED', 'Слишком много запросов к платёжному провайдеру', {
      reason: 'PAYMENT_PROVIDER_RATE_LIMITED',
      retryable: true,
    });
  return new AppError('INTERNAL_ERROR', 'Платёжный провайдер недоступен', {
    reason: 'PAYMENT_PROVIDER_UNAVAILABLE',
    httpStatus: status,
    retryable: true,
  });
}

/** Ответ PaymentResponse → ProviderPayment; неизвестный статус/формат — ошибка (не угадываем). */
function toPayment(r: Json): ProviderPayment {
  const status = r['status'];
  const amount = r['amount'] as Json | undefined;
  if (typeof r['id'] !== 'string' || !STATUSES.includes(status as ProviderPaymentStatus) || !amount)
    throw malformed();
  const pm = r['payment_method'] as Json | undefined;
  const conf = r['confirmation'] as Json | undefined;
  const cancel = r['cancellation_details'] as Json | undefined;
  const meta = r['metadata'] as Json | undefined;
  const metadata: Record<string, string> = {};
  if (meta && typeof meta === 'object')
    for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') metadata[k] = v;
  return {
    id: r['id'],
    status: status as ProviderPaymentStatus,
    paid: r['paid'] === true,
    amountKopecks: amountToKopecks(amount['value']),
    currency: typeof amount['currency'] === 'string' ? amount['currency'] : 'RUB',
    test: r['test'] === true,
    confirmationUrl: typeof conf?.['confirmation_url'] === 'string' ? conf['confirmation_url'] : undefined,
    paymentMethod:
      pm && typeof pm['id'] === 'string'
        ? {
            id: pm['id'],
            saved: pm['saved'] === true,
            type: typeof pm['type'] === 'string' ? pm['type'] : 'unknown',
            title: typeof pm['title'] === 'string' ? pm['title'] : undefined,
          }
        : undefined,
    metadata,
    cancellationReason: typeof cancel?.['reason'] === 'string' ? cancel['reason'] : undefined,
  };
}

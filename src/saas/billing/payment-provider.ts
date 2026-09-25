/**
 * Платёжный провайдер (SaaS-ТЗ §10.1, D9): биллинг знает только этот интерфейс; второй провайдер добавляется
 * без изменения `SubscriptionService`. Суммы — целые копейки. Первая реализация — ЮKassa (`yookassa.ts`).
 */

export type ProviderPaymentStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

/** Позиция чека 54-ФЗ: одна услуга «Доступ к сервису MCP для Bitrix24, тариф X, период». */
export interface ReceiptInput {
  /** Email или телефон покупателя — куда провайдер отправит чек. */
  readonly customerContact: { readonly email?: string; readonly phone?: string };
  readonly customerFullName?: string;
  readonly customerInn?: string;
  readonly itemDescription: string;
}

export interface CreatePaymentInput {
  /** Ключ идемпотентности запроса к провайдеру (повтор с тем же ключом не создаёт второй платёж). */
  readonly idempotenceKey: string;
  readonly amountKopecks: number;
  readonly description: string;
  readonly receipt: ReceiptInput;
  /** Служебные метки (id арендатора и платежа сервиса) — без персональных данных. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CheckoutInput extends CreatePaymentInput {
  /** Куда вернуть пользователя со страницы оплаты. */
  readonly returnUrl: string;
  /** Сохранить способ оплаты для автосписаний (согласие — явная галочка в кабинете, §10.1). */
  readonly savePaymentMethod: boolean;
}

export interface ChargeSavedInput extends CreatePaymentInput {
  /** Идентификатор сохранённого способа оплаты у провайдера (расшифрованный). */
  readonly paymentMethodId: string;
}

export interface ProviderPaymentMethod {
  readonly id: string;
  readonly saved: boolean;
  readonly type: string;
  /** Маска для кабинета («Bank card *4444»), без реквизитов. */
  readonly title: string | undefined;
}

export interface ProviderPayment {
  readonly id: string;
  readonly status: ProviderPaymentStatus;
  readonly paid: boolean;
  readonly amountKopecks: number;
  readonly currency: string;
  readonly test: boolean;
  /** Адрес страницы оплаты (confirmation.confirmation_url) — только у платежа, ожидающего пользователя. */
  readonly confirmationUrl: string | undefined;
  readonly paymentMethod: ProviderPaymentMethod | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly cancellationReason: string | undefined;
}

export interface RefundInput {
  readonly idempotenceKey: string;
  readonly paymentId: string;
  readonly amountKopecks: number;
  readonly description: string;
  readonly receipt?: ReceiptInput;
}

export interface ProviderRefund {
  readonly id: string;
  readonly paymentId: string;
  readonly status: 'pending' | 'succeeded' | 'canceled';
  readonly amountKopecks: number;
}

/** Разобранное уведомление: только идентификатор объекта. Статус из уведомления НЕ используется (§10.1). */
export interface ProviderNotification {
  readonly event: string;
  readonly objectType: 'payment' | 'refund';
  readonly objectId: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Первая оплата: страница провайдера, при согласии — сохранение способа оплаты. */
  createPayment(input: CheckoutInput): Promise<ProviderPayment>;
  /** Рекуррентное списание сохранённым способом (без участия пользователя). */
  chargeSaved(input: ChargeSavedInput): Promise<ProviderPayment>;
  /** Текущее состояние платежа по API провайдера — единственный источник истины о статусе. */
  getPayment(id: string): Promise<ProviderPayment>;
  refund(input: RefundInput): Promise<ProviderRefund>;
  /** Адрес отправителя уведомления входит в документированный список провайдера. */
  isTrustedSource(ip: string): boolean;
  /** Разбор тела уведомления (структура); undefined — не уведомление провайдера. */
  parseNotification(body: unknown): ProviderNotification | undefined;
}

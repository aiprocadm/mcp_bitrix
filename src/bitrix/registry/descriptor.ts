/**
 * Тип записи реестра REST-методов и помощник D (ТЗ §12, §14.1, §15.4).
 * Вынесено отдельно, чтобы группы модулей (src/bitrix/registry/*.ts) не импортировали method-registry.ts циклически.
 */
export type ApiVersion = 'legacy' | 'v3';
export type OperationKind = 'read' | 'create' | 'update' | 'delete' | 'upload' | 'admin/diagnostic';
export type PaginationKind = 'none' | 'offset' | 'cursor' | 'message-id' | 'first-page-only';

export interface MethodDescriptor {
  readonly method: string;
  readonly apiVersion: ApiVersion;
  readonly operation: OperationKind;
  /** Scope Bitrix24; undefined для базовых методов без отдельного scope (profile, method.get). */
  readonly scope?: string;
  readonly pagination: PaginationKind;
  readonly supportsNativeIdempotency: boolean;
  readonly applicationContextRequired: boolean;
  /** Разрешён ли метод для `bitrix_rest_call` в принципе (при наличии в policy allowlist). */
  readonly rawCallable: boolean;
  readonly source: string;
}

export const D = (d: MethodDescriptor): readonly [string, MethodDescriptor] => [
  `${d.apiVersion}:${d.method}`,
  d,
];

export const DOCS = 'https://apidocs.bitrix24.ru';

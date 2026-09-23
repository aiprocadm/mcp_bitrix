/**
 * Политики из JSON-файлов (ТЗ §13 METHOD_POLICY_FILE / ACCESS_POLICY_FILE / OUTPUT_POLICY_FILE).
 * `npm run setup` создаёт рабочие файлы из policies/*.example.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';

const MethodPolicySchema = z
  .object({
    version: z.string().min(1),
    /** Положительный allowlist для bitrix_rest_call: только эти пары (apiVersion, method). */
    rawAllowlist: z
      .array(
        z
          .object({
            apiVersion: z.enum(['legacy', 'v3']),
            method: z.string().regex(/^[a-z][a-z0-9_.]*$/i),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const RoleSchema = z.enum(['reader', 'operator', 'administrator']);

const AccessPolicySchema = z
  .object({
    version: z.string().min(1),
    principals: z.record(z.string(), z.object({ role: RoleSchema }).strict()),
    /** Инструменты, запрещённые конкретной роли (сверх типов операций). */
    deniedTools: z.partialRecord(RoleSchema, z.array(z.string())).default({}),
  })
  .strict();

const OutputPolicySchema = z
  .object({
    version: z.string().min(1),
    /** Поля (regex по имени ключа, регистр учитывается: поля Bitrix — ВЕРХНИЙ_РЕГИСТР), удаляемые из любых ответов. */
    deniedFieldPatterns: z.array(z.string()).default([]),
    /** Профили выдачи: какие поля разрешены для роли по модулю/сущности; пусто = все, кроме denied. */
    profiles: z
      .record(z.string(), z.record(z.string(), z.record(z.string(), z.array(z.string()))))
      .default({}),
  })
  .strict();

export type MethodPolicy = z.infer<typeof MethodPolicySchema>;
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;
export type OutputPolicy = z.infer<typeof OutputPolicySchema>;
export type Role = z.infer<typeof RoleSchema>;

export interface Policies {
  readonly methods: MethodPolicy;
  readonly access: AccessPolicy;
  readonly output: OutputPolicy;
  /** Версия набора политик, попадает в план записи (ТЗ §8.2 п.2). */
  readonly version: string;
}

function loadJson<T>(filePath: string, schema: z.ZodType<T>, field: string): T {
  if (!existsSync(filePath)) {
    throw new AppError('CONFIG_INVALID', `Файл политики не найден: выполните npm run setup`, {
      field,
      nextAction: 'npm run setup',
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new AppError('CONFIG_INVALID', 'Файл политики не является корректным JSON', { field });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(
      'CONFIG_INVALID',
      `Файл политики не соответствует схеме: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`,
      {
        field,
      },
    );
  }
  return parsed.data;
}

export function loadPolicies(paths: { methods: string; access: string; output: string }): Policies {
  const methods = loadJson(paths.methods, MethodPolicySchema, 'METHOD_POLICY_FILE');
  const access = loadJson(paths.access, AccessPolicySchema, 'ACCESS_POLICY_FILE');
  const output = loadJson(paths.output, OutputPolicySchema, 'OUTPUT_POLICY_FILE');
  for (const p of output.deniedFieldPatterns) {
    try {
      new RegExp(p);
    } catch {
      throw new AppError('CONFIG_INVALID', `Неверное регулярное выражение в deniedFieldPatterns`, {
        field: 'OUTPUT_POLICY_FILE',
      });
    }
  }
  return { methods, access, output, version: `${methods.version}/${access.version}/${output.version}` };
}

export const POLICY_SCHEMAS = { MethodPolicySchema, AccessPolicySchema, OutputPolicySchema };

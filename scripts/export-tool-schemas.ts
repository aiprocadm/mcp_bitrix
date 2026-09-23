/**
 * npm run schemas:export — JSON Schema всех реализованных инструментов в docs/schemas/
 * и раздел «реализовано» в docs/tools-catalog.md. Источник истины — код, не рукописный список.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { envelopeSchema } from '../src/mcp/result.js';
import { allTools } from '../src/tools/index.js';

const root = process.cwd();
const outDir = path.join(root, 'docs', 'schemas');
mkdirSync(outDir, { recursive: true });

const lines: string[] = [
  '# Каталог инструментов',
  '',
  'Раздел «Реализовано» генерируется командой `npm run schemas:export` из кода; правки вносить в исходники инструментов.',
  'Полный реестр требований — ТЗ §9 (docs/TZ.md); статусы этапов — docs/STATUS.md.',
  '',
  '## Реализовано',
  '',
  '| Инструмент | Модуль | Операция | readOnly | destructive | idempotent | Нужен Bitrix | Схемы |',
  '|---|---|---|---|---|---|---|---|',
];

for (const t of allTools()) {
  const input = z.toJSONSchema(t.inputSchema, { target: 'draft-2020-12' });
  const output = z.toJSONSchema(envelopeSchema(t.outputDataSchema), {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  const file = path.join(outDir, `${t.name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        name: t.name,
        title: t.title,
        description: t.description,
        annotations: t.annotations,
        inputSchema: input,
        outputSchema: output,
      },
      null,
      2,
    ) + '\n',
  );
  lines.push(
    `| \`${t.name}\` | ${t.module} | ${t.operation} | ${t.annotations.readOnlyHint} | ${t.annotations.destructiveHint} | ${t.annotations.idempotentHint} | ${t.requiresBitrix ? 'да' : 'нет'} | [json](schemas/${t.name}.json) |`,
  );
}

lines.push('', '## Описания', '');
for (const t of allTools()) {
  lines.push(`### \`${t.name}\``, '', t.description, '');
}

lines.push(
  '## Запланировано (ТЗ §9, не реализовано)',
  '',
  'MVP (этапы 8–9): `task_create`, `task_get`, `task_list`, `chat_send_message`, `disk_upload_file`, `calendar_create_event`. CRM-инструменты выше поддерживают только entityType=deal; лиды/контакты/компании/smart — полная версия.',
  '',
  'Полная версия (§11): остальные строки таблиц §9.2–§9.14. Каждый инструмент появляется в разделе «Реализовано» только после кода, схем, тестов и документации; заглушки с `success:true` не допускаются.',
  '',
);

writeFileSync(path.join(root, 'docs', 'tools-catalog.md'), lines.join('\n'));
process.stdout.write(`Экспортировано ${allTools().length} схем в docs/schemas/ и docs/tools-catalog.md\n`);

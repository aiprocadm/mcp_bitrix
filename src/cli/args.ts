/** Минимальный разбор аргументов `--key value` / `--flag` без внешних зависимостей. */
export interface ArgSpec {
  kind: 'string' | 'boolean';
}

export interface ParsedArgs {
  values: Record<string, string | undefined>;
  flags: Record<string, boolean>;
  positional: string[];
}

export function parseCliArgs(argv: readonly string[], spec: Record<string, ArgSpec>): ParsedArgs {
  const values: Record<string, string | undefined> = {};
  const flags: Record<string, boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const s = spec[name];
    if (!s) throw new Error(`Неизвестный аргумент --${name}`);
    if (s.kind === 'boolean') {
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Аргумент --${name} требует значение`);
    values[name] = value;
    if (eq < 0) i += 1;
  }
  return { values, flags, positional };
}

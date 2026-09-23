import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

interface Pkg {
  name: string;
  version: string;
}

const pkg = require('../package.json') as Pkg;

/** SDK не экспортирует свой package.json через exports — читаем файл из node_modules напрямую. */
function readSdkVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, '..', 'node_modules', '@modelcontextprotocol', 'server', 'package.json');
    return (JSON.parse(readFileSync(p, 'utf8')) as Pkg).version;
  } catch {
    return 'unknown';
  }
}

export const SERVER_VERSION = pkg.version;
export const SERVER_PACKAGE_NAME = pkg.name;
export const MCP_SDK_VERSION = readSdkVersion();
/** Версия спецификации MCP, реализуемая SDK v2 (README пакета). */
export const MCP_SPEC_VERSION = '2026-07-28';
export const NODE_VERSION = process.versions.node;

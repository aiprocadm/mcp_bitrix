/**
 * Логгер (ТЗ §8.1): всегда stderr, потому что в stdio-транспорте stdout принадлежит
 * протоколу MCP (T42). Каждое сообщение и каждый объект проходят через редактор
 * секретов до записи.
 */
import pino, { type Logger, type LevelWithSilent } from 'pino';
import { redactString, redactValue } from '../security/redaction.js';

export type AppLogger = Logger;

export interface LoggerOptions {
  level: LevelWithSilent;
  name?: string;
}

export function createLogger(options: LoggerOptions): AppLogger {
  return pino(
    {
      name: options.name ?? 'bitrix24-mcp-server',
      level: options.level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((a: unknown) =>
            typeof a === 'string' ? redactString(a) : redactValue(a),
          );
          // pino типизирует args как [msg, ...] — форма сохраняется
          method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
    },
    pino.destination({ fd: 2, sync: true }),
  );
}

export function createSilentLogger(): AppLogger {
  return pino({ level: 'silent' });
}

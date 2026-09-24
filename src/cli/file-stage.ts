/**
 * npm run file:stage -- --path <абсолютный путь внутри UPLOAD_ROOT>  (ТЗ §8.5, §17.5)
 * Проверяет файл (при UPLOAD_SCAN_REQUIRED — через сканер), копирует в staging и печатает
 * непрозрачный fileToken для disk_upload_file.
 */
import { createApp } from '../app/container.js';
import { createSilentLogger } from '../logging/logger.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), { path: { kind: 'string' } });
  const config = cliConfig(args);
  const filePath = args.values['path'];
  if (!filePath) fail(new Error('Укажите --path <абсолютный путь к файлу внутри UPLOAD_ROOT>'));
  const app = createApp(config, { logger: createSilentLogger() });
  try {
    const m = await app.files.stageFromPath(filePath, app.principal.id);
    out(`Файл подготовлен: ${m.originalName} (${String(m.size)} байт, ${m.mime}), сканер: ${m.scanStatus}`);
    out(`sha256    : ${m.sha256}`);
    out(`действует : до ${m.expiresAt}`);
    out(`fileToken : ${m.token}`);
    out('Передайте fileToken инструменту disk_upload_file; путь к файлу модели не сообщайте.');
  } finally {
    app.close();
  }
}

main().catch((e: unknown) => fail(e, 1));

/**
 * npm run approval:review -- --id <operationId> | --list  (ТЗ §8.2 п.3, §17.5)
 * Интерактивный просмотр плана и решение человека. Флага --yes нет и не будет;
 * без терминала (pipe) команда отказывается принимать решение.
 */
import { createInterface } from 'node:readline/promises';
import { createApp } from '../app/container.js';
import { AppError } from '../errors/app-error.js';
import { createSilentLogger } from '../logging/logger.js';
import { cliArgs, cliConfig, fail, out } from './common.js';

const CONFIRM_WORD = 'ПОДТВЕРЖДАЮ';
const DENY_WORD = 'ОТКЛОНЯЮ';

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), { id: { kind: 'string' }, list: { kind: 'boolean' } });
  const config = cliConfig(args);
  const app = createApp(config, { logger: createSilentLogger() });
  await app.ready;
  try {
    const principalId = app.principal.id;
    const portalKey = app.auth.portalKey;

    if (args.flags['list'] || !args.values['id']) {
      const pending = await app.approvals.listPending(principalId, portalKey);
      if (pending.length === 0) {
        out('Ожидающих подтверждения операций нет.');
      } else {
        out(`Ожидают решения (${pending.length}):`);
        for (const p of pending)
          out(
            `  ${p.operationId}  ${p.status.padEnd(9)} ${p.tool.padEnd(24)} до ${p.expiresAt}  ${p.target ?? ''}`,
          );
        out('');
        out('Просмотр и решение: npm run approval:review -- --id <operationId>');
      }
      return;
    }

    const id = args.values['id'];
    const { view, plan } = await app.approvals.readPlan(id, principalId, portalKey);
    out('================ ПЛАН ОПЕРАЦИИ ================');
    out(`operationId : ${view.operationId}`);
    out(`статус      : ${view.status}`);
    out(`инструмент  : ${view.tool} (${view.operationKind})`);
    out(`портал      : ${plan.summary.portalOrigin}`);
    out(`действие    : ${plan.summary.action}`);
    out(`цель        : ${plan.summary.target}`);
    out(`создан      : ${view.createdAt}, действует до ${view.expiresAt}`);
    out('--- что уйдёт в Bitrix24 (полностью) ---');
    out(JSON.stringify(plan.summary.details, null, 2));
    if (plan.summary.risks.length) {
      out('--- возможные последствия ---');
      for (const r of plan.summary.risks) out(`  • ${r}`);
    }
    out('================================================');

    if (view.status !== 'prepared') {
      out(`Решение не требуется: операция в состоянии ${view.status}.`);
      return;
    }
    if (Date.parse(view.expiresAt) < Date.now()) {
      out('Срок подтверждения истёк. Попросите подготовить новый план.');
      process.exitCode = 1;
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AppError(
        'ACCESS_DENIED',
        'Подтверждение возможно только в интерактивном терминале; автоматический ввод через pipe запрещён',
        {
          nextAction: 'Запустите команду вручную в терминале',
        },
      );
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await rl.question(
          `Введите ${CONFIRM_WORD} чтобы разрешить, ${DENY_WORD} чтобы отклонить, иначе Enter: `,
        )
      ).trim();
      if (answer === CONFIRM_WORD) {
        const v = await app.approvals.approve(id, principalId, portalKey);
        out(
          `Подтверждено: статус ${v.status}. Теперь повторите вызов инструмента с теми же параметрами и approvalId=${id}.`,
        );
      } else if (answer === DENY_WORD) {
        const v = await app.approvals.deny(id, principalId, portalKey);
        out(`Отклонено: статус ${v.status}.`);
      } else {
        out('Решение не принято; план остаётся в ожидании до истечения срока.');
      }
    } finally {
      rl.close();
    }
  } finally {
    app.close();
  }
}

main().catch((e: unknown) => fail(e, 1));

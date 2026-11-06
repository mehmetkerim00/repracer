import { readFileSync } from 'node:fs';

/**
 * Шаг 114: конфигурация части Б — идентификаторы AWS и SP-API, которые появляются при живой привязке: очередь и очередь недоставленных,
 * шина и правило EventBridge, адресаты SP-API. Значения — секретами в файле вне репозитория; шаблон с заглушками —
 * deploy/notification-receiver/part-b.env.example. Процесс приёмника из них читает только своё (адрес очереди, регион, приложение,
 * ключи AWS — config.ts); остальное нужно, чтобы проверить привязку до звонка и после неё.
 *
 * Проверка отвечает по каждому пункту только «да» или «нет» и не печатает значений ни целиком, ни частями. Проверяется согласованность
 * между значениями (один регион, один аккаунт AWS, одна очередь в адресе и ARN, источник партнёра — формата страницы
 * set-up-notifications-with-amazon-eventbridge: `aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}`), а не
 * то, что AWS и Amazon примут их: это проверяет только живой вызов части Б.
 *
 * Шаг 114.1 (P1-03): приложение SP-API — две формы идентификатора: `amzn1.sp.solution.…` (боевое приложение в нынешнем портале разработчика,
 * проверка ключей 2026-11-05) и `amzn1.sellerapps.app.…` (примеры снимка моделей). Какую форму Amazon подставит в имя источника партнёра и в
 * `ApplicationId` уведомления, снимок не говорит — A-34, проверяется на звонке части Б. Поэтому проверка принимает обе и сверяет равенство
 */
export const PART_B_KEYS = [
  'REPRACER_AMAZON_REGION', 'REPRACER_AWS_REGION', 'REPRACER_AWS_ACCOUNT_ID', 'REPRACER_AMAZON_APPLICATION_ID',
  'REPRACER_SQS_QUEUE_URL', 'REPRACER_SQS_QUEUE_ARN', 'REPRACER_SQS_DLQ_ARN',
  'REPRACER_EVENTBRIDGE_PARTNER_SOURCE', 'REPRACER_EVENTBRIDGE_BUS_ARN', 'REPRACER_EVENTBRIDGE_RULE_ARN',
  'REPRACER_SPAPI_DESTINATION_ID_SQS', 'REPRACER_SPAPI_DESTINATION_ID_EVENTBRIDGE',
  'REPRACER_AWS_ACCESS_KEY_ID', 'REPRACER_AWS_SECRET_ACCESS_KEY',
] as const;

export interface PartBCheck { check: string; ok: boolean }

/** Заглушка шаблона: пусто, угловые скобки, нули аккаунта или слово-подсказка */
const APPLICATION_ID = 'amzn1\\.(?:sp\\.solution|sellerapps\\.app)\\.[A-Za-z0-9-]+';
const placeholder = (v: string | undefined) => !v || /<[^>]*>|^0{12}$|:0{12}:|\/0{12}\/|REPLACE|CHANGE_ME/i.test(v);

/** Файл KEY=VALUE: пустые строки и комментарии пропускаются, кавычки вокруг значения снимаются */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function checkPartB(env: Readonly<Record<string, string | undefined>>): PartBCheck[] {
  const v = (k: (typeof PART_B_KEYS)[number]) => env[k] ?? '';
  const checks: PartBCheck[] = PART_B_KEYS.map((k) => ({ check: `${k} заполнен`, ok: !placeholder(env[k]) }));
  const url = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/.exec(v('REPRACER_SQS_QUEUE_URL'));
  const queueArn = /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(v('REPRACER_SQS_QUEUE_ARN'));
  const dlqArn = /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(v('REPRACER_SQS_DLQ_ARN'));
  const source = new RegExp(`^aws\\.partner/sellingpartnerapi\\.amazon\\.com/(\\d{12})/(${APPLICATION_ID})$`).exec(v('REPRACER_EVENTBRIDGE_PARTNER_SOURCE'));
  const bus = /^arn:aws:events:([a-z0-9-]+):(\d{12}):event-bus\/(.+)$/.exec(v('REPRACER_EVENTBRIDGE_BUS_ARN'));
  const rule = /^arn:aws:events:([a-z0-9-]+):(\d{12}):rule\/(.+)\/([A-Za-z0-9._-]{1,64})$/.exec(v('REPRACER_EVENTBRIDGE_RULE_ARN'));
  const region = v('REPRACER_AWS_REGION');
  const account = v('REPRACER_AWS_ACCOUNT_ID');
  checks.push(
    { check: 'регион SP-API — EU, NA или FE', ok: ['EU', 'NA', 'FE'].includes(v('REPRACER_AMAZON_REGION')) },
    { check: 'приложение — вида amzn1.sp.solution.… или amzn1.sellerapps.app.…', ok: new RegExp(`^${APPLICATION_ID}$`).test(v('REPRACER_AMAZON_APPLICATION_ID')) },
    { check: 'аккаунт AWS — 12 цифр', ok: /^\d{12}$/.test(account) },
    { check: 'адрес очереди, ARN очереди и очереди недоставленных, шина и правило — правильного вида', ok: !!(url && queueArn && dlqArn && bus && rule) },
    { check: 'всё в одном регионе AWS', ok: !!(url && queueArn && dlqArn && bus && rule) && [url[1], queueArn[1], dlqArn[1], bus[1], rule[1]].every((r) => r === region) },
    { check: 'всё в одном аккаунте AWS', ok: !!(url && queueArn && dlqArn && bus && rule && source) && [url[2], queueArn[2], dlqArn[2], bus[2], rule[2], source[1]].every((a) => a === account) },
    { check: 'адрес и ARN — одна очередь', ok: !!(url && queueArn) && url[3] === queueArn[3] },
    { check: 'очередь недоставленных — другая очередь', ok: !!(queueArn && dlqArn) && queueArn[3] !== dlqArn[3] },
    { check: 'источник партнёра — наше приложение', ok: !!source && source[2] === v('REPRACER_AMAZON_APPLICATION_ID') },
    { check: 'шина — шина источника партнёра, правило — на этой шине', ok: !!(bus && rule && source) && bus[3] === v('REPRACER_EVENTBRIDGE_PARTNER_SOURCE') && rule[3] === bus[3] },
    { check: 'адресаты SQS и EventBridge — разные', ok: !placeholder(env.REPRACER_SPAPI_DESTINATION_ID_SQS) && v('REPRACER_SPAPI_DESTINATION_ID_SQS') !== v('REPRACER_SPAPI_DESTINATION_ID_EVENTBRIDGE') },
  );
  return checks;
}

/** Проверка файла: строки «пункт: да/нет», без значений; код выхода 0 — всё «да» */
export function reportPartB(path: string): { lines: string[]; ok: boolean } {
  const checks = checkPartB(parseEnvFile(readFileSync(path, 'utf8')));
  return { lines: checks.map((c) => `${c.check}: ${c.ok ? 'да' : 'нет'}`), ok: checks.every((c) => c.ok) };
}

// Запуск: node --experimental-strip-types services/notification-receiver/src/part-b.ts <файл секретов части Б>
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: part-b.ts <env file>\n');
    process.exit(2);
  }
  const { lines, ok } = reportPartB(path);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(ok ? 0 : 1);
}

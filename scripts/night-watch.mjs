// Р-236 (шаг 110, довесок владельца): сторож ночи — последнее задание ночного полного прогона main, при любом исходе остальных.
//
// Красная ночь — Issue «Красная ночь YYYY-MM-DD» со ссылкой на прогон и списком упавших заданий; повторная красная ночь — комментарий в
// открытый Issue, а не новый; зелёная ночь — комментарий и закрытие. Issue находят по метке night-red: так уведомление не зависит от
// настроек почты аккаунта, а ворота слияния (scripts/merge-when-green.mjs) не сливают, пока такой Issue открыт.
//
//   NEEDS='<toJSON(needs)>' node scripts/night-watch.mjs     — в CI; GH_TOKEN — токен задания с правом issues: write

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NIGHT_LABEL = 'night-red';
export const NIGHT_TITLE = 'Красная ночь';

/** Задания ночи не в success — по контексту needs. Снятое и пропущенное тоже: ночь, прошедшая не целиком, не зелёная */
export function failedJobs(needs) {
  return Object.entries(needs)
    .filter(([, value]) => value.result !== 'success')
    .map(([job, value]) => ({ job, result: value.result }))
    .sort((a, b) => a.job.localeCompare(b.job));
}

/**
 * Что сделать с Issue красной ночи. `failed` — упавшие задания, `openIssues` — открытые Issue с меткой (номер и время создания).
 * Возвращает `{ kind: 'CREATE', title, body } | { kind: 'COMMENT' | 'CLOSE', numbers, body } | { kind: 'NONE' }`
 */
export function nightIssuePlan({ failed, openIssues, date, runUrl, sha, event, owner }) {
  const open = [...openIssues].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const list = failed.map((f) => `- \`${f.job}\` — ${f.result}`).join('\n');
  if (failed.length > 0 && open.length === 0) {
    return {
      kind: 'CREATE',
      title: `${NIGHT_TITLE} ${date}`,
      body: [
        `Ночной полный прогон main не зелёный: ${runUrl}`,
        `Коммит ${sha.slice(0, 12)}, событие ${event}.`,
        '',
        'Не прошли:',
        list,
        '',
        'Слияния шагов стоят, пока этот Issue открыт (Р-236, scripts/merge-when-green.mjs): разбор первым делом. Повтор после исправления — '
          + '`gh workflow run ci --ref main`; зелёная ночь закроет Issue сама.',
        '',
        `cc @${owner}`,
      ].join('\n'),
    };
  }
  if (failed.length > 0) {
    return { kind: 'COMMENT', numbers: [open[0].number], body: [`${NIGHT_TITLE} ${date} — снова: ${runUrl}`, `Коммит ${sha.slice(0, 12)}, событие ${event}.`, '', 'Не прошли:', list].join('\n') };
  }
  if (open.length > 0) return { kind: 'CLOSE', numbers: open.map((i) => i.number), body: `Зелёная ночь ${date}: ${runUrl} — закрыто.` };
  return { kind: 'NONE' };
}

/** Команды gh по плану */
export function nightIssueCommands(plan) {
  if (plan.kind === 'CREATE') {
    return [
      ['label', 'create', NIGHT_LABEL, '--color', 'B60205', '--description', 'Ночной полный прогон main не зелёный (Р-236)', '--force'],
      ['issue', 'create', '--title', plan.title, '--body', plan.body, '--label', NIGHT_LABEL],
    ];
  }
  if (plan.kind === 'COMMENT') return plan.numbers.map((n) => ['issue', 'comment', String(n), '--body', plan.body]);
  if (plan.kind === 'CLOSE') return plan.numbers.map((n) => ['issue', 'close', String(n), '--comment', plan.body]);
  return [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const needs = JSON.parse(env.NEEDS ?? 'null');
  if (needs === null || Object.keys(needs).length === 0) throw new Error('NEEDS: контекст needs задания пуст');
  const openIssues = JSON.parse(execFileSync('gh', ['issue', 'list', '--label', NIGHT_LABEL, '--state', 'open', '--json', 'number,createdAt', '--limit', '20'], { encoding: 'utf8' }));
  const failed = failedJobs(needs);
  const plan = nightIssuePlan({
    failed, openIssues,
    date: new Date().toISOString().slice(0, 10),
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    sha: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME, owner: env.GITHUB_REPOSITORY_OWNER,
  });
  console.log(JSON.stringify({ kind: plan.kind, failed, open: openIssues.map((i) => i.number) }));
  for (const args of nightIssueCommands(plan)) execFileSync('gh', args, { stdio: 'inherit' });
}

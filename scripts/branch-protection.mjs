// Р-236 (шаг 110.1, довесок владельца): защита ветки main на стороне GitHub. Ворота слияния (scripts/merge-when-green.mjs) отправляют в
// main ровно проверенный SHA fast-forward'ом; защита делает то же правило свойством GitHub: push коммита без зелёных проверок каждого
// push отбивает сам GitHub — в том числе у владельца (enforce_admins), force-push и удаление main запрещены.
//
// Обязательные проверки — ровно задания, которые идут на каждый push (без условия): guards, шарды fast, clickhouse-compression.
// Ночные задания на push пропущены по условию, а пропущенное по условию задание GitHub засчитывает как успех — требовать их бессмысленно.
// Pull request не требуется: ворота пушат напрямую. «Ветка обновлена» (strict) — правило слияния pull request; fast-forward держат ворота.
//
//   node scripts/branch-protection.mjs check [ветка]    — сверить живую защиту с этой; печатает находки, код 1 при расхождении
//   node scripts/branch-protection.mjs apply [ветка]    — включить (PUT, права admin на репозиторий)
//   node scripts/branch-protection.mjs remove <ветка>   — снять (только не main: снятие защиты main — решение владельца руками)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAST_SHARDS } from './test-scopes.mjs';

/** GitHub Actions: обязательную проверку засчитывает только запуск этого приложения, а не любой статус с тем же именем */
export const ACTIONS_APP_ID = 15368;

/** Задания каждого push — имена проверок, как их называет GitHub: у матрицы fast — «fast (k/N)» */
export const REQUIRED_CHECKS = ['guards', ...Array.from({ length: FAST_SHARDS }, (_, i) => `fast (${i + 1}/${FAST_SHARDS})`), 'clickhouse-compression'];

/** Тело PUT /repos/{owner}/{repo}/branches/{branch}/protection */
export function protectionBody(checks = REQUIRED_CHECKS) {
  return {
    required_status_checks: { strict: false, checks: checks.map((context) => ({ context, app_id: ACTIONS_APP_ID })) },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/** Расхождения живой защиты (ответ GET …/protection) с нужной; пустой список — защита та */
export function protectionFindings(live, checks = REQUIRED_CHECKS) {
  if (live === null) return ['ветка не защищена'];
  const findings = [];
  const required = live.required_status_checks?.checks ?? [];
  const names = required.map((c) => c.context);
  const missing = checks.filter((c) => !names.includes(c));
  const extra = names.filter((c) => !checks.includes(c));
  if (missing.length > 0) findings.push(`нет обязательных проверок: ${missing.join(', ')}`);
  // Лишняя проверка, которой нет в каждом push, никогда не появится — push в main будет отбиваться всегда
  if (extra.length > 0) findings.push(`лишние обязательные проверки: ${extra.join(', ')}`);
  const foreign = required.filter((c) => c.app_id !== ACTIONS_APP_ID).map((c) => c.context);
  if (foreign.length > 0) findings.push(`проверку засчитает не только GitHub Actions: ${foreign.join(', ')}`);
  if (live.enforce_admins?.enabled !== true) findings.push('владелец обходит защиту (enforce_admins выключен)');
  if (live.allow_force_pushes?.enabled !== false) findings.push('force-push разрешён');
  if (live.allow_deletions?.enabled !== false) findings.push('удаление ветки разрешено');
  if (live.required_pull_request_reviews) findings.push('требуется pull request — ворота пушат напрямую и упрутся в защиту');
  return findings;
}

const repo = () => execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8', timeout: 60_000 }).trim();

function liveProtection(branch) {
  try {
    return JSON.parse(execFileSync('gh', ['api', `repos/${repo()}/branches/${branch}/protection`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
  } catch (error) {
    if (String(error.stdout ?? '').includes('Branch not protected')) return null;
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, branch = 'main'] = process.argv.slice(2);
  if (command === 'apply') {
    execFileSync('gh', ['api', '--method', 'PUT', `repos/${repo()}/branches/${branch}/protection`, '--input', '-'], { input: JSON.stringify(protectionBody()), stdio: ['pipe', 'ignore', 'inherit'], timeout: 60_000 });
  } else if (command === 'remove') {
    if (branch === 'main') throw new Error('снятие защиты main — решение владельца, руками');
    execFileSync('gh', ['api', '--method', 'DELETE', `repos/${repo()}/branches/${branch}/protection`], { stdio: 'inherit', timeout: 60_000 });
    console.log(JSON.stringify({ branch, removed: true }));
    process.exit(0);
  } else if (command !== 'check') {
    throw new Error('usage: branch-protection.mjs check|apply|remove [branch]');
  }
  const findings = protectionFindings(liveProtection(branch));
  console.log(JSON.stringify({ branch, required: REQUIRED_CHECKS, findings }));
  if (findings.length > 0) process.exit(1);
}

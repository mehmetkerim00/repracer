import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

/**
 * Шаг 185: deploy/pilot/secrets.sh уносит в пилот приложение Amazon из файла ключей боевого приложения. 2026-11-26 в этом файле нашлись ключи
 * ПЕСОЧНОГО приложения (client ID песочницы; старый секрет — тоже её), и пилот подключился бы к песочному приложению, не сказав ни слова.
 * Теперь ключ боевого файла, совпавший с ключом файла песочницы, — отказ с именами обеих переменных, и ни один файл Amazon не создаётся.
 * Заодно отложенное «134»: файл ключей больше не исполняется (`source`) — строки KEY= читаются как текст. Значение с `|` bash принимал за
 * конвейер и печатал остаток значения (так 2026-11-15 утёк sandbox refresh-токен).
 *
 * Данные синтетические. Нужны bash и openssl; ни Docker, ни базы.
 */
const root = new URL('../../', import.meta.url).pathname;
const works: string[] = [];
after(() => { for (const w of works) rmSync(w, { recursive: true, force: true }); });

const PROD = {
  AMAZON_PRODUCTION_APP_ID: 'amzn1.sp.solution.syn-185-prod-app',
  AMAZON_PRODUCTION_LWA_CLIENT_ID: 'amzn1.application-oa2-client.syn185prod',
  AMAZON_PRODUCTION_LWA_CLIENT_SECRET: 'amzn1.oa2-cs.v1.syn185prodsecret',
};
const SANDBOX = {
  AMAZON_SANDBOX_APP_ID: 'amzn1.sp.solution.syn-185-sandbox-app',
  AMAZON_SANDBOX_LWA_CLIENT_ID: 'amzn1.application-oa2-client.syn185sandbox',
  AMAZON_SANDBOX_LWA_CLIENT_SECRET: 'amzn1.oa2-cs.v1.syn185sandboxsecret',
};
const lines = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');

/** Один запуск secrets.sh в своём каталоге: файл ключей боевого приложения — `prod`, песочницы — `sandbox` (null — файла нет) */
function run(prod: string, sandbox: string | null) {
  const work = mkdtempSync(join(tmpdir(), 'repracer-pilot-secrets-'));
  works.push(work);
  const out = join(work, 'pilot');
  writeFileSync(join(work, 'amazon-production.env'), `# synthetic\n${prod}\n`);
  if (sandbox !== null) writeFileSync(join(work, 'amazon-sandbox.env'), `# synthetic\n${sandbox}\n`);
  const r = spawnSync('bash', [join(root, 'deploy/pilot/secrets.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: work, REPRACER_PILOT_LOCAL_SECRETS: out,
      REPRACER_AMAZON_PRODUCTION_ENV: join(work, 'amazon-production.env'), REPRACER_AMAZON_SANDBOX_ENV: join(work, 'amazon-sandbox.env') },
    encoding: 'utf8' });
  const file = (name: string) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : null);
  return { status: r.status, output: `${r.stdout}${r.stderr}`, secret: file('amazon_lwa_client_secret'), env: file('amazon.env') };
}

test('step 185: different production and sandbox keys — the pilot gets exactly the production app (control)', () => {
  const r = run(lines(PROD), lines(SANDBOX));
  assert.equal(r.status, 0, r.output);
  assert.equal(r.secret, PROD.AMAZON_PRODUCTION_LWA_CLIENT_SECRET);
  assert.equal(r.env, `REPRACER_AMAZON_APP_ID=${PROD.AMAZON_PRODUCTION_APP_ID}\nREPRACER_AMAZON_LWA_CLIENT_ID=${PROD.AMAZON_PRODUCTION_LWA_CLIENT_ID}\n`);
  for (const v of [...Object.values(PROD), ...Object.values(SANDBOX)]) assert.ok(!r.output.includes(v), 'no key value in the output');
});

test('step 185: a production key equal to the sandbox one is refused by name, and no Amazon file is made', () => {
  for (const [prodKey, sandboxKey] of [['LWA_CLIENT_ID', 'LWA_CLIENT_ID'], ['LWA_CLIENT_SECRET', 'LWA_CLIENT_SECRET'], ['APP_ID', 'APP_ID']] as const) {
    const prod = { ...PROD, [`AMAZON_PRODUCTION_${prodKey}`]: SANDBOX[`AMAZON_SANDBOX_${sandboxKey}`] };
    const r = run(lines(prod), lines(SANDBOX));
    assert.notEqual(r.status, 0, `${prodKey}: refused`);
    assert.match(r.output, new RegExp(`AMAZON_PRODUCTION_${prodKey}\\b.*AMAZON_SANDBOX_${sandboxKey}\\b`), `${prodKey}: the refusal names both variables`);
    assert.equal(r.secret, null, `${prodKey}: no client secret file`);
    assert.equal(r.env, null, `${prodKey}: no amazon.env`);
    for (const v of [...Object.values(prod), ...Object.values(SANDBOX)]) assert.ok(!r.output.includes(v), `${prodKey}: no key value in the output`);
  }
});

test('step 185 (deferred «134»): the key file is read as text — a value with "|" in another line neither runs nor leaks', () => {
  const tail = 'syn185-refresh-tail-never-printed';
  const r = run(`${lines(PROD)}\nAMAZON_PRODUCTION_REFRESH_TOKEN=Atzr|${tail}`, lines(SANDBOX));
  assert.ok(!r.output.includes(tail), `the rest of the token is not printed: ${r.output.replace(tail, '<tail>')}`);
  assert.equal(r.status, 0, r.output.replace(tail, '<tail>'));
  assert.equal(r.secret, PROD.AMAZON_PRODUCTION_LWA_CLIENT_SECRET);
});

test('step 185: two lines of one key are refused — the file must say one thing', () => {
  const r = run(`${lines(PROD)}\nAMAZON_PRODUCTION_LWA_CLIENT_ID=amzn1.application-oa2-client.syn185second`, null);
  assert.notEqual(r.status, 0, 'refused');
  assert.match(r.output, /AMAZON_PRODUCTION_LWA_CLIENT_ID/);
  assert.equal(r.env, null, 'no amazon.env');
  assert.ok(!r.output.includes('syn185second') && !r.output.includes('syn185prod'), 'no key value in the output');
});

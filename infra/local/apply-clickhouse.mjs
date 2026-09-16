// Применяет DDL аналитического слоя к ClickHouse по HTTP и проверяет 099_verify.sql (каждый запрос — 0 строк).
// HTTP-интерфейс принимает один оператор на запрос: файл делится по «;» в конце строки, комментарии-строки отбрасываются.
//   REPRACER_CH_PASSWORD=... node infra/local/apply-clickhouse.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.REPRACER_CH_URL ?? 'http://127.0.0.1:18123';
const user = process.env.REPRACER_CH_USER ?? 'repracer_local_admin';
const password = process.env.REPRACER_CH_PASSWORD;
if (!password) {
  console.error('REPRACER_CH_PASSWORD is required');
  process.exit(2);
}
const dir = fileURLToPath(new URL('../../schemas/clickhouse/', import.meta.url));
const auth = { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password };

function statements(file) {
  const text = readFileSync(dir + file, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

async function run(sql) {
  const response = await fetch(`${url}/`, { method: 'POST', headers: auth, body: sql });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${body.trim()}\n--- statement ---\n${sql}`);
  return body;
}

for (const file of ['001_roles_and_profiles.sql', '010_tables.sql', '020_row_policies.sql', '030_step6.sql', '040_step7.sql', '050_step10.sql', '060_step14.sql']) {
  const list = statements(file);
  console.log(`== ${file} (${list.length} statements)`);
  for (const sql of list) await run(sql);
}

console.log('== 099_verify.sql');
let failed = false;
for (const sql of statements('099_verify.sql')) {
  const out = (await run(`${sql} FORMAT TSV`)).trim();
  if (out) {
    failed = true;
    console.log(`VERIFY FAILED:\n${sql}\n${out}`);
  }
}
if (failed) process.exit(1);
console.log('OK');

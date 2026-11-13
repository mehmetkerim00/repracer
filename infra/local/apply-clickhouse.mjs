// Применяет DDL аналитического слоя к ClickHouse по HTTP и проверяет 099_verify.sql (каждый запрос — 0 строк).
// HTTP-интерфейс принимает один оператор на запрос: файл делится по «;» в конце строки, комментарии-строки отбрасываются.
//   REPRACER_CH_PASSWORD=... node infra/local/apply-clickhouse.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../schemas/clickhouse/', import.meta.url));

/**
 * Шаг 124 (находка при сборке deploy/pilot): файлы DDL — из каталога, по порядку номера, проверка 099 — последней и отдельно. Список руками с шагов 97 и 109
 * пропускал 097 и 098: выгрузка писала столбцы, которых ClickHouse, поднятый этим скриптом, не знал
 */
export function ddlFiles() {
  return readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f !== '099_verify.sql').sort();
}

function statements(file) {
  const text = readFileSync(dir + file, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

const url = process.env.REPRACER_CH_URL ?? 'http://127.0.0.1:18123';
let auth = {};

async function run(sql) {
  const response = await fetch(`${url}/`, { method: 'POST', headers: auth, body: sql });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${body.trim()}\n--- statement ---\n${sql}`);
  return body;
}

async function main() {
  const password = process.env.REPRACER_CH_PASSWORD;
  if (!password) {
    console.error('REPRACER_CH_PASSWORD is required');
    process.exit(2);
  }
  auth = { 'X-ClickHouse-User': process.env.REPRACER_CH_USER ?? 'repracer_local_admin', 'X-ClickHouse-Key': password };
  for (const file of ddlFiles()) {
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
}

// Запуск скриптом; импорт (тест списка файлов) ничего не применяет
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

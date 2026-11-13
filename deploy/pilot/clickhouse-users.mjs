// Шаг 124 [Р-246]: логины ролей выгрузки ClickHouse пилота — те же роли и гранты, что заводит CI (.github/workflows/ci.yml, шаг «ClickHouse DDL applied and
// verified»): запись (repracer_ingest) и проверка выгрузки с удалением (repracer_retention). Пароли — из файлов каталога секретов; ни пароль, ни текст ответа
// ClickHouse в вывод не попадают (ответ на ошибку может повторить запрос). Повторный запуск задаёт пароль заново — так меняется пароль.
//   (в контейнере tools пилота) node deploy/pilot/clickhouse-users.mjs
import { readFileSync } from 'node:fs';

const url = process.env.REPRACER_CH_URL;
const admin = process.env.REPRACER_CH_USER;
const adminPassword = process.env.REPRACER_CH_PASSWORD;
if (!url || !admin || !adminPassword) {
  console.error('REPRACER_CH_URL, REPRACER_CH_USER and REPRACER_CH_PASSWORD are required (clickhouse.env of the pilot secrets)');
  process.exit(2);
}
const logins = [
  { user: process.env.REPRACER_CH_INGEST_USER, file: process.env.REPRACER_CH_INGEST_PASSWORD_FILE, role: 'repracer_ingest' },
  { user: process.env.REPRACER_CH_VERIFIER_USER, file: process.env.REPRACER_CH_VERIFIER_PASSWORD_FILE, role: 'repracer_retention' },
];
async function run(sql, what) {
  const response = await fetch(`${url}/`, { method: 'POST', headers: { 'X-ClickHouse-User': admin, 'X-ClickHouse-Key': adminPassword }, body: sql });
  await response.text();
  if (!response.ok) {
    console.error(`ClickHouse refused: ${what} (HTTP ${response.status}; the response is not printed — it may repeat the statement)`);
    process.exit(1);
  }
}
for (const { user, file, role } of logins) {
  if (!user || !/^[a-z][a-z0-9_]{0,62}$/.test(user)) { console.error(`a ClickHouse login name for ${role} is missing or malformed`); process.exit(2); }
  const password = file ? readFileSync(file, 'utf8').trim() : '';
  if (!/^[0-9a-f]{32,128}$/.test(password)) { console.error(`the password file of ${user} is missing or not hex (the value is not printed)`); process.exit(2); }
  await run(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH sha256_password BY '${password}' DEFAULT ROLE ${role}`, `create ${user}`);
  await run(`ALTER USER ${user} IDENTIFIED WITH sha256_password BY '${password}'`, `password of ${user}`);
  await run(`GRANT ${role} TO ${user}`, `grant ${role} to ${user}`);
  console.log(`${user}: ${role}`);
}
console.log('ClickHouse logins of the pilot are in place');

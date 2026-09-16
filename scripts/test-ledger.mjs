// Р-89 (шаг 17, находка 8 ревью шага 16): журнал реально выполненных тестовых файлов. Подключается test-all.mjs через
// NODE_OPTIONS=--import в каждый процесс node, в том числе в процессы файлов node --test; путь выполняемого файла теста
// дописывается в REPRACER_TEST_LEDGER. Сборка сверяет журнал со списком включённых файлов.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ledger = process.env.REPRACER_TEST_LEDGER;
const file = process.argv[1];
if (ledger && file && /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) {
  appendFileSync(ledger, `${resolve(file)}\n`);
}

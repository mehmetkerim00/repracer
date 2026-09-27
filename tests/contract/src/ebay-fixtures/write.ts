import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEbayScenarios, EBAY_FIXTURES_DIR } from './index.ts';

/** Перезаписать fixtures/ebay из построителя: npm run fixtures:ebay -w @repracer/contract-tests */
const dir = fileURLToPath(EBAY_FIXTURES_DIR);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(`${dir}${f}`);
const built = buildEbayScenarios();
for (const { file, scenario } of built) writeFileSync(`${dir}${file}`, `${JSON.stringify(scenario, null, 2)}\n`);
console.log(`wrote ${built.length} eBay scenarios`);

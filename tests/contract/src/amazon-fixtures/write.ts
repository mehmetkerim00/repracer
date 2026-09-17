import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AMAZON_FIXTURES_DIR, buildAmazonScenarios } from './index.ts';

/** Перезаписать fixtures/amazon из построителя: npm run fixtures:amazon -w @repracer/contract-tests */
const dir = fileURLToPath(AMAZON_FIXTURES_DIR);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(`${dir}${f}`);
for (const { file, scenario } of buildAmazonScenarios()) writeFileSync(`${dir}${file}`, `${JSON.stringify(scenario, null, 2)}\n`);
console.log(`wrote ${buildAmazonScenarios().length} Amazon scenarios`);

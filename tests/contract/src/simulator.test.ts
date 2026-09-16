import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isNeverWritten } from '@repracer/channel-port';
import { kauflandUnderTest } from './adapters.ts';
import { channelFetch, type TraceEntry } from './harness/channel.ts';
import { runScenario } from './harness/runner.ts';
import { expandVariants, loadScenarios } from './harness/scenario.ts';
import { VirtualClock } from './harness/world.ts';
import { SimulatedKauflandChannel, type KauflandChannelModelSpec } from './simulator/kaufland-channel.ts';
import { KAUFLAND_PARAMETERS } from './simulator/params.ts';

/** Симулятор каналов [Р-113]: сценарии того же формата, канал с состоянием; каждый вариант — ответ на открытый вопрос */
const FIXTURES = fileURLToPath(new URL('../fixtures/kaufland-sim/', import.meta.url));
const loaded = loadScenarios(FIXTURES);
const variantsRun: string[] = [];

for (const { file, scenario } of loaded) {
  for (const { variant, question, finding, scenario: s } of expandVariants(scenario)) {
    test(`${scenario.id} [${variant}${question ? `, ${question}` : ''}] — ${file}`, async () => {
      const report = await runScenario(s, kauflandUnderTest);
      variantsRun.push(`${question ?? '—'} ${scenario.id}#${variant}${finding ? `: ${finding}` : ''}`);
      assert.deepEqual(report.failures, [], report.failures.join('\n'));
    });
  }
}

test('every open Kaufland question in the model is exercised by a scenario variant', () => {
  const asked = new Set(Object.values(KAUFLAND_PARAMETERS).map((p) => p.question).filter((q): q is string => q !== null));
  const exercised = new Set(loaded.flatMap(({ scenario }) => (scenario.variants ?? []).map((v) => v.question)));
  assert.deepEqual([...asked].filter((q) => !exercised.has(q)).sort(), []);
  // Каждый вопрос параметра существует в матрице возможностей (не выдуман)
  const capabilities = readFileSync(fileURLToPath(new URL('../../../docs/channel-capabilities.md', import.meta.url)), 'utf8');
  for (const q of asked) assert.ok(capabilities.includes(`| ${q} |`), `${q} is not a question in channel-capabilities.md`);
});

test('simulator records a minimum_price write as a violation (Р-12, Р-111) and the port lists the Amazon field as never written', async () => {
  const spec: KauflandChannelModelSpec = {
    seed: 1, webhookUrl: 'https://hooks.example.invalid/kaufland/wh_tok_synthetic_0001',
    units: [{ idUnit: 9001, storefront: 'de', idOffer: 'SYN-OFFER-9001', idProduct: 362009001, listingPriceMinor: 1500, amount: 1 }], competitors: [],
  };
  const clock = new VirtualClock('2026-09-14T10:00:00.000Z');
  const channel = new SimulatedKauflandChannel(spec, clock.iso());
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const fetch = channelFetch(channel, () => [], clock, violations, trace);
  const response = await fetch('https://sellerapi.kaufland.com/v2/units/9001?storefront=de', { method: 'PATCH', body: JSON.stringify({ minimum_price: 1400 }) });
  assert.equal(response.status, 200);
  assert.deepEqual(channel.finish(), ['PATCH /v2/units/9001: body writes minimum_price (Р-12, Р-111)']);
  assert.equal(isNeverWritten('AMAZON', 'CHANNEL_MIN_PRICE'), true);
  // Kaufland: исключение — явный режим Smart Pricing тенанта [Р-12], его закрепляет база (0077)
  assert.equal(isNeverWritten('KAUFLAND', 'CHANNEL_MIN_PRICE'), false);
});

test('simulator is deterministic for a seed', async () => {
  const scenario = loaded.find((l) => l.scenario.id === 'kaufland-sim/price-war-undercut')?.scenario;
  const dumps: string[] = [];
  for (let i = 0; i < 2; i++) {
    const variant = expandVariants(scenario!).find((v) => v.variant === 'k10-debounce-and-loss')!;
    await runScenario(variant.scenario, kauflandUnderTest, undefined, undefined, { async onFinish(f) { dumps.push(JSON.stringify(f.simulator!.dump())); } });
  }
  assert.equal(dumps[0], dumps[1]);
});

test('variants and findings', (t) => {
  t.diagnostic(`\n${variantsRun.sort().join('\n')}`);
  assert.ok(variantsRun.length > 0);
});

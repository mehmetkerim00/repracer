import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import pg from 'pg';
import { EcbFormatError, loadEcbDailyRates, parseEcbDailyXml, rateToMicros } from '../src/index.ts';

const XML = readFileSync(new URL('./fixtures/eurofxref-daily-2026-09-14.xml', import.meta.url), 'utf8');

test('parses the ECB daily file: one date, all currencies, rates as exact decimal strings', () => {
  const parsed = parseEcbDailyXml(XML);
  assert.equal(parsed.rateDate, '2026-09-14');
  assert.equal(parsed.rates.length, 29);
  assert.deepEqual(parsed.rates.find((r) => r.currency === 'USD'), { currency: 'USD', rate: '1.1551' });
  assert.equal(rateToMicros('1.1551'), 1_155_100);
  assert.equal(rateToMicros('20398.66'), 20_398_660_000);
  assert.equal(rateToMicros('0.85598'), 855_980);
});

test('anything unexpected is refused rather than guessed', () => {
  assert.throws(() => parseEcbDailyXml(XML.replace('European Central Bank', 'Somebody Else')), EcbFormatError);
  assert.throws(() => parseEcbDailyXml(XML.replace("rate='1.1551'", "rate='1,1551'")), EcbFormatError);
  assert.throws(() => parseEcbDailyXml(XML.replace("rate='1.1551'", "rate='0'")), EcbFormatError);
  assert.throws(() => parseEcbDailyXml(XML.replace("<Cube time='2026-09-14'>", "<Cube time='2026-02-30'>")), EcbFormatError);
  assert.throws(() => parseEcbDailyXml(XML.replace("<Cube currency='JPY'", "<Cube currency='USD'")), EcbFormatError);
  assert.throws(() => parseEcbDailyXml(XML.replace("<Cube time='2026-09-14'>", "<Cube time='2026-09-14'></Cube><Cube time='2026-09-15'>")), EcbFormatError);
});

// Загрузка — ролью svc_fx_loader (repracer_fx_loader) в одноразовой базе со всеми миграциями и test/setup.sql хранилища
const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? new pg.Pool({ connectionString: PG_URL.replace('svc_app@', 'svc_fx_loader@'), max: 1 }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
after(async () => {
  await pool?.end();
});

test('Р-61: the day rate loads once, reloading the same rate changes nothing, a different rate for the same day is refused', {}, async () => {
  const day = '2019-01-02';
  const xml = XML.replace("<Cube time='2026-09-14'>", `<Cube time='${day}'>`);
  const first = await loadEcbDailyRates(pool!, xml, 'test fixture');
  assert.ok(first.inserted.includes('USD') || first.unchanged.includes('USD'));
  const second = await loadEcbDailyRates(pool!, xml, 'test fixture');
  assert.deepEqual(second.inserted, []);
  await assert.rejects(loadEcbDailyRates(pool!, xml.replace("rate='1.1551'", "rate='1.2000'"), 'test fixture'), /differs from the loaded one/);
});

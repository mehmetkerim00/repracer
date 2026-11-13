import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Шаг 124 (находка при сборке deploy/pilot, Р-246): `infra/local/apply-clickhouse.mjs` перечислял файлы DDL списком и с шагов 97 и 109 пропускал
 * `097_step97.sql` и `098_step109.sql` — выгрузка пишет их столбцы (`offers.holds_buybox`, `offers.coupon_minor`, `buybox_segments.*`), а ClickHouse, поднятый
 * этим скриптом (CI и любой сервер), их не знал. Теперь список берётся из каталога: каждый файл DDL, кроме проверки 099, применяется по порядку номера
 */
test('step 124: every DDL file of schemas/clickhouse is applied, in order, the verification last', async () => {
  const { ddlFiles } = await import('../../infra/local/apply-clickhouse.mjs');
  const onDisk = readdirSync(new URL('../../schemas/clickhouse/', import.meta.url)).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f !== '099_verify.sql').sort();
  assert.deepEqual(ddlFiles(), onDisk);
  assert.ok(ddlFiles().includes('097_step97.sql') && ddlFiles().includes('098_step109.sql'), 'the files the old list skipped');
});

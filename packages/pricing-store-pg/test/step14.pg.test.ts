import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { exportCoreArchive, MemoryArchiveSink, archiveKey, decodeBundle } from '@repracer/analytics-export';
import { can, MEMBER_ROLES, PRICING_ACTIONS, type PriceDecisionDraft, type PriceIntentDraft } from '@repracer/pricing-model';
import { EXPLANATION_RULESETS, standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { approved, contextOf, engineCost, explained } from './drafts.ts';

/**
 * Шаг 14 в базе — поведение, а не имена в каталоге (ретроспективное ревью, C1):
 *  - находка 2: справочник объяснений и матрица прав в БД совпадают с кодом;
 *  - находка 4: автор остановки, возобновления и ручного снятия — только членство пользователя сессии;
 *  - находка 10: у решения NO_OP нет ссылки на снимок;
 *  - Р-80: слепок без копий столбцов, столбцы intent в решении — из intent; сжатие в секциях отменено Р-86 — проверяются значения по умолчанию;
 *  - Р-79: архив ядра, выгруженный ролью экспортёра, объясняет каждую строку без базы; подтверждение без справочников БД не примет.
 * Каждый отказ проверяется рядом с разрешённым случаем: тест не проходит в пустом контексте.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-step14-test' }) : null;
const provisioning = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' }) : null;
const admin = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' }) : null;
const exporter = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_exporter@'), { max: 2, applicationName: 'repracer-step14-exporter' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const skip = false;
after(async () => {
  await pool?.end();
  await provisioning?.end();
  await admin?.end();
  await exporter?.end();
});

const TENANT = '10000000-0000-4000-8000-000000000140';
const ACCOUNT = '20000000-0000-4000-8000-000000000140';
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const now = () => new Date().toISOString();

function scopeSeed(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(1400 + n),
    channelProductRef: `36214${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', cost: engineCost(), strategy: FIXED,
    currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
  };
}

const seed = (scopes: MemorySeedScope[], extra: { halts?: Array<{ marketplace: string; haltedAt: string }> } = {}): Promise<SeededPricingWorld> =>
  seedPricingWorld(pool!, { provisioningPool: provisioning!, adminPool: admin!, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes, ...extra } as never });

/** Итог фиксации строкой: и результат, и ошибка БД — чтобы сверить причину отказа */
const outcomeOf = (p: Promise<unknown>) => p.then((r) => JSON.stringify(r), (e: unknown) => String(e instanceof Error ? e.message : e));

test('finding 2: the explanation dictionary and the permission matrix in the database equal the code', { skip }, async () => {
  const { rows } = await pool!.query('SELECT ruleset_id, kind, definition FROM platform.explanation_ruleset ORDER BY ruleset_id');
  const inDb = rows.map((r) => ({ rulesetId: r.ruleset_id, kind: r.kind, definition: r.definition }));
  const inCode = [...EXPLANATION_RULESETS].map((r) => ({ rulesetId: r.rulesetId, kind: r.kind, definition: r.definition })).sort((a, b) => a.rulesetId.localeCompare(b.rulesetId));
  assert.ok(inCode.length >= 2);
  assert.deepEqual(inDb, inCode);

  let allowed = 0;
  let denied = 0;
  for (const role of MEMBER_ROLES) {
    for (const action of PRICING_ACTIONS) {
      const r = (await pool!.query('SELECT security.pricing_permission($1, $2) AS ok', [role, action])).rows[0] as { ok: boolean };
      assert.equal(r.ok, can(role, action), `${role} × ${action}`);
      if (r.ok) allowed += 1;
      else denied += 1;
    }
  }
  assert.ok(allowed > 0 && denied > 0, `the matrix is not trivially all-true or all-false (${allowed}/${denied})`);
  assert.equal((await pool!.query(`SELECT security.pricing_permission('OWNER', 'DROP_TENANT') AS ok`)).rows[0].ok, false, 'an unknown action is denied');
});

test('finding 4: a stop, a resume and a manual halt release are accepted only from the session user of the membership; the audit author is that user', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(1)], { halts: [{ marketplace: 'de', haltedAt: now() }] });
  const member = (alias: string) => w.ids.dbId(alias);
  const user = (alias: string) => w.ids.dbId(standUserOf(alias));
  const record = (membership: string, userId: string) => ({
    scope: 'TENANT' as const, channelAccountId: null, marketplace: null, stoppedAt: now(), stoppedByMembershipId: member(membership), stoppedByUserId: userId,
    note: 'Synthetic stop for the author check',
  });

  // Оператор пишет от членства владельца — отказ; без пользователя сессии — отказ; от своего членства — принято
  assert.equal((await store.stopPricing(w.tenantId, record('membership-owner', user('membership-operator')))).status, 'FORBIDDEN', 'finding 4: a stop is not written in the name of another membership');
  // Административный сервис (Р-90) без пользователя сессии
  const noSession = await outcomeOf(inTenant(admin!, w.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_at, stopped_by_membership_id, stop_note) VALUES ($1, 'TENANT', now(), $2, 'Synthetic stop without session user')`,
    [w.tenantId, member('membership-owner')])));
  // Р-97 (0066): без пользователя сессии административный сервис не пишет вовсе — отказ раньше проверки автора
  assert.match(noSession, /without a person/);
  const stopped = await store.stopPricing(w.tenantId, record('membership-operator', user('membership-operator')));
  assert.equal(stopped.status, 'STOPPED');
  const stopId = stopped.status === 'STOPPED' ? stopped.stop.stopId : '';

  // Возобновление: администратор от своего пользователя — да; владелец с пользователем администратора — нет
  const release = (membership: string, userId: string) => ({ membershipId: member(membership), userId, mfa: true, note: 'Synthetic resume for the author check', at: now() });
  assert.equal((await store.releaseStop(w.tenantId, stopId, release('membership-owner', user('membership-admin')))).status, 'FORBIDDEN');
  assert.equal((await store.releaseStop(w.tenantId, stopId, release('membership-admin', user('membership-admin')))).status, 'RELEASED');

  // Ручное снятие системной остановки
  const [halt] = await inTenant(pool!, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  assert.ok(halt, 'the seeded halt exists');
  const manual = (membership: string, userId: string | undefined) => ({
    kind: 'MANUAL_RELEASE' as const, mfa: true, outcome: 'RELEASED' as const, sampleSize: 0, failedCount: 0, details: {}, membershipId: member(membership),
    ...(userId ? { userId } : {}), note: 'Synthetic manual release for the author check', at: now(),
  });
  assert.match(await outcomeOf(store.releaseHalt(w.tenantId, halt.pricing_halt_id, manual('membership-operator', user('membership-owner')))), /session user/);
  // Р-97 (0066): без пользователя сессии административный сервис не пишет вовсе
  assert.match(await outcomeOf(store.releaseHalt(w.tenantId, halt.pricing_halt_id, manual('membership-operator', undefined))), /without a person/);
  await store.releaseHalt(w.tenantId, halt.pricing_halt_id, manual('membership-operator', user('membership-operator')));

  // Р-96: журнал аудита читает административный сервис, у пути решения чтения аудита нет
  const audit = await inTenant(admin!, w.tenantId, async (tx) => (await tx.query(
    `SELECT e.action, e.actor_user_id, m.user_id AS membership_user FROM audit.audit_event e
       JOIN tenant_data.membership m ON m.tenant_id = e.tenant_id AND m.membership_id = e.actor_membership_id
      WHERE e.tenant_id = $1 AND e.actor_type = 'USER' AND e.action NOT LIKE 'admin_change.%' ORDER BY e.recorded_at`, [w.tenantId])).rows);
  assert.deepEqual(audit.map((a) => a.action), ['pricing.stop_created', 'pricing.stop_released', 'pricing.halt_released']);
  assert.deepEqual(audit.map((a) => a.actor_user_id), [user('membership-operator'), user('membership-admin'), user('membership-operator')]);
  assert.ok(audit.every((a) => a.actor_user_id === a.membership_user));
});

test('finding 10, Р-80: a NO_OP decision keeps no snapshot reference; a stored explanation repeats no row column; decision intent columns come from the intent', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(1), scopeSeed(2)]);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-1'));
  const key = { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition };
  const commitOne = (d: ReturnType<typeof explained>) => store.commitEvaluation(w.tenantId, { key, now: now(), decisions: [d] });

  // Одобрение: столбцы intent — в решении; в слепке их нет
  const changed = await commitOne(explained(approved(ctx, 1900)));
  assert.equal(changed.status, 'COMMITTED', JSON.stringify(changed));
  // NO_OP — только код причины
  const base = approved(ctx, 1850);
  const intent: PriceIntentDraft = { ...base.intent, intentClass: 'NO_OP', reason: { code: 'ALREADY_AT_TARGET', params: {} } };
  const decision: PriceDecisionDraft = { ...base.decision, outcome: 'NO_CHANGE', decisionClass: 'NO_OP', finalMinor: null, reason: { code: 'NO_CHANGE', params: {} } };
  const noop = await commitOne(explained({ context: ctx, intent, decision }));
  assert.equal(noop.status, 'COMMITTED', JSON.stringify(noop));

  const rows = await inTenant(pool!, w.tenantId, async (tx) => (await tx.query(
    `SELECT d.price_decision_id, d.decided_at, d.write_scope_id, d.intent_class, d.rule_code, d.trigger_type, d.proposed_amount_minor::int AS proposed, d.pricing_strategy_version,
            i.rule_code AS intent_rule, i.trigger_type AS intent_trigger, i.proposed_amount_minor::int AS intent_proposed, d.explanation
       FROM channel_data.price_decision d JOIN channel_data.price_intent i ON i.tenant_id = d.tenant_id AND i.price_intent_id = d.price_intent_id
      WHERE d.tenant_id = $1 ORDER BY d.intent_class`, [w.tenantId])).rows);
  assert.deepEqual(rows.map((r) => r.intent_class), ['CHANGED', 'NO_OP']);
  for (const r of rows) assert.deepEqual([r.rule_code, r.trigger_type, r.proposed], [r.intent_rule, r.intent_trigger, r.intent_proposed]);
  assert.deepEqual([rows[0].proposed, rows[1].proposed, rows[0].pricing_strategy_version], [1900, 1850, 1]);
  assert.equal(rows[0].explanation.format, 'r80.1');
  assert.equal(rows[0].explanation.strategy.ruleCode, undefined);

  const ref = (r: { price_decision_id: string; decided_at: Date; write_scope_id: string }) => inTenant(pool!, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.price_decision_snapshot_ref (tenant_id, price_decision_id, decided_at, write_scope_id, competitor_snapshot_id, source, observed_at)
     VALUES ($1, $2, $3, $4, gen_random_uuid(), 'KAUFLAND_BUYBOX', now())`, [w.tenantId, r.price_decision_id, r.decided_at, r.write_scope_id]));
  assert.match(await outcomeOf(ref(rows[1])), /NO_OP decision .* keeps no snapshot reference/, 'finding 10: a snapshot reference of a NO_OP decision is refused');
  assert.equal(await outcomeOf(ref(rows[0]).then(() => 'accepted')), '"accepted"', 'a CHANGED decision may have a snapshot reference');

  // Копия столбца в слепке — отказ БД, даже если приложение её положило
  const ctx2 = await contextOf(store, w.tenantId, w.ids.dbId('ws-2'));
  const copy = explained(approved(ctx2, 1950));
  copy.decision.explanation = { ...copy.decision.explanation!, strategy: { ...copy.decision.explanation!.strategy, ruleCode: 'FIXED' } as never };
  const key2 = { ...key, channelProductRef: ctx2.scope.channelProductRef };
  assert.match(await outcomeOf(store.commitEvaluation(w.tenantId, { key: key2, now: now(), decisions: [copy] })), /explanation_no_column_copies|explanation_keys_declared/);
});

test('Р-86: the partitions of the decision and the core keep the default storage — the in-database compression of step 14 is withdrawn', { skip }, async () => {
  const { rows } = await pool!.query(
    `SELECT t.tbl::text AS tbl, count(*) FILTER (WHERE pt.isleaf)::int AS leaves,
            count(*) FILTER (WHERE a.attcompression <> '' OR a.attstorage <> 'x')::int AS non_default,
            count(*) FILTER (WHERE pt.isleaf AND c.reloptions::text LIKE '%toast_tuple_target%')::int AS leaves_with_target
       FROM (VALUES ('channel_data.price_decision'::regclass), ('tenant_data.price_intent_core'::regclass)) AS t(tbl)
       CROSS JOIN LATERAL pg_partition_tree(t.tbl) pt
       JOIN pg_class c ON c.oid = pt.relid
       JOIN pg_attribute a ON a.attrelid = pt.relid AND a.attname = 'explanation'
      GROUP BY t.tbl ORDER BY 1`);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual([r.non_default, r.leaves_with_target, r.leaves > 0], [0, 0, true], JSON.stringify(r));
  // Роль приложения не видит схему maintenance по имени: столбец ищется в каталоге по именам схемы и таблицы
  const { rows: [col] } = await pool!.query(
    `SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'maintenance' AND c.relname = 'retention_policy' AND a.attname = 'leaf_toast_tuple_target' AND NOT a.attisdropped`);
  assert.equal(col.n, 0);
});

test('Р-79: the core archive exported by the exporter role explains every row without the database; a confirmation without dictionaries is refused', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(4)]);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-4'));
  const r = await store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition },
    now: now(), decisions: [explained(approved(ctx, 1980))],
  });
  assert.equal(r.status, 'COMMITTED', JSON.stringify(r));
  const { rows: [part] } = await pool!.query(
    `SELECT c.oid::regclass::text AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'tenant_data.price_intent_core'::regclass
        AND pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES FROM (''' || to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') || '%'
      ORDER BY 1 LIMIT 1`);
  assert.ok(part, 'the current month partition of the core exists');

  const sink = new MemoryArchiveSink();
  const result = await exportCoreArchive(exporter!, sink, part.name);
  assert.deepEqual([result.verified, result.gaps], [true, []], JSON.stringify(result.gaps.slice(0, 3)));
  assert.ok(result.rows >= 1 && result.tenants >= 1);
  const bundle = decodeBundle(await sink.get(archiveKey(w.tenantId, 'tenant_data.price_intent_core', part.name)));
  assert.equal(bundle.core.length, 1);
  assert.deepEqual(bundle.dictionary.strategies.map((s) => Number(s.version)), [1], 'the strategy version travels with the core');
  assert.ok([...sink.objects.keys()].every((k) => k.startsWith('tenant=')), 'one archive per tenant prefix (Р-23)');

  const { rows: [recorded] } = await exporter!.query(`SELECT verified_at IS NOT NULL AS verified, explanation_dictionary_included FROM maintenance.partition_export WHERE partition_name = $1 AND target = 'ARCHIVE'`, [part.name]);
  assert.deepEqual(recorded, { verified: true, explanation_dictionary_included: true });
  assert.match(await outcomeOf(exporter!.query(
    `INSERT INTO maintenance.partition_export (parent_table, partition_name, target, exported_rows, verified_at, explanation_dictionary_included)
     VALUES ('tenant_data.price_intent_core', 'tenant_data.price_intent_core_y1999m01', 'ARCHIVE', 0, now(), false)`)), /partition_export_core_archive_self_contained/,
    'Р-79: a verified archive of the core without the explanation dictionary is refused');
});

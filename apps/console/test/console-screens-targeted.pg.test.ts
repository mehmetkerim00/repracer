import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { DecisionListView, ProductListView, StopView, StrategyListView } from '@repracer/console-model';
import { buildStandWorlds, pgStandJoinMember, pgStandUsers, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { pgStoreFactory } from '@repracer/contract-tests/pg-store';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createPool } from '@repracer/pricing-store-pg';
import type { StandToken } from '../src/api-types.ts';
import { createStandApi } from '../server/stand-server.ts';

/**
 * Шаг 67 (OQ-248): экраны больше не собирают каталог целиком — каждый называет единицы, которые покажет, и спрашивает базу о каталоге
 * только то, что ему нужно (страница, число и первые предложения, поиск, использование стратегий, влияние остановки, ценообразование
 * канала, первая единица по ключу снимка). Это ВТОРОЕ правило того же, что экран считал по каталогу в памяти, — и тест держит их
 * РАВНЫМИ: на каждом мире стенда, поднятом на PostgreSQL, каждый экран отвечает одинаково через обычный сервер и через сервер, который
 * строит экраны из каталога целиком (`fullCatalogScreens`). Номера неверной формы — тот же отказ, а не 500 приведения типа в базе.
 */
const PG_URL = process.env.REPRACER_PG_URL;
// Р-84: без базы тест не пропускается, а падает
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const role = (r: string, max = 2) => createPool(PG_URL.replace('svc_app@', `${r}@`), { max, applicationName: 'repracer-screens-targeted' });
const pool = createPool(PG_URL, { max: 6, applicationName: 'repracer-screens-targeted' });
const pools = { scan: role('svc_dispatcher'), fx: role('svc_fx_loader', 1), onboarding: role('svc_onboarding', 1), admin: role('svc_admin', 4),
  bulk: role('svc_bulk_worker'), auth: role('svc_authenticator'), provisioning: role('svc_provisioning', 1) };
let worlds: LiveWorld[] = [];
let targeted: ReturnType<typeof createStandApi>;
let full: ReturnType<typeof createStandApi>;
/**
 * Ревью шага 67, находка 2: равенство двух путей ничего не доказывает, если точечный путь выключился (нет метода у обёртки хранилища,
 * опечатка в условии) — тогда оба сервера строят экраны из каталога целиком. Каждый API получает свои обёртки миров и считает, КАК строил:
 * миров из каталога целиком, миров из названных единиц, фактов и страниц базы
 */
type Calls = { wholeCatalog: number; namedUnits: number; facts: number; pages: number };
const calls = { targeted: { wholeCatalog: 0, namedUnits: 0, facts: 0, pages: 0 } as Calls, full: { wholeCatalog: 0, namedUnits: 0, facts: 0, pages: 0 } as Calls };
const counted = (live: LiveWorld, c: Calls): LiveWorld => ({
  ...live,
  view: (viewer, options) => { if (options?.scopeIds) c.namedUnits += 1; else c.wholeCatalog += 1; return live.view(viewer, options); },
  store: new Proxy(live.store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || (prop !== 'consoleCatalogFacts' && prop !== 'consoleCatalogPage')) return value;
      return (...args: unknown[]) => { if (prop === 'consoleCatalogFacts') c.facts += 1; else c.pages += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  }),
});

before(async () => {
  const directory = new PgIdentityDirectory(pools.auth as never);
  const memberUsers = await pgStandUsers(directory, pools.onboarding);
  worlds = await buildStandWorlds({
    storeFactory: pgStoreFactory(pool, pools.scan, pools.fx, { memberUsers, memberEmails: STAND_EMAILS, joinMember: pgStandJoinMember(pools.admin, directory),
      adminPool: pools.admin, provisioningPool: pools.provisioning, bulkWorkerPool: pools.bulk }),
  });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const identity = {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (a: { subject: string; email: string }) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 },
  };
  targeted = createStandApi(worlds.map((w) => counted(w, calls.targeted)), identity);
  full = createStandApi(worlds.map((w) => counted(w, calls.full)), identity, { fullCatalogScreens: true });
});
after(async () => {
  await pool.end();
  for (const p of Object.values(pools)) await p.end();
});

test('step 67 (OQ-248): every screen built from the units it names and the database facts equals the same screen built from the whole catalog, on every stand world', { timeout: 30 * 60_000 }, async () => {
  const r = await targeted({ method: 'POST', url: '/api/stand-issuer/token', body: { role: 'OWNER' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const auth = { authorization: `Bearer ${(r.body as StandToken).accessToken}`, cookie: 'repracer_locale=en' };
  const seen = { worlds: 0, strategyScopes: 0, channelPricing: 0, stopImpact: 0, searchHits: 0, searchNarrowed: 0, decisions: 0, rejected: 0, dangerous: 0, feed: 0 };
  const compare = async (url: string) => {
    const [a, b] = await Promise.all([targeted({ method: 'GET', url, body: null, ...auth }), full({ method: 'GET', url, body: null, ...auth })]);
    assert.equal(a.status, b.status, `${url}: status — targeted ${a.status} ${JSON.stringify(a.body).slice(0, 300)}, whole catalog ${b.status}`);
    assert.deepEqual(a.body, b.body, `${url}: the targeted screen equals the screen built from the whole catalog`);
    return a;
  };
  for (const live of worlds) {
    if (!live.store.consoleCatalogFacts) continue;
    const api = (path: string) => `/api/worlds/${encodeURIComponent(live.id)}/${path}`;
    const products = (await compare(api('products?offset=0&limit=7'))).body as ProductListView;
    if (products.page.total === 0) continue;
    seen.worlds += 1;
    const firstId = products.rows[0]!.unit.writeScopeId;
    const unit = products.rows[0]!.unit;
    for (const path of ['products?offset=7&limit=7', 'products?offset=1000&limit=7', 'bounds?offset=0&limit=7', `bounds/${firstId}`, 'bounds/not-a-unit',
      'bounds/00000000-0000-4000-8000-000000000000', 'stock?offset=0&limit=7', 'shadow?offset=0&limit=7', 'jobs', 'compliance?offset=0&limit=7', 'compliance?offset=7&limit=7',
      'feed', `feed?writeScopeId=${firstId}`, 'feed?writeScopeId=not-a-unit', 'feed?writeScopeId=00000000-0000-4000-8000-000000000000',
      'decisions/not-a-decision', `decisions?offset=0&limit=5&writeScopeId=${firstId}`, 'decisions?offset=0&limit=5&writeScopeId=not-a-unit']) {
      await compare(api(path));
    }
    const strategies = (await compare(api('strategies?offset=0&limit=7'))).body as StrategyListView;
    await compare(api('strategies?offset=7&limit=7'));
    seen.strategyScopes += strategies.strategies.reduce((n, s) => n + s.scopeCount, 0);
    seen.channelPricing += strategies.channelPricingOffersTotal;
    const stop = (await compare(api('stop'))).body as StopView;
    seen.stopImpact += stop.storefronts.reduce((n, c) => n + c.impact.prices + c.impact.pendingWritesDropped, 0);
    // Поиск: пустой, по подписи (канал и витрина), по номеру единицы, по куску номера, по ссылке товара, мимо всего
    for (const q of ['', unit.label.slice(0, 6), unit.externalUnitId, unit.externalUnitId.slice(1, 4), unit.channelProductRef, unit.label.toUpperCase().slice(-5), 'zz-no-such-offer']) {
      const found = (await compare(api(`offers?q=${encodeURIComponent(q)}`))).body as { total: number };
      if (q !== '' && found.total > 0) seen.searchHits += 1;
      if (found.total > 0 && found.total < products.page.total) seen.searchNarrowed += 1;
    }
    const decisions = (await compare(api('decisions?offset=0&limit=5'))).body as DecisionListView;
    for (const d of decisions.items.slice(0, 2)) await compare(api(`decisions/${d.decisionId}`));
    seen.decisions += decisions.items.length;
    seen.rejected += ((await compare(api('rejected'))).body as { items: unknown[] }).items.length;
    for (const days of ['7', '30']) seen.dangerous += ((await compare(api(`dangerous?days=${days}`))).body as { items: unknown[] }).items.length;
    seen.feed += ((await compare(api('feed'))).body as { items: unknown[] }).items.length;
  }
  // Сравнение не пустое: каждое правило, переписанное запросом, встретило данные — иначе равенство было бы равенством пустот [Р-94]
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `every rule met data: ${k} = 0 (${JSON.stringify(seen)})`);
  // И пути действительно разные: точечный ни разу не собрал каталог целиком и спрашивал базу фактами и страницами, полный — наоборот
  assert.equal(calls.targeted.wholeCatalog, 0, `the targeted screens never load the whole catalog: ${JSON.stringify(calls)}`);
  assert.ok(calls.targeted.namedUnits > 0 && calls.targeted.facts > 0 && calls.targeted.pages > 0, `the targeted screens ask the database: ${JSON.stringify(calls)}`);
  assert.deepEqual([calls.full.namedUnits, calls.full.facts, calls.full.pages], [0, 0, 0], `the whole-catalog screens read the whole catalog only: ${JSON.stringify(calls)}`);
});

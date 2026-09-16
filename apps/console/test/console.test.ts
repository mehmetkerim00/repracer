import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { messagesFor, type BoundsDiffView, type BoundsView, type DangerousReportView, type DecisionListItem, type DecisionTrace, type Locale, type PriceFeedView, type ProductListView, type RejectedView, type StopPlan, type StopView, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import { buildStandWorlds, memoryStandDirectory, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import type { BoundsIndexItem, EnableResult, SessionView, StandToken, WorldSummary } from '../src/api-types.ts';
import { createStandApi, resolveStandIdentityMode } from '../server/stand-server.ts';

/**
 * Интерфейс на мирах стенда (хранилище в памяти): вход через токен поставщика identity [Р-78] (на стенде — имитатор),
 * роли из членств при каждом запросе, права администратора и менеджера цен [OQ-129], журнал аудита остановок с автором —
 * пользователем токена [Р-76, находка 4], NO_OP без слепка [Р-74], тексты DE/EN [Р-72]. Экраны рендерятся теми же компонентами.
 */

const WORLDS = [
  'kaufland/pipeline/happy-path', 'kaufland/pipeline/above-max-price', 'kaufland/pipeline/fx-usd-floor-eur-cost', 'kaufland/pipeline/mass-shift-halt',
  'kaufland/pipeline/enable-margin-without-cost', 'kaufland/pipeline/kill-switch-tenant-stop',
];
const root = fileURLToPath(new URL('..', import.meta.url));
const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
let handle: ReturnType<typeof createStandApi>;
let worlds: LiveWorld[] = [];
let vite: ViteDevServer | null = null;

before(async () => {
  worlds = await buildStandWorlds({ filter: (s) => WORLDS.includes(s.id) });
  handle = createStandApi(worlds, {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(worlds) }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 },
  });
  vite = await createServer({ root, configFile: `${root}vite.config.ts`, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
});
after(async () => {
  await vite?.close();
});

const account = (role: string) => STAND_ACCOUNTS.find((a) => a.role === role)!;

/** Запрос браузера: токен поставщика в заголовке и язык в cookie (сессии у сервера нет) */
interface Auth { authorization: string; cookie: string }

/** Вход на стенде: токен имитатора поставщика для синтетического пользователя роли */
async function login(role: string, locale: Locale = 'en'): Promise<Auth> {
  const r = await handle({ method: 'POST', url: `/api/stand-issuer/token?locale=${locale}`, body: { role } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${(r.body as StandToken).accessToken}`, cookie: `repracer_locale=${locale}` };
}

const call = (auth: Auth | string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  handle({ method, url, body, ...(typeof auth === 'string' ? { authorization: auth } : auth) });
async function get<T>(auth: Auth, url: string): Promise<T> {
  const r = await call(auth, 'GET', url);
  assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const api = (id: string, ...parts: string[]) => `/api/worlds/${[id, ...parts].map(encodeURIComponent).join('/')}`;

async function html(module: string, component: string, props: Record<string, unknown>, locale: Locale = 'en'): Promise<string> {
  const components = (await vite!.ssrLoadModule('/src/components.tsx')) as { MessagesContext: { Provider: Parameters<typeof createElement>[0] } };
  const m = (await vite!.ssrLoadModule(module)) as Record<string, Parameters<typeof createElement>[0]>;
  const markup = renderToStaticMarkup(createElement(components.MessagesContext.Provider as never, { value: messagesFor(locale) } as never, createElement(m[component]!, props)));
  for (const bad of ['undefined', 'NaN', '[object Object]']) assert.ok(!markup.includes(bad), `${component}: "${bad}" rendered`);
  return markup;
}

test('Р-78: no password and no session — every request carries a provider token; missing, forged, expired, foreign or unlinked tokens are refused alike', async () => {
  assert.equal((await handle({ method: 'GET', url: '/api/worlds', body: undefined })).status, 401);
  const session = (await handle({ method: 'GET', url: '/api/session?locale=en', body: undefined })).body as SessionView;
  assert.deepEqual([session.user, session.simulator?.map((a) => a.role)], [null, STAND_ACCOUNTS.map((a) => a.role)]);

  const owner = await login('OWNER');
  assert.deepEqual((await get<SessionView>(owner, '/api/session')).user, { subject: account('OWNER').subject, email: account('OWNER').email });
  assert.equal((await get<WorldSummary[]>(owner, '/api/worlds')).length, WORLDS.length);

  const refused = async (authorization: string, why: string) => {
    const r = await call(authorization, 'GET', '/api/worlds');
    assert.deepEqual([r.status, (r.body as { error: { code: string } }).error.code], [401, 'UNAUTHENTICATED'], why);
  };
  const [header, payload] = owner.authorization.slice('Bearer '.length).split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: account('ADMIN').subject })).toString('base64url');
  await refused(`Bearer ${header}.${forged}.${owner.authorization.split('.')[2]}`, 'a payload changed after signing');
  await refused(`Bearer ${issuer.token(account('OWNER').subject, { expiresInSeconds: -120 })}`, 'an expired token');
  const foreign = createTestIssuer({ issuer: 'https://identity.other.test', audience: STAND_AUDIENCE });
  await refused(`Bearer ${foreign.token(account('OWNER').subject)}`, 'a token of another issuer');
  const otherKey = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  await refused(`Bearer ${otherKey.token(account('OWNER').subject)}`, 'the right issuer name signed with a key not in its JWKS');
  await refused(`Bearer ${issuer.token('stand-user-nobody')}`, 'a valid token of a subject without a linked user');
  await refused(owner.authorization.replace('Bearer ', 'Basic '), 'not a bearer token');
  const r = await handle({ method: 'POST', url: '/api/session', body: { email: account('OWNER').email, password: 'anything-at-all' } });
  assert.equal(r.status, 404, 'there is no password sign-in endpoint any more');
  assert.equal((await handle({ method: 'POST', url: '/api/stand-issuer/token', body: { role: 'ROOT' } })).status, 400);
});

test('stand API serves every screen of every world in German and English and refuses unknown addresses', async () => {
  const auth = await login('VIEWER');
  const list = await get<WorldSummary[]>(auth, '/api/worlds');
  assert.deepEqual(list.map((w) => w.id).sort(), [...WORLDS].sort());
  assert.ok(list.every((w) => w.role === 'Viewer'));
  for (const locale of ['de', 'en'] as const) {
    for (const w of list) {
      const q = `?locale=${locale}`;
      await get<ProductListView>(auth, api(w.id, 'products') + q);
      for (const d of await get<DecisionListItem[]>(auth, api(w.id, 'decisions') + q)) await get<DecisionTrace>(auth, api(w.id, 'decisions', d.decisionId) + q);
      await get<RejectedView>(auth, api(w.id, 'rejected') + q);
      for (const b of await get<BoundsIndexItem[]>(auth, api(w.id, 'bounds') + q)) await get<BoundsView>(auth, api(w.id, 'bounds', b.writeScopeId) + q);
      await get<StopView>(auth, api(w.id, 'stop') + q);
    }
  }
  assert.equal((await call(auth, 'GET', api('no-such-world', 'products'))).status, 404);
  const missing = await call(auth, 'GET', `${api(WORLDS[0]!, 'decisions', 'decision-9999')}?locale=de`);
  assert.deepEqual([missing.status, (missing.body as { error: { message: string } }).error.message], [404, 'Nicht gefunden.']);
});

test('screens render from the dictionary: sign-in, products with the effective floor, why this price with a NO_OP gap, rejected, bounds, stop with the audit log', async () => {
  const auth = await login('OWNER');
  const id = 'kaufland/pipeline/happy-path';
  const products = await html('/src/screens/Products.tsx', 'ProductsView', { view: await get<ProductListView>(auth, api(id, 'products')) });
  for (const text of ['Effective floor', 'Next check', 'No data', 'Kaufland de · unit 4101', '€17.75', 'Why this price']) assert.ok(products.includes(text), text);

  const decisions = await get<DecisionListItem[]>(auth, api(id, 'decisions'));
  const approved = decisions.find((d) => d.outcome === 'Approved')!;
  const trace = await html('/src/screens/Decisions.tsx', 'TraceView', { trace: await get<DecisionTrace>(auth, api(id, 'decisions', approved.decisionId)) });
  for (const text of ['Why this price', 'Competitor snapshot', 'Input check', 'Plausibility anchors', 'Strategy', 'Price Gate', 'Write to the channel', 'Channel confirmation']) {
    assert.ok(trace.includes(text), text);
  }
  const noChange = decisions.find((d) => d.outcome === 'No change')!;
  const kept = await get<DecisionTrace>(auth, api(id, 'decisions', noChange.decisionId));
  assert.ok(kept.gaps.some((g) => g.code === 'NO_OP_NOT_EXPLAINED'));
  const keptHtml = await html('/src/screens/Decisions.tsx', 'TraceView', { trace: kept });
  for (const text of ['Not kept for decisions that did not change the price (Р-74)', 'Explanation of a decision that kept the price']) assert.ok(keptHtml.includes(text), text);

  const rejected = await html('/src/screens/Rejected.tsx', 'RejectedScreenView', { view: await get<RejectedView>(auth, api('kaufland/pipeline/above-max-price', 'rejected')) });
  for (const text of ['Your bounds stopped 1 dangerous change', 'dangerous', '53.2%']) assert.ok(rejected.includes(text), text);

  const usd = (await get<BoundsIndexItem[]>(auth, api('kaufland/pipeline/fx-usd-floor-eur-cost', 'bounds'))).find((b) => b.label.includes('ATVPDKIKX0DER'))!;
  const bounds = await html('/src/screens/Bounds.tsx', 'BoundsScreenView', { view: await get<BoundsView>(auth, api('kaufland/pipeline/fx-usd-floor-eur-cost', 'bounds', usd.writeScopeId)) });
  for (const text of ['Effective floor', '$17.79', 'ECB rate', 'add up to the price to the cent']) assert.ok(bounds.includes(text), text);

  const stop = await html('/src/screens/Stop.tsx', 'StopScreenView', { view: await get<StopView>(auth, api('kaufland/pipeline/mass-shift-halt', 'stop')), onStop: () => {}, onResume: () => {}, onRelease: () => {} });
  for (const text of ['Stop by a person', 'Storefront halts by the system', 'Stop the whole tenant…', 'Audit log of stops', 'Storefront halted by the system', 'Second factor']) assert.ok(stop.includes(text), text);

  const session = await get<SessionView>(auth, '/api/session?locale=de');
  const loginView = await html('/src/App.tsx', 'LoginView', { simulator: session.simulator, error: null, busy: false, onSignIn: () => {} }, 'de');
  for (const text of ['Anmelden', 'Identitätsanbieter', 'Anmelden als Inhaber']) assert.ok(loginView.includes(text), text);
  assert.ok(!loginView.includes('type="password"'), 'no password field (Р-78)');
});

test('Р-69, Р-76, OQ-129: a viewer cannot stop; an operator stops; the operator and the pricing manager cannot resume a tenant stop, the admin can; every step is in the audit log', async () => {
  const id = 'kaufland/pipeline/happy-path';
  const target = { kind: 'TENANT' };
  const viewer = await login('VIEWER');
  assert.equal((await get<StopView>(viewer, api(id, 'stop'))).permissions.canStop, false);
  assert.equal((await call(viewer, 'POST', api(id, 'stop'), { target, note: 'Synthetic kill switch', confirmed: true })).status, 403);

  const operator = await login('OPERATOR');
  const plan = (await call(operator, 'POST', api(id, 'stop', 'plan'), { target })).body as StopPlan;
  assert.equal(plan.confirmTitle, 'Stop all price changes: the whole tenant?');
  assert.equal((await call(operator, 'POST', api(id, 'stop'), { target, note: 'short', confirmed: true })).status, 400);
  assert.equal((await call(operator, 'POST', api(id, 'stop'), { target, note: 'Synthetic kill switch', confirmed: true })).status, 200);
  assert.equal((await call(operator, 'POST', api(id, 'stop'), { target, note: 'Synthetic kill switch', confirmed: true })).status, 409);
  assert.ok((await get<ProductListView>(operator, api(id, 'products'))).rows.every((r) => r.enabled.label === 'Stopped'));

  const stopId = (await get<StopView>(operator, api(id, 'stop'))).stops.active[0]!.stopId;
  assert.equal((await call(operator, 'POST', api(id, 'stops', stopId, 'resume'), { note: 'Operator tries to resume', confirmed: true })).status, 403);
  const pricingManager = await login('PRICING_MANAGER');
  assert.equal((await get<StopView>(pricingManager, api(id, 'stop'))).permissions.canStop, true, 'a pricing manager may stop');
  assert.equal((await call(pricingManager, 'POST', api(id, 'stops', stopId, 'resume'), { note: 'Pricing manager tries to resume', confirmed: true })).status, 403);
  const admin = await login('ADMIN', 'de');
  const resumed = await call(admin, 'POST', api(id, 'stops', stopId, 'resume'), { note: 'Geprüft, wir setzen fort', confirmed: true });
  assert.deepEqual([resumed.status, (resumed.body as { message: string }).message], [200, 'Preisänderungen fortgesetzt.']);

  // Находка 4: членство автора сверяется с пользователем токена — чужое членство не принимается ни хранилищем, ни БД
  const live = worlds.find((w) => w.id === id)!;
  const forged = await live.pipeline.stopPricing(live.callContext(live.accounts[0]!.channelAccountId), {
    scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: live.clock.iso(), stoppedByMembershipId: 'membership-owner', stoppedByUserId: 'user-operator',
    note: 'Operator writes as the owner',
  });
  assert.equal(forged.status, 'FORBIDDEN');
  const audit = (await get<StopView>(admin, `${api(id, 'stop')}?locale=en`)).audit;
  assert.deepEqual(audit.slice(0, 2).map((a) => [a.action, a.actor, a.scope, a.note]), [
    ['Pricing resumed', 'Admin (you)', 'the whole tenant', 'Geprüft, wir setzen fort'],
    ['Pricing stopped', 'Operator', 'the whole tenant', 'Synthetic kill switch'],
  ]);
});

test('Р-52: a system halt is released by an operator with a note; a viewer may not', async () => {
  const id = 'kaufland/pipeline/mass-shift-halt';
  const viewer = await login('VIEWER');
  const halt = (await get<StopView>(viewer, api(id, 'stop'))).halts.active[0];
  assert.ok(halt, 'the world has an active halt');
  assert.equal((await call(viewer, 'POST', api(id, 'halts', halt.haltId, 'release'), { note: 'Synthetic halt release', confirmed: true })).status, 403);
  const operator = await login('OPERATOR');
  const released = await call(operator, 'POST', api(id, 'halts', halt.haltId, 'release'), { note: 'Synthetic halt release', confirmed: true });
  assert.equal(released.status, 200);
  const view = (released.body as { stop: StopView }).stop;
  assert.equal(view.halts.active.length, 0);
  assert.deepEqual([view.audit[0]!.action, view.audit[0]!.actor], ['Storefront halt released', 'Operator (you)']);
});

test('G, Р-77: enabling a margin price without cost warns with the strategy type and who needs the cost', async () => {
  const id = 'kaufland/pipeline/enable-margin-without-cost';
  const operator = await login('OPERATOR', 'de');
  const scope = (await get<ProductListView>(operator, api(id, 'products'))).rows[0]!;
  const first = (await call(operator, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: false })).body as EnableResult;
  assert.deepEqual([first.enabled, first.problems, first.warnings.map((w) => [w.code, w.problems])], [false, [], [['MARGIN_WITHOUT_COST', []]]]);
  assert.equal(first.warnings[0]!.text, 'Hinweis: die Strategie Zielmarge und die Mindestmarge 15 % brauchen die Einstandskosten, aber die Einstandskosten sind nicht gesetzt. Bis dahin würde jeder Preis abgelehnt.');
  const dialog = await html('/src/screens/Products.tsx', 'EnableResultView', { unit: scope.unit.label, result: first, busy: false, error: null, onAcknowledge: () => {}, onClose: () => {} }, 'de');
  for (const text of ['Vor dem Aktivieren:', 'Trotzdem aktivieren']) assert.ok(dialog.includes(text), text);
  assert.equal(((await call(operator, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: true })).body as EnableResult).enabled, true);
  const viewer = await login('VIEWER');
  assert.equal((await call(viewer, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: true })).status, 403);
});

test('no endless spinner: a request that gets no answer ends with an error the screen can show', async () => {
  const { requestJson, ApiError } = (await vite!.ssrLoadModule('/src/api.ts')) as {
    requestJson: (path: string, init: { timeoutMs: number }) => Promise<unknown>;
    ApiError: new (...a: never[]) => Error;
  };
  const { errorText } = (await vite!.ssrLoadModule('/src/components.tsx')) as { errorText: (e: unknown, m: unknown) => string };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;
  try {
    await assert.rejects(requestJson('/api/worlds', { timeoutMs: 50 }), (e: unknown) => e instanceof ApiError && /did not answer within 0\.05 s/.test(errorText(e, messagesFor('en'))));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('finding 6: the sign-in mode of the stand is explicit — a partial OIDC configuration or a simulator next to OIDC settings refuses to start', () => {
  assert.deepEqual(resolveStandIdentityMode({ STAND_IDENTITY: 'simulator' }), { kind: 'simulator' });
  assert.deepEqual(resolveStandIdentityMode({ STAND_IDENTITY: 'oidc', OIDC_ISSUER: 'https://idp.example.test', OIDC_AUDIENCE: 'console', OIDC_JWKS_URL: 'https://idp.example.test/keys' }),
    { kind: 'oidc', issuer: 'https://idp.example.test', audience: 'console', jwksUrl: 'https://idp.example.test/keys' });
  assert.throws(() => resolveStandIdentityMode({}), /must be "simulator" or "oidc"/);
  assert.throws(() => resolveStandIdentityMode({ OIDC_ISSUER: 'https://idp.example.test', OIDC_AUDIENCE: 'console' }), /must be "simulator" or "oidc"/, 'no silent simulator');
  assert.throws(() => resolveStandIdentityMode({ STAND_IDENTITY: 'oidc', OIDC_ISSUER: 'https://idp.example.test', OIDC_AUDIENCE: 'console', OIDC_JWKS_URLL: 'x' }), /missing: OIDC_JWKS_URL/);
  assert.throws(() => resolveStandIdentityMode({ STAND_IDENTITY: 'simulator', OIDC_JWKS_URL: 'https://idp.example.test/keys' }), /refuses OIDC_JWKS_URL/);
  assert.throws(() => resolveStandIdentityMode({ STAND_IDENTITY: 'oidc', OIDC_ISSUER: 'http://idp.example.test', OIDC_AUDIENCE: 'c', OIDC_JWKS_URL: 'http://idp.example.test/k' }), /https/);
});


test('step 21: a strategy is saved only with the token of the preview shown; bounds are applied only with the token of the difference screen and a second factor for several offers', async () => {
  const id = 'kaufland/pipeline/happy-path';
  const owner = await login('OWNER');
  const viewer = await login('VIEWER');
  const draft = { name: 'Synthetic undercut', params: { type: 'MATCH_BUYBOX', undercutMinor: 10, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 };
  const list = await get<StrategyListView>(owner, api(id, 'strategies'));
  assert.equal(list.canEdit, true);
  assert.equal((await get<StrategyListView>(viewer, api(id, 'strategies'))).canEdit, false);
  const bad = await call(owner, 'POST', api(id, 'strategies', 'preview'), { draft: { ...draft, deadbandMinor: 'x' }, writeScopeIds: ['ws-price-de-4101'] });
  assert.deepEqual([bad.status, (bad.body as { error: { code: string; message: string } }).error.message], [400, 'Threshold, cents: whole number of cents or basis points']);
  const preview = await call(viewer, 'POST', api(id, 'strategies', 'preview'), { draft, writeScopeIds: ['ws-price-de-4101'] });
  assert.equal(preview.status, 200, 'a viewer may preview');
  const view = preview.body as StrategyPreviewView;
  assert.equal(view.rows.length, 1);
  const save = (auth: Auth, previewToken: string, confirmed = true) => call(auth, 'POST', api(id, 'strategies'), { draft, writeScopeIds: ['ws-price-de-4101'], strategyId: null, previewToken, confirmed });
  assert.equal((await save(viewer, view.previewToken)).status, 403);
  assert.equal((await save(owner, view.previewToken, false)).status, 400);
  assert.equal((await save(owner, 'not-the-preview')).status, 409);
  const saved = await save(owner, view.previewToken);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match((saved.body as { message: string }).message, /^Saved as version 1, assigned to 1 offer\.$/);
  const html1 = await html('/src/screens/Strategies.tsx', 'PreviewTable', { view });
  assert.ok(html1.includes('snapshot of '));

  // Правка границ: экран различий → применение; без экрана и с устаревшим токеном — отказ
  const request = { writeScopeIds: ['ws-price-de-4101'], min: { kind: 'SET', minor: 1600 } };
  assert.equal((await call(viewer, 'POST', api(id, 'bounds', 'plan'), { request })).status, 403);
  const plan = await call(owner, 'POST', api(id, 'bounds', 'plan'), { request });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const diff = plan.body as BoundsDiffView;
  assert.deepEqual([diff.rows[0]!.minBefore, diff.rows[0]!.minAfter, diff.mfaRequired], ['€15.00', '€16.00', false]);
  assert.equal((await call(owner, 'POST', api(id, 'bounds', 'apply'), { request, planToken: 'stale', confirmed: true })).status, 409);
  const applied = await call(owner, 'POST', api(id, 'bounds', 'apply'), { request, planToken: diff.planToken, confirmed: true });
  assert.deepEqual([applied.status, (applied.body as { message: string }).message], [200, 'Bounds of 1 offer changed.']);
  assert.equal((await call(owner, 'POST', api(id, 'bounds', 'apply'), { request, planToken: diff.planToken, confirmed: true })).status, 409, 'the difference screen is stale after applying');
  const diffHtml = await html('/src/screens/BoundsEdit.tsx', 'BoundsDiffTable', { view: diff }, 'de');
  assert.ok(diffHtml.includes('€15.00') && diffHtml.includes('min vorher'), 'amounts come from the server in the session language, labels from the dictionary of the page');

  const multi = 'kaufland/pipeline/fx-usd-floor-eur-cost';
  const mass = { writeScopeIds: (await get<BoundsIndexItem[]>(owner, api(multi, 'bounds'))).map((i) => i.writeScopeId), min: { kind: 'PERCENT', bp: -500 } };
  const massPlan = (await call(owner, 'POST', api(multi, 'bounds', 'plan'), { request: mass })).body as BoundsDiffView;
  assert.equal(massPlan.mfaRequired, true);
  // Токен имитатора по умолчанию несёт второй фактор (pwd + otp); вход только паролем — без него
  const passwordOnly = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd'] })}`, cookie: 'repracer_locale=en' };
  const noMfa = await call(passwordOnly, 'POST', api(multi, 'bounds', 'apply'), { request: mass, planToken: massPlan.planToken, confirmed: true });
  assert.equal(noMfa.status, 403, JSON.stringify(noMfa.body));
  assert.equal((noMfa.body as { error: { code: string } }).error.code, 'MFA_REQUIRED');
  const withMfa = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd', 'otp'] })}`, cookie: 'repracer_locale=en' };
  assert.equal((await call(withMfa, 'POST', api(multi, 'bounds', 'apply'), { request: mass, planToken: massPlan.planToken, confirmed: true })).status, 200);
});

test('step 21: the price feed and the report of dangerous changes stopped by the bounds (Р-73) are served and rendered in German and English', async () => {
  const viewer = await login('VIEWER');
  const feed = await get<PriceFeedView>(viewer, api('kaufland/pipeline/happy-path', 'feed'));
  assert.ok(feed.items.length >= 1);
  const report = await get<DangerousReportView>(viewer, `${api('kaufland/pipeline/above-max-price', 'dangerous')}?days=30`);
  assert.equal(report.count, 1);
  assert.equal((await call(viewer, 'GET', `${api('kaufland/pipeline/above-max-price', 'dangerous')}?days=5`)).status, 400);
  for (const locale of ['de', 'en'] as const) {
    const auth = await login('VIEWER', locale);
    const r = await get<DangerousReportView>(auth, `${api('kaufland/pipeline/above-max-price', 'dangerous')}?days=7`);
    const markup = await html('/src/screens/Dangerous.tsx', 'DangerousScreenView', { view: r }, locale);
    assert.ok(markup.includes(r.headline));
    assert.ok((await html('/src/screens/Feed.tsx', 'FeedScreenView', { view: await get<PriceFeedView>(auth, api('kaufland/pipeline/happy-path', 'feed')) }, locale)).includes(messagesFor(locale).ui.feed.pageTitle));
  }
});

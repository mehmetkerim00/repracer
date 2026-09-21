import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { messagesFor, type DecisionListView, type BulkJobView, type ComplianceView, type CostImportView, type DiscountCheckView, type BoundsDiffView, type BoundsView, type DangerousReportView, type DecisionListItem, type DecisionTrace, type Locale, type PriceFeedView, type ProductListView, type RejectedView, type StopPlan, type StopView, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import { buildStandWorlds, memoryStandDirectory, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import type { BoundsIndexView, DiscountAnnounceResponse, EnableResult, JobCreatedResponse, SessionView, StandToken, WorldSummary } from '../src/api-types.ts';
import { createHash } from 'node:crypto';
import { createStandApi, EVIDENCE_MAX_DAYS, resolveStandIdentityMode } from '../server/stand-server.ts';
import { runJob, runPendingJobs } from './run-jobs.ts';

/**
 * Интерфейс на мирах стенда (хранилище в памяти): вход через токен поставщика identity [Р-78] (на стенде — имитатор),
 * роли из членств при каждом запросе, права администратора и менеджера цен [OQ-129], журнал аудита остановок с автором —
 * пользователем токена [Р-76, находка 4], NO_OP без слепка [Р-74], тексты DE/EN [Р-72]. Экраны рендерятся теми же компонентами.
 */

const WORLDS = [
  'kaufland/pipeline/happy-path', 'kaufland/pipeline/above-max-price', 'kaufland/pipeline/fx-usd-floor-eur-cost', 'kaufland/pipeline/mass-shift-halt',
  'kaufland/pipeline/enable-margin-without-cost', 'kaufland/pipeline/kill-switch-tenant-stop',
  // Шаг 23: мир Amazon — недоверие каналу, Automate Pricing, PRICING_HEALTH
  'amazon/pipeline/console-channel-trust',
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

/**
 * Р-139 (шаг 30): массовая операция отвечает ЗАДАНИЕМ, а не итогом. Тест выполняет его тем же обработчиком, которым занят
 * фоновый процесс, и смотрит на итог глазами экрана хода.
 */
const liveOf = (worldId: string) => worlds.find((w) => w.id === worldId)!;
const finishJob = (worldId: string, response: { status: number; body: unknown }, locale: 'de' | 'en' = 'de') => {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return runJob(liveOf(worldId), (response.body as JobCreatedResponse).jobId, locale);
};

/**
 * OQ-201 (шаг 30): предпросмотр стратегии — тоже задание: решение считается по каждому выбранному предложению. Экран берёт
 * готовый ответ из итога задания, а сохранение сверяется с ЭТИМ заданием — поэтому тест держит и то, и другое.
 */
async function previewOf(auth: Auth, worldId: string, body: Record<string, unknown>): Promise<{ jobId: string; view: StrategyPreviewView }> {
  const created = await call(auth, 'POST', api(worldId, 'strategies', 'preview'), body);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const jobId = (created.body as JobCreatedResponse).jobId;
  const job = await runJob(liveOf(worldId), jobId, 'en');
  assert.equal(job.status, 'SUCCEEDED', job.error ?? job.headline);
  return { jobId, view: (job.result as { view: StrategyPreviewView }).view };
}

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
  // OQ-204: `every` истинно на пустом списке — сперва утверждается, что списку есть что проверять
  assert.ok(list.length > 0 && list.every((w) => w.role === 'Viewer'), `миры зрителя: ${JSON.stringify(list.map((w) => w.role))}`);
  for (const locale of ['de', 'en'] as const) {
    for (const w of list) {
      const q = `?locale=${locale}`;
      await get<ProductListView>(auth, api(w.id, 'products') + q);
      for (const d of (await get<DecisionListView>(auth, api(w.id, 'decisions') + q)).items) await get<DecisionTrace>(auth, api(w.id, 'decisions', d.decisionId) + q);
      await get<RejectedView>(auth, api(w.id, 'rejected') + q);
      for (const b of (await get<BoundsIndexView>(auth, api(w.id, 'bounds') + q)).items) await get<BoundsView>(auth, api(w.id, 'bounds', b.writeScopeId) + q);
      await get<StrategyListView>(auth, api(w.id, 'strategies') + q);
      await get<PriceFeedView>(auth, api(w.id, 'feed') + q);
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

  const decisions = (await get<DecisionListView>(auth, api(id, 'decisions'))).items;
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

  const usd = (await get<BoundsIndexView>(auth, api('kaufland/pipeline/fx-usd-floor-eur-cost', 'bounds'))).items.find((b) => b.label.includes('ATVPDKIKX0DER'))!;
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
  const stoppedRows = (await get<ProductListView>(operator, api(id, 'products'))).rows;
  assert.ok(stoppedRows.length > 0 && stoppedRows.every((r) => r.enabled.label === 'Stopped'),
    `после остановки все строки остановлены: ${JSON.stringify(stoppedRows.map((r) => r.enabled.label))}`);

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

test('Р-131, G: without the declared cost the screen shows a requirement, not a warning that can be waved away', async () => {
  const id = 'kaufland/pipeline/enable-margin-without-cost';
  const operator = await login('OPERATOR', 'de');
  // 4702 — предложение сценария, которому себестоимость так и не объявили
  const scope = (await get<ProductListView>(operator, api(id, 'products'))).rows.find((r) => r.unit.writeScopeId.endsWith('4702'))!;
  const first = (await call(operator, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: false })).body as EnableResult;
  assert.deepEqual([first.enabled, first.problems.map((p) => p.code), first.warnings.map((w) => [w.code, w.problems])],
    [false, ['COST_REQUIRED'], [['MARGIN_WITHOUT_COST', []]]]);
  assert.equal(first.warnings[0]!.text, 'Hinweis: die Strategie Zielmarge und die Mindestmarge 15 % brauchen die Einstandskosten, aber die Einstandskosten sind nicht gesetzt. Bis dahin würde jeder Preis abgelehnt.');
  const dialog = await html('/src/screens/Products.tsx', 'EnableResultView', { unit: scope.unit.label, result: first, busy: false, error: null, onAcknowledge: () => {}, onClose: () => {} }, 'de');
  assert.ok(dialog.includes(first.problems[0]!.text), first.problems[0]!.text);
  // Р-131: подтверждения нет — кнопки «всё равно включить» на экране с препятствием не существует
  assert.equal(dialog.includes('Trotzdem aktivieren'), false, dialog);
  const acknowledged = (await call(operator, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: true })).body as EnableResult;
  assert.deepEqual([acknowledged.enabled, acknowledged.problems.map((p) => p.code)], [false, ['COST_REQUIRED']], 'acknowledging a warning does not declare a cost');
  const viewer = await login('VIEWER');
  assert.equal((await call(viewer, 'POST', api(id, 'scopes', scope.unit.writeScopeId, 'enable'), { acknowledgeWarnings: true })).status, 403);
});

test('Р-134, Р-135 (шаг 28): импорт себестоимости — предпросмотр до применения, несопоставленное перечислено, применение со вторым фактором', async () => {
  const id = 'kaufland/pipeline/happy-path';
  const owner = await login('OWNER', 'de');
  const viewer = await login('VIEWER');
  const products = await get<ProductListView>(owner, api(id, 'products'));
  const unit = products.rows[0]!.unit.externalUnitId;
  // Выгрузка продавца: разделитель «;», запятая в числе, одна строка про несуществующий оффер и одна без себестоимости
  const csv = [
    'Artikelnummer;Einstandspreis;Währung;Provision %',
    `${unit};10,50;EUR;15`,
    'A-DOES-NOT-EXIST;7,00;EUR;15',
    `${unit};;EUR;15`,   // тот же оффер, но без себестоимости: строка не применяется и названа отдельно
  ].join('\n');
  const file = { fileName: 'kosten.csv', content: Buffer.from(csv, 'utf8').toString('base64') };
  assert.equal((await call(viewer, 'POST', api(id, 'cost-import', 'plan'), file)).status, 403, 'у зрителя импорта нет');
  const planned = await call(owner, 'POST', api(id, 'cost-import', 'plan'), file);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const view = planned.body as CostImportView;
  // Продавец видит: как прочитан файл, какие колонки узнаны, что применится и что нет — с причиной
  assert.deepEqual([view.source.format, view.source.delimiter], ['CSV', ';']);
  assert.equal(view.summary.apply, 1);
  assert.ok(view.skipped.some((g) => g.problem === 'OFFER_NOT_FOUND' && g.examples.some((e) => e.offerKey === 'A-DOES-NOT-EXIST')));
  assert.ok(view.skipped.some((g) => g.problem === 'COST_MISSING'));
  // Ревью шага 28, находка 15: «больше либо равно нулю» — не проверка. Значение имеет число офферов, которые после импорта
  // репрайсинг включить не смогут [Р-131], и то, что продавец видит его на экране
  assert.equal(view.stillWithoutCost, products.rows.length - view.summary.offersCovered,
    'без себестоимости остаются все офферы списка, кроме тех, чьи строки применятся [Р-131]');
  assert.equal(view.mfaRequired, true);
  // Ревью шага 28, находка 6: массовый импорт — это файл продавца, а не несколько строк. Раньше тело запроса было ограничено
  // 64 КиБ, и выгрузка больше ~2 000 строк не доходила до сервера вовсе
  const bigCsv = ['Artikelnummer;Einstandspreis;Währung;Provision %',
    ...Array.from({ length: 4000 }, (_, i) => `A-SYNTH-${i};10,50;EUR;15`)].join('\n');
  assert.ok(Buffer.from(bigCsv, 'utf8').toString('base64').length > 64 * 1024, 'файл заведомо больше прежнего предела тела запроса');
  const big = await call(owner, 'POST', api(id, 'cost-import', 'plan'),
    { fileName: 'gross.csv', content: Buffer.from(bigCsv, 'utf8').toString('base64') });
  assert.equal(big.status, 200, 'выгрузка в сотни килобайт доходит до сервера');
  assert.equal((big.body as CostImportView).summary.skipped, 4000, 'все её строки разобраны и перечислены с причиной');

  // Ревью шага 28, находка 8: подсказку можно исправить — выбор продавца сильнее, и предпросмотр строится заново
  const wrongColumn = await call(owner, 'POST', api(id, 'cost-import', 'plan'), { ...file, mapping: { unitCostMinor: 2 } });
  assert.equal(wrongColumn.status, 200);
  const wrongView = wrongColumn.body as CostImportView;
  assert.equal(wrongView.summary.apply, 0, 'колонка валюты вместо себестоимости — применять нечего');
  assert.equal(wrongView.fields.find((f) => f.field === 'unitCostMinor')?.columnIndex, 2, 'экран показывает выбор продавца');
  assert.deepEqual(view.fileColumns.map((c) => c.name), ['A', 'B', 'C', 'D'], 'колонки файла названы так же, как в таблице продавца');
  const preview = await html('/src/screens/CostImport.tsx', 'CostImportPreview', { view }, 'de');
  // На экране: заголовок списка непримененных строк, правило «целиком или никак» и требование второго фактора
  for (const text of ['Zeilen, die nicht angewendet werden', 'vollständig angewendet', 'zweitem Faktor']) assert.ok(preview.includes(text), text);
  // Применение: подтверждение обязательно, отпечаток — тоже, второй фактор — тоже
  const apply = (auth: Auth, body: Record<string, unknown>) => call(auth, 'POST', api(id, 'cost-import', 'apply'), { ...file, ...body });
  assert.equal((await apply(owner, { fingerprint: view.fingerprint })).status, 400, 'без подтверждения не применяется');
  /**
   * Р-139 (находка 10 ревью шага 30): отпечаток сверяет ЗАДАНИЕ, а не запрос. Разобрать файл, чтобы его посчитать, стоит
   * столько же, сколько предпросмотр, — держать это в нажатии значило бы не перенести работу в фон, а только переименовать её.
   */
  const stale = await finishJob(id, await apply(owner, { fingerprint: 'stale', confirmed: true }));
  assert.deepEqual([stale.status, stale.error], ['FAILED', messagesFor('de').ui.jobs.errors.PLAN_CHANGED],
    'устаревший предпросмотр не применяется, и продавец читает почему');
  // Вход только паролем: второго фактора нет — импорт не применяется [Р-135]
  const passwordOnly = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd'] })}`, cookie: 'repracer_locale=de' };
  const withoutMfa = await apply(passwordOnly, { fingerprint: view.fingerprint, confirmed: true });
  assert.deepEqual([withoutMfa.status, (withoutMfa.body as { error: { code: string } }).error.code], [403, 'MFA_REQUIRED']);
  const strong = owner;
  /**
   * Р-139 (шаг 30): применение — фоновое задание. Ответ несёт идентификатор задания, а не итог; до работы исполнителя в базе
   * ничего не изменено. Это и проверяется: сначала состояние задания «ничего не изменено», потом — итог.
   */
  const created = await apply(strong, { fingerprint: view.fingerprint, confirmed: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const pending = (created.body as JobCreatedResponse).job!;
  assert.deepEqual([pending.status, pending.effect], ['PENDING', messagesFor('de').ui.jobs.effectPending],
    'до работы исполнителя задание ждёт, и экран говорит, что в базе ничего не изменено');
  const done = await finishJob(id, created);
  assert.equal(done.status, 'SUCCEEDED', done.error ?? '');
  assert.match(done.headline, /Selbstkosten von 1 Angebot importiert \(1 Zeilen/);
  assert.equal(done.effect, messagesFor('de').ui.jobs.effectApplied);
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
  assert.deepEqual([bad.status, (bad.body as { error: { code: string; message: string } }).error.message], [400, 'Threshold: an amount like 19.99 or a percentage like 12.5']);
  const { jobId: previewJobId, view } = await previewOf(viewer, id, { draft, writeScopeIds: ['ws-price-de-4101'] });
  assert.equal(view.rows.length, 1, 'зритель вправе посчитать предпросмотр');
  assert.deepEqual([view.shown.rows, view.shown.of, view.sample.text], [1, 1, null], 'OQ-201: посчитано всё выбранное, а не выборка');
  const save = (auth: Auth, previewToken: string, confirmed = true, jobId: string | null = previewJobId) =>
    call(auth, 'POST', api(id, 'strategies'), { draft, writeScopeIds: ['ws-price-de-4101'], strategyId: null, previewJobId: jobId, previewToken, confirmed });
  assert.equal((await save(viewer, view.previewToken)).status, 403);
  assert.equal((await save(owner, view.previewToken, false)).status, 400);
  assert.equal((await save(owner, 'not-the-preview')).status, 409);
  assert.equal((await save(owner, view.previewToken, true, null)).status, 409, 'без предпросмотра сохранения нет');
  // Р-139 (шаг 30): сохранение с назначением — фоновое задание; токен предпросмотра сверяет сервер ДО его создания
  const saved = await finishJob(id, await save(owner, view.previewToken), 'en');
  assert.deepEqual([saved.status, saved.headline], ['SUCCEEDED', 'Done: version 1 assigned to 1 offer.']);
  // Находка 4 ревью шага 21: то же превью после сохранения устарело — стратегия единицы уже другая
  assert.equal((await save(owner, view.previewToken)).status, 409, 'finding 4: a preview older than the strategy of the offer is not saved');
  // Находка 3 ревью шага 21 [Р-39]: Kaufland не даёт полного списка предложений — «ниже всех на рынке» не назначается
  const market = { name: 'Synthetic market lowest', params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 };
  const marketPreview = await previewOf(owner, id, { draft: market, writeScopeIds: ['ws-price-de-4101'] });
  assert.ok(marketPreview.view.rows[0]!.unavailable, 'the preview shows the strategy as unavailable');
  const refused = await call(owner, 'POST', api(id, 'strategies'), { draft: market, writeScopeIds: ['ws-price-de-4101'], strategyId: null, previewJobId: marketPreview.jobId, previewToken: marketPreview.view.previewToken, confirmed: true });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'STRATEGY_UNAVAILABLE'], 'finding 3: an unavailable strategy is not saved');
  const html1 = await html('/src/screens/Strategies.tsx', 'PreviewTable', { view });
  assert.ok(html1.includes('snapshot of '));

  // Правка границ: экран различий → применение; без экрана и с устаревшим токеном — отказ
  const request = { writeScopeIds: ['ws-price-de-4101'], min: { kind: 'SET', minor: 1600 } };
  assert.equal((await call(viewer, 'POST', api(id, 'bounds', 'plan'), { request })).status, 403);
  /**
   * Задача D шага 31: экран различий — тоже задание, и применение ССЫЛАЕТСЯ на него, а не пересылает запрос. Применяется ровно
   * то, что посчитано и показано, и считается это один раз, а не дважды.
   */
  const planJob = await finishJob(id, await call(owner, 'POST', api(id, 'bounds', 'plan'), { request }));
  assert.equal(planJob.status, 'SUCCEEDED', planJob.error ?? '');
  const diff = (planJob.result as { view: BoundsDiffView }).view;
  assert.deepEqual([diff.rows[0]!.minBefore, diff.rows[0]!.minAfter, diff.mfaRequired], ['€15.00', '€16.00', false]);
  const applyBody = (over: Record<string, unknown> = {}) => ({ planJobId: planJob.jobId, planToken: diff.planToken, confirmed: true, ...over });
  assert.equal((await call(owner, 'POST', api(id, 'bounds', 'apply'), applyBody({ planToken: 'stale' }))).status, 409,
    'устаревший токен экрана различий ловит запрос: сверка с посчитанным заданием дёшева');
  assert.equal((await call(owner, 'POST', api(id, 'bounds', 'apply'), applyBody({ planJobId: null }))).status, 409, 'без экрана различий применения нет');
  const applied = await finishJob(id, await call(owner, 'POST', api(id, 'bounds', 'apply'), applyBody()), 'en');
  assert.deepEqual([applied.status, applied.headline], ['SUCCEEDED', 'Done: bounds checked for 1 offer, 1 changed.']);
  // Тот же экран различий после применения устарел: границы предложения уже другие, и хранилище отвечает CONFLICT
  const afterApply = await finishJob(id, await call(owner, 'POST', api(id, 'bounds', 'apply'), applyBody()));
  assert.equal(afterApply.status, 'FAILED', 'the difference screen is stale after applying');
  const diffHtml = await html('/src/screens/BoundsEdit.tsx', 'BoundsDiffTable', { view: diff }, 'de');
  assert.ok(diffHtml.includes('€15.00') && diffHtml.includes('min vorher'), 'amounts come from the server in the session language, labels from the dictionary of the page');

  const multi = 'kaufland/pipeline/fx-usd-floor-eur-cost';
  const mass = { writeScopeIds: (await get<BoundsIndexView>(owner, api(multi, 'bounds'))).items.map((i) => i.writeScopeId), min: { kind: 'PERCENT', bp: -500 } };
  const massPlanJob = await finishJob(multi, await call(owner, 'POST', api(multi, 'bounds', 'plan'), { request: mass }));
  const massPlan = (massPlanJob.result as { view: BoundsDiffView }).view;
  assert.equal(massPlan.mfaRequired, true);
  const massBody = { planJobId: massPlanJob.jobId, planToken: massPlan.planToken, confirmed: true };
  // Токен имитатора по умолчанию несёт второй фактор (pwd + otp); вход только паролем — без него
  const passwordOnly = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd'] })}`, cookie: 'repracer_locale=en' };
  const noMfa = await call(passwordOnly, 'POST', api(multi, 'bounds', 'apply'), massBody);
  assert.equal(noMfa.status, 403, JSON.stringify(noMfa.body));
  assert.equal((noMfa.body as { error: { code: string } }).error.code, 'MFA_REQUIRED');
  const withMfa = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd', 'otp'] })}`, cookie: 'repracer_locale=en' };
  const massJob = await finishJob(multi, await call(withMfa, 'POST', api(multi, 'bounds', 'apply'), massBody), 'en');
  // Р-135, Р-139: второй фактор предъявлен при СОЗДАНИИ задания — стражи массового изменения принимают его у применяющего процесса
  assert.equal(massJob.status, 'SUCCEEDED', massJob.error ?? '');

  /**
   * Р-144 (шаг 31): рутинная операция не наследует требования массовой. Тот же вход без второго фактора правит ОДНО
   * предложение — и это проходит: второго фактора эта правка не требовала и до фоновых заданий.
   */
  const onePlan = await finishJob(multi, await call(passwordOnly, 'POST', api(multi, 'bounds', 'plan'),
    { request: { writeScopeIds: [mass.writeScopeIds[0]], min: { kind: 'PERCENT', bp: -100 } } }), 'en');
  const oneApply = await call(passwordOnly, 'POST', api(multi, 'bounds', 'apply'),
    { planJobId: onePlan.jobId, planToken: (onePlan.result as { view: BoundsDiffView }).view.planToken, confirmed: true });
  assert.equal(oneApply.status, 200, `правка одного предложения второго фактора не требует: ${JSON.stringify(oneApply.body)}`);
  assert.equal((await finishJob(multi, oneApply, 'en')).status, 'SUCCEEDED');
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

test('step 23, B/C: the stop screen shows three kinds of stop; a channel distrust is released only by an owner or admin with a second factor and a note', async () => {
  const id = 'amazon/pipeline/console-channel-trust';
  const owner = await login('OWNER');
  const operator = await login('OPERATOR');
  const view = await get<StopView>(owner, api(id, 'stop'));
  assert.deepEqual(view.kinds.map((k) => [k.kind, k.active]), [['HUMAN', 0], ['SYSTEM_HALT', 0], ['CHANNEL_DISTRUST', 1]]);
  assert.equal(view.distrusts.active.length, 1);
  assert.equal(view.permissions.canReleaseDistrust, true);
  assert.equal((await get<StopView>(operator, api(id, 'stop'))).permissions.canReleaseDistrust, false, 'an operator may stop pricing but not trust the channel again');
  const card = view.distrusts.active[0]!;
  assert.match(card.holds, /all prices, including fixed and margin prices/);
  const markup = await html('/src/screens/Stop.tsx', 'StopScreenView', { view, onReleaseDistrust: () => {} });
  for (const text of ['Three kinds of stop', 'Channel distrust (Р-118)', 'Channel distrusted by the system', 'Trust again…', 'wrong price basis']) assert.ok(markup.includes(text), text);

  const products = await get<ProductListView>(owner, api(id, 'products'));
  const row = (sku: string) => products.rows.find((r) => r.unit.externalUnitId === sku)!;
  assert.equal(row('SYN-SKU-8501').enabled.label, 'Held: channel distrusted');
  assert.deepEqual(row('SYN-SKU-8502').channelNotes.map((n) => n.code), ['AUTOMATED_PRICING']);
  assert.deepEqual(row('SYN-SKU-8501').channelNotes.map((n) => [n.code, n.label]), [['PRICING_HEALTH', 'Channel: BuyBoxDisqualification']]);
  assert.match(row('SYN-SKU-8501').channelNotes[0]!.detail, /competitive price threshold of the channel €19\.49/);

  const release = (auth: Auth, body: unknown) => call(auth, 'POST', api(id, 'distrusts', card.distrustId, 'release'), body);
  const note = 'Price basis checked in the synthetic channel account';
  assert.equal((await release(operator, { note, confirmed: true })).status, 403);
  const passwordOnly = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd'] })}`, cookie: 'repracer_locale=en' };
  const noMfa = await release(passwordOnly, { note, confirmed: true });
  assert.deepEqual([noMfa.status, (noMfa.body as { error: { code: string } }).error.code], [403, 'MFA_REQUIRED']);
  assert.equal((await release(owner, { note: 'short', confirmed: true })).status, 400);
  assert.equal((await release(owner, { note, confirmed: false })).status, 400);
  const released = await release(owner, { note, confirmed: true });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const after = (released.body as { stop: StopView }).stop;
  assert.deepEqual([after.distrusts.active.length, after.distrusts.history.length, after.kinds[2]!.active], [0, 1, 0]);
  assert.deepEqual(after.audit.slice(0, 1).map((a) => [a.action, a.actor, a.note]), [['Distrust of the channel released', 'Owner (you)', note]]);
  assert.equal((await release(owner, { note, confirmed: true })).status, 404, 'released twice');
});

test('step 23, C/F: offers the channel prices itself are listed before a strategy; saving is blocked on screen and refused by the store', async () => {
  const id = 'amazon/pipeline/console-channel-trust';
  const owner = await login('OWNER');
  const list = await get<StrategyListView>(owner, api(id, 'strategies'));
  assert.deepEqual(list.channelPricingOffers.map((o) => o.label), ['Amazon A1PA6795UKMFR9 · unit SYN-SKU-8502']);
  assert.deepEqual(list.scopes.filter((s) => !s.assignable).map((s) => s.unit.externalUnitId), ['SYN-SKU-8502']);
  assert.ok(list.strategies.length >= 1 && list.strategies.every((s) => s.draft.params.type === 'FIXED'));
  assert.ok(list.strategies.length > 0 && list.strategies.every((x) => x.versions.length >= 1), 'OQ-170: every strategy lists its versions');

  const ws = list.scopes.find((s) => s.unit.externalUnitId === 'SYN-SKU-8502')!.unit.writeScopeId;
  const draft = { name: 'Synthetic fixed', params: { type: 'FIXED', priceMinor: 2050 }, deadbandMinor: 0 };
  const preview = await previewOf(owner, id, { draft, writeScopeIds: [ws] });
  assert.match(preview.view.saveBlocked ?? '', /the channel prices these offers itself/);
  const refused = await call(owner, 'POST', api(id, 'strategies'), { draft, writeScopeIds: [ws], strategyId: null, previewJobId: preview.jobId, previewToken: preview.view.previewToken, confirmed: true });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'CHANNEL_PRICING_ACTIVE']);

  const screen = await html('/src/screens/Strategies.tsx', 'StrategiesScreenView', { view: list, worldId: id, initialPreview: preview.view });
  for (const text of ['Offers the channel prices itself', 'cannot be assigned', 'New version…', 'Cannot be saved: the channel prices these offers itself']) assert.ok(screen.includes(text), text);
  assert.match(screen, /<button type="button" class="danger" disabled="">Save and assign…<\/button>/, 'the save button is disabled while the preview is blocked');
  const deScreen = await html('/src/screens/Strategies.tsx', 'StrategiesScreenView', { view: await get<StrategyListView>(await login('OWNER', 'de'), api(id, 'strategies')), worldId: id }, 'de');
  assert.ok(deScreen.includes('Angebote, die der Kanal selbst bepreist'));
});

test('step 23, F: bounds edit is offered only with the right; the feed filters and pages on the server', async () => {
  const id = 'kaufland/pipeline/fx-usd-floor-eur-cost';
  const owner = await login('OWNER');
  const viewer = await login('VIEWER');
  const index = await get<BoundsIndexView>(owner, api(id, 'bounds'));
  assert.equal(index.canEdit, true);
  const viewerIndex = await get<BoundsIndexView>(viewer, api(id, 'bounds'));
  assert.equal(viewerIndex.canEdit, false);
  const noRight = await html('/src/screens/BoundsEdit.tsx', 'BoundsEditPanel', { worldId: id, items: viewerIndex.items, total: viewerIndex.page.total, canEdit: false });
  assert.ok(noRight.includes('Your role may view bounds but not change them.') && !noRight.includes('Show the differences'));
  const panel = await html('/src/screens/BoundsEdit.tsx', 'BoundsEditPanel', { worldId: id, items: index.items, total: index.page.total, canEdit: true });
  for (const text of ['set to (amount)', 'change by (%)']) assert.ok(panel.includes(text), text);
  /**
   * Р-140 (шаг 30): «всё» — это весь каталог, а не показанная страница; выбор названного числа виден всегда, а листание его
   * сбрасывает. Проверяется то, что читает продавец: страница названа страницей, каталог — каталогом, и оба числа настоящие.
   */
  assert.ok(panel.includes(`All ${index.page.total} offers of the catalogue — including those on other pages`), 'каталог назван каталогом');
  assert.ok(panel.includes(`Select the ${index.items.length} on this page`), 'страница названа страницей, с её числом');
  assert.ok(panel.includes('Nothing selected'), 'ничего не выбрано — сказано прямо, а не пустотой');
  assert.ok(panel.includes('Paging or changing the filter clears the selection of individual rows.'), 'сброс выбора при листании назван до того, как он случится');
  assert.ok(!/>Select all</.test(panel), 'кнопки «выбрать всё», означающей страницу, на экране больше нет');

  const feedId = 'kaufland/pipeline/happy-path';
  const all = await get<PriceFeedView>(viewer, api(feedId, 'feed'));
  assert.ok(all.page.total >= 1);
  const applied = await get<PriceFeedView>(viewer, `${api(feedId, 'feed')}?status=APPLIED`);
  assert.ok(applied.items.length > 0 && applied.items.every((i) => i.status === 'Applied'), JSON.stringify(applied.items.map((i) => i.status)));
  assert.deepEqual(applied.counts, all.counts, 'counts are per group, not per status filter');
  const one = await get<PriceFeedView>(viewer, `${api(feedId, 'feed')}?limit=1`);
  assert.deepEqual([one.items.length, one.page.from, one.page.to, one.page.total, one.page.hasNext], [1, 1, 1, all.page.total, all.page.total > 1]);
  for (const bad of ['status=ALL', 'days=5', 'limit=0', 'limit=201', 'offset=-1', 'writeScopeId=ws-unknown']) {
    assert.equal((await call(viewer, 'GET', `${api(feedId, 'feed')}?${bad}`)).status, 400, bad);
  }
  const markup = await html('/src/screens/Feed.tsx', 'FeedScreenView', { view: one, onQuery: () => {} });
  for (const text of ['Status', 'last 7 days', 'Older →', `1–1 of ${all.page.total}`]) assert.ok(markup.includes(text), text);
});

test('step 24, OQ-169/170: an existing strategy version is assigned without a new version after its preview; a strategy is removed only with repricing off; versions show author and status', async () => {
  const owner = await login('OWNER');
  const viewer = await login('VIEWER');
  const id = 'kaufland/pipeline/fx-usd-floor-eur-cost';
  const list = await get<StrategyListView>(owner, api(id, 'strategies'));
  const original = list.strategies.find((x) => x.assignable)!;
  const target = list.scopes.find((x) => x.assignable && x.strategyId === original.strategyId)!;
  assert.ok(original && target);

  // OQ-170: новая версия, сохранённая человеком, показывает автора и статус
  const draft = { name: 'Synthetic author check', params: { type: 'FIXED', priceMinor: 2100 }, deadbandMinor: 0 };
  const p1 = await previewOf(owner, id, { draft, writeScopeIds: [target.unit.writeScopeId] });
  // Р-139 (шаг 30): сохранение и назначение идут заданием, поэтому список стратегий читается заново после его работы
  const savedJob = await finishJob(id, await call(owner, 'POST', api(id, 'strategies'), { draft, writeScopeIds: [target.unit.writeScopeId], strategyId: null, previewJobId: p1.jobId, previewToken: p1.view.previewToken, confirmed: true }), 'en');
  assert.equal(savedJob.status, 'SUCCEEDED', savedJob.error ?? '');
  const afterSave = await get<StrategyListView>(owner, api(id, 'strategies'));
  const created = afterSave.strategies.find((x) => x.name === 'Synthetic author check')!;
  assert.deepEqual(created.versions.map((v) => [v.version, v.status, v.author]), [[1, 'active', 'Owner (you)']]);
  const markup = await html('/src/screens/Strategies.tsx', 'StrategiesScreenView', { view: afterSave, worldId: id });
  for (const text of ['Assign this version…', 'Versions: v1 · active · Owner (you)']) assert.ok(markup.includes(text), text);

  // OQ-169: прежняя версия возвращается офферу без новой версии — после превью её параметров
  const item = afterSave.strategies.find((x) => x.strategyId === original.strategyId)!;
  const preview = await previewOf(owner, id, { draft: item.draft, writeScopeIds: [target.unit.writeScopeId] });
  const body = { strategyId: item.strategyId, version: item.version, writeScopeIds: [target.unit.writeScopeId], previewJobId: preview.jobId, previewToken: preview.view.previewToken, confirmed: true };
  assert.equal((await call(viewer, 'POST', api(id, 'strategies', 'assign'), body)).status, 403);
  assert.equal((await call(owner, 'POST', api(id, 'strategies', 'assign'), { ...body, previewToken: 'stale' })).status, 409);
  const assigned = await finishJob(id, await call(owner, 'POST', api(id, 'strategies', 'assign'), body), 'en');
  assert.deepEqual([assigned.status, assigned.headline], ['SUCCEEDED', `Done: version ${item.version} assigned to 1 offer.`]);
  const after = await get<StrategyListView>(owner, api(id, 'strategies'));
  const scopeAfter = after.scopes.find((x) => x.unit.writeScopeId === target.unit.writeScopeId)!;
  assert.deepEqual([scopeAfter.strategyId, scopeAfter.version], [item.strategyId, item.version]);
  assert.equal(after.strategies.find((x) => x.strategyId === item.strategyId)?.version, item.version, 'no new version was created');

  // Снять стратегию при включённом репрайсинге нельзя; при выключенном — можно
  const refused = await call(owner, 'POST', api(id, 'strategies', 'unassign'), { writeScopeIds: [target.unit.writeScopeId], confirmed: true });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'REPRICING_ENABLED'], JSON.stringify(refused.body));
  // Продавец выключил репрайсинг оффера (подготовка мира: выключение — действие хранилища), затем стратегия снимается
  const live = worlds.find((w) => w.id === id)!;
  await live.store.setPricingMode(live.tenantId, target.unit.writeScopeId, 'OFF', account('OWNER').userAlias);
  const offList = await get<StrategyListView>(owner, api(id, 'strategies'));
  assert.equal(offList.scopes.find((x) => x.unit.writeScopeId === target.unit.writeScopeId)?.canUnassign, true);
  assert.equal((await call(viewer, 'POST', api(id, 'strategies', 'unassign'), { writeScopeIds: [target.unit.writeScopeId], confirmed: true })).status, 403);
  const removed = await call(owner, 'POST', api(id, 'strategies', 'unassign'), { writeScopeIds: [target.unit.writeScopeId], confirmed: true });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((removed.body as { strategies: StrategyListView }).strategies.scopes.find((x) => x.unit.writeScopeId === target.unit.writeScopeId)?.strategyId, null);
});

test('step 24, Р-123: a discount is checked before it is announced; a prior price above the 30-day lowest is refused; announced discounts are rechecked; the price evidence is a CSV with its checksum', async () => {
  const owner = await login('OWNER');
  const viewer = await login('VIEWER');
  const id = 'kaufland/pipeline/happy-path';
  const live = worlds.find((w) => w.id === id)!;
  const view = await get<ComplianceView>(owner, api(id, 'compliance'));
  assert.deepEqual([view.rows.length, view.canAnnounce, view.cannotCheck.length > 0], [0, true, true]);
  // Р-124 (шаг 25): модуль не гарантирует соответствие; у каждого оффера — глубина видимой истории
  assert.match(view.notAGuarantee, /^This module does not guarantee compliance\./);
  assert.equal(view.depth.length, view.offers.length);
  for (const d of view.depth) assert.match(d.depth.seen, /^We see (\d+ days? of price history for this offer \(since .+\)|no price history for this offer)\.$/);
  const scope = view.offers[0]!;
  const startsAt = new Date(Date.parse(live.clock.iso()) + 86_400_000).toISOString();
  const prior = await live.store.omnibusCheck(live.tenantId, scope.writeScopeId, startsAt);
  assert.ok(prior.lowestMinor !== null, 'the stand world has a price of ours before the discount');
  const lowest = prior.lowestMinor!;
  const discount = { writeScopeId: scope.writeScopeId, referencePriceMinor: lowest + 1, salePriceMinor: lowest - 100, startsAt, endsAt: null };

  // Предупреждение до записи: просмотр вправе проверить, но не объявить
  const warned = await call(viewer, 'POST', api(id, 'compliance', 'check'), discount);
  assert.equal(warned.status, 200, JSON.stringify(warned.body));
  const check = warned.body as DiscountCheckView;
  assert.deepEqual([check.verdict, check.tone, check.canAnnounce], ['VIOLATION', 'stop', false]);
  assert.match(check.headline, /^This discount breaks the rule: the stated prior price .+ is above the lowest price .+ of the last 30 days\.$/);
  assert.match(check.depth.seen, /^We see \d+ days? of price history for this offer \(since .+\)\.$/);
  // Скидка завтра — окно не завершено: проверка неполная, с причиной
  assert.deepEqual([check.depth.complete, check.depth.reliability], [false, 'The check is incomplete: the discount starts later, prices until then are not known yet.']);
  assert.equal(check.depth.limit, 'Prices set in the channel back office or by another tool that our reconciliation did not notice are not visible.');
  assert.equal((await call(viewer, 'POST', api(id, 'compliance', 'announce'), { ...discount, confirmed: true })).status, 403);
  assert.equal((await call(owner, 'POST', api(id, 'compliance', 'announce'), discount)).status, 400, 'not confirmed');
  const refused = await call(owner, 'POST', api(id, 'compliance', 'announce'), { ...discount, confirmed: true });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'OMNIBUS_VIOLATION']);
  assert.equal((await call(owner, 'POST', api(id, 'compliance', 'check'), { ...discount, referencePriceMinor: 'x' })).status, 400);

  // На наименьшей цене окна — объявляется; проверка хранится, отчёт проверяет заново
  const fair = { ...discount, referencePriceMinor: lowest };
  const okCheck = (await call(owner, 'POST', api(id, 'compliance', 'check'), fair)).body as DiscountCheckView;
  assert.notEqual(okCheck.verdict, 'VIOLATION');
  assert.equal(okCheck.canAnnounce, true);
  const announced = await call(owner, 'POST', api(id, 'compliance', 'announce'), { ...fair, confirmed: true });
  assert.equal(announced.status, 200, JSON.stringify(announced.body));
  const report = (announced.body as DiscountAnnounceResponse).compliance;
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]!.atAnnouncement.verdict, okCheck.verdict);
  assert.equal(report.rows[0]!.now.verdict, okCheck.verdict);
  assert.equal(report.counts.VIOLATION, 0);

  // Доказательная история: CSV с контрольной суммой; неверный период — 400
  const day = (iso: string) => iso.slice(0, 10);
  const from = day(new Date(Date.parse(live.clock.iso()) - 30 * 86_400_000).toISOString());
  const to = day(startsAt);
  /**
   * OQ-202, Р-139 (шаг 30): выгрузка — фоновое задание. Файл лежит в базе и скачивается отдельным запросом; в ответе экрана его
   * нет вовсе. Предела строк больше нет: каталог целиком выгружается тем же заданием.
   */
  const evidenceJob = (auth: Auth, body: Record<string, unknown>) => call(auth, 'POST', api(id, 'compliance', 'evidence'), body);
  const evidence = await finishJob(id, await evidenceJob(viewer, { from, to, writeScopeId: scope.writeScopeId }), 'en');
  assert.equal(evidence.status, 'SUCCEEDED', evidence.error ?? '');
  assert.ok(evidence.artifact!.rows > 0, 'the evidence has storefront days');
  const file = await call(viewer, 'GET', api(id, 'jobs', evidence.jobId, 'artifact'));
  assert.equal(file.status, 200);
  const csv = (file.file as { content: string }).content;
  assert.equal(csv.split('\n')[0], 'channel,marketplace,offer,day,time_zone,currency,price_basis,min_price,max_price,first_price,last_price,changes,source,corrected,correction_reason');
  // Ревью тавтологий (шаг 29): «сумма равна сумме того же тела» верно всегда. Значение имеет, что сумма СЧИТАЕТСЯ ПО СОДЕРЖИМОМУ:
  // другой период — другая выгрузка и другая сумма; тот же запрос — та же сумма
  assert.equal(evidence.artifact!.sha256, createHash('sha256').update(csv).digest('hex'));
  const again = await finishJob(id, await evidenceJob(owner, { from, to }), 'en');
  assert.equal(again.artifact!.sha256, evidence.artifact!.sha256, 'тот же период — та же сумма');
  // Период без истории: выгрузка другая (только заголовок) — значит сумма считается по содержимому, а не по запросу
  const empty = await finishJob(id, await evidenceJob(owner, { from: '2019-01-01', to: '2019-01-31' }), 'en');
  assert.equal(empty.artifact!.rows, 0, 'в этом периоде истории нет');
  assert.notEqual(empty.artifact!.sha256, evidence.artifact!.sha256, 'другая выгрузка — другая сумма');
  assert.equal((await evidenceJob(owner, { from: to, to: from })).status, 400);
  assert.equal((await evidenceJob(owner, { from: '2020-01-01', to: '2026-01-01' })).status, 400, `longer than ${EVIDENCE_MAX_DAYS} days`);
  // Находка 11 ревью шага 24: несуществующая дата — 400, а не ошибка базы; изменяющие маршруты — только POST
  assert.equal((await evidenceJob(owner, { from: '2026-13-01', to: '2026-13-02' })).status, 400);
  assert.equal((await evidenceJob(owner, { from: '2026-02-30', to: '2026-03-01' })).status, 400);
  assert.equal((await call(owner, 'PUT' as 'POST', api(id, 'compliance', 'announce'), { ...fair, confirmed: true })).status, 405);
  // Находка 1: объявление задним числом отклоняется
  const past = await call(owner, 'POST', api(id, 'compliance', 'announce'), { ...fair, startsAt: new Date(Date.parse(live.clock.iso()) - 5 * 86_400_000).toISOString(), confirmed: true });
  assert.deepEqual([past.status, (past.body as { error: { code: string } }).error.code], [400, 'STARTS_BEFORE_TODAY']);

  // Экран на обоих языках
  const en = await html('/src/screens/Compliance.tsx', 'ComplianceScreenView', { worldId: id, initial: report });
  for (const text of ['Omnibus: prior price of a discount', 'Announced discounts', 'What this module cannot check', 'Download CSV', 'This module does not guarantee compliance', 'How much price history we see', 'We see ']) assert.ok(en.includes(text), text);
  const de = await html('/src/screens/Compliance.tsx', 'ComplianceScreenView', { worldId: id, initial: await get<ComplianceView>(await login('OWNER', 'de'), api(id, 'compliance')) }, 'de');
  for (const text of ['Omnibus: vorheriger Preis eines Rabatts', 'Angekündigte Rabatte', 'Was dieses Modul nicht prüfen kann', 'Dieses Modul garantiert keine Rechtskonformität', 'Wir sehen ']) assert.ok(de.includes(text), text);
});

/**
 * Р-142 (шаг 31): ссылка в консоли НЕ МОЖЕТ вести на адрес API. Браузер по ссылке не шлёт заголовок `Authorization`, а токен
 * поставщика живёт только в памяти страницы [Р-78] — продавец получит 401 вместо файла. Ровно это и случилось с доказательством
 * Omnibus на шаге 30: OQ-202 объявили закрытым, а скачать было нельзя.
 *
 * Проверка структурная и потому дешёвая: она смотрит на ИСХОДНЫЙ ТЕКСТ экранов, а не на поведение одной кнопки, — и поймает
 * следующую такую ссылку до того, как её увидит продавец.
 */
test('Р-142: ни один экран консоли не ведёт ссылкой на адрес API — браузер по ссылке токен не шлёт', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/screens/', import.meta.url);
  const files = ['../src/App.tsx', '../src/components.tsx', ...readdirSync(dir).map((f) => `../src/screens/${f}`)];
  /**
   * Что именно запрещено: отдать браузеру адрес API так, чтобы он пошёл туда САМ, — ссылкой, ресурсом, новой вкладкой или
   * сменой адреса страницы. Во всех этих случаях заголовка `Authorization` не будет. Правило смотрит на текст экрана целиком,
   * а не построчно: атрибут JSX переносится на следующую строку так же легко, как остаётся на одной (находка 10 ревью шага 31).
   */
  const NAVIGATION = /(?:href|src|action)\s*=|window\.open\s*\(|location\s*\.\s*(?:href|assign|replace)\s*[=(]/g;
  const API_TARGET = /^[^;\n]{0,200}?(?:'\/api\/|"\/api\/|`\/api\/|worldPath\s*\()/;
  const linksToApi = (text: string) => [...text.matchAll(NAVIGATION)].some((hit) => API_TARGET.test(text.slice(hit.index + hit[0].length)));
  // У правила должны быть зубы: то, что оно ищет, оно обязано находить — иначе оно зеленеет на чём угодно [Р-94]
  for (const bad of [
    `<a href={\`${'$'}{worldPath(worldId, 'jobs', jobId)}/artifact\`} download>x</a>`,
    `window.open(worldPath(worldId, 'jobs', jobId) + '/artifact')`,
    `location.href = '/api/worlds/x/jobs';`,
    `<a\n  href={worldPath(worldId, 'jobs')}\n>x</a>`,
  ]) assert.equal(linksToApi(bad), true, `правило обязано ловить: ${bad.slice(0, 60)}`);
  for (const fine of [
    `<a href={href(world.id, 'products')}>{w.title}</a>`,
    `void downloadFile(\`${'$'}{worldPath(worldId, 'jobs', jobId)}/artifact\`, name, m.locale)`,
  ]) assert.equal(linksToApi(fine), false, `правило не должно ловить: ${fine.slice(0, 60)}`);

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    if (linksToApi(text)) offenders.push(file.split('/').pop()!);
  }
  assert.deepEqual(offenders, [], 'ссылка на API в консоли: браузер пойдёт по ней без токена и получит 401, а не файл');
});

/**
 * Р-145 (шаг 32): выгрузка файла имеет ОДИН путь. Строки превращает в файл, режет его на части, считает контрольную сумму,
 * приводит имя к безопасному виду и кладёт в базу только исполнитель заданий (`packages/bulk-jobs/src/index.ts`).
 *
 * Правило нужно потому, что обратное уже случилось: шаг 31 починил сборку файла для доказательства Omnibus — и в том же шаге
 * новый обработчик выгрузки ленты собрал файл заново, синхронно и квадратично (находка 1 ревью шага 31). Когда два
 * обработчика решают одну задачу по-своему, второй решает её хуже. Тип это уже запрещает — хранилище выгрузки обработчику не
 * видно, — а правило ловит обход типа приведением и сборку файла где угодно ещё.
 */
test('Р-145: файл собирается ровно в одном месте — обработчик отдаёт строки, а не байты', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  /** Единственное место, которому это можно: исполнитель заданий. Всё остальное — нарушители */
  const THE_ONE_PATH = 'packages/bulk-jobs/src/index.ts';
  /**
   * Что запрещено: положить файл задания в базу, превратить строки в CSV и посчитать контрольную сумму файла. Вместе это и
   * есть «собрать выгрузку»; порознь любое из трёх означает, что рядом растёт второй путь.
   */
  const BUILDS_A_FILE = /\.\s*saveBulkJobArtifact\s*\(|(?<!function\s)\bcsvOf\s*\(/;
  // У правила должны быть зубы [Р-94]: оно обязано находить ровно тот код, который шаг 32 из обработчиков и убрал
  for (const bad of [
    `await ctx.store.saveBulkJobArtifact(ctx.tenantId, ctx.jobId, { fileName, content: csv });`,
    `const csv = await buildCsvInChunks(rows, (chunk) => csvOf(PRICE_FEED_CSV_HEADER, chunk), progress, total);`,
  ]) assert.match(bad, BUILDS_A_FILE, `правило обязано ловить: ${bad.slice(0, 60)}`);
  /**
   * Чего правило ловить не должно: ОБЪЯВИТЬ выгрузку — не значит собрать файл. Хранилище обязано уметь класть файл, а
   * отрисовщик — существовать; запрещено ЗВАТЬ их мимо единственного пути.
   */
  for (const fine of [
    `return { ...await produce({ fileName, header: PRICE_FEED_CSV_HEADER, rows }) };`,
    `export function priceFeedRowsOf(world: StandWorld, m: Messages, query: FeedQuery): string[][] {`,
    `export function csvOf(header: readonly string[], rows: readonly (readonly string[])[]): string {`,
    `async saveBulkJobArtifact(tenantId: string, jobId: string, artifact: BulkJobArtifact): Promise<void> {`,
  ]) assert.doesNotMatch(fine, BUILDS_A_FILE, `правило не должно ловить: ${fine.slice(0, 60)}`);

  const root = new URL('../../../', import.meta.url);
  const sources: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const child = `${rel}${name}`;
      if (statSync(new URL(child, root)).isDirectory()) walk(`${child}/`);
      // Тесты собирают файл, чтобы проверить его содержимое, — это чтение проверяемого, а не второй путь выгрузки
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(child);
    }
  };
  // Находка 8 ревью шага 32: правило обещало «весь код», а смотрело три каталога из шести
  for (const dir of ['packages/', 'apps/', 'services/', 'tests/', 'scripts/', 'deploy/']) walk(dir);
  assert.ok(sources.length > 100, `правило обязано смотреть на весь код, а не на пустой список: ${sources.length}`);

  const offenders = sources.filter((f) => f !== THE_ONE_PATH && BUILDS_A_FILE.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(offenders, [], 'второй путь сборки файла: он разойдётся с первым, и исправление одного не дойдёт до другого [Р-145]');
  // И сам единственный путь существует: правило, которому нечего охранять, зеленеет на пустом месте
  assert.match(readFileSync(new URL(THE_ONE_PATH, root), 'utf8'), BUILDS_A_FILE, 'единственный путь выгрузки на месте');
});

/**
 * Р-146 (шаг 32): правила, выросшие из находок ревью шагов 29–31. Находку закрывает не только исправление — иначе следующий
 * экран и следующий обработчик повторят её, и поймает это опять ревьюер, то есть случайно.
 */
test('Р-146: сервер консоли не превращает строку запроса в число сам (находка 14 ревью шага 29)', async () => {
  const { readFileSync } = await import('node:fs');
  /**
   * `Number('0x10')` — это 16, `Number('1e3')` — 1000, `Number(' 5 ')` — 5. Разбор числа из запроса живёт в одном месте
   * (`parseListQuery`, строгая `/^\d{1,9}$/`), а не в каждом обработчике.
   */
  const PARSES_A_NUMBER = /(?:Number|parseInt|parseFloat)\s*\(\s*(?:url\.)?searchParams/;
  for (const bad of [
    `const days = Number(url.searchParams.get('days') ?? 7);`,
    `const n = parseInt(searchParams.get('limit')!, 10);`,
  ]) assert.match(bad, PARSES_A_NUMBER, `правило обязано ловить: ${bad.slice(0, 50)}`);
  for (const fine of [
    `const days = REPORT_PERIODS_DAYS.find((d) => String(d) === raw);`,
    `const query = parseListQuery(url.searchParams);`,
  ]) assert.doesNotMatch(fine, PARSES_A_NUMBER, `правило не должно ловить: ${fine.slice(0, 50)}`);

  const server = readFileSync(new URL('../server/stand-server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(server, PARSES_A_NUMBER, 'обработчик разбирает число из строки запроса сам: `0x10` и `1e3` пройдут');
});

/**
 * Находка 11 ревью шага 30: «прервано» решалось часами КОНСОЛИ — задание объявлялось брошенным по времени машины, которая
 * его показывает, а не по времени базы, которая держит аренду. Модели экранов вообще не должны знать, «который час».
 */
test('Р-146: модели экранов не читают часы машины (находка 11 ревью шага 30)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const READS_THE_CLOCK = /Date\s*\.\s*now\s*\(\s*\)|new\s+Date\s*\(\s*\)/;
  for (const bad of ['const interrupted = Date.now() > leaseUntil;', 'const today = new Date();']) {
    assert.match(bad, READS_THE_CLOCK, `правило обязано ловить: ${bad}`);
  }
  for (const fine of ['const today = new Date(job.finishedAt);', 'if (job.leaseExpired) return "INTERRUPTED";']) {
    assert.doesNotMatch(fine, READS_THE_CLOCK, `правило не должно ловить: ${fine}`);
  }
  const dir = new URL('../../../packages/console-model/src/', import.meta.url);
  const offenders = readdirSync(dir).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => READS_THE_CLOCK.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(offenders, [], 'модель экрана читает часы машины: состояние задания станет зависеть от часов браузера');
});

/**
 * Р-147 (шаг 32): итог задания не едет в СПИСКЕ заданий. У плана правки каталога в итоге лежат 10 000 правок — около
 * мегабайта; двадцать таких заданий в списке дают десятки мегабайт при пределе экрана 8 МБ, а экран истории опрашивает
 * список раз в секунду (находка 4 ревью шага 31).
 *
 * Проверяется поведением: списку дают задание с большим итогом и смотрят, что от итога в ответе не осталось ничего.
 */
test('Р-147: список заданий не несёт их итогов', async () => {
  const { bulkJobsView, bulkJobView, messagesFor } = await import('@repracer/console-model');
  const secret = 'ROWS-THAT-MUST-NOT-TRAVEL';
  const job = {
    jobId: '11111111-1111-1111-1111-111111111111', kind: 'BOUNDS_PLAN', status: 'SUCCEEDED',
    doneItems: 10_000, totalItems: 10_000, phase: 'PRODUCING', attempts: 1,
    createdAt: '2026-09-19T10:00:00.000Z', startedAt: '2026-09-19T10:00:01.000Z', finishedAt: '2026-09-19T10:00:09.000Z',
    createdByMembershipId: 'm', createdByUserId: 'u', createdWithMfa: false, leaseExpired: false, errorCode: null,
    /**
     * Канарейка лежит именно в `result.view` — в том, что экран ОДНОГО задания показывает (находка 2 ревью шага 32).
     * Положить её рядом с `view` значило бы проверять `screenResult`, который отбрасывает всё лишнее и без списка: тест
     * зеленел бы и после снятия защиты, то есть не существовал бы [Р-94].
     */
    params: {}, result: { view: { headline: 'x', edits: Array.from({ length: 10_000 }, () => secret) } },
  } as never;
  const m = messagesFor('de');
  const list = JSON.stringify(bulkJobsView([job], m, new Map()));
  assert.ok(!list.includes(secret), 'итог задания уехал в список: на каталоге это десятки мегабайт раз в секунду');
  assert.ok(list.includes('SUCCEEDED') && list.includes('10000'), `состояние и ход в списке остаются: ${list.slice(0, 160)}`);
  // И тот же итог доступен по ОДНОМУ заданию: список его не несёт, но и не прячет — он запрашивается отдельно [Р-147]
  assert.ok(JSON.stringify(bulkJobView(job, m)).includes(secret), 'экран одного задания свой итог показывает');
});

/**
 * Задача D шага 32: чужое задание отменяет тот, кто имеет право на САМУ ЭТУ ОПЕРАЦИЮ. До шага 32 право было одно на все виды
 * — «менять цены»: наблюдатель не мог отменить даже чужую выгрузку, которая ничего не меняет, а различие между «отменить
 * подтверждённый вторым фактором импорт» и «отменить чей-то отчёт» не выражалось вовсе.
 */
test('Р-143, задача D: право на отмену чужого задания — право на его вид операции', async () => {
  const { canCancelBulkJob, CANCEL_ACTION } = await import('@repracer/console-model');
  const KINDS = ['COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'REPRICING_ENABLE'] as const;
  // Вид задания без решения о праве существовать не может: перечисление полное [Р-146]
  assert.deepEqual(Object.keys(CANCEL_ACTION).sort(), [...KINDS].sort(), 'у каждого вида задания названо право на его отмену');

  // СВОЁ задание отменяет любой участник — в том числе тот, кому эта операция недоступна
  for (const kind of KINDS) assert.equal(canCancelBulkJob('VIEWER', kind, true), true, `своё задание ${kind}`);

  /**
   * Чужое: меняющее цены задание наблюдатель не отменяет, а чужую выгрузку — отменяет. Второе и есть разница, появившаяся на
   * шаге 32: прежнее общее право «менять цены» запрещало бы и её.
   */
  assert.equal(canCancelBulkJob('VIEWER', 'COST_IMPORT', false), false, 'чужой импорт себестоимости наблюдателю не отменить');
  assert.equal(canCancelBulkJob('OPERATOR', 'BOUNDS_EDIT', false), false, 'чужую массовую правку границ оператору не отменить');
  assert.equal(canCancelBulkJob('VIEWER', 'PRICE_EVIDENCE', false), true, 'чужая выгрузка ничего не меняет — её отменяет любой участник');
  assert.equal(canCancelBulkJob('PRICING_MANAGER', 'COST_IMPORT', false), true, 'у менеджера цен право на эту операцию есть');
  /**
   * Экран различий и предпросмотр — первая половина правки цен: применение ссылается на них и без них не проходит. Отменить
   * чужой экран различий значит сорвать чужую правку каталога, поэтому они НЕ идут по праву просмотра (находка 4 ревью
   * шага 32) — и потому список прав на отмену не совпадает со списком «ничего не меняющих» видов.
   */
  assert.equal(canCancelBulkJob('VIEWER', 'BOUNDS_PLAN', false), false, 'чужой экран различий зритель не отменяет: это начатая правка цен');
  assert.equal(canCancelBulkJob('VIEWER', 'STRATEGY_PREVIEW', false), false, 'чужой предпросмотр стратегии — тоже начатая операция с ценами');
  // Шаг 34: включение движка — своё право; оператор включает, значит и чужое включение отменяет, а цены при этом не правит
  assert.equal(canCancelBulkJob('OPERATOR', 'REPRICING_ENABLE', false), true, 'оператор вправе включать — вправе и отменить чужое включение');
  assert.equal(canCancelBulkJob('VIEWER', 'REPRICING_ENABLE', false), false, 'зритель включать не вправе — и отменять чужое включение тоже');
});

/**
 * OQ-207 (ревью шага 30, находка 12), шаг 31: ошибочно запущенная массовая операция останавливалась только ожиданием, а
 * очередь тенанта ничем не ограничивалась — один участник мог задержать всех остальных. Проверяется то, что видит продавец:
 * ждущее задание отменяется, идущее — нет, и очередь имеет названный предел.
 */
test('OQ-207: ждущее задание отменяется, идущее — нет, очередь тенанта ограничена', async () => {
  const id = 'kaufland/pipeline/happy-path';
  const owner = await login('OWNER');
  const live = liveOf(id);
  const start = async () => {
    const created = await call(owner, 'POST', api(id, 'compliance', 'evidence'), { from: '2026-01-01', to: '2026-01-31' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return (created.body as JobCreatedResponse).jobId;
  };
  const waiting = await start();
  const cancelled = await call(owner, 'POST', api(id, 'jobs', waiting, 'cancel'));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual([(cancelled.body as BulkJobView).status, (cancelled.body as BulkJobView).effect],
    ['CANCELLED', messagesFor('en').ui.jobs.effectNothing], 'отменённое задание ничего не изменило и об этом сказано');
  assert.equal((await call(owner, 'POST', api(id, 'jobs', waiting, 'cancel'))).status, 409, 'отменить дважды нельзя');

  // Завершённое задание не отменяется: применение целиком или никак, отменять на полпути нечего
  const done = await finishJob(id, await call(owner, 'POST', api(id, 'compliance', 'evidence'), { from: '2026-01-01', to: '2026-01-31' }));
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.cancellable, false, 'у завершённого задания кнопки отмены нет');
  assert.equal((await call(owner, 'POST', api(id, 'jobs', done.jobId, 'cancel'))).status, 409);

  /**
   * У КАЖДОГО участника свой предел очереди, и он меньше общего: иначе участник с правом только смотреть занимает очередь
   * тенанта выгрузками, и владелец получает отказ на импорт себестоимости (находка 14 ревью шага 31).
   */
  const queued: string[] = [];
  for (let i = 0; i < 5; i++) queued.push(await start());
  const overflow = await call(owner, 'POST', api(id, 'compliance', 'evidence'), { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(overflow.status, 409, `очередь участника ограничена: ${JSON.stringify(overflow.body)}`);
  // Другой участник в это же время ставит СВОЁ задание: очередь тенанта им не занята
  const viewer = await login('VIEWER');
  assert.equal((await call(viewer, 'POST', api(id, 'compliance', 'evidence'), { from: '2026-01-01', to: '2026-01-31' })).status, 200,
    'предел одного участника не закрывает очередь остальным');
  // Место освобождается отменой — ровно то, ради чего она и нужна
  assert.equal((await call(owner, 'POST', api(id, 'jobs', queued[0]!, 'cancel'))).status, 200);
  assert.equal((await call(owner, 'POST', api(id, 'compliance', 'evidence'), { from: '2026-01-01', to: '2026-01-31' })).status, 200);
  /**
   * Чужое задание отменяет тот, у кого есть право на ЭТУ операцию (задача D шага 32). Выгрузка доказательства ничего не
   * меняет, её право — просмотр, и чужую выгрузку отменяет любой участник; на импорте себестоимости тот же зритель получил бы
   * отказ. Обе стороны перечислены в проверке «право на отмену — право на вид операции» выше по файлу.
   */
  const byViewer = await call(viewer, 'POST', api(id, 'jobs', queued[1]!, 'cancel'));
  assert.equal(byViewer.status, 200, `чужая выгрузка ничего не меняет: ${JSON.stringify(byViewer.body)}`);
  assert.equal((byViewer.body as BulkJobView).status, 'CANCELLED');
  await runPendingJobs(live);
});

/**
 * OQ-196 (шаг 33): за отказом «нужен второй фактор» стоят два разных правила, и продавцу важно, какое сработало.
 *
 * Массовая правка — «больше одного предложения одной транзакцией». Окно [Р-135] — «правок больше пяти за десять минут»,
 * и оно срабатывает на правке ОДНОГО предложения тоже. До шага 33 оба отказа приходили одним кодом, и продавец,
 * поправивший шестое предложение подряд, читал совет про операцию, которой не делал: делить ему было нечего.
 */
test('OQ-196: окно массовой правки объясняется продавцу своим текстом, а не текстом массовой правки', async () => {
  const { bulkJobView, messagesFor } = await import('@repracer/console-model');
  const failed = (errorCode: string) => bulkJobView({
    jobId: '22222222-2222-4222-8222-222222222222', kind: 'BOUNDS_EDIT', status: 'FAILED', errorCode,
    doneItems: 0, totalItems: 1, phase: 'APPLYING', attempts: 1, result: null, params: {},
    createdAt: '2026-09-20T10:00:00.000Z', startedAt: '2026-09-20T10:00:01.000Z', finishedAt: '2026-09-20T10:00:02.000Z',
    createdByMembershipId: 'm', createdByUserId: 'u', createdWithMfa: false, leaseExpired: false,
  } as never, messagesFor('en')).error;

  const window = failed('MFA_REQUIRED_WINDOW');
  const mass = failed('MFA_REQUIRED');
  assert.notEqual(window, mass, 'у окна свой текст: иначе продавцу советуют не то, что с ним случилось');
  // Текст окна называет ИМЕННО окно: сколько предложений и за какое время
  assert.match(window!, /ten minutes/, window!);
  assert.match(window!, /five offers/, window!);
  // Текст верен и для импорта себестоимости: окно считает не только границы, но и себестоимость
  assert.ok(!/bounds|Grenzen/.test(window!), `текст окна не сужает его до границ: ${window!}`);
  // И это не заглушка «неизвестный код»: такой текст назвал бы сам код
  assert.ok(!window!.includes('MFA_REQUIRED_WINDOW'), window!);
});

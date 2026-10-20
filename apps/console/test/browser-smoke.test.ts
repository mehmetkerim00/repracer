import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { messagesFor, WALMART_UNPUBLISHED } from '@repracer/console-model';
import { buildStandWorlds, memoryStandDirectory, STAND_AUDIENCE, STAND_ISSUER, STAND_PEOPLE, STAND_USERS } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import type { ShadowPage } from '@repracer/pricing-store-pg';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import { launchBrowser, type Browser } from './browser.ts';
import { runNextBulkJob } from '@repracer/bulk-jobs';
import { handlersFor, runPendingJobs } from './run-jobs.ts';
import type { LiveWorld } from '@repracer/contract-tests/stand';
import { EMPTY_WORLD_ID, emptyWorld, emptyWorldConnect } from './empty-world.ts';

/**
 * Шаг 76 (предполётный прогон демо, ревью — находка 7): страница консоли исполняется настоящим браузером. Страница была ПУСТОЙ с шага 29
 * — код страницы тянул модули Node, — и ни один прогон этого не видел: все ходят через HTTP API. Правило `scripts/browser-imports.mjs`
 * ловит одну причину; этот прогон — любую: исключение при загрузке или отрисовке, ошибку экспорта, падение экрана. Стенд в памяти, Vite
 * так же, как у ведущего демо, безголовый Chrome.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const en = messagesFor('en');
const de = messagesFor('de');
const es = messagesFor('es');
const fr = messagesFor('fr');

/** Шаг 98 [Р-223]: строки словаря — значения-строки (не функции) всех уровней */
function dictionaryStrings(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') { const t = value.trim(); if (t) out.add(t); }
  else if (value && typeof value === 'object') for (const v of Object.values(value)) dictionaryStrings(v, out);
  return out;
}
/** Имена, которые не переводятся (глоссарий): бренд, каналы, Buy Box, Omnibus, Price Gate; коды — заглавными буквами и цифрами */
const KEPT_NAMES = /^(PriceTrail|pricetrail|Kaufland|Amazon|eBay|Otto|Walmart|Buy Box|Omnibus|Price Gate)$/;
/** Английские тексты словаря, которых нет в словаре языка: на его экране такой текст — непереведённая строка */
function englishOnly(target: typeof en): string[] {
  const own = dictionaryStrings(target);
  return [...dictionaryStrings(en)].filter((t) => !own.has(t) && /[A-Za-z]{2}/.test(t) && !KEPT_NAMES.test(t) && !/^[A-Z0-9_./-]+$/.test(t));
}
/**
 * Шаг 98 [Р-223]: правило «на экране испанского или французского нет английской строки словаря» — видимый текст (узлы текста целиком)
 * и подписи для диктора, подсказки и заполнители полей. Исключения — только то, что глоссарий не переводит (бренд, каналы, коды)
 */
const UNTRANSLATED = (english: readonly string[]) => `(() => {
  const english = new Set(${JSON.stringify(english)});
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || '').trim();
    if (!t || !english.has(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest('script, style, [hidden]') || el.getClientRects().length === 0) continue;
    out.push(t);
  }
  for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
    for (const a of ['aria-label', 'title', 'placeholder']) {
      const v = (el.getAttribute(a) || '').trim();
      if (v && english.has(v)) out.push(a + ': ' + v);
    }
  }
  return [...new Set(out)];
})()`;
let stand: ReturnType<typeof createStandServer> | null = null;
let vite: ViteDevServer | null = null;
let browser: Browser | null = null;
let pageUrl = '';
/** Шаг 87: два экземпляра API на одних мирах — профиль eu (Kaufland, немецкий, Omnibus) и профиль us; сервер стенда ходит в текущий */
let euApi: ReturnType<typeof createStandApi>;
let usApi: ReturnType<typeof createStandApi>;
/** Шаг 88 [Р-213]: профиль us с флагом расширенных ролей — вход предлагает пять ролей */
let extendedApi: ReturnType<typeof createStandApi>;
let currentApi: ReturnType<typeof createStandApi>;
/** Шаг 100 (A): стенд, где у входящего ровно одно рабочее пространство */
let soloApi: ReturnType<typeof createStandApi>;
/** Шаг 99: мир смоука — по нему исполняются задания импорта (исполнителя у смоука нет, задания зовутся из теста) */
let smokeLive: LiveWorld;
/** Шаг 96: подменённый ответ отчёта о поле (страницы по 50 и схлопывание повторов); null — настоящий ответ стенда */
let syntheticDangerous: unknown = null;

/** Синтетический отчёт о поле: 24 одинаковых удержания одного предложения и 106 разных — 107 строк после схлопывания, три страницы */
function syntheticFloorReport(worldId: string) {
  const reason = { code: 'CAPPED_AT_MIN_PRICE', title: 'Target capped at your minimum price', text: 'Target capped at your minimum price.', problems: [], limit: null, withheld: [] };
  const unit = (i: number) => ({ writeScopeId: `smoke-hold-${i}`, channel: 'KAUFLAND', marketplace: 'de', externalUnitId: `u-${i}`, channelProductRef: `p-${i}`, condition: 'NEW', gtin: null, label: `Synthetic lamp ${i} · kaufland.de` });
  const at = (i: number) => new Date(Date.UTC(2026, 9, 15, 12) - i * 600_000).toISOString();
  const items = [
    ...Array.from({ length: 24 }, (_, i) => ({ at: at(i), unit: unit(0), kind: 'CAPPED', target: '€9.99', floor: '€14.00', below: '€4.01', reason, decisionId: null })),
    ...Array.from({ length: 106 }, (_, i) => ({ at: at(24 + i), unit: unit(i + 1), kind: 'CAPPED', target: '€9.99', floor: '€14.00', below: '€4.01', reason, decisionId: null })),
  ];
  return {
    worldId, phrase: 'in the last 7 days', from: at(130), to: at(0), clipped: false,
    headline: 'The floor held the price 107 times in the last 7 days', floorHolds: { count: 130, withoutFloor: [], unknownAmount: 0, items },
    gateHeadline: 'Your bounds stopped 0 dangerous changes in the last 7 days', count: 0, prevented: [], worst: null, byUnit: [], byBound: [], items: [], truncated: false, gaps: [],
  };
}

/**
 * Шаг 96.2: вкладка «Prevented by rules» как на живом скрине демо — 12 предложений по 11 одинаковых удержаний и поправок (×11), у всех
 * «set to the floor», двойная пилюля, длинная причина и пустая колонка «Beyond bound». `dangerous` добавляет один опасный отказ Gate —
 * тогда колонка «Beyond bound» появляется
 */
function demoLikeFloorReport(worldId: string) {
  const reason = { code: 'CAPPED_AT_MIN_PRICE', title: 'Target capped at your minimum price', text: 'Target capped at your minimum price.', problems: [], limit: null, withheld: [] };
  const unit = (i: number) => ({ writeScopeId: `smoke-like-${i}`, channel: 'KAUFLAND', marketplace: 'de', externalUnitId: `l-${i}`, channelProductRef: `lp-${i}`, condition: 'NEW', gtin: null, label: `Synthetic clock ${i} · kaufland.de` });
  const at = (i: number) => new Date(Date.UTC(2026, 9, 15, 12) - i * 300_000).toISOString();
  const items = Array.from({ length: 132 }, (_, n) => ({ at: at(n), unit: unit(n % 12), kind: 'CAPPED', target: `€${(8.99 + (n % 12) * 0.5).toFixed(2)}`, floor: `€${(14 + (n % 3)).toFixed(2)}`, below: `€${(5.01 - (n % 12) * 0.5 + (n % 3)).toFixed(2)}`, reason, decisionId: null }));
  return {
    worldId, phrase: 'in the last 7 days', from: at(132), to: at(0), clipped: false,
    headline: 'The floor held the price 132 times in the last 7 days', floorHolds: { count: 132, withoutFloor: [], unknownAmount: 0, items },
    gateHeadline: 'Your bounds stopped 0 dangerous changes in the last 7 days', count: 0, prevented: [], worst: null, byUnit: [], byBound: [], items: [], truncated: false, gaps: [],
  };
}
function demoLikeRejected(worldId: string, dangerous = false) {
  const capped = { code: 'CAPPED_AT_MIN_PRICE', title: 'Target capped at your minimum price', text: 'The target from competitor prices was below your minimum price — capped at €14.00.', problems: [], limit: null, withheld: [] };
  const below = { code: 'BELOW_MIN_PRICE', title: 'Below your minimum price', text: 'The price €12.20 is below your minimum price €14.00 — the Price Gate refused it.', problems: [], limit: null, withheld: [] };
  const unit = (i: number) => ({ writeScopeId: `smoke-like-${i}`, channel: 'KAUFLAND', marketplace: 'de', externalUnitId: `l-${i}`, channelProductRef: `lp-${i}`, condition: 'NEW', gtin: null, label: `Synthetic clock ${i} · kaufland.de` });
  const at = (i: number) => `Oct 15, ${String(12 - Math.floor(i / 12)).padStart(2, '0')}:${String(59 - (i % 12) * 4).padStart(2, '0')}`;
  const items = [
    ...Array.from({ length: 132 }, (_, n) => ({ kind: 'STRATEGY_CAP', tone: 'progress', at: at(n), unit: unit(n % 12), productRef: null, proposed: '€12.49', current: '€18.50', change: '−32.5%',
      limit: 'your minimum price €14.00', set: '€14.00', deviation: null, intervention: 'CORRECTED', reason: capped, decisionId: null })),
    ...Array.from({ length: 12 }, (_, n) => ({ kind: 'GATE', tone: 'progress', at: at(n), unit: unit(n), productRef: null, proposed: '€12.20', current: '€18.50', change: '−34.1%',
      limit: 'your minimum price €14.00', set: '€18.50', deviation: '−12.9%', intervention: 'CORRECTED', reason: below, decisionId: null })),
    ...(dangerous ? [{ kind: 'GATE', tone: 'stop', at: at(0), unit: unit(0), productRef: null, proposed: '€3.00', current: '€18.50', change: '−83.8%',
      limit: 'your minimum price €14.00', set: '€18.50', deviation: '−78.6%', intervention: 'DANGEROUS', reason: below, decisionId: null }] : []),
  ];
  return {
    worldId, headline: `Your bounds stopped ${dangerous ? 1 : 0} dangerous changes and corrected 144`,
    summary: { dangerous: dangerous ? 1 : 0, corrected: 144, unresolvable: 0, floorAboveCeiling: 0, limiterHolds: 0, stops: 0, inputRejects: 0, halts: 0 },
    groups: [{ code: 'CAPPED_AT_MIN_PRICE', title: 'Target capped at your minimum price', count: 132 }, { code: 'BELOW_MIN_PRICE', title: 'Below your minimum price', count: 12 + (dangerous ? 1 : 0) }],
    items, gaps: [],
  };
}
let syntheticRejected: unknown = null;
/** Шаг 100 (E): чип движения конкурента у первой строки настоящей страницы решений — в мире смоука у предложений один снимок, сравнивать не с чем */
let decisionChip: { chip: string; full: string } | null = null;
/** Шаг 101 (C): таблица конкурентов квитанции под фильтром — у шага снимка настоящей квитанции (в мире смоука стратегий с фильтром нет) */
let receiptCompetitors: unknown = null;

/** Синтетическая неделя тени для смоука адаптива: только форма экрана, ничего из базы */
function syntheticShadow() {
  const page = (now: string, sinceDays = 7): ShadowPage => {
    const until = Date.parse(now);
    const at = (msAgo: number) => new Date(until - msAgo).toISOString() as never;
    const hour = 3_600_000;
    return {
      summary: { since: at(sinceDays * 24 * hour), until: at(0), decisions: 3070, changes: 505, floorHeld: 131, ceilingHeld: 0, heldWrites: 719,
        heldPriceWrites: 515, heldQuantityWrites: 204, wouldSpendBudget: 10, wouldSpendUnconfirmed: 10, floorSavings: [{ currency: 'EUR', minor: 188826 }], floorSavingsHolds: 626 },
      rows: Array.from({ length: 12 }, (_, i) => ({ channelWriteId: `smoke-write-${i}`, writeScopeId: `smoke-scope-${i}`, channel: 'KAUFLAND', channelAccountId: 'smoke-account',
        sku: `syn-smoke-${100 + i}`, title: `Synthetic desk lamp, size ${i + 1}`, marketplace: 'de', field: i % 3 === 0 ? 'QUANTITY' : 'PRICE',
        amountMinor: i % 3 === 0 ? null : 1838 + i, currency: i % 3 === 0 ? null : 'EUR', quantity: i % 3 === 0 ? 24 : null, priceDecisionId: null,
        wouldSpendBudget: i === 0, finishedAt: at(i * hour) })),
      total: 719,
      accounts: [{ channelAccountId: 'smoke-account', channel: 'KAUFLAND', displayName: 'Kaufland', externalAccountId: 'syn-smoke-account', writeMode: 'SHADOW',
        authStatus: 'ACTIVE', changedAt: null, changedByMembershipId: null, changedFrom: null, offers: 200, engineScopes: 200 }],
      properties: [
        { channel: 'AMAZON', marketplace: 'ATVPDKIKX0DER', country: 'US', property: 'DAY_BOUNDARY', value: null, status: 'UNKNOWN', question: 'A-03', closesBy: 'SHADOW_READ', source: 'synthetic' },
        { channel: 'AMAZON', marketplace: 'ATVPDKIKX0DER', country: 'US', property: 'PRICE_TAX_BASIS', value: 'NET', status: 'CONSERVATIVE', question: 'A-02', closesBy: 'FIRST_LIVE_WRITE', source: 'synthetic' },
      ],
      digests: [{ periodStart: at(14 * 24 * hour), periodEnd: at(7 * 24 * hour), decisions: 2900, heldWrites: 700, floorSavings: [{ currency: 'EUR', minor: 150000 }],
        deliveredAt: at(7 * 24 * hour - hour), deliveryKind: 'DRY_RUN' }],
      decisionsByHour: Array.from({ length: sinceDays * 24 }, (_, i) => ({ hour: at((i + 1) * hour), decisions: 18 + (i % 7) })),
    };
  };
  return {
    shadowPage: async (_tenantId: string, now: string, query: { sinceDays?: number }) => page(now, query.sinceDays ?? 7),
    switchWriteMode: async () => ({ status: 'NOT_OWNER' as const }),
  };
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createNetServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

before(async () => {
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  // Шаг 85: у мира сценария в памяти тени нет (экран отвечает 404) — смоуку адаптива нужен и экран тени, поэтому у смоук-мира — синтетическая
  // неделя тени: плитки, график по дням, сводка, аккаунт, свойства витрин, письмо и строки удержанных записей (числа выдуманы, как у демо)
  const worlds = (await buildStandWorlds({ filter: (s) => s.id === 'kaufland/pipeline/happy-path' })).map((w) => ({ ...w, shadow: syntheticShadow() }));
  /**
   * Шаг 93: у предложения смоук-мира — заметка канала «снят с публикации» (самая длинная пилюля и строка таблицы Offers), чтобы правило
   * ширины таблицы видело колонку «Channel says» (шаг 89 нашёл её переполнение проходом, а не смоуком — в мирах смоука заметок не было)
   */
  const w0 = worlds[0]!;
  smokeLive = w0;
  const scope0 = (await w0.view(STAND_USERS[0] as never) as { state: { scopes: Array<{ channelAccountId: string; marketplace: string; channelProductRef: string; condition: string }> } }).state.scopes[0]!;
  await w0.store.recordPricingHealth(w0.tenantId, scope0.channelAccountId, {
    marketplace: scope0.marketplace, channelProductRef: scope0.channelProductRef, condition: scope0.condition, issueType: WALMART_UNPUBLISHED,
    occurredAt: w0.clock.iso(), competitivePriceThreshold: { amountMinor: 1999, currency: 'EUR' }, sourceEventId: 'smoke-unpublished',
  } as never);
  // Шаг 87: рядом — пустое рабочее пространство (онбординг и подключение предлагают каналы и витрины профиля)
  const empty = emptyWorld(worlds[0]!.clock);
  // Счётчики пустого пространства говорят «есть витрина ЕС»: тогда вкладку Omnibus в профиле us прячет ИМЕННО профиль, а в eu она на месте
  const counters = empty.store.worldCounters.bind(empty.store);
  (empty.store as { worldCounters: typeof counters }).worldCounters = async (...args) => ({ ...(await counters(...args)), euStorefronts: true });
  const all = [...worlds, empty];
  const identity: Parameters<typeof createStandApi>[1] = {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(all) }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email, extra: { name: a.displayName } }), expiresInSeconds: 900 },
  };
  /**
   * Шаг 103 [Р-228]: у смоук-мира — аккаунт Kaufland на экране Channels (как у мира тенанта): карточка аккаунта со стратегией по умолчанию
   * для новых предложений. Аккаунт — тот же, что у предложений мира, данные синтетические
   */
  const smokeAccount = w0.accounts[0]!;
  const smokeConnect: typeof emptyWorldConnect = {
    connectable: () => [],
    connections: async () => ({
      accounts: [{
        channelAccountId: smokeAccount.channelAccountId, channel: smokeAccount.channel, region: null, marketplaces: [...smokeAccount.marketplaces], externalAccountId: 'syn-smoke-account',
        authStatus: 'ACTIVE', accessBlockers: [], writeMode: 'SHADOW', connectedAt: w0.clock.iso() as never, offers: 200, unmanagedOffers: 0, shadowDecisions24h: 3070,
        credentialObtainedAt: null, credentialVerifiedAt: null, credentialCheckFailures: 0, oauth: false, discoveryCircleStartedAt: null, discoveryCircleCompletedAt: null,
        otherTools: 'NONE', otherToolsAnsweredAt: w0.clock.iso() as never, quantityWritesConfirmed: true, externalEdits24h: 0,
      }],
      pending: [],
    }),
    start: async () => ({ status: 'UNAVAILABLE' }),
    callback: async () => ({ status: 'BAD_CALLBACK' }),
    cancel: async () => false,
  };
  const connect = (worldId: string) => (worldId === EMPTY_WORLD_ID ? emptyWorldConnect : worldId === w0.id ? smokeConnect : null);
  // Основной стенд — профиль eu: смоук Kaufland и немецкие проходы шагов 76–86 гоняются на нём (Европа заморожена, не удалена)
  euApi = createStandApi(all, identity, { defaultLocale: 'en', market: 'eu', connect, people: STAND_PEOPLE });
  usApi = createStandApi(all, identity, { market: 'us', connect, people: STAND_PEOPLE });
  extendedApi = createStandApi(all, identity, { market: 'us', connect, extendedRoles: true, people: STAND_PEOPLE });
  soloApi = createStandApi([w0], identity, { defaultLocale: 'en', market: 'eu', connect, people: STAND_PEOPLE });
  currentApi = euApi;
  // Шаг 96 (Б12): страницы и «×N» вкладки «Prevented by rules» проверяются на синтетическом отчёте о поле — в мире смоука удержаний нет
  stand = createStandServer((req) => (syntheticDangerous && /\/dangerous(\?|$)/.test(req.url) ? Promise.resolve({ status: 200, body: syntheticDangerous })
    : syntheticRejected && /\/rejected(\?|$)/.test(req.url) ? Promise.resolve({ status: 200, body: syntheticRejected })
    : receiptCompetitors && /\/decisions\/[^/?]+(\?|$)/.test(req.url) ? currentApi(req).then((r) => {
      const body = r.body as { steps?: Array<Record<string, unknown>> };
      const step = r.status === 200 ? body.steps?.find((x) => x.key === 'SNAPSHOT') : undefined;
      if (step) step.competitors = receiptCompetitors;
      return r;
    })
    : decisionChip && /\/decisions\?/.test(req.url) ? currentApi(req).then((r) => {
      const body = r.body as { items?: Array<Record<string, unknown>> };
      if (r.status === 200 && body.items?.length) body.items[0] = { ...body.items[0], trigger: decisionChip };
      return r;
    }) : currentApi(req)));
  await new Promise<void>((resolve) => stand!.listen(0, '127.0.0.1', resolve));
  const standPort = (stand.address() as { port: number }).port;
  vite = await createServer({
    root, configFile: `${root}vite.config.ts`, logLevel: 'silent',
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false, proxy: { '/api': `http://127.0.0.1:${standPort}` } },
  });
  await vite.listen();
  pageUrl = vite.resolvedUrls!.local[0]!;
  browser = await launchBrowser();
});
// Уборка — каждый шаг отдельно: отказ одного не оставляет открытыми остальные (CI шага 76: исключение в первом шаге оставляло стенд и
// Vite слушать, процесс теста не завершался, и задание висело до своего срока); первый отказ — провал файла после всей уборки
after(async () => {
  const failures: unknown[] = [];
  const step = async (f: () => Promise<unknown> | undefined) => { try { await f(); } catch (e) { failures.push(e); } };
  await step(() => browser?.close());
  await step(() => vite?.close());
  await step(() => new Promise((r) => { if (!stand) return r(null); stand.closeAllConnections(); stand.close(r); }));
  if (failures.length > 0) throw failures[0];
});

/** Экран готов: «Loading…» ушло; сообщение об ошибке экрана — провал с его текстом */
async function settled(b: Browser, what: string): Promise<void> {
  await b.waitText(/./);
  for (let i = 0; i < 600; i++) {
    const state = await b.evaluate<{ loading: boolean; error: string | null }>(
      `({ loading: document.querySelector('.loading') !== null, error: document.querySelector('main .error')?.innerText ?? null })`);
    if (state.error !== null) assert.fail(`${what}: the screen shows an error — ${state.error}`);
    if (!state.loading) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}: the screen kept loading`);
}

test('step 76: the console page runs in a real browser — sign-in, workspace list and the screens render without page errors', async () => {
  const b = browser!;
  await b.open(pageUrl);
  // Экран входа — на языке развёртывания (стенд с `defaultLocale: 'en'`), имитатор входа даёт кнопки ролей
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  // Шаг 84: роли — строками «имя роли — что может»; «Sign in as Owner» — доступное имя кнопки
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  assert.equal(await b.evaluate<string>('document.documentElement.lang'), 'en', 'the document language follows the screen');
  // Шаг 92 [Р-216]: вкладка называет продукт в прозе — «PriceTrail · seller console»
  assert.equal(await b.evaluate<string>('document.title'), en.ui.app.documentTitle, 'the tab title names the product, not a Russian placeholder');
  /**
   * Шаг 92 [Р-216]: знак PriceTrail — SVG «held trail», а не кружок с буквой «r»; имя знака — строчное «pricetrail». Линия — цвет контекста,
   * конечная точка — зелёный Primer своего контекста: на светлом входе — `--fgColor-success`, в тёмной шапке — зелёный тёмной темы
   */
  const mark = (where: string) => b.evaluate<{ svg: boolean; text: string; line: string; end: string } | null>(`(() => {
    const host = document.querySelector(${JSON.stringify(where)}); const svg = host?.querySelector('svg.brand-mark');
    if (!host || !svg) return null;
    return { svg: true, text: host.textContent.trim(), line: getComputedStyle(svg).color, end: getComputedStyle(svg.querySelector('.brand-mark-end')).fill };
  })()`);
  assert.deepEqual(await mark('.login-brand'), { svg: true, text: en.ui.app.brand, line: 'rgb(31, 35, 40)', end: 'rgb(26, 127, 55)' }, 'sign-in: the mark on light, the lowercase name');
  assert.equal(en.ui.app.brand, 'pricetrail');
  assert.deepEqual(await mark('.topbar .brand'), { svg: true, text: en.ui.app.title, line: 'rgb(255, 255, 255)', end: 'rgb(63, 185, 80)' }, 'header: the mark on dark');
  assert.equal(await b.evaluate<number>(`[...document.querySelectorAll('.brand-mark')].filter((e) => e.textContent.trim() === 'r').length`), 0, 'the old «r» mark is gone');
  await b.click(owner);
  await b.waitText(en.ui.app.worlds);
  const worldLink = await b.evaluate<string>(`[...document.querySelectorAll('h3 a')].map((a) => a.getAttribute('href'))[0] ?? ''`);
  assert.match(worldLink, /^#\/w\/[^/]+\/products$/, 'a world that declares no landing opens on products');
  await b.click((await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`)));
  await settled(b, 'products');
  const world = worldLink.split('/')[2]!;
  /**
   * Шаг 79 (визуальное ревью, находка 1): у широкой таблицы последняя колонка закреплена справа, и всё, что шире окна, уходило ПОД неё —
   * статус предложения и причина в лентах не были видны. Правило [Р-146]: при окне 1440 таблица с закреплённой колонкой помещается в свою рамку
   */
  const stickyTables = () => b.evaluate<Array<{ table: number; wrap: number }>>(
    `[...document.querySelectorAll('.table-wrap')].filter((w) => w.querySelector('table.sticky-end')).map((w) => ({ table: w.querySelector('table').scrollWidth, wrap: w.clientWidth }))`);
  // Шаг 93: правило — в обеих темах (светлой и тёмной системной)
  for (const scheme of ['light', 'dark'] as const) {
    await b.setColorScheme(scheme);
    // Шаг 95 [Р-217]: экраны нового меню и их вкладки — журнал решений, люди и правила защиты, массовые операции
    for (const screen of ['products', 'feed', 'feed/decisions', 'strategies', 'costs', 'protections', 'protections/people', 'stop', 'inventory', 'products/bulk']) {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${screen}`)}, true)`);
      await settled(b, `${scheme} ${screen}`);
      for (const t of await stickyTables()) assert.ok(t.table <= t.wrap + 1, `${scheme} ${screen}: the table is ${t.table}px wide in a ${t.wrap}px frame — columns hide under the pinned action column`);
    }
  }
  await b.setColorScheme(null);
  // Положительный контроль правила: в суженной рамке та же таблица товаров обязана НЕ поместиться — иначе проверка выше ничего не мерит
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
  await settled(b, 'products (control)');
  assert.ok((await stickyTables()).length > 0, 'the products screen of the smoke world has a table with a pinned column');
  // Шаг 93: правило видит колонку «Channel says» — она есть у смоук-мира; контроль — прежняя растянутая колонка (до шага 89) краснеет
  assert.ok(await b.evaluate<boolean>(`!!document.querySelector('table.products.with-channel td.channel-says .badge')`), 'the smoke world has the «Channel says» column');
  await b.evaluate(`(document.head.insertAdjacentHTML('beforeend', '<style id="wide-channel">table.products td.channel-says .cell { max-width: none; } table.products td.channel-says .badge, table.products td.channel-says .cell-detail, table.products.with-channel td.strategy { white-space: nowrap; }</style>'), true)`);
  const stretched = await stickyTables();
  assert.ok(stretched[0]!.table > stretched[0]!.wrap + 1, `control: the stretched «Channel says» column of step 89 must overflow — ${JSON.stringify(stretched)}`);
  await b.evaluate(`(document.getElementById('wide-channel').remove(), true)`);
  await b.evaluate(`(document.querySelector('.table-wrap').style.width = '480px', true)`);
  const squeezed = await stickyTables();
  assert.ok(squeezed[0]!.table > squeezed[0]!.wrap + 1, `control: a 480px frame must overflow — ${JSON.stringify(squeezed)}`);
  // Положительный контроль сборщика ошибок: исключение страницы им видно — иначе пустой список ниже ничего не значит [Р-94]
  await b.evaluate(`(setTimeout(() => { throw new Error('smoke control'); }), true)`);
  for (let i = 0; i < 50 && !b.errors().some((e) => e.includes('smoke control')); i++) await new Promise((r) => setTimeout(r, 100));
  const errors = b.errors();
  assert.ok(errors.some((e) => e.includes('smoke control')), 'the page error collector must see a thrown error');
  assert.deepEqual(errors.filter((e) => !e.includes('smoke control')), [], 'the console page threw or logged errors');
});

/**
 * Шаг 85 (адаптив): консоль пригодна от телефона 375px до широкого монитора. Правила [Р-146]: на каждой ширине — ноль ошибок страницы;
 * при 375 и 768 страница НИГДЕ не листается вбок (листается только таблица внутри своей рамки), цели касания — не ниже 44px, навигация —
 * выдвижной панелью, которую закрывают выбор пункта, крестик, клик мимо и Esc; при 1012 и шире — прежняя боковая панель без кнопки меню
 */
/** Шаг 95 [Р-217]: меню из 9 пунктов в профиле us (в eu у пространства с витриной ЕС перед «Stop pricing» — Omnibus) */
const MENU_US = ['shadow', 'feed', 'strategies', 'costs', 'protections', 'products', 'inventory', 'channels', 'stop'];
/** Шаг 95 [Р-217]: экраны меню из 9 пунктов и их вкладки; последним — Costs & floors (на нём проверяется навигация ниже) */
const SCREENS = ['shadow', 'products', 'products/bulk', 'inventory', 'feed', 'feed/decisions', 'protections', 'protections/people', 'stop', 'channels', 'strategies', 'compliance', 'costs'];
const WIDTHS: ReadonlyArray<readonly [number, number]> = [[375, 812], [768, 1024], [1012, 800], [1440, 900]];

/** Ширина прокрутки документа против ширины окна (без полосы прокрутки) и элементы, которые торчат за окно не внутри своей рамки прокрутки */
const PAGE_FIT = `(() => {
  const root = document.documentElement, vw = root.clientWidth;
  const scroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  const out = [...document.querySelectorAll('body *')].filter((el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0
    && el.getBoundingClientRect().right > vw + 0.5 && !scroller(el)).slice(0, 3).map((el) => el.tagName.toLowerCase() + '.' + String(el.className) + ' «' + (el.textContent ?? '').trim().slice(0, 30) + '»');
  return { scrollWidth: root.scrollWidth, width: vw, out };
})()`;
/** Цели касания ниже 44px: кнопки, выборы, поля, пункты меню, ссылки строк, вкладки, меню колонок */
/**
 * Шаг 93 [Р-146]: в сетке карточек (`.cards`, `.worlds`, `.stats`, `.choices`) зазор даёт gap — дети одного ряда стоят на одной линии.
 * Общее правило «блок после блока — отступ сверху» дважды сдвигало вторую и третью карточку ряда вниз (шаг 91 — «Your workspaces», шаг 93 —
 * «Stop pricing»: правило соседей сильнее сброса в сетке по специфичности). Ряд — дети, идущие слева направо
 */
const ROW_MISALIGNED = `[...document.querySelectorAll('.cards, .worlds, .stats, .choices')].filter((g) => g.checkVisibility()).flatMap((g) => {
  const kids = [...g.children].filter((k) => k.checkVisibility()).map((k) => ({ k, r: k.getBoundingClientRect() }));
  const bad = [];
  for (let i = 1; i < kids.length; i += 1) {
    const a = kids[i - 1], b = kids[i];
    if (b.r.left > a.r.left && Math.abs(b.r.top - a.r.top) > 1) bad.push(g.className + ' › ' + (b.k.querySelector('h2, h3, h4, dt')?.textContent ?? b.k.textContent).trim().slice(0, 40) + ' — ' + Math.round(b.r.top - a.r.top) + 'px');
  }
  return bad; })`;
/**
 * Шаг 94 [Р-146]: стандарт формы — геометрией, а не договорённостью. У поля стандарта подпись стоит НАД контролом, пояснение — ПОД ним;
 * у галочки контрол слева от подписи и на линии её первой строки. Отзыв владельца после шага 93: поля «летали» — подпись, поле и хвост фразы
 * одной строкой, чекбокс в углу; правило репозитория `scripts/form-fields.mjs` держит, что поле в стандарте есть, это — что оно так стоит
 */
/**
 * Шаг 97 [Р-146]: поле стандарта не выше своего содержимого. На телефоне ряд фильтров встаёт столбиком, и основа flex полей ряда (18rem,
 * у выбора — 12rem) становилась их ВЫСОТОЙ: под каждым полем журнала цен, Shadow mode и Protections — пустота 12–18rem (с шага 96, найдено
 * снимками шага 97). Правило: у поля ряда фильтров высота минус высота содержимого (подпись, контрол, пояснение) — не больше 24px (в сетке формы
 * поля законно тянутся до высоты соседа по строке — они правилом не судятся)
 */
const FIELD_SLACK = `(() => {
  const out = [];
  for (const f of document.querySelectorAll('.world-content .field-toolbar > .field')) {
    const r = f.getBoundingClientRect();
    if (r.height === 0) continue;
    const kids = [...f.children].map((c) => c.getBoundingClientRect()).filter((k) => k.height > 0);
    if (kids.length === 0) continue;
    const content = Math.max(...kids.map((k) => k.bottom)) - Math.min(...kids.map((k) => k.top));
    if (r.height - content > 24) out.push((f.querySelector('label, .field-label')?.textContent.trim() ?? '?') + ': ' + Math.round(r.height) + 'px for ' + Math.round(content) + 'px of content');
  }
  return out.slice(0, 5);
})()`;

const FORM_GEOMETRY = `(() => {
  const vis = (el) => el && el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0;
  const bad = [];
  for (const f of document.querySelectorAll('.field')) {
    if (!vis(f)) continue;
    const label = f.querySelector(':scope > .field-label'), control = label?.nextElementSibling, caption = f.querySelector(':scope > .field-caption');
    const name = (label?.textContent ?? '?').trim().slice(0, 30);
    if (!label || !vis(control)) { bad.push('«' + name + '»: no label or control'); continue; }
    const l = label.getBoundingClientRect(), c = control.getBoundingClientRect();
    if (l.bottom > c.top + 0.5) bad.push('«' + name + '»: the label is not above its control (' + Math.round(l.bottom - c.top) + 'px)');
    if (vis(caption) && caption.getBoundingClientRect().top < c.bottom - 0.5) bad.push('«' + name + '»: the caption is not under its control');
  }
  for (const f of document.querySelectorAll('.check-field')) {
    if (!vis(f)) continue;
    const box = f.querySelector(':scope > input'), label = f.querySelector(':scope > label');
    const name = (label?.textContent ?? '?').trim().slice(0, 30);
    if (!vis(box) || !vis(label)) { bad.push('«' + name + '»: no checkbox or label'); continue; }
    const r = document.createRange(); r.selectNodeContents(label);
    const line = r.getClientRects()[0] ?? label.getBoundingClientRect(), x = box.getBoundingClientRect();
    if (x.right > line.left + 0.5) bad.push('«' + name + '»: the checkbox is not left of its label');
    const off = Math.abs((x.top + x.bottom) / 2 - (line.top + line.bottom) / 2);
    if (off > 3) bad.push('«' + name + '»: the checkbox is ' + Math.round(off) + 'px off the first line of its label');
  }
  return bad.slice(0, 5);
})()`;
const SMALL_TARGETS = `[...document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]), .nav-group a, a.row-link, .tabs a, summary')]
  .filter((el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 43.5)
  .slice(0, 5).map((el) => el.tagName.toLowerCase() + ' «' + (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30) + '» ' + Math.round(el.getBoundingClientRect().height) + 'px')`;

test('step 85: the console works from a 375px phone to a wide monitor — no page errors, no sideways page scroll, 44px touch targets, a drawer for the nav', async () => {
  const b = browser!;
  const before = b.errors().length;
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  // Шаг 93: светлая тема — на всех ширинах, тёмная — на телефоне и мониторе; шаг 94 — обе темы на всех четырёх ширинах
  const RUNS: ReadonlyArray<readonly ['light' | 'dark', number, number]> = (['light', 'dark'] as const).flatMap((scheme) => WIDTHS.map(([w, h]) => [scheme, w, h] as const));
  for (const [scheme, width, height] of RUNS) {
    const narrow = width < 1012;
    await b.setColorScheme(scheme);
    await b.setViewport(width, height);
    // токен — только в памяти страницы: открыть заново — новый вход на этой ширине
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OWNER);
    const checkPage = async (what: string) => {
      const fit = await b.evaluate<{ scrollWidth: number; width: number; out: string[] }>(PAGE_FIT);
      if (width <= 768) {
        assert.ok(fit.scrollWidth <= fit.width, `${width}px, ${what}: the page scrolls sideways — ${fit.scrollWidth}px in a ${fit.width}px window; sticking out: ${fit.out.join('; ')}`);
        assert.deepEqual(fit.out, [], `${width}px, ${what}: elements stick out of the window`);
      }
      if (narrow) assert.deepEqual(await b.evaluate<string[]>(SMALL_TARGETS), [], `${width}px, ${what}: touch targets lower than 44px`);
      assert.deepEqual(await b.evaluate<string[]>(ROW_MISALIGNED), [], `${scheme} ${width}px, ${what}: cards of one row do not stand on one line`);
      assert.deepEqual(await b.evaluate<string[]>(FORM_GEOMETRY), [], `${scheme} ${width}px, ${what}: a form field breaks the standard`);
      assert.deepEqual(await b.evaluate<string[]>(FIELD_SLACK), [], `${scheme} ${width}px, ${what}: a field is taller than its content`);
    };
    // поля стандарта, которые правило геометрии увидело на этой ширине: без них проверка выше ничего не мерит
    let fieldsSeen = 0;
    let checksSeen = 0;
    await checkPage('sign-in');
    // Шаг 93: тема действительно та — канва страницы цветом своей темы Primer (`--bgColor-muted`: светлая #f6f8fa, тёмная #151b23)
    assert.equal(await b.evaluate<string>('getComputedStyle(document.body).backgroundColor'), scheme === 'dark' ? 'rgb(21, 27, 35)' : 'rgb(246, 248, 250)', `${scheme} ${width}px: the canvas`);
    await b.click(owner);
    await b.waitText(en.ui.app.worlds);
    await checkPage('workspaces');
    if (narrow) {
      // Шаг 93: шапка телефона вне пространства — знак, язык, тема и выход; немецкие подписи длиннее («Abmelden»); шаг 94 — тема иконкой
      await chooseLanguage(b, de.ui.app.languages.de);
      await b.waitText(de.ui.app.worlds);
      await checkPage('workspaces, German');
      await chooseLanguage(b, de.ui.app.languages.en);
      await b.waitText(en.ui.app.worlds);
    }
    // Гонка теста (шаг 102): заголовок списка появляется раньше карточек — карточка ждётся, а не читается сразу
    await waitFor(b, `document.querySelector('h3 a') !== null`, 'the workspace cards render');
    const world = (await b.evaluate<string>(`document.querySelector('h3 a').getAttribute('href')`)).split('/')[2]!;
    // Шаг 97: страница Competition предложения — те же правила адаптива на каждой ширине и в обеих темах (адрес — из строки Offers)
    {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
      await settled(b, `${width}px products for competition`);
      const competition = await b.evaluate<string | null>(`document.querySelector('.world-content a[href*="/competition/"]')?.getAttribute('href') ?? null`);
      assert.ok(competition, `${width}px: an offer row links its Competition page`);
      await b.evaluate(`(location.hash = ${JSON.stringify(competition)}, true)`);
      await settled(b, `${width}px competition`);
      await checkPage('competition');
    }
    for (const screen of SCREENS) {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${screen}`)}, true)`);
      await settled(b, `${width}px ${screen}`);
      await checkPage(screen);
      fieldsSeen += await b.evaluate<number>(`document.querySelectorAll('.field').length`);
      checksSeen += await b.evaluate<number>(`document.querySelectorAll('.check-field').length`);
    }
    assert.ok(fieldsSeen >= 10 && checksSeen >= 3, `${scheme} ${width}px: the screens show fields of the standard — ${fieldsSeen} fields, ${checksSeen} checkboxes`);
    if (width === 375 && scheme === 'light') {
      // Шаг 97: положительный контроль — прежняя основа flex поля в столбике (18rem) — правило «поле не выше содержимого» краснеет на журнале цен
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed`)}, true)`);
      await settled(b, `${width}px feed, field control`);
      await b.evaluate(`(() => { const st = document.createElement('style'); st.id = 'slack-control'; st.textContent = '.field-toolbar > .field { flex: 0 1 18rem !important; }'; document.head.append(st); return true; })()`);
      const slack = await b.evaluate<string[]>(FIELD_SLACK);
      await b.evaluate(`(document.getElementById('slack-control').remove(), true)`);
      assert.ok(slack.length > 0, 'control: a filter field 18rem tall in a column is caught');
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/costs`)}, true)`);
      await settled(b, `${width}px back to costs`);
    }
    if (width === 1440 && scheme === 'light') {
      // положительный контроль: прежний отступ «карточка после карточки» внутри сетки — правило краснеет на экране остановок
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/stop`)}, true)`);
      await settled(b, `${width}px stop, control`);
      await b.evaluate(`(() => { const st = document.createElement('style'); st.id = 'row-control'; st.textContent = '.cards > .card + .card { margin-top: var(--space-3) !important; }'; document.head.append(st); return true; })()`);
      const bad = await b.evaluate<string[]>(ROW_MISALIGNED);
      await b.evaluate(`(document.getElementById('row-control').remove(), true)`);
      assert.ok(bad.length > 0, 'control: a card pushed down inside a row is caught');
      // положительный контроль стандарта формы: подпись сбоку от поля и галочка высотой поля ввода (так было до шага 94) — правило краснеет
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/inventory`)}, true)`);
      await settled(b, `${width}px stock, form control`);
      for (const css of ['.field { flex-direction: row !important; }', ".check-field > input { min-height: var(--control-h) !important; }"]) {
        await b.evaluate(`(() => { const st = document.createElement('style'); st.id = 'form-control'; st.textContent = ${JSON.stringify(css)}; document.head.append(st); return true; })()`);
        const broken = await b.evaluate<string[]>(FORM_GEOMETRY);
        await b.evaluate(`(document.getElementById('form-control').remove(), true)`);
        assert.ok(broken.length > 0, `control: «${css}» breaks the form standard and the rule sees it`);
      }
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/costs`)}, true)`);
      await settled(b, `${width}px back to costs`);
    }
    // навигация: на узком — выдвижная панель за кнопкой меню, на широком — боковая панель на месте, кнопки меню нет
    const nav = () => b.evaluate<{ menu: boolean; sidebar: boolean; screen: string }>(
      `({ menu: !!document.querySelector('.menu-button')?.checkVisibility({ visibilityProperty: true }), sidebar: document.querySelector('.sidebar').checkVisibility({ visibilityProperty: true }), screen: location.hash.split('/')[3] ?? '' })`);
    if (!narrow) {
      assert.deepEqual(await nav(), { menu: false, sidebar: true, screen: 'costs' }, `${width}px: the side nav stays in place without a menu button`);
      continue;
    }
    assert.deepEqual(await nav(), { menu: true, sidebar: false, screen: 'costs' }, `${width}px: the nav hides behind the menu button`);
    const open = async () => { await b.click(en.ui.app.menu); assert.equal((await nav()).sidebar, true, `${width}px: the menu button opens the drawer`); };
    await open();
    // пункты меню, «← All workspaces», язык и выход видны только в открытой панели — и проверяются в ней
    assert.deepEqual(await b.evaluate<string[]>(SMALL_TARGETS), [], `${width}px, open drawer: touch targets lower than 44px`);
    await b.click(en.ui.app.screens.inventory, '.nav-group a');
    assert.deepEqual(await nav(), { menu: true, sidebar: false, screen: 'inventory' }, `${width}px: choosing an item navigates and closes the drawer`);
    await settled(b, `${width}px stock after the drawer`);
    await open();
    await b.click(en.ui.app.closeMenu);
    assert.equal((await nav()).sidebar, false, `${width}px: the cross closes the drawer`);
    await open();
    await b.evaluate(`(document.querySelector('.nav-backdrop').click(), true)`);
    assert.equal((await nav()).sidebar, false, `${width}px: a click beside the drawer closes it`);
    await open();
    await b.evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true)`);
    assert.equal((await nav()).sidebar, false, `${width}px: Esc closes the drawer`);
    // Положительный контроль [Р-94]: элемент шире окна правило обязано увидеть — иначе проверка выше ничего не мерит
    await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<div id="wide-control" style="width:${width + 200}px;height:1px"></div>'), true)`);
    const control = await b.evaluate<{ scrollWidth: number; width: number; out: string[] }>(PAGE_FIT);
    assert.ok(control.scrollWidth > control.width && control.out.length > 0, `${width}px control: a too-wide element must make the page scroll sideways — ${JSON.stringify(control)}`);
    await b.evaluate(`(document.getElementById('wide-control').remove(), true)`);
  }
  await b.setColorScheme(null);
  await b.setViewport(1440, 900);
  assert.deepEqual(b.errors().slice(before), [], 'the console page threw or logged errors at some width');
});

/**
 * Шаг 86: пункт меню и заголовок его страницы — одни и те же слова (ревью 79: «Why this price» вело на «Price decisions»,
 * «Dangerous changes» — на «What your bounds prevented»). Правило [Р-146] — на каждом пункте навигации, на обоих языках
 */
/**
 * Шаг 86: содержимое не выступает за свою рамку — карточку, плитку, кнопку, пилюлю, пункт меню, панель фильтров (немецкий проход нашёл
 * таблицы в карточках тени, выступавшие за рамку на 7px; немецкие тексты длиннее английских). Листаемое внутри своей рамки — не выступ
 */
const OUT_OF_BOX = `(() => {
  const visible = (el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0;
  const scrollerBetween = (el, stop) => { for (let p = el.parentElement; p && p !== stop; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  const out = [];
  for (const box of document.querySelectorAll('.card, .stats > *, button, .badge, .nav-group a, .toolbar, .verdict, .notice')) {
    if (!visible(box)) continue;
    const bb = box.getBoundingClientRect();
    for (const el of box.querySelectorAll('*')) {
      if (!visible(el) || scrollerBetween(el, box)) continue;
      const b = el.getBoundingClientRect();
      if (b.right > bb.right + 1.5 || b.left < bb.left - 1.5) { out.push(el.tagName.toLowerCase() + ' «' + (el.textContent ?? '').trim().slice(0, 40) + '» sticks out of ' + box.tagName.toLowerCase() + '.' + String(box.className) + ' by ' + Math.round(Math.max(b.right - bb.right, bb.left - b.left)) + 'px'); break; }
    }
  }
  // Шаг 99: таблица в рамке с прокруткой, ушедшая под её левый край (поле карточки шага 86 у таблицы в рамке), — срезана, а не листается:
  // выступ прежняя проверка не видит, он внутри листаемого
  for (const wrap of document.querySelectorAll('.table-wrap')) {
    const table = wrap.firstElementChild;
    if (!table || !visible(wrap) || wrap.scrollLeft !== 0) continue;
    const shift = wrap.getBoundingClientRect().left + wrap.clientLeft - table.getBoundingClientRect().left;
    if (shift > 0.5) out.push(table.tagName.toLowerCase() + '.' + String(table.className) + ' starts under the left edge of its frame by ' + Math.round(shift) + 'px');
  }
  return out.slice(0, 5);
})()`;


/**
 * Шаг 100 (D, находка по скринам владельца): пояс колонки времени — один раз в шапке («When · UTC−4»), строки — коротко, без года и
 * пояса («Oct 17, 15:41»). В испанском и французском разбор месяца не срабатывал, и каждая строка несла полную дату с поясом в две
 * строки. Правило — на каждом пункте меню, на четырёх языках: в колонке, у которой пояс в шапке, нет ни года, ни «UTC»
 */
const LONG_WHEN = `(() => {
  const out = [];
  for (const table of document.querySelectorAll('.world-content table')) {
    const heads = [...table.querySelectorAll('thead th')];
    const col = heads.findIndex((th) => th.querySelector('.th-zone'));
    if (col < 0) continue;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const text = (tr.children[col]?.innerText ?? '').trim();
      if (/\\b\\d{4}\\b|UTC/.test(text)) { out.push(heads[col].innerText.trim() + ': ' + text); break; }
    }
  }
  return out;
})()`;
/**
 * Шаг 96.1 [Р-146]: служебное предложение не повторяется в строках таблицы. Inventory повторял в каждой строке «to publish: N; held by shadow
 * mode: N would be sent (<время>) — nothing was sent; channel has not confirmed yet» — тот же класс, что лента чинила на шаге 84.1. Правило:
 * строка ячейки (по видимым строкам текста) с десятью и больше словами, одинаковая с точностью до чисел, стоит не больше чем в трёх строках
 * одной таблицы. Числа и время различают строки, но не делают предложение своим — поэтому они маскируются
 */
const REPEATED_IN_ROWS = `(() => {
  const out = [];
  for (const table of document.querySelectorAll('.world-content table')) {
    const rows = [...table.querySelectorAll('tbody tr')];
    if (rows.length < 4) continue;
    const seen = new Map();
    for (const tr of rows) {
      // по ячейкам: строка таблицы в innerText склеивает ячейки табуляцией
      const lines = new Set([...tr.querySelectorAll('td')].flatMap((td) => td.innerText.split('\\n')).map((l) => l.trim().replace(/\\d+([.,:]\\d+)*/g, '#'))
        .filter((l) => l.split(/\\s+/).filter((w) => /\\p{L}{2,}/u.test(w) && !w.includes('#')).length >= 10));
      for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    for (const [l, n] of seen) if (n > 3) out.push('×' + n + ' «' + l.slice(0, 100) + '»');
  }
  return out.slice(0, 5);
})()`;

/**
 * Шаг 96.2 [Р-146]: колонка таблицы, у которой на странице все ячейки — одно и то же значение или прочерк, — кандидат на подпись секции
 * или на скрытие: «Held how: set to the floor» в каждой строке, «Beyond bound» из одних прочерков. Колонка без заголовка (действия,
 * выбор строки) не считается; числовая колонка (`th.num`) — только если она целиком из прочерков: одинаковые суммы — данные (у демо пол
 * $14.00 у всех предложений amazon.com), а не служебный текст. Таблица меньше трёх строк не судится
 */
const CONSTANT_COLUMNS = `(() => {
  const out = [];
  for (const table of document.querySelectorAll('.world-content table')) {
    const rows = [...table.querySelectorAll('tbody tr')].filter((tr) => tr.querySelectorAll('td').length > 1);
    if (rows.length < 3) continue;
    [...table.querySelectorAll('thead th')].forEach((th, c) => {
      const head = th.innerText.trim().replace(/\\s+/g, ' ');
      if (!head) return;
      const cells = rows.map((tr) => tr.children[c]);
      if (cells.some((td) => !td)) return;
      const values = cells.map((td) => td.innerText.trim().replace(/\\s+/g, ' ')).filter((v) => v !== '' && !/^[–—-]$/.test(v));
      if (values.length === 0) out.push('«' + head + '»: every cell is a dash');
      else if (!th.classList.contains('num') && values.length === cells.length && new Set(values).size === 1) out.push('«' + head + '»: every cell is «' + values[0].slice(0, 50) + '»');
    });
  }
  return out;
})()`;

test('step 86, step 98 (Р-223): every menu item and the heading of its page are the same words — English, German, Spanish and French; no English dictionary string on a Spanish or French screen', async () => {
  const b = browser!;
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  // Шаг 93: правило — в обеих темах
  for (const scheme of ['light', 'dark'] as const) {
  await b.setColorScheme(scheme);
  for (const m of [en, de, es, fr]) {
    if (m !== en) {
      // Имя языка в переключателе — его собственное (Deutsch, Español, Français) и одинаково во всех словарях
      await chooseLanguage(b, en.ui.app.languages[m.locale]);
      await b.waitText(m.ui.app.screens.feed);
    }
    // Шаг 98: непереведённая строка — один прогон на язык (светлая тема), на каждом экране меню
    const english = scheme === 'light' && (m === es || m === fr) ? englishOnly(m) : null;
    const untranslated: string[] = [];
    const links = await b.evaluate<Array<{ text: string; href: string }>>(
      `[...document.querySelectorAll('.nav-group a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
    // Шаг 95 [Р-217]: девять пунктов и Omnibus — у смоук-мира витрины ЕС
    assert.deepEqual(links.map((l) => l.href.split('/')[3]), [...MENU_US.slice(0, 8), 'compliance', 'stop'], `${m.locale}: the menu of nine items and Omnibus`);
    assert.ok(links.some((l) => l.text === m.ui.app.screens.feed), `${m.locale}: the navigation speaks the screen language`);
    const mismatches: string[] = [];
    for (const l of links) {
      await b.evaluate(`(location.hash = ${JSON.stringify(l.href)}, true)`);
      await settled(b, `${m.locale} ${l.text}`);
      const heading = await b.evaluate<string>(`(document.querySelector('.world-content h2') ?? document.querySelector('.world-content h3'))?.childNodes[0]?.textContent?.trim() ?? ''`);
      if (heading !== l.text) mismatches.push(`«${l.text}» → «${heading}»`);
      assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${m.locale} ${l.text}: content sticks out of its frame`);
      assert.deepEqual(await b.evaluate<string[]>(REPEATED_IN_ROWS), [], `${m.locale} ${l.text}: a service sentence repeats in the rows of a table`);
      assert.deepEqual(await b.evaluate<string[]>(LONG_WHEN), [], `${m.locale} ${l.text}: a row of a time column carries the year or the zone`);
      if (english) for (const t of await b.evaluate<string[]>(UNTRANSLATED(english))) untranslated.push(`${l.text}: ${t}`);
    }
    assert.deepEqual(mismatches, [], `${scheme} ${m.locale}: a menu item leads to a page with another heading`);
    if (english) {
      assert.ok(english.length > 500, `${m.locale}: the rule knows the English strings (${english.length})`);
      assert.deepEqual(untranslated, [], `${m.locale}: an English dictionary string on the screen`);
      // Положительный контроль [Р-94]: английская строка словаря, вставленная в экран этого языка, — находка правила
      await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<p id="untranslated-control">' + ${JSON.stringify(en.ui.app.screens.feed)} + '</p><button id="untranslated-aria" aria-label=' + ${JSON.stringify(JSON.stringify(en.ui.app.screens.strategies))} + '>x</button>'), true)`);
      assert.deepEqual(await b.evaluate<string[]>(UNTRANSLATED(english)), [en.ui.app.screens.feed, `aria-label: ${en.ui.app.screens.strategies}`], `${m.locale}: the control is seen`);
      await b.evaluate(`(document.getElementById('untranslated-control').remove(), document.getElementById('untranslated-aria').remove(), true)`);
    }
  }
  await chooseLanguage(b, fr.ui.app.languages.en);
  await b.waitText(en.ui.app.screens.feed);
  }
  await b.setColorScheme(null);
  // Положительный контроль шага 100 (D): строка колонки с поясом в шапке, несущая полную дату, — находка правила
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<table id="when-control"><thead><tr><th>Cuándo<span class="th-zone"> · UTC−4</span></th></tr></thead><tbody><tr><td>oct 17, 2026, 17:30 UTC−4</td></tr></tbody></table>'), true)`);
  assert.deepEqual(await b.evaluate<string[]>(LONG_WHEN), ['Cuándo · UTC−4: oct 17, 2026, 17:30 UTC−4']);
  await b.evaluate(`(document.getElementById('when-control').remove(), true)`);
  // Положительный контроль [Р-94]: таблица, растянутая за поля карточки, как была до шага 86, — выступ, и правило его видит
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<section class="card" id="out-control"><table style="margin: 0 -24px; width: calc(100% + 48px)"><tbody><tr><td>control</td></tr></tbody></table></section>'), true)`);
  assert.match((await b.evaluate<string[]>(OUT_OF_BOX)).join(' | '), /sticks out of section\.card by 7px/);
  await b.evaluate(`(document.getElementById('out-control').remove(), true)`);
  // Положительный контроль шага 99: таблица в рамке внутри карточки с полем карточки шага 86 (как журнал импортов до правки) — срезана слева
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<section class="card" id="frame-control"><div class="table-wrap"><table class="frame-control" style="margin: 0 -16px; width: calc(100% + 32px)"><tbody><tr><td>control</td></tr></tbody></table></div></section>'), true)`);
  assert.match((await b.evaluate<string[]>(OUT_OF_BOX)).join(' | '), /table\.frame-control starts under the left edge of its frame by 16px/);
  await b.evaluate(`(document.getElementById('frame-control').remove(), true)`);
  // Положительный контроль правила повторов: прежняя строка канала Inventory (шаг 96) в четырёх строках с разными числами и временем —
  // повтор; три таких строки — ещё нет
  const old = (n: number, at: string) => `${en.ui.stock.channel.published(n)}; ${en.ui.stock.channel.heldInShadow(n, at)}; ${en.ui.stock.channel.notConfirmed}`;
  const table = (k: number) => `<table id="repeat-control"><tbody>${Array.from({ length: k }, (_, i) => `<tr><td>Offer ${i}</td><td><div>${old(50 + i, `Oct ${10 + i}, 2026, 0${i}:31 UTC−4`)}</div></td></tr>`).join('')}</tbody></table>`;
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', ${JSON.stringify(table(4))}), true)`);
  assert.match((await b.evaluate<string[]>(REPEATED_IN_ROWS)).join(' | '), /^×4 «to publish: #; held by shadow mode: # would be sent/);
  await b.evaluate(`(document.getElementById('repeat-control').remove(), document.querySelector('.world-content').insertAdjacentHTML('beforeend', ${JSON.stringify(table(3))}), true)`);
  assert.deepEqual(await b.evaluate<string[]>(REPEATED_IN_ROWS), [], 'three rows are not yet a repeat');
  await b.evaluate(`(document.getElementById('repeat-control').remove(), true)`);
});

/**
 * Шаг 95 [Р-217]: меню из 9 пунктов вместо 14 — функции не исчезают, исчезают лишние двери. Прежние адреса (закладки, ссылки из писем,
 * старые вкладки) ведут на новые места, к нужному разделу, заменой адреса: «назад» не возвращает на перенаправление. Квитанция решения
 * «Why this price» и страница предложения «Bounds and price floor» остаются своими адресами, пункт меню над ними — журнал цен и Costs & floors
 */
const OLD_ROUTES: ReadonlyArray<readonly [string, string, string]> = [
  ['decisions', 'feed/decisions', 'feed'], ['rejected', 'protections/rules', 'protections'], ['dangerous', 'protections/rules', 'protections'],
  ['dangerous/30', 'protections/rules/30', 'protections'], ['bounds', 'costs', 'costs'], ['cost-import', 'costs/import', 'costs'],
  ['connections', 'channels/accounts', 'channels'], ['onboarding', 'channels', 'channels'], ['jobs', 'products/bulk', 'products'],
  // Шаг 96 (аудит В19): страница остатков — Inventory
  ['stock', 'inventory', 'inventory'],
];

test('step 95 (Р-217): nine menu items; every old address leads to its new place and section; a decision receipt and an offer page keep their addresses', async () => {
  const b = browser!;
  const before = b.errors().length;
  await b.setViewport(1440, 900);
  await b.setColorScheme(null);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  const go = async (to: string) => { await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${to}`)}, true)`); };
  const at = () => b.evaluate<string>(`location.hash.split('/').slice(3).join('/')`);
  const waitAt = async (want: string) => { for (let i = 0; i < 50 && (await at()) !== want; i++) await new Promise((r) => setTimeout(r, 100)); return at(); };
  const page = () => b.evaluate<{ heading: string; active: string | null }>(`({ heading: document.querySelector('.world-content h2')?.textContent.trim() ?? '',
    active: document.querySelector('.nav-group a.active')?.getAttribute('href').split('/')[3] ?? null })`);
  const headingOf: Record<string, string> = { feed: en.ui.app.screens.feed, protections: en.ui.app.screens.protections, costs: en.ui.app.screens.costs, channels: en.ui.app.screens.channels, products: en.ui.jobs.pageTitle, inventory: en.ui.app.screens.inventory };
  for (const [old, to, menu] of OLD_ROUTES) {
    await go('inventory');
    await settled(b, 'inventory');
    await go(old);
    assert.equal(await waitAt(to), to, `«${old}» leads to «${to}»`);
    await settled(b, to);
    assert.deepEqual(await page(), { heading: headingOf[menu]!, active: menu }, `«${old}»: the page and its menu item`);
    // Раздел, к которому ведёт адрес, — под шапкой окна, а не ниже первого экрана
    const section = to === 'costs/import' ? 'cost-import' : to === 'channels/accounts' ? 'channel-accounts' : null;
    if (section) {
      // короткая страница до верха не прокручивается — тогда раздел в окне, а страница прокручена до конца
      const where = () => b.evaluate<{ top: number; bottom: boolean; height: number }>(`(() => { const r = document.getElementById(${JSON.stringify(section)}).getBoundingClientRect();
        return { top: Math.round(r.top), bottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1, height: window.innerHeight }; })()`);
      let w = await where();
      for (let i = 0; i < 30 && !(w.top >= 0 && (w.top < 200 || w.bottom)); i++) { await new Promise((r) => setTimeout(r, 100)); w = await where(); }
      assert.ok(w.top >= 0 && w.top < w.height - 100 && (w.top < 200 || w.bottom), `«${old}»: the section «${section}» is in the window — ${JSON.stringify(w)}`);
    }
    // «Назад» ведёт туда, откуда пришли, а не на прежний адрес (он перенаправил бы снова)
    await b.evaluate('(history.back(), true)');
    assert.equal(await waitAt('inventory'), 'inventory', `«${old}»: back returns to the page before, not to the redirect`);
  }
  // Положительный контроль: без раздела в адресе страница остаётся наверху — условие «раздел в окне» выше само собой не выполняется
  await go('costs');
  await settled(b, 'costs, top');
  const plain = await b.evaluate<{ top: number; scrollY: number }>(`({ top: Math.round(document.getElementById('cost-import').getBoundingClientRect().top), scrollY: Math.round(window.scrollY) })`);
  assert.ok(plain.scrollY === 0 && plain.top >= 200, `control: «costs» without a section stays at the top — ${JSON.stringify(plain)}`);
  // Положительный контроль: неизвестный адрес — «не найдено», а не перенаправление
  await go('nonsense');
  await settled(b, 'nonsense');
  assert.equal((await b.evaluate<string>(`document.querySelector('.world-content h2')?.textContent.trim() ?? ''`)), en.ui.app.notFoundTitle);
  // Журнал цен: вид «All decisions» — фильтр Kind; строки ведут на квитанцию «Why this price» своим адресом, пункт меню — журнал
  await go('feed');
  await settled(b, 'feed');
  await b.evaluate(`(() => { const s = [...document.querySelectorAll('.toolbar select')].find((x) => [...x.options].some((o) => o.value === 'decisions'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'decisions'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.equal(await waitAt('feed/decisions'), 'feed/decisions', 'Kind «All decisions» switches the journal');
  await settled(b, 'feed/decisions');
  const fields = await b.evaluate<string[]>(`[...document.querySelectorAll('.toolbar .field-label')].map((l) => l.textContent.trim())`);
  // Шаг 96: у решений — период и исход (вариант шага 95 принят); статус — только у записей
  assert.deepEqual(fields, [en.ui.feed.kind.label, en.ui.period.label, en.ui.feed.filters.offer, en.ui.feed.outcome.label], 'decisions: kind, period, offer and outcome — status belongs to price writes');
  const receipt = await b.evaluate<string>(`document.querySelector('.world-content table a.row-link').getAttribute('href')`);
  await b.evaluate(`(location.hash = ${JSON.stringify(receipt)}, true)`);
  await settled(b, 'receipt');
  assert.match(await at(), /^decisions\/[^/]+$/, 'the receipt keeps its address');
  assert.deepEqual(await b.evaluate<{ heading: string; active: string | null }>(`({ heading: document.querySelector('.world-content h2')?.textContent.trim() ?? '', active: document.querySelector('.nav-group a.active')?.getAttribute('href').split('/')[3] ?? null })`),
    { heading: en.ui.trace.pageTitle, active: 'feed' }, 'the receipt «Why this price» under Price changes');
  // Страница предложения — своим адресом под Costs & floors
  await go('costs');
  await settled(b, 'costs');
  await b.evaluate(`(location.hash = document.querySelector('.world-content table a.row-link').getAttribute('href'), true)`);
  await settled(b, 'offer bounds');
  assert.match(await at(), /^bounds\/[^/]+$/);
  assert.deepEqual(await page(), { heading: en.ui.bounds.pageTitle, active: 'costs' }, 'the offer page «Bounds and price floor» under Costs & floors');
  // Protections: вкладки «Stopped by people» и «Prevented by rules»; витрина «пол удержал» — сверху вкладки правил
  await go('protections');
  await settled(b, 'protections');
  const tabs = await b.evaluate<string[]>(`[...document.querySelectorAll('.protections > nav.tabs a')].map((a) => a.textContent.trim() + (a.classList.contains('active') ? ' *' : ''))`);
  assert.deepEqual(tabs, [en.ui.protections.people, `${en.ui.protections.rules} *`]);
  assert.match(await b.evaluate<string>(`document.querySelector('.protections .summary-card .headline').textContent`), /^The floor /, 'the floor showcase opens the rules tab');
  await b.click(en.ui.protections.people, '.protections > nav.tabs a');
  assert.equal(await waitAt('protections/people'), 'protections/people');
  await settled(b, 'protections/people');
  // Offers: «Bulk operations» (шаг 96, было «Bulk edit») открывает массовые операции, пункт меню — Offers
  await go('products');
  await settled(b, 'products');
  await b.click(en.ui.products.bulkEdit, 'a.button-link');
  assert.equal(await waitAt('products/bulk'), 'products/bulk');
  await settled(b, 'bulk');
  assert.deepEqual(await page(), { heading: en.ui.jobs.pageTitle, active: 'products' });
  // Channels: шаг 96 (аудит Б15) — аккаунты первыми; путь подключения, который ещё идёт (у смоук-мира путь не выбран), — чеклистом под ними
  await go('channels');
  await settled(b, 'channels');
  assert.ok(await b.evaluate<boolean>(`(() => { const s = document.querySelector('.setup-section'), a = document.getElementById('channel-accounts');
    return !!s && !!a && s.getBoundingClientRect().top > a.getBoundingClientRect().top; })()`), 'the channel accounts come first, the unfinished setup checklist below them');
  assert.deepEqual(b.errors().slice(before), [], 'the console page threw or logged errors');
});

/**
 * Шаг 96 (аудит): иконки меню — разные (Octicons, сверку с пакетом держит design-tokens.test.ts); поиск журнала цен фильтрует саму
 * таблицу по мере ввода (Б11); вкладка «Prevented by rules» — страницы по 50 и одинаковые удержания одной строкой «×N» (Б12)
 */
test('step 96: menu icons differ; the price journal search filters the table as you type; Prevented by rules pages by 50 and collapses repeats', async () => {
  const b = browser!;
  const before = b.errors().length;
  await b.setViewport(1440, 900);
  await b.setColorScheme(null);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  // Иконки: у каждого пункта своя (первый путь иконки различает их), всего пунктов с иконкой — столько же, сколько пунктов
  const icons = await b.evaluate<string[]>(`[...document.querySelectorAll('.nav-group a')].map((a) => a.querySelector('svg.octicon path')?.getAttribute('d') ?? '')`);
  assert.ok(icons.length >= 9 && icons.every((d) => d.length > 10), `every menu item has an Octicon — ${icons.length}`);
  assert.equal(new Set(icons).size, icons.length, 'menu icons are unique');
  // Поиск фильтрует таблицу по мере ввода: несуществующее слово — пустая таблица, часть SKU — только её строки
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed`)}, true)`);
  await settled(b, 'feed');
  const rows = () => b.evaluate<string[]>(`[...document.querySelectorAll('.journal-table table.feed tbody tr')].map((r) => r.querySelector('.offer').textContent.trim())`);
  const all = await rows();
  assert.ok(all.length >= 1, `the journal of the smoke world has rows — ${all.length}`);
  const type = (text: string) => b.evaluate(`(() => { const i = document.querySelector('.filters .offer-picker input[type=search]'); i.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const waitRows = async (ok: (r: string[]) => boolean) => { let r = await rows(); for (let i = 0; i < 50 && !ok(r); i++) { await new Promise((x) => setTimeout(x, 100)); r = await rows(); } return r; };
  await type('zzz-no-such-offer');
  assert.deepEqual(await waitRows((r) => r.length === 0), [], 'a search that matches nothing empties the table');
  assert.equal(await b.evaluate<string>(`document.activeElement?.getAttribute('type') ?? ''`), 'search', 'the search field keeps the focus while the table reloads');
  const fragment = all[0]!.split(' · ')[0]!.slice(-4);
  await type(fragment);
  const found = await waitRows((r) => r.length > 0);
  assert.ok(found.length > 0 && found.every((r) => r.toLowerCase().includes(fragment.toLowerCase())), `rows of «${fragment}» — ${JSON.stringify(found)}`);
  // Строка журнала ведёт на квитанцию целиком (Б17)
  await b.evaluate(`(document.querySelector('.journal-table table.feed tbody tr.row-clickable td.offer').click(), true)`);
  for (let i = 0; i < 30 && !(await b.evaluate<string>('location.hash')).includes('/decisions/'); i++) await new Promise((x) => setTimeout(x, 100));
  assert.match(await b.evaluate<string>('location.hash'), /\/decisions\/[^/]+$/, 'a click on the row opens the decision receipt');
  // Prevented by rules: 130 удержаний → 107 строк (24 одинаковых — одной строкой «×24»), по 50 на странице
  syntheticDangerous = syntheticFloorReport(world);
  try {
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/protections/rules`)}, true)`);
    await settled(b, 'protections');
    const holdRows = () => b.evaluate<number>(`document.querySelector('.protections table.sticky-end tbody')?.querySelectorAll('tr').length ?? 0`);
    for (let i = 0; i < 50 && (await holdRows()) === 0; i++) await new Promise((x) => setTimeout(x, 100));
    assert.equal(await holdRows(), 50, 'the first page shows 50 rows');
    const first = await b.evaluate<string>(`document.querySelector('.protections table.sticky-end tbody tr').innerText`);
    // шаг 96.2 (B): повтор — чипом «×N · период» (было «×24 in the last 7 days»)
    assert.match(first, /×24 · 7d/, `repeats collapse into one row — ${first}`);
    const pager = () => b.evaluate<string>(`document.querySelector('.protections .local-pager span')?.textContent ?? ''`);
    assert.equal(await pager(), en.ui.protections.pageOf(1, 50, 107));
    await b.click(en.ui.feed.next, '.protections .local-pager button');
    assert.equal(await pager(), en.ui.protections.pageOf(51, 100, 107));
    await b.click(en.ui.feed.next, '.protections .local-pager button');
    assert.equal(await holdRows(), 7, 'the last page shows the 7 rows left');
  } finally {
    syntheticDangerous = null;
  }
  assert.deepEqual(b.errors().slice(before), [], 'the console page threw or logged errors');
});

/**
 * Шаг 96.1 (решение владельца): период — один контрол диапазона. Кнопка показывает даты; календарь — два месяца рядом (на телефоне — лист во
 * весь экран и один месяц), пресеты слева, Apply / Cancel внизу; диапазон — двумя нажатиями; конец раньше начала — живая подсказка и
 * Apply недоступна; стрелки двигают фокус по дням, Esc закрывает без изменений; цвета — токены Primer в обеих темах. Подпись «Period» —
 * метка самой кнопки (стандарт Field). Разделы меню из одного пункта — без заголовка
 */
test('step 96.1: the period is one date-range control — dates on the button, two months, presets, two clicks, the end never before the start, keyboard, aria, both themes, a sheet on a phone; menu sections of one item have no title', async () => {
  const b = browser!;
  const before = b.errors().length;
  await b.setViewport(1440, 900);
  await b.setColorScheme('light');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  // Меню: у раздела из одного пункта заголовка нет, у остальных — есть
  const groups = await b.evaluate<Array<{ title: string | null; items: number }>>(`[...document.querySelectorAll('.nav-group')].map((g) => ({ title: g.querySelector('.group-title')?.textContent.trim() ?? null, items: g.querySelectorAll('a').length }))`);
  assert.ok(groups.every((g) => (g.items === 1) === (g.title === null)), `a title only above a section of several items — ${JSON.stringify(groups)}`);
  assert.deepEqual(groups.filter((g) => g.items === 1).length, 2, `Overview and Inventory are sections of one item — ${JSON.stringify(groups)}`);
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed`)}, true)`);
  await settled(b, 'feed');
  const trigger = () => b.evaluate<{ text: string; expanded: string | null; label: string | null; focused: boolean }>(`(() => { const x = document.querySelector('.drp-trigger');
    const l = document.querySelector('label[for="' + x.id + '"]'); return { text: x.textContent.trim(), expanded: x.getAttribute('aria-expanded'), label: l?.textContent.trim() ?? null, focused: document.activeElement === x }; })()`);
  const state = () => b.evaluate<{ dialog: string | null; months: number; focused: string | null; today: string | null; hint: string; applyOff: boolean; selected: string[]; presets: string[] }>(`(() => ({
    dialog: document.querySelector('.drp-pop[role="dialog"]')?.getAttribute('aria-label') ?? null,
    months: document.querySelectorAll('.drp-month table[role="grid"]').length,
    focused: document.activeElement?.dataset?.day ?? null,
    today: document.querySelector('.drp-day[aria-current="date"]')?.dataset.day ?? null,
    hint: (document.querySelector('.drp-hint')?.firstChild?.textContent ?? '').trim(),
    applyOff: !!document.querySelector('.drp-foot button.primary')?.disabled,
    selected: [...document.querySelectorAll('.drp-month td[aria-selected="true"] button')].map((x) => x.dataset.day),
    presets: [...document.querySelectorAll('.drp-presets button')].map((x) => x.textContent.trim()),
  }))()`);
  const openIt = () => b.evaluate(`(document.querySelector('.drp-trigger').click(), true)`);
  const day = (d: string) => b.evaluate(`(document.querySelector('.drp-day[data-day="${d}"]').click(), true)`);
  const key = (k: string) => b.evaluate(`(document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })), true)`);
  const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const short = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${d}T00:00:00Z`));
  const full = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${d}T00:00:00Z`));
  const range = (a: string, z: string) => `${a.slice(0, 4) === z.slice(0, 4) ? short(a) : full(a)} – ${full(z)}`;
  const t = en.ui.period;
  const closed = await trigger();
  assert.equal(closed.label, t.label, 'the field label «Period» labels the button itself');
  assert.equal(closed.expanded, 'false');
  assert.match(closed.text, /^Last 7 days · [A-Z][a-z]{2} \d{1,2}(, \d{4})? – [A-Z][a-z]{2} \d{1,2}, \d{4}$/, `the button shows the dates — ${closed.text}`);
  assert.equal(await b.evaluate<number>(`document.querySelectorAll('.world-content input[type="date"]').length`), 0, 'no native date fields any more');
  await openIt();
  let s1 = await state();
  const today = s1.today!;
  assert.deepEqual([s1.dialog, s1.months, s1.focused, (await trigger()).expanded, s1.presets], [t.dialog, 2, today, 'true', [t.presetsLong['24h'], t.presetsLong['7d'], t.presetsLong['30d']]],
    'open: a dialog of two months, the focus on today, presets on the left');
  assert.ok(s1.selected.length >= 7 && s1.selected.includes(today), `the last 7 days are marked selected — ${s1.selected.length}`);
  // клавиатура: стрелки двигают фокус по дням и неделям
  await key('ArrowLeft');
  assert.equal((await state()).focused, add(today, -1), 'ArrowLeft — the day before');
  await key('ArrowUp');
  assert.equal((await state()).focused, add(today, -8), 'ArrowUp — a week earlier');
  // два нажатия; конец раньше начала — подсказка, Apply недоступна
  const [a, early, z] = [add(today, -3), add(today, -5), add(today, -1)];
  await day(a);
  s1 = await state();
  assert.deepEqual([s1.hint, s1.applyOff, s1.selected], [t.pickEnd(full(a)), true, [a]], 'the first click starts the range');
  await day(early);
  s1 = await state();
  assert.deepEqual([s1.hint, s1.applyOff], [t.endBeforeStart(full(a)), true], 'an end before the start is refused in words, live');
  assert.equal(await b.evaluate<string | null>(`document.querySelector('.drp-hint').getAttribute('aria-live')`), 'polite');
  await day(z);
  s1 = await state();
  assert.deepEqual([s1.hint, s1.applyOff, s1.selected], [t.chosen(range(a, z)), false, [a, add(a, 1), z]], 'the second click closes the range');
  await b.evaluate(`(document.querySelector('.drp-foot button.primary').click(), true)`);
  await settled(b, 'feed after apply');
  assert.deepEqual([(await state()).dialog, (await trigger()).text], [null, range(a, z)], 'Apply closes the calendar; the button shows the chosen dates');
  assert.ok(await b.evaluate<boolean>(`[...performance.getEntriesByType('resource')].some((e) => e.name.includes('/feed?') && e.name.includes('from=${a}') && e.name.includes('to=${z}'))`),
    'the journal is read for the chosen days');
  // Esc закрывает без изменений и возвращает фокус на кнопку; пресет — одним нажатием и Apply
  await openIt();
  await b.evaluate(`(document.querySelector('.drp-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  const afterEsc = await trigger();
  assert.deepEqual([(await state()).dialog, afterEsc.text, afterEsc.focused], [null, range(a, z), true], 'Escape closes without a change, the focus is back on the button');
  // цвета — токены Primer: начало и конец диапазона — заливка акцента своей темы
  const edge = () => b.evaluate<{ bg: string; accent: string }>(`(() => { const probe = document.createElement('span'); probe.style.background = 'var(--accent-emphasis)'; document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor; probe.remove(); return { bg: getComputedStyle(document.querySelector('.drp-day.edge')).backgroundColor, accent }; })()`);
  await openIt();
  const light = await edge();
  assert.equal(light.bg, light.accent, 'light: the ends of the range are the accent of the light theme');
  await b.evaluate(`(document.querySelector('.drp-foot button:not(.primary)').click(), true)`);
  await b.setColorScheme('dark');
  await openIt();
  const dark = await edge();
  assert.ok(dark.bg === dark.accent && dark.bg !== light.bg, `dark: the accent of the dark theme — ${JSON.stringify({ light, dark })}`);
  await b.evaluate(`(document.querySelector('.drp-foot button:not(.primary)').click(), true)`);
  // телефон: шаг 100 (B) — нижняя панель во всю ширину (проверяет тест шага 100); здесь — один месяц и дни 44 px
  await b.setViewport(375, 812);
  await openIt();
  assert.deepEqual(await b.evaluate<number[]>(`[document.querySelectorAll('.drp-month').length, Math.round(Math.min(document.querySelector('.drp-day').getBoundingClientRect().width, document.querySelector('.drp-day').getBoundingClientRect().height))]`), [1, 44],
    'a phone gets one month and 44px days');
  await b.evaluate(`(document.querySelector('.drp-foot button:not(.primary)').click(), true)`);
  await b.setViewport(1440, 900);
  await b.setColorScheme(null);
  assert.deepEqual(b.errors().slice(before), [], 'the console page threw or logged errors');
});

/**
 * Шаг 96.2: правила таблиц — на всех экранах консоли (мир смоука, Protections — на отчёте как у демо). Срабатывания вне Protections в
 * этом шаге не правятся — они названы здесь поимённо и в docs/deferred.md (строки «96.2»); список только сокращается: новое срабатывание
 * и исчезнувшее старое — оба красные
 */
const KNOWN_TABLE_FINDINGS: Readonly<Record<string, readonly string[]>> = {
  // docs/deferred.md, «96.2»: таблица трёх видов остановки — колонка «Active» из одних нулей (в мире без остановок)
  stop: ['«Active»: every cell is «0»'],
};
const TABLE_ROUTES = ['shadow', 'feed', 'feed/decisions', 'strategies', 'costs', 'costs/import', 'protections/people', 'protections/rules', 'products', 'products/bulk',
  'inventory', 'channels', 'channels/accounts', 'compliance', 'stop'];

test('step 96.2: no service sentence repeats and no column is one value on any console screen; Prevented by rules — one state pill, one price history, short reasons with a ×N chip, stat chips, reason filters', async () => {
  const b = browser!;
  const before = b.errors().length;
  await b.setViewport(1440, 900);
  await b.setColorScheme('light');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  syntheticDangerous = demoLikeFloorReport(world);
  syntheticRejected = demoLikeRejected(world);
  try {
    const visit = async (route: string) => {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${route}`)}, true)`);
      await settled(b, route);
      await new Promise((x) => setTimeout(x, 300));
    };
    const findings = async () => [...await b.evaluate<string[]>(REPEATED_IN_ROWS), ...await b.evaluate<string[]>(CONSTANT_COLUMNS)];
    // 1) оба правила на каждом экране; квитанция решения и страница предложения — тоже
    const found: Record<string, string[]> = {};
    for (const route of TABLE_ROUTES) {
      await visit(route);
      const f = await findings();
      if (f.length) found[route] = f;
    }
    await visit('feed/decisions');
    const receipt = await b.evaluate<string | null>(`document.querySelector('.world-content table a.row-link')?.getAttribute('href') ?? null`);
    if (receipt) { await b.evaluate(`(location.hash = ${JSON.stringify(receipt)}, true)`); await settled(b, 'receipt'); const f = await findings(); if (f.length) found['decisions/<id>'] = f; }
    await visit('costs');
    const bounds = await b.evaluate<string | null>(`document.querySelector('.world-content table a.row-link')?.getAttribute('href') ?? null`);
    if (bounds) { await b.evaluate(`(location.hash = ${JSON.stringify(bounds)}, true)`); await settled(b, 'bounds page'); const f = await findings(); if (f.length) found['bounds/<id>'] = f; }
    // Шаг 97 [I5]: страница Competition предложения — ссылкой из строки Offers, те же правила таблиц; меню остаётся из девяти пунктов
    await visit('products');
    const competition = await b.evaluate<string | null>(`[...document.querySelectorAll('.world-content table a.secondary-link')].find((a) => a.textContent.trim() === ${JSON.stringify(en.ui.competition.link)})?.getAttribute('href') ?? null`);
    assert.ok(competition, 'every offer row links its Competition page');
    await b.evaluate(`(location.hash = ${JSON.stringify(competition)}, true)`);
    await settled(b, 'competition page');
    assert.equal(await b.evaluate<string>(`document.querySelector('.world-content h2')?.textContent.trim() ?? ''`), en.ui.competition.pageTitle);
    assert.equal(await b.evaluate<string>(`document.querySelector('.nav-group a.active')?.getAttribute('href')?.split('/')[3] ?? ''`), 'products', 'the Competition page belongs to Offers — no menu item of its own');
    { const f = await findings(); if (f.length) found['competition/<id>'] = f; }
    assert.deepEqual([found['protections/rules'] ?? [], found['protections/people'] ?? []], [[], []], `Protections: tables say each thing once — ${JSON.stringify(found)}`);
    const elsewhere = Object.fromEntries(Object.entries(found).filter(([r]) => !r.startsWith('protections')));
    assert.deepEqual(elsewhere, KNOWN_TABLE_FINDINGS, 'findings outside Protections are exactly the known list of docs/deferred.md (it only shrinks)');

    // 2) Prevented by rules — по пунктам задания; решение владельца по G2: одно значение у всей страницы — фразой подписи, а не колонкой
    await visit('protections/rules');
    const r = en.ui.rejected;
    const also = () => b.evaluate<Array<{ pills: string[]; history: string; wanted: string; set: string; reason: string | null }>>(`[...document.querySelectorAll('table.also-stopped tbody tr')].map((tr) => ({
      pills: [...tr.querySelectorAll('.badge')].map((x) => x.textContent.trim()), history: tr.querySelector('td.history')?.innerText.trim() ?? '',
      wanted: tr.querySelector('td.history s')?.textContent.trim() ?? '', set: tr.querySelector('td.history strong')?.textContent.trim() ?? '',
      reason: tr.querySelector('td.reason-cell')?.innerText.trim() ?? null }))`);
    const caption = () => b.evaluate<{ state: string | null; reason: string | null }>(`(() => { const c = document.querySelector('.also-caption'); return {
      state: c?.querySelector('.uniform-state .badge')?.textContent.trim() ?? null, reason: c?.querySelector('.uniform-reason')?.textContent.trim() ?? null }; })()`);
    const heads = () => b.evaluate<string[]>(`[...document.querySelectorAll('table.also-stopped thead th')].map((th) => th.innerText.trim().replace(/\\s+/g, ' '))`);
    let rows = await also();
    assert.equal(rows.length, 24, 'the 144 corrections collapse into 24 rows (12 offers, two reasons)');
    // C: все строки «corrected» — состояние одной пилюлей в подписи, колонки и пилюль в строках нет
    assert.deepEqual([(await caption()).state, rows.every((x) => x.pills.length === 0), (await heads()).includes(r.stateColumn)], [r.interventions.CORRECTED, true, false],
      'C: one state for every row — a pill in the caption, not a column of identical pills');
    assert.deepEqual([rows[0]!.history, rows[0]!.wanted, rows[0]!.set], ['€18.50 → €12.49 → €14.00', '€12.49', '€14.00'], 'A: one price history, the refused target struck, the result bold');
    assert.ok((await heads()).some((h) => h.includes(r.historyLegend)), `A: the legend once in the head — ${JSON.stringify(await heads())}`);
    assert.ok(!(await heads()).includes(r.columns.deviation), 'A: no «Beyond bound» column without a dangerous case');
    // B: две причины на странице — категория и чип в строке; полного предложения в строках нет
    assert.ok(rows.every((x) => x.reason !== null && !x.reason.includes('The target from competitor prices') && !x.reason.includes('the Price Gate refused')), 'B: the full sentence is not in the rows');
    assert.match(rows[0]!.reason!, /^Target capped at your minimum price\s*×11 · 7d$/, `B: a short category and a ×N chip — ${rows[0]!.reason}`);
    assert.equal(rows[23]!.reason, 'Below your minimum price', 'B: a single occurrence has no chip');
    // E: счётчики периода — чипами, все категории видны, ненулевые — акцентом
    const chips = await b.evaluate<Array<{ text: string; on: boolean }>>(`[...document.querySelectorAll('.stat-chips .stat-chip')].map((c) => ({ text: c.innerText.replace(/\\s+/g, ' ').trim(), on: c.classList.contains('on') }))`);
    // Шаг 102: восьмая категория — «пол выше потолка» (уточнение владельца: замороженный товар виден, а не прячется в «границу не вычислить»)
    assert.equal(chips.length, 8, `E: eight categories, zeros too — ${JSON.stringify(chips)}`);
    assert.ok(chips.every((c) => /\s\d+$/.test(c.text)), `E: every category carries its number — ${JSON.stringify(chips)}`);
    assert.deepEqual(chips.filter((c) => c.on).map((c) => c.text), [`${r.stats.corrected} 144`], 'E: only non-zero chips are accented');
    // F: группы причин — фильтры таблицы
    const filters = () => b.evaluate<Array<{ text: string; pressed: string | null }>>(`[...document.querySelectorAll('.reason-filters button.reason-filter')].map((x) => ({ text: x.innerText.replace(/\\s+/g, ' ').trim(), pressed: x.getAttribute('aria-pressed') }))`);
    const press = (i: number) => b.evaluate(`(document.querySelectorAll('.reason-filters button.reason-filter')[${i}].click(), true)`);
    assert.deepEqual((await filters()).map((f) => f.pressed), ['false', 'false']);
    await press(1);
    rows = await also();
    assert.deepEqual([rows.length, (await caption()).reason, rows.every((x) => x.reason === null)], [12, r.uniformReason('Below your minimum price'), true],
      'F: a click shows only that reason — and one reason for the page goes to the caption');
    assert.deepEqual((await filters()).map((f) => f.pressed), ['false', 'true'], 'F: the active filter is visible');
    await press(1);
    assert.equal((await also()).length, 24, 'F: a second click clears the filter');
    await press(0);
    assert.equal((await also()).length, 12);
    await b.evaluate(`(document.querySelector('.reason-filters button.clear-filter').click(), true)`);
    assert.equal((await also()).length, 24, 'F: the cross clears the filter');
    // смена периода сбрасывает фильтр
    await press(0);
    await b.evaluate(`(document.querySelector('.drp-trigger').click(), true)`);
    await b.evaluate(`([...document.querySelectorAll('.drp-presets button')].find((x) => x.textContent.trim() === ${JSON.stringify(en.ui.period.presetsLong['30d'])}).click(), true)`);
    await new Promise((x) => setTimeout(x, 150));
    await b.evaluate(`(document.querySelector('.drp-foot button.primary').click(), true)`);
    await settled(b, 'protections 30d');
    assert.match(await b.evaluate<string>(`document.querySelector('.drp-trigger').textContent`), /Last 30 days/, 'the period is now the last 30 days');
    await new Promise((x) => setTimeout(x, 300));
    assert.deepEqual([(await also()).length, (await filters()).map((f) => f.pressed)], [24, ['false', 'false']], 'a new period clears the reason filter');
    // D: удержания полом — «как удержано» и одна на всех причина — подписью секции; числа справа табличными цифрами
    const floor = await b.evaluate<{ heads: string[]; caption: string; reasonCells: number; nums: Array<{ align: string; numeric: string }> }>(`(() => { const t = document.querySelector('table.floor-holds');
      return { heads: [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim()), caption: document.querySelector('.floor-caption')?.textContent.trim() ?? '',
        reasonCells: t.querySelectorAll('td.reason-cell').length,
        nums: [...t.querySelector('tbody tr').querySelectorAll('td.num')].map((td) => ({ align: getComputedStyle(td).textAlign, numeric: getComputedStyle(td).fontVariantNumeric })) }; })()`);
    const d = en.ui.dangerous;
    assert.ok(!floor.heads.includes(d.floorColumns.kind) && !floor.heads.includes(d.floorColumns.reason) && floor.reasonCells === 0, `D: no «Held how» and no one-value «Reason» column — ${JSON.stringify(floor.heads)}`);
    // период теперь 30 дней — чип повторов говорит это же
    assert.equal(floor.caption, `${d.floorCaption.CAPPED} ${r.uniformReason('Target capped at your minimum price')} — ${r.eachRepeat('×11 · 30d')}`, 'D: how the floor held and the reason — once, as the caption of the section');
    assert.ok(floor.nums.length === 3 && floor.nums.every((n) => n.align === 'right' && n.numeric.includes('tabular-nums')), `D: amounts right-aligned in tabular figures — ${JSON.stringify(floor.nums)}`);
    // C: пилюли и чипы не переносятся ни на одной ширине (строки текста считаются по прямоугольникам текста, а не по высоте кнопки)
    const LINES = `(() => { const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); const tops = [...r.getClientRects()].filter((q) => q.width > 0).map((q) => q.top).sort((a, b) => a - b);
      return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 6).length; };
      return [...document.querySelectorAll('.protections .badge, .protections .stat-chip, .protections .reason-filter, .protections .repeat-chip')].filter((x) => x.getClientRects().length > 0 && lines(x) > 1).map((x) => x.textContent.trim()); })()`;
    for (const [w, h] of [[375, 812], [768, 1024], [1012, 800], [1440, 900]] as const) {
      await b.setViewport(w, h);
      await new Promise((x) => setTimeout(x, 250));
      assert.deepEqual(await b.evaluate<string[]>(LINES), [], `${w}px: no pill or chip wraps`);
    }
    // контроль правила переноса: пилюля в узкой ячейке прежнего вида (td.pills, white-space: normal, 160px) — переносится, и правило это видит
    await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<div class="protections" id="wrap-control"><table><tbody><tr><td class="pills"><span class="badge" style="white-space: normal; max-width: 90px">Strategy capped at a bound</span></td></tr></tbody></table></div>'), true)`);
    assert.deepEqual(await b.evaluate<string[]>(LINES), ['Strategy capped at a bound'], 'control: a wrapping pill is seen');
    await b.evaluate(`(document.getElementById('wrap-control').remove(), true)`);
    await b.setViewport(1440, 900);
    // A, C: с опасным случаем в периоде — колонка «Beyond bound» и колонка состояния с одной пилюлей на строку
    syntheticRejected = demoLikeRejected(world, true);
    await visit('protections/people');
    await visit('protections/rules');
    rows = await also();
    assert.ok((await heads()).includes(r.columns.deviation), 'A: a dangerous case brings the «Beyond bound» column');
    assert.ok(rows.every((x) => x.pills.length === 1), 'C: states differ — one state pill per row');
    assert.deepEqual(rows.filter((x) => x.pills[0] === r.interventions.DANGEROUS).length, 1, 'the dangerous row has its own red pill');
    assert.deepEqual(await b.evaluate<string[]>(CONSTANT_COLUMNS), [], 'with a dangerous case no column is one value');
  } finally {
    syntheticDangerous = null;
    syntheticRejected = null;
    await b.setViewport(1440, 900);
    await b.setColorScheme(null);
  }
  assert.deepEqual(b.errors().slice(before), [], 'the console page threw or logged errors');
});

/**
 * Шаг 93: тема — свойство устройства. По умолчанию — системная (`prefers-color-scheme`); ручной выбор «светлая» или «тёмная» перебивает
 * систему и переживает перезагрузку. Значения — пары Primer: канва `--bgColor-muted`, карточка `--bgColor-default`, текст
 * `--fgColor-default`. Шапка называет человека по имени от поставщика identity, адрес — подсказкой.
 * Шаг 96.1 (решение владельца): кнопка — только солнце и луна, то есть тема, которую видно сейчас; нажатие переключает светлую ↔ тёмную;
 * пока выбора нет, тема и иконка следуют системе НА ЛЕТУ; имя кнопки и подсказка называют, куда она переключит
 */
test('step 93/96.1: the theme belongs to the device — sun or moon toggles light and dark, kept over a reload; without a choice the system rules live; the header names the person', async () => {
  const b = browser!;
  await b.setViewport(1440, 900);
  await b.setColorScheme('dark');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  const colours = () => b.evaluate<{ canvas: string; card: string; text: string }>(`(() => { const card = document.querySelector('.card.login') ?? document.querySelector('.card');
    return { canvas: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(card).backgroundColor, text: getComputedStyle(card).color }; })()`);
  const button = () => b.evaluate<{ choice: string; seen: string; label: string; title: string; icon: string | null; selects: number } | null>(`(() => { const x = document.querySelector('.topbar .theme-button');
    const d = x?.querySelector('svg path')?.getAttribute('d') ?? null;
    return x ? { choice: x.dataset.themeChoice, seen: x.dataset.themeSeen, label: x.getAttribute('aria-label'), title: x.getAttribute('title'), icon: d,
      selects: document.querySelectorAll('.topbar select').length } : null; })()`);
  const press = () => b.evaluate(`(document.querySelector('.topbar .theme-button').click(), true)`);
  const t = en.ui.app.theme;
  // иконка — по первому пути Octicons из icons.tsx (файл с JSX тест не импортирует — читает): солнце или луна, монитора больше нет
  const icons = readFileSync(fileURLToPath(new URL('../src/icons.tsx', import.meta.url)), 'utf8');
  const pathOf = (name: string) => new RegExp(`'${name}': \\["([^"]+)"`).exec(icons)?.[1] ?? `no ${name}`;
  assert.equal(icons.includes("'device-desktop'"), false, 'the monitor icon is gone from the theme switch');
  const ICON = { light: pathOf('sun'), dark: pathOf('moon') };
  const expectButton = async (choice: 'system' | 'light' | 'dark', seen: 'light' | 'dark') => {
    const label = seen === 'dark' ? t.toLight : t.toDark;
    const want = { choice, seen, label, title: label, icon: ICON[seen], selects: 0 };
    // смена системной темы доходит до кнопки событием matchMedia — после того, как CSS уже перекрасил страницу: ждём до 3 с
    let got = await button();
    for (let i = 0; i < 30 && JSON.stringify(got) !== JSON.stringify(want); i++) { await new Promise((r) => setTimeout(r, 100)); got = await button(); }
    assert.deepEqual(got, want, `choice «${choice}», seen «${seen}»: the button offers «${label}»`);
  };
  const DARK = { canvas: 'rgb(21, 27, 35)', card: 'rgb(13, 17, 23)', text: 'rgb(240, 246, 252)' };
  const LIGHT = { canvas: 'rgb(246, 248, 250)', card: 'rgb(255, 255, 255)', text: 'rgb(31, 35, 40)' };
  assert.deepEqual(await colours(), DARK, 'a dark system gets the dark Primer pairs without a choice');
  await expectButton('system', 'dark');
  // Без выбора — система на лету: смена системной темы без перезагрузки меняет и страницу, и иконку
  await b.setColorScheme('light');
  assert.deepEqual(await colours(), LIGHT, 'without a choice the page follows a system switched to light without a reload');
  await expectButton('system', 'light');
  await b.setColorScheme('dark');
  assert.deepEqual(await colours(), DARK, 'and follows it back to dark');
  await expectButton('system', 'dark');
  await press();
  await expectButton('light', 'light');
  assert.deepEqual(await colours(), LIGHT, 'the moon switches a dark page to light — and the choice wins over a dark system');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await expectButton('light', 'light');
  assert.deepEqual(await colours(), LIGHT, 'the choice is kept on the device over a reload');
  await press();
  await expectButton('dark', 'dark');
  assert.deepEqual(await colours(), DARK, 'the sun switches back to dark: two states, no third');
  await b.setColorScheme('light');
  assert.deepEqual(await colours(), DARK, 'a manual choice ignores the system');
  await press();
  await expectButton('light', 'light');
  // уборка: выбор хранится в профиле браузера — следующие тесты начинают без выбора, с системной темой
  await b.evaluate(`(localStorage.removeItem('repracer.theme'), delete document.documentElement.dataset.theme, true)`);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await expectButton('system', 'light');
  // на узком экране кнопка темы — цель касания 44×44
  await b.setViewport(375, 812);
  assert.deepEqual(await b.evaluate<{ w: number; h: number }>(`(() => { const r = document.querySelector('.topbar .theme-button').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`),
    { w: 44, h: 44 }, '375px: the theme button is a 44px touch target');
  await b.setViewport(1440, 900);
  // Шапка: человек по имени, адрес — подсказкой
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  assert.deepEqual(await b.evaluate<{ text: string; title: string }>(`(() => { const u = document.querySelector('.topbar .user'); return { text: u.textContent.trim(), title: u.getAttribute('title') }; })()`),
    { text: 'Alex Porter', title: en.ui.app.login.signedIn('owner@stand.repracer.test') });
  // в шапке рабочего пространства кнопка темы стоит рядом с именем и выходом
  assert.ok(await b.evaluate<boolean>(`(() => { const x = document.querySelector('.topbar .theme-button'), u = document.querySelector('.topbar .user'); return !!x && !!u && x.parentElement === u.parentElement; })()`),
    'the theme button sits next to the name and Sign out');
  await b.setColorScheme(null);
});

/**
 * Шаг 87 [Р-214]: профиль рынка us — продукт выходит в США. Европейское спрятано, но не удалено: в профиле us нет переключателя языка,
 * вкладки Omnibus, канала Kaufland и витрин ЕС ни на одном экране; рабочие пространства без витрины профиля не показываются; пункт меню
 * по-прежнему равен заголовку страницы. Профиль eu на тех же мирах показывает Европу — положительный контроль правила
 */
// Шаг 96.2: и «German» / «Europe» — подпись файла остатков говорила «headers in German or English» в профиле us, а правило знало только «Deutsch»
const EUROPE = /Kaufland|kaufland\.|amazon\.de|ebay\.de|€|\bEUR\b|Deutsch|Omnibus|\bGerman\b|\bGermany\b|\bEuropean?\b/;

test('step 87: the us market profile shows no German, no Omnibus, no Kaufland and no European storefront on any screen; eu still does', async () => {
  const b = browser!;
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  const europeOnPage = async () => { const t = await b.evaluate<string>('document.body.innerText'); const found = EUROPE.exec(t); return found ? `«${found[0]}» in …${t.slice(Math.max(0, found.index - 80), found.index + 40)}…` : null; };
  currentApi = usApi;
  try {
    await b.setViewport(1440, 900);
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OWNER);
    // Шаг 98 [Р-223]: в профиле us — английский, испанский и французский; немецкого нет (он за профилем ЕС)
    assert.deepEqual(await languagesOffered(b), ['English', 'Español', 'Français'], 'us: the language switch offers English, Spanish and French, not German');
    assert.equal(await europeOnPage(), null, 'us: sign-in');
    await b.click(owner);
    // Шаг 100 (A): у входящего в профиле us одно пространство — пустое (мир с витринами только ЕС не предлагается), и вход ведёт сразу в него
    await waitFor(b, `location.hash.startsWith('#/w/')`, 'us: straight into the only workspace');
    await settled(b, 'us empty workspace');
    assert.equal(decodeURIComponent((await b.evaluate<string>('location.hash')).split('/')[2]!), EMPTY_WORLD_ID,
      'us: a workspace whose storefronts are all European is not offered; an empty one is');
    const links = await b.evaluate<Array<{ text: string; href: string }>>(
      `[...document.querySelectorAll('.nav-group a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
    assert.deepEqual(links.map((l) => l.href.split('/')[3]), MENU_US, `us: nine menu items, no Omnibus — ${links.map((l) => l.text).join(', ')}`);
    for (const l of links) {
      await b.evaluate(`(location.hash = ${JSON.stringify(l.href)}, true)`);
      await settled(b, `us ${l.text}`);
      const heading = await b.evaluate<string>(`(document.querySelector('.world-content h2') ?? document.querySelector('.world-content h3'))?.childNodes[0]?.textContent?.trim() ?? ''`);
      assert.equal(heading, l.text, `us: the menu item and the heading of its page`);
      assert.equal(await europeOnPage(), null, `us: ${l.text}`);
    }
    // Подключение предлагает витрины США — словами — и только их
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/channels`)}, true)`);
    await settled(b, 'us connections');
    const connectText = await b.evaluate<string>('document.body.innerText');
    assert.ok(connectText.includes('amazon.com') && connectText.includes('ebay.com'), `us: amazon.com and ebay.com are offered — ${connectText.slice(0, 300)}`);
    // Шаг 89: Walmart — канал рынка США; подключить его нельзя, пока у платформы нет ключей, и экран говорит это словами
    assert.ok(/\bWalmart\b/.test(connectText) && connectText.includes(en.ui.connections.missing.WALMART_API_KEYS!), `us: Walmart is named and waits for our keys — ${connectText.slice(0, 400)}`);
  } finally {
    currentApi = euApi;
  }
  // Положительный контроль [Р-94]: на профиле eu тот же экран подключений предлагает amazon.de, и есть переключатель «Deutsch»
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(owner);
  await b.waitText(en.ui.app.worlds);
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/channels`)}, true)`);
  await settled(b, 'eu connections');
  const eu = await europeOnPage();
  assert.ok(eu !== null, `eu: the rule sees Europe — ${eu}`);
  // Шаг 100 (C): «Deutsch» — пункт меню языков, а не ссылка в шапке
  assert.ok(/amazon\.de/.test(await b.evaluate<string>('document.body.innerText')), 'eu: the connections offer amazon.de');
  assert.ok((await languagesOffered(b)).includes('Deutsch'), 'eu: the language menu offers Deutsch');
  // шаг 96.2: в профиле eu подпись файла остатков называет немецкие заголовки — и правило это видит; в us её не было (выше)
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/inventory`)}, true)`);
  await settled(b, 'eu inventory');
  assert.ok((await b.evaluate<string>('document.body.innerText')).includes(en.ui.stock.importFile.hintBilingual), 'eu: the stock file takes German or English headers');
  assert.deepEqual([EUROPE.test(en.ui.stock.importFile.hintBilingual), EUROPE.test(en.ui.stock.importFile.hint)], [true, false], 'the rule sees the German headers of the eu caption and nothing European in the us one');
  assert.ok(!/\bWalmart\b/.test(await b.evaluate<string>('document.body.innerText')), 'eu: Walmart is a channel of the us market only');
  const euMenu = await b.evaluate<string[]>(`[...document.querySelectorAll('.nav-group a')].map((a) => a.textContent.trim())`);
  assert.ok(euMenu.includes(en.ui.app.screens.compliance), `eu: the same workspace has the Omnibus tab — ${euMenu.join(', ')}`);
});

test('step 88 (Р-213), step 98 (Р-222): sign-in offers two roles at 375 and 1440, four with the extended roles flag; the manager manages channel accounts; the audit log names roles', async () => {
  const b = browser!;
  const rows = () => b.evaluate<string[]>(`[...document.querySelectorAll('.role-row .role-name')].map((e) => e.textContent.trim())`);
  const can = () => b.evaluate<string[]>(`[...document.querySelectorAll('.role-row .role-can')].map((e) => e.textContent.trim())`);
  currentApi = usApi;
  try {
    for (const width of [375, 1440]) {
      await b.setViewport(width, 900);
      await b.open(pageUrl);
      await b.waitText(en.ui.app.login.roleCan.MANAGER);
      assert.deepEqual(await rows(), ['Owner', 'Manager'], `${width}: two roles for people`);
      assert.deepEqual(await can(), [en.ui.app.login.roleCan.OWNER, en.ui.app.login.roleCan.MANAGER], `${width}: each role says what it may do`);
      assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${width}: no sideways scroll on sign-in`);
    }
    await b.setViewport(1440, 900);
    // Положительный контроль флага: тот же стенд с расширенными ролями — четыре строки, прежние роли за флагом живы
    currentApi = extendedApi;
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OPERATOR);
    assert.deepEqual(await rows(), ['Owner', 'Manager', 'Admin', 'Operator'], 'the extended roles flag adds admin and operator');
    currentApi = usApi;
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.MANAGER);
    await b.click(en.ui.app.login.asAccount(en.values.MANAGER));
    // Шаг 100 (A): у менеджера в профиле us одно пространство — вход ведёт сразу в него
    await waitFor(b, `location.hash.startsWith('#/w/')`, 'the manager goes straight into the only workspace');
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/channels`)}, true)`);
    await settled(b, 'manager connections');
    const connections = await b.evaluate<string>('document.body.innerText');
    // Шаг 98 [Р-222]: аккаунты каналов, язык и пояс — и у менеджера (ролей для людей две, права одинаковые)
    assert.ok(!connections.includes(en.ui.connections.noRight), 'the manager is not told that channel accounts are the owner’s');
    assert.ok(await b.evaluate<number>(`[...document.querySelectorAll('button')].filter((x) => /^Connect/.test(x.textContent.trim())).length`) > 0, 'the manager connects a channel');
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/stop`)}, true)`);
    await settled(b, 'manager stop');
    assert.ok((await b.evaluate<string>('document.body.innerText')).includes(en.ui.stop.auditTitle), 'the audit log of stops and roles');
  } finally {
    currentApi = euApi;
    await b.setViewport(1440, 900);
  }
});

/**
 * Шаг 99 [Р-224, Р-225]: импорты продавца на своих страницах — меню не растёт. Шаблон скачивается, файл с ошибочной строкой проверяется
 * и НЕ применяется (кнопки «Apply» нет, причина названа), исправленный файл применяется ровно по примерке, и экран называет время. Каждый
 * экран импорта — в обеих темах, на 375 и 1440, без выступов и без прокрутки страницы вбок; на испанском и французском — без английских
 * строк словаря. Задания исполняются тем же обработчиком, что у исполнителя (`run-jobs.ts`)
 */
test('step 99 (Р-224): imports on their own pages — template, a check with an error by row and no Apply, the corrected file applied with the time; themes, phone, ES and FR', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  await b.setViewport(1440, 900);
  await b.setColorScheme('light');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  const visit = async (route: string) => {
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${route}`)}, true)`);
    await settled(b, route);
    await new Promise((x) => setTimeout(x, 300));
  };
  const t = en.ui.imports;
  const headings = () => b.evaluate<string[]>(`[...document.querySelectorAll('.import-panel > h3')].map((h) => h.textContent.trim())`);
  // Меню прежнее — девять пунктов и Omnibus; импорты — разделами страниц
  assert.equal((await b.evaluate<number>(`document.querySelectorAll('.nav-group a').length`)), 10, 'the menu does not grow');
  await visit('costs');
  assert.deepEqual(await headings(), [t.titles.COSTS, t.titles.BOUNDS], 'Costs & floors holds the unit-cost and the bounds imports');
  await visit('strategies');
  assert.deepEqual(await headings(), [t.titles.STRATEGY]);
  await visit('inventory');
  assert.deepEqual(await headings(), [t.titles.STOCK]);

  // Шаблон: задание, затем файл забирается клиентом консоли — ошибок страницы нет
  await visit('costs');
  await b.click(t.templateCsv, '.import-costs button');
  await new Promise((x) => setTimeout(x, 300));
  await runPendingJobs(smokeLive);
  await waitFor(b, `document.querySelector('.import-costs .job') === null`, 'the template job card leaves once the file is downloaded');

  // Файл с ошибочной строкой: строка названа номером и причиной, применить нельзя — и сказано почему
  const offer = await smokeLive.view(STAND_USERS[0] as never) as { state: { scopes: Array<{ externalUnitId: string; currency: string }> } };
  const unit = offer.state.scopes[0]!.externalUnitId;
  const upload = async (text: string, name: string) => {
    await b.evaluate(`(() => { const input = document.querySelector('.import-costs input[type=file]'); const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'text/csv' })); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(b, `[...document.querySelectorAll('.import-costs .file-drop')].some((x) => x.textContent.includes(${JSON.stringify(name)}))`, 'the file is chosen');
    await b.click(t.check, '.import-costs button');
    await new Promise((x) => setTimeout(x, 300));
    await runPendingJobs(smokeLive);
    await waitFor(b, `document.querySelector('.import-costs .import-check') !== null`, 'the check is shown');
  };
  await upload(`sku,unit_cost,currency\n${unit},9.99,EUR\nNO-SUCH-SKU,7.00,EUR\n`, 'costs-with-error.csv');
  const check = await b.evaluate<{ chips: string[]; errors: string[][]; apply: boolean; hint: string }>(`(() => { const c = document.querySelector('.import-costs');
    return { chips: [...c.querySelectorAll('.stat-chip')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim()),
      errors: [...c.querySelectorAll('.import-errors tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim())),
      apply: [...c.querySelectorAll('button')].some((x) => x.textContent.trim() === ${JSON.stringify(t.apply)}),
      hint: c.querySelector('.form-hint')?.innerText.trim() ?? '' }; })()`);
  assert.deepEqual(check.chips, [`${t.stats.total} 2`, `${t.stats.changed} 1`, `${t.stats.unchanged} 0`, `${t.stats.rejected} 1`]);
  assert.deepEqual(check.errors, [['3', 'NO-SUCH-SKU', t.fields.sku, t.problems.NOT_FOUND]], 'the error names the row of the file and the reason');
  assert.equal(check.apply, false, 'a file with an error has no Apply button');
  assert.equal(check.hint, t.applyBlocked.errors(1));
  for (const width of [375, 1440]) {
    await b.setViewport(width, 900);
    await new Promise((x) => setTimeout(x, 200));
    assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${width}: no sideways scroll with a check on screen — ${
      await b.evaluate<string>(`[...document.querySelectorAll('.world-content *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).join(' | ')`)}`);
    assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${width}: nothing sticks out of its frame`);
  }
  await b.setViewport(1440, 900);

  // Исправленный файл: одна строка к изменению, «Apply» — и экран называет время
  await b.click(t.back, '.import-costs button');
  await upload(`sku,unit_cost,currency\n${unit},9.99,EUR\n`, 'costs.csv');
  await b.click(t.apply, '.import-costs button');
  await new Promise((x) => setTimeout(x, 300));
  // Решение владельца: пока запись идёт одной транзакцией, экран занят видимо — спиннер, «in one go» и секунды, а не «0 of N» на пустой
  // полосе. Запись задерживается внутри транзакции, пока браузер не увидит занятость
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const gated = new Proxy(smokeLive.store, {
    get(target, prop, receiver) {
      if (prop === 'importCosts') return async (...args: unknown[]) => { await gate; return (target.importCosts as (...a: unknown[]) => unknown).apply(target, args); };
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const running = runNextBulkJob({ store: gated, tenantId: smokeLive.tenantId, owner: 'test-bulk-worker', handlers: handlersFor(smokeLive) });
  // Провал проверки не оставляет запись задержанной: иначе исполнитель держит аренду и прогон не завершается никогда
  try {
    await waitFor(b, `document.querySelector('.import-costs .job .job-busy') !== null`, 'the one-transaction apply shows a spinner with seconds');
    const busy = await b.evaluate<{ headline: string; bar: boolean; time: string }>(`(() => { const j = document.querySelector('.import-costs .job');
      return { headline: j.querySelector('.headline').innerText.trim(), bar: j.querySelector('progress') !== null, time: j.querySelector('.job-busy').innerText.trim() }; })()`);
    assert.equal(busy.headline, en.ui.jobs.applyingInOneGo(1), 'the card says the rows go in one go');
    assert.equal(busy.bar, false, 'no bar stuck at zero');
    assert.match(busy.time, /^Working for \d+ s$/);
    await waitFor(b, `document.querySelector('.import-costs .job-busy').innerText.trim() !== ${JSON.stringify(busy.time)}`, 'the seconds move while the apply runs', 5_000);
  } finally {
    release();
    await running;
  }
  await waitFor(b, `document.querySelector('.import-costs .import-applied') !== null`, 'the applied notice');
  const applied = await b.evaluate<string>(`document.querySelector('.import-costs .import-applied').innerText.trim()`);
  assert.match(applied, /^Done: 1 row applied in \d+(\.\d)? s\.$/, `the time is named: ${applied}`);
  await waitFor(b, `document.querySelectorAll('.import-costs .import-history tbody tr').length >= 3`, 'the journal lists the checks and the apply');
  const outcomes = await b.evaluate<string[]>(`[...document.querySelectorAll('.import-costs .import-history .badge')].map((x) => x.textContent.trim())`);
  assert.equal(outcomes[0], t.outcomes.APPLIED, `the newest run is the apply: ${outcomes.join(', ')}`);

  // Обе темы и телефон: страницы импортов без выступов; испанский и французский — без английских строк словаря
  for (const scheme of ['light', 'dark'] as const) {
    await b.setColorScheme(scheme);
    for (const width of [375, 1440]) {
      await b.setViewport(width, 900);
      for (const route of ['costs', 'strategies', 'inventory']) {
        await visit(route);
        assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${scheme} ${width} ${route}: no sideways scroll`);
        assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${scheme} ${width} ${route}: nothing sticks out`);
      }
    }
  }
  await b.setViewport(1440, 900);
  await b.setColorScheme('light');
  for (const m of [es, fr]) {
    await chooseLanguage(b, en.ui.app.languages[m.locale]);
    await b.waitText(m.ui.app.screens.feed);
    const english = englishOnly(m);
    for (const route of ['costs', 'strategies', 'inventory']) {
      await visit(route);
      assert.deepEqual(await b.evaluate<string[]>(UNTRANSLATED(english)), [], `${m.locale} ${route}: an English dictionary string on an import page`);
      // Шаг 100 (D): журнал импортов — пояс в шапке, строки коротко, и на испанском и французском
      assert.deepEqual(await b.evaluate<string[]>(LONG_WHEN), [], `${m.locale} ${route}: a row of the import history carries the year or the zone`);
    }
    await chooseLanguage(b, m.ui.app.languages.en);
    await b.waitText(en.ui.app.screens.feed);
  }
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

test('step 100 (A): one workspace — straight into it after sign-in, no workspace list and no «All workspaces»; two or more — the list as before', async () => {
  const b = browser!;
  const before = b.errors().length;
  const rootLinks = `[...document.querySelectorAll('.sidebar a')].filter((a) => a.getAttribute('href') === '#/').length`;
  currentApi = soloApi;
  try {
    for (const width of [1440, 375]) {
      await b.setViewport(width, 900);
      await b.open(pageUrl);
      await b.waitText(en.ui.app.login.roleCan.OWNER);
      await b.click(en.ui.app.login.asAccount(en.values.OWNER));
      await waitFor(b, `location.hash.startsWith('#/w/')`, `${width}: straight into the only workspace`);
      await settled(b, `${width}: the only workspace`);
      assert.equal(await b.evaluate<boolean>(`document.querySelector('.worlds-page') === null`), true, `${width}: no workspace list`);
      assert.equal(await b.evaluate<number>(rootLinks), 0, `${width}: no «All workspaces» — nothing to choose from`);
      // «#/» вручную — снова внутрь
      await b.evaluate(`(location.hash = '#/', true)`);
      await waitFor(b, `location.hash.startsWith('#/w/')`, `${width}: the root leads into the only workspace`);
    }
  } finally {
    currentApi = euApi;
  }
  // Контроль: два пространства — список и ссылка «All workspaces», как прежде
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  assert.equal(await b.evaluate<number>(`document.querySelectorAll('.worlds-page h3 a').length`), 2);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'a workspace of two');
  assert.equal(await b.evaluate<number>(rootLinks), 1, 'with two workspaces the way back is there');
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

test('step 100 (B): the period calendar — presets as a segment row above the months, quiet weekdays, today outlined, round ends joined by an even fill, a hover preview, a quiet footer, Primer radius and shadow; a bottom sheet with one month on a phone', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  await b.setViewport(1440, 900);
  await b.setColorScheme('light');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed`)}, true)`);
  await settled(b, 'feed');
  const t = en.ui.period;
  const token = (name: string, prop = 'color') => `(() => { const p = document.createElement('span'); p.style.${prop} = 'var(${name})'; document.body.append(p); const v = getComputedStyle(p).${prop}; p.remove(); return v; })()`;
  const look = () => b.evaluate<Record<string, unknown>>(`(() => {
    const pop = document.querySelector('.drp-pop'); const r = (e) => e.getBoundingClientRect();
    const presets = [...document.querySelectorAll('.drp-presets button')].map(r);
    const month = r(document.querySelector('.drp-month'));
    const th = getComputedStyle(document.querySelector('.drp-month th'));
    const today = getComputedStyle(document.querySelector('.drp-day.today') ?? document.body);
    const edge = document.querySelector('.drp-day.edge') ?? document.body; const edgeStyle = getComputedStyle(edge);
    const inside = [...document.querySelectorAll('.drp-month td.in-range')];
    const gaps = inside.slice(1).map((td, k) => { const a = r(inside[k]); const z = r(td); return Math.abs(a.top - z.top) < 1 ? Math.round(z.left - a.right) : 0; });
    const disabled = document.querySelector('.drp-day.disabled');
    const foot = document.querySelector('.drp-foot'); const status = document.querySelector('.drp-status'); const actions = foot.querySelector('.form-actions');
    const limit = document.querySelector('.drp-limit');
    const cancel = [...foot.querySelectorAll('button')].find((x) => !x.classList.contains('primary'));
    const apply = foot.querySelector('button.primary');
    return {
      presetsRow: presets.every((p) => Math.abs(p.top - presets[0].top) < 1), presetsAbove: presets.every((p) => p.bottom <= month.top),
      thWeight: th.fontWeight, thColor: th.color, thSize: th.fontSize,
      todayDecoration: today.textDecorationLine, todayRing: today.boxShadow !== 'none' || today.borderStyle !== 'none' && today.borderWidth !== '0px',
      edgeRound: parseFloat(edgeStyle.borderTopLeftRadius) * 2 >= edge.getBoundingClientRect().width - 1,
      inRange: inside.length, gaps: [...new Set(gaps)], fill: inside.length ? getComputedStyle(inside[Math.floor(inside.length / 2)]).backgroundColor : null,
      disabledColor: disabled ? getComputedStyle(disabled).color : null,
      statusLeft: !!status && !!actions && r(status).right <= r(actions).left, limit: limit?.textContent.trim() ?? null, limitColor: limit ? getComputedStyle(limit).color : null,
      cancelGhost: !!cancel && cancel.classList.contains('ghost') && getComputedStyle(cancel).backgroundColor === 'rgba(0, 0, 0, 0)', applyPrimary: !!apply,
      navIcons: [...document.querySelectorAll('.drp-nav button')].every((x) => x.querySelector('svg') && x.getAttribute('aria-label')),
      radius: getComputedStyle(pop).borderRadius, shadow: getComputedStyle(pop).boxShadow,
    };
  })()`);
  for (const scheme of ['light', 'dark'] as const) {
    await b.setColorScheme(scheme);
    await b.evaluate(`(document.querySelector('.drp-trigger').click(), true)`);
    await waitFor(b, `document.querySelector('.drp-pop') !== null`, 'the calendar opens');
    const v = await look();
    const want = {
      text2: await b.evaluate<string>(token('--text-2')), text3: await b.evaluate<string>(token('--text-3')), soft: await b.evaluate<string>(token('--accent-soft', 'backgroundColor')),
      radius: await b.evaluate<string>(token('--radius-lg', 'borderRadius')), shadow: await b.evaluate<string>(token('--shadow-lg', 'boxShadow')),
    };
    assert.deepEqual([v.presetsRow, v.presetsAbove], [true, true], `${scheme}: presets — one row of segments above the months`);
    assert.deepEqual([v.thWeight, v.thColor], ['400', want.text2], `${scheme}: weekday heads — small and muted, not bold`);
    assert.deepEqual([v.todayDecoration, v.todayRing], ['none', true], `${scheme}: today — a thin outline, not an underline`);
    assert.equal(v.edgeRound, true, `${scheme}: the ends of the range are round`);
    assert.ok((v.inRange as number) >= 5, `${scheme}: the days of the range carry the fill — ${String(v.inRange)}`);
    assert.deepEqual([v.gaps, v.fill], [[0], want.soft], `${scheme}: the fill joins the days without gaps or steps`);
    assert.equal(v.disabledColor, want.text3, `${scheme}: days beyond the kept window are lighter`);
    // у журнала цен окно — 90 суток (шаг 96)
    assert.deepEqual([v.statusLeft, v.limit, v.limitColor], [true, t.limit(90), want.text2], `${scheme}: the footer — the choice on the left, the limit short and grey`);
    assert.ok(!/[()]/.test(String(v.limit)), 'the limit has no brackets');
    assert.deepEqual([v.cancelGhost, v.applyPrimary, v.navIcons], [true, true, true], `${scheme}: Cancel is a ghost, Apply the primary, the month arrows icon buttons`);
    assert.deepEqual([v.radius, v.shadow], [want.radius, want.shadow], `${scheme}: radius and shadow of the Primer scales`);
    // Превью: после первого нажатия подсветка тянется за курсором до второй даты
    const days = await b.evaluate<string[]>(`[...document.querySelectorAll('.drp-day:not(.disabled)')].map((x) => x.dataset.day)`);
    const [first, hover] = [days[days.length - 6]!, days[days.length - 2]!];
    await b.evaluate(`(document.querySelector('.drp-day[data-day="${first}"]').click(), true)`);
    // Настоящий курсор (а не событие страницы): строка под ним в состоянии :hover — её заливка не гаснет (снимок шага нашёл ровно это)
    const at = await b.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('.drp-day[data-day="${hover}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await b.mouseMove(at.x, at.y);
    await waitFor(b, `document.querySelectorAll('.drp-month td.in-range').length >= 3`, `${scheme}: the preview follows the pointer`);
    assert.deepEqual(await b.evaluate<string[]>(`[...document.querySelectorAll('.drp-month td.preview button')].map((x) => x.dataset.day)`).then((x) => [x[0], x[x.length - 1]]), [first, hover],
      `${scheme}: the preview runs from the first click to the pointer`);
    const unfilled = await b.evaluate<string[]>(`[...document.querySelectorAll('.drp-month td.preview:not(.range-start):not(.range-end)')].filter((td) => getComputedStyle(td).backgroundColor !== ${JSON.stringify(want.soft)}).map((td) => td.querySelector('button').dataset.day)`);
    assert.deepEqual(unfilled, [], `${scheme}: every day of the preview is filled, the row under the pointer too`);
    await b.mouseMove(0, 0);
    await b.evaluate(`(document.querySelector('.drp-foot button:not(.primary)').click(), true)`);
  }
  // Телефон: один месяц, нижняя панель во всю ширину, дни — цель касания
  await b.setColorScheme('light');
  await b.setViewport(375, 812);
  await b.evaluate(`(document.querySelector('.drp-trigger').click(), true)`);
  await waitFor(b, `document.querySelector('.drp-pop') !== null`, 'the calendar opens on a phone');
  const sheet = await b.evaluate<Record<string, number | string | null>>(`(() => { const r = document.querySelector('.drp-pop').getBoundingClientRect(); const v = document.documentElement;
    const d = document.querySelector('.drp-day').getBoundingClientRect();
    return { months: document.querySelectorAll('.drp-month').length, left: Math.round(r.left), width: Math.round(r.width) - v.clientWidth, bottom: Math.round(r.bottom) - v.clientHeight,
      top: Math.round(r.top) > 0 ? 'below the top' : 'at the top', day: Math.round(Math.min(d.width, d.height)), modal: document.querySelector('.drp-pop').getAttribute('aria-modal') }; })()`);
  assert.deepEqual(sheet, { months: 1, left: 0, width: 0, bottom: 0, top: 'below the top', day: 44, modal: 'true' }, 'a phone: one month in a full-width bottom sheet');
  assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), 'no sideways scroll');
  await b.evaluate(`(document.querySelector('.drp-foot button:not(.primary)').click(), true)`);
  await b.setViewport(1440, 900);
  await b.setColorScheme(null);
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

test('step 100 (C): the language is one menu — globe and «EN ▾», native names with a check at the current one, the keyboard of a menu; on sign-in, in the header and on a phone', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = usApi;
  try {
    await b.setViewport(1440, 900);
    await b.setColorScheme('light');
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OWNER);
    const button = () => b.evaluate<Record<string, unknown>>(`(() => { const x = document.querySelector('.topbar .lang-button'); return x ? { text: x.innerText.trim(), popup: x.getAttribute('aria-haspopup'),
      expanded: x.getAttribute('aria-expanded'), label: x.getAttribute('aria-label'), globe: !!x.querySelector('svg'), focused: document.activeElement === x,
      plain: document.querySelectorAll('.topbar .lang > button:not(.lang-button)').length } : null; })()`);
    const focused = () => b.evaluate<{ text: string; role: string | null; checked: string | null; check: boolean } | null>(`(() => { const a = document.activeElement;
      return a?.getAttribute('role') === 'menuitemradio' ? { text: a.textContent.trim(), role: a.getAttribute('role'), checked: a.getAttribute('aria-checked'), check: !!a.querySelector('svg') } : null; })()`);
    const key = (k: string) => b.evaluate(`(document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })), true)`);
    // Вход: одна кнопка-меню вместо трёх ссылок
    assert.deepEqual(await button(), { text: 'EN', popup: 'menu', expanded: 'false', label: `${en.ui.app.languageMenu}: English`, globe: true, focused: false, plain: 0 }, 'sign-in: a menu button «globe · EN ▾»');
    // Клавиатура: стрелка вниз открывает меню на текущем языке; стрелки по кругу; Home и End; Esc — закрыть и вернуть фокус
    await b.evaluate(`(document.querySelector('.topbar .lang-button').focus(), true)`);
    await key('ArrowDown');
    await waitFor(b, `document.activeElement?.getAttribute('role') === 'menuitemradio'`, 'ArrowDown opens the menu on the current language');
    assert.deepEqual(await focused(), { text: 'English', role: 'menuitemradio', checked: 'true', check: true }, 'the current language — checked, with a check mark');
    assert.equal((await button())!.expanded, 'true');
    assert.deepEqual(await b.evaluate<string[]>(`[...document.querySelectorAll('.topbar .lang-menu [role=menuitemradio]')].map((x) => x.getAttribute('aria-checked') + ' ' + x.textContent.trim() + ' ' + x.lang)`),
      ['true English en', 'false Español es', 'false Français fr'], 'native names, the language of each item, one checked');
    await key('ArrowDown');
    assert.equal((await focused())!.text, 'Español');
    await key('End');
    assert.equal((await focused())!.text, 'Français');
    await key('ArrowDown');
    assert.equal((await focused())!.text, 'English', 'arrows go round');
    await key('ArrowUp');
    assert.equal((await focused())!.text, 'Français');
    await key('Home');
    assert.equal((await focused())!.text, 'English');
    await key('Escape');
    assert.deepEqual([await b.evaluate<boolean>(`document.querySelector('.lang-menu') === null`), (await button())!.focused, (await button())!.expanded], [true, true, 'false'],
      'Escape closes the menu and gives the focus back to the button');
    // Нажатие мимо закрывает
    await b.evaluate(`(document.querySelector('.topbar .lang-button').click(), true)`);
    await waitFor(b, `document.querySelector('.topbar .lang-menu') !== null`, 'the menu opens on a click');
    await b.evaluate(`(document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
    await waitFor(b, `document.querySelector('.topbar .lang-menu') === null`, 'a click elsewhere closes the menu');
    // Выбор языка — страница на нём, кнопка называет его кодом
    await chooseLanguage(b, 'Español');
    await b.waitText(es.ui.app.login.roleCan.OWNER);
    assert.deepEqual([await b.evaluate<string>('document.documentElement.lang'), (await button())!.text, (await button())!.label], ['es', 'ES', `${es.ui.app.languageMenu}: Español`]);
    await chooseLanguage(b, 'English');
    await b.waitText(en.ui.app.login.roleCan.OWNER);
    // Телефон: та же кнопка на входе, меню целиком в экране; в пространстве — в выдвижной панели
    for (const scheme of ['light', 'dark'] as const) {
      await b.setColorScheme(scheme);
      await b.setViewport(375, 812);
      await b.open(pageUrl);
      await b.waitText(en.ui.app.login.roleCan.OWNER);
      assert.deepEqual([(await button())!.text, (await button())!.plain], ['EN', 0], `${scheme} 375: the menu button, not «EN · ES · FR»`);
      await b.evaluate(`(document.querySelector('.topbar .lang-button').click(), true)`);
      await waitFor(b, `document.querySelector('.topbar .lang-menu') !== null`, 'the menu opens on a phone');
      const box = await b.evaluate<{ left: number; right: number; bg: string; surface: string }>(`(() => { const r = document.querySelector('.topbar .lang-menu').getBoundingClientRect();
        const p = document.createElement('span'); p.style.background = 'var(--surface)'; document.body.append(p); const surface = getComputedStyle(p).backgroundColor; p.remove();
        return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), bg: getComputedStyle(document.querySelector('.topbar .lang-menu')).backgroundColor, surface }; })()`);
      assert.ok(box.left >= 0 && box.right >= 0, `${scheme} 375: the menu stays on the screen — ${JSON.stringify(box)}`);
      assert.equal(box.bg, box.surface, `${scheme}: the menu is a surface of its theme`);
      assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${scheme} 375: no sideways scroll`);
      await key('Escape');
    }
    await b.setColorScheme('light');
    await b.click(en.ui.app.login.asAccount(en.values.OWNER));
    await waitFor(b, `location.hash.startsWith('#/w/')`, 'into the workspace');
    await settled(b, 'workspace on a phone');
    await b.evaluate(`(document.querySelector('.menu-button').click(), true)`);
    await waitFor(b, `document.querySelector('.sidebar-extras .lang-button') !== null`, 'the drawer holds the language menu');
    await chooseLanguage(b, 'Français', '.sidebar-extras');
    await waitFor(b, `document.documentElement.lang === 'fr'`, 'the language changes from the drawer');
    await b.evaluate(`(document.querySelector('.menu-button').click(), true)`);
    // Гонка теста (шаг 102): после смены языка страница перерисовывается — панель ждётся так же, как при первом открытии
    await waitFor(b, `document.querySelector('.sidebar-extras .lang-button') !== null`, 'the drawer opens again');
    await chooseLanguage(b, 'English', '.sidebar-extras');
    await waitFor(b, `document.documentElement.lang === 'en'`, 'back to English');
  } finally {
    currentApi = euApi;
    await b.setViewport(1440, 900);
    await b.setColorScheme(null);
  }
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

test('step 100 (E): a decision caused by a competitor move names it in the Reason column — a short chip on its own line, the full phrase as its title', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  decisionChip = { chip: 'North Ridge Supply ↓ €17.57', full: en.ui.trace.competitors.trigger('North Ridge Supply', '€18.00', '€17.57') };
  try {
    for (const width of [1440, 375]) {
      await b.setViewport(width, 900);
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed/decisions`)}, true)`);
      await settled(b, `${width}: feed, decisions`);
      const row = await b.evaluate<{ chip: string; title: string | null; cell: string | null; ownLine: boolean; others: number } | null>(`(() => {
        const chip = document.querySelector('.world-content tbody tr .trigger-chip'); if (!chip) return null;
        const reason = chip.closest('td'); const text = [...reason.childNodes].find((n) => n.nodeType === 3);
        return { chip: chip.textContent.trim(), title: chip.getAttribute('title'), cell: reason.getAttribute('data-label'),
          ownLine: chip.parentElement !== reason && chip.parentElement.tagName === 'DIV', others: document.querySelectorAll('.world-content tbody tr .trigger-chip').length - 1 }; })()`);
      assert.deepEqual(row, { chip: decisionChip.chip, title: decisionChip.full, cell: en.ui.trace.columns.reason, ownLine: true, others: 0 }, `${width}: the chip of the competitor move in the Reason column`);
      assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${width}: no sideways scroll`);
      assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${width}: nothing sticks out`);
    }
  } finally {
    decisionChip = null;
    await b.setViewport(1440, 900);
  }
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

test('step 101 (C): the draft offers Anchor and Compete with where they mean something; the receipt dims the excluded offers and heads the table with the filter', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  const t = en.ui.strategies;
  const c = en.ui.trace.competitors;
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/strategies`)}, true)`);
  await settled(b, 'strategies');
  // Поля черновика: подписи над контролами, варианты — словами; у «Match the Buy Box» ориентира нет, у фиксированной цены нет обоих
  const fields = () => b.evaluate<Array<{ label: string; options: string[]; caption: string }>>(`[...document.querySelectorAll('.draft-form .field')].map((f) => ({
    label: f.querySelector('label, .field-label')?.textContent.trim() ?? '', options: [...f.querySelectorAll('option')].map((o) => o.textContent.trim()),
    caption: f.querySelector('.field-caption, .caption')?.textContent.trim() ?? '' })).filter((f) => [${JSON.stringify(t.fields.anchor)}, ${JSON.stringify(t.fields.competeWith)}].includes(f.label))`);
  const chooseType = (type: string) => b.evaluate(`(() => { const sel = [...document.querySelectorAll('.draft-form select')].find((x) => [...x.options].some((o) => o.value === 'FIXED'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(type)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const expected = {
    anchor: { label: t.fields.anchor, options: [t.anchors.BUYBOX, t.anchors.LOWEST, t.anchors.LOWER_OF_TWO], caption: t.captions.anchor },
    competeWith: { label: t.fields.competeWith, options: [t.competeWithOptions.ALL, t.competeWithOptions.CHANNEL, t.competeWithOptions.MERCHANT], caption: t.captions.competeWith },
  };
  assert.deepEqual(await fields(), [expected.competeWith], 'Match the Buy Box: only Compete with');
  assert.match(expected.competeWith.caption, /Walmart does not say who fulfills an offer/, 'the honest caption names where the filter is unavailable');
  for (const type of ['BEAT_LOWEST', 'WIN_BUYBOX']) {
    await chooseType(type);
    await new Promise((x) => setTimeout(x, 200));
    assert.deepEqual(await fields(), [expected.anchor, expected.competeWith], `${type}: Anchor and Compete with`);
  }
  await chooseType('FIXED');
  await new Promise((x) => setTimeout(x, 200));
  assert.deepEqual(await fields(), [], 'a fixed price has neither');

  // Квитанция: исключённые строки остаются — приглушённые, с пометкой; шапка — с кем соревновались и сколько предложений рассмотрено
  receiptCompetitors = {
    trigger: null, note: c.kept, columns: { fulfilment: true, rating: false, buyBox: true, landedKnown: true, uniform: [] },
    filter: { head: c.filterHead(t.competeWithInline.CHANNEL, 1, 3), unknown: c.filterUnknown(1) },
    rows: [
      { seller: 'Prime Shelf', self: false, landed: '€18.41', fulfilment: 'Kaufland', buyBox: true, rating: null, move: null, was: null, landedKnown: true, excluded: null },
      { seller: 'Budget Bin', self: false, landed: '€16.99', fulfilment: en.ui.competition.fulfilment.merchant, buyBox: false, rating: null, move: null, was: null, landedKnown: true, excluded: c.excluded.FILTER },
      { seller: 'Quiet Lane', self: false, landed: '€17.50', fulfilment: null, buyBox: false, rating: null, move: null, was: null, landedKnown: true, excluded: c.excluded.UNKNOWN },
      { seller: c.you, self: true, landed: '€19.50', fulfilment: en.ui.competition.fulfilment.merchant, buyBox: false, rating: null, move: null, was: null, landedKnown: true, excluded: null },
    ],
  };
  try {
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/feed/decisions`)}, true)`);
    await settled(b, 'feed, decisions');
    const receipt = await b.evaluate<string | null>(`document.querySelector('.world-content table a.row-link')?.getAttribute('href') ?? null`);
    assert.ok(receipt, 'the decision list links a receipt');
    for (const scheme of ['light', 'dark'] as const) {
      await b.setColorScheme(scheme);
      for (const width of [1440, 375]) {
        await b.setViewport(width, 900);
        await b.evaluate(`(location.hash = ${JSON.stringify(receipt)}, true)`);
        await settled(b, `${scheme} ${width}: receipt`);
        const seen = await b.evaluate<{ head: string; excluded: Array<[string, string]>; dim: boolean; plain: boolean } | null>(`(() => {
          const box = document.querySelector('details.competitors-at'); if (!box) return null;
          const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim();
          const probe = document.createElement('span'); probe.style.color = muted; document.body.append(probe); const mutedRgb = getComputedStyle(probe).color; probe.remove();
          const rows = [...box.querySelectorAll('tbody tr')];
          const ex = rows.filter((r) => r.classList.contains('excluded-row'));
          return { head: box.querySelector('p.competitors-filter')?.textContent.trim() ?? '',
            excluded: ex.map((r) => [r.querySelector('td.seller').childNodes[0].textContent.trim(), r.querySelector('.excluded-note')?.textContent.trim() ?? '']),
            dim: ex.every((r) => getComputedStyle(r.querySelector('td.landed')).color === mutedRgb),
            plain: rows.filter((r) => !r.classList.contains('excluded-row')).every((r) => getComputedStyle(r.querySelector('td.landed')).color !== mutedRgb) }; })()`);
        assert.deepEqual(seen, { head: `${c.filterHead(t.competeWithInline.CHANNEL, 1, 3)} · ${c.filterUnknown(1)}`,
          excluded: [['Budget Bin', c.excluded.FILTER], ['Quiet Lane', c.excluded.UNKNOWN]], dim: true, plain: true }, `${scheme} ${width}: the excluded offers are dimmed and named, the head counts the snapshot`);
        assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${scheme} ${width}: no sideways scroll`);
        assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${scheme} ${width}: nothing sticks out`);
      }
    }
  } finally {
    receiptCompetitors = null;
    await b.setColorScheme(null);
    await b.setViewport(1440, 900);
  }
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

/**
 * Шаг 100 (C): язык выбирается в меню — кнопка «глобус · EN ▾» в шапке (или в выдвижной панели), пункт с родным именем языка
 */
async function chooseLanguage(b: Browser, name: string, scope = '.topbar'): Promise<void> {
  await b.evaluate(`(document.querySelector(${JSON.stringify(`${scope} .lang-button`)}).click(), true)`);
  await waitFor(b, `document.querySelector(${JSON.stringify(`${scope} .lang-menu`)}) !== null`, `the language menu of ${scope} opens`);
  await b.click(name, `${scope} .lang-menu [role=menuitemradio]`);
}

/** Языки, которые предлагает меню шапки, — их родные имена; меню закрывается Esc */
async function languagesOffered(b: Browser): Promise<string[]> {
  await b.evaluate(`(document.querySelector('.topbar .lang-button').click(), true)`);
  await waitFor(b, `document.querySelector('.topbar .lang-menu') !== null`, 'the language menu opens');
  const names = await b.evaluate<string[]>(`[...document.querySelectorAll('.topbar .lang-menu [role=menuitemradio]')].map((x) => x.textContent.trim())`);
  await b.evaluate(`(document.querySelector('.topbar .lang-menu [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  return names;
}

async function waitFor(b: Browser, expression: string, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await b.evaluate<boolean>(expression))) {
    if (Date.now() > deadline) assert.fail(`${what}: not reached in ${timeoutMs / 1000} s`);
    await new Promise((x) => setTimeout(x, 200));
  }
}

/**
 * Шаг 102 (C) [Р-227]: страница пола — раздел режима распродажи: поле пола в стандарте полей, убыток на штуку считается при вводе, без
 * подтверждения и записки кнопка недоступна и говорит почему; включение — пилюля «Clearance» цветом attention Primer у заголовка страницы
 * пола и у предложения в Offers, обе темы, 1440 и 375 без прокрутки вбок; выключение — одним нажатием
 */
test('step 102 (C): the floor page enables clearance with the loss per piece; the Clearance pill is attention-coloured on the floor page and Offers; one click turns it off', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  const t = en.ui.bounds.clearance;
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
  await settled(b, 'offers');
  const boundsHref = await b.evaluate<string>(`document.querySelector('.world-content a[href*="/bounds/"]').getAttribute('href')`);
  await b.evaluate(`(location.hash = ${JSON.stringify(boundsHref)}, true)`);
  await settled(b, 'floor page');
  await b.waitText(t.title);
  const type = (selector: string, value: string) => b.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await type('section.clearance input[inputmode="decimal"]', '1.00');
  await new Promise((x) => setTimeout(x, 200));
  const form = await b.evaluate<{ loss: string; disabled: boolean; why: string }>(`(() => { const s = document.querySelector('section.clearance');
    const outputs = [...s.querySelectorAll('output.field-value')].map((o) => o.textContent.trim());
    const button = [...s.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(t.enable)});
    return { loss: outputs[1] ?? '', disabled: button.disabled, why: button.title }; })()`);
  assert.match(form.loss, /^−€\d+\.\d{2}$/, `the loss per piece is computed while typing — ${form.loss}`);
  assert.deepEqual([form.disabled, form.why], [true, t.causes.ACK_REQUIRED], 'without the acknowledgement the button says why');
  await b.evaluate(`(document.querySelector('section.clearance input[type=checkbox]').click(), true)`);
  await type('section.clearance input[placeholder]', 'Clearing summer stock');
  await new Promise((x) => setTimeout(x, 200));
  await b.click(t.enable, 'section.clearance button');
  await b.waitText(t.on);
  const pillColour = `(() => { const pill = document.querySelector('h2 .badge.tone-warn'); if (!pill) return null;
    const probe = document.createElement('span'); probe.style.color = 'var(--warning)'; document.body.append(probe); const attention = getComputedStyle(probe).color; probe.remove();
    return { text: pill.textContent.trim(), attention: getComputedStyle(pill).color === attention }; })()`;
  for (const scheme of ['light', 'dark'] as const) {
    await b.setColorScheme(scheme);
    for (const width of [1440, 375]) {
      await b.setViewport(width, 900);
      await settled(b, `${scheme} ${width}: floor page`);
      assert.deepEqual(await b.evaluate(pillColour), { text: en.ui.products.clearancePill, attention: true }, `${scheme} ${width}: the pill uses the attention token`);
      const fit = await b.evaluate<{ scrollWidth: number; width: number; out: string[] }>(PAGE_FIT);
      assert.ok(fit.scrollWidth <= fit.width, `${scheme} ${width}: the floor page does not scroll sideways — ${fit.out.join('; ')}`);
    }
  }
  await b.setColorScheme('light');
  await b.setViewport(1440, 900);
  // Offers: пилюля у названия предложения
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
  await settled(b, 'offers with clearance');
  assert.equal(await b.evaluate<number>(`document.querySelectorAll('.world-content td.offer .badge.tone-warn').length`), 1, 'the offer in clearance carries the pill on Offers');
  // Выключение — одним нажатием
  await b.evaluate(`(location.hash = ${JSON.stringify(boundsHref)}, true)`);
  await settled(b, 'floor page again');
  await b.click(t.disable, 'section.clearance button');
  await waitFor(b, `document.querySelector('h2 .badge.tone-warn') === null`, 'one click turns clearance off');
  /**
   * Уточнение владельца к шагу 102: «пол выше потолка» (безубыточность выросла выше max_price) теперь законное состояние — и видимое:
   * пометка у предложения в Offers и плашка на странице пола с тем, что сделать. Себестоимость поднимается тем же путём, что сценарии
   * стенда (`setCost` хранилища в памяти), и возвращается — следующие проверки видят мир прежним
   */
  const state = await smokeLive.view(STAND_USERS[0] as never) as { state: { scopes: Array<{ writeScopeId: string; cost: unknown; bounds: { max: { status: string; amountMinor?: number } } }> } };
  const writeScopeId = decodeURIComponent(boundsHref.split('/').pop()!);
  const scope = state.state.scopes.find((x) => x.writeScopeId === writeScopeId)!;
  const store = smokeLive.store as unknown as { setCost(id: string, cost: unknown): void };
  assert.equal(typeof store.setCost, 'function', 'the smoke world keeps its store in memory');
  assert.equal(scope.bounds.max.status, 'RESOLVED');
  const before102 = scope.cost;
  store.setCost(writeScopeId, { ...(scope.cost as object), unitCostMinor: scope.bounds.max.amountMinor! * 2 });
  try {
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
    await settled(b, 'offers with a floor above the ceiling');
    const frozen = await b.evaluate<string[]>(`[...document.querySelectorAll('.world-content td.offer .badge.tone-stop')].map((x) => x.textContent.trim())`);
    assert.ok(frozen.includes(en.ui.products.floorAboveCeiling), `the frozen offer is marked on Offers — ${JSON.stringify(frozen)}`);
    await b.evaluate(`(location.hash = ${JSON.stringify(boundsHref)}, true)`);
    await settled(b, 'floor page with a floor above the ceiling');
    const notice = await b.evaluate<string | null>(`document.querySelector('.notice.frozen')?.textContent.trim() ?? null`);
    assert.match(notice ?? '', /^Floor above ceiling — prices frozen\. .*Raise the maximum price or enable clearance\.$/, 'the floor page says why prices stand and what to do');
  } finally {
    store.setCost(writeScopeId, before102);
  }
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

/**
 * Шаг 103 [Р-228]: карточка аккаунта на Channels называет стратегию по умолчанию для новых предложений одной строкой и задаёт её — выбором
 * стандарта формы (Field), кнопка без изменения говорит почему; после сохранения строка называет стратегию и кто задал. Обе темы, 1440 и 375 —
 * без прокрутки вбок, выбор не выходит за карточку
 */
test('step 103 (D) [Р-228]: the channel account card says the default strategy for new offers in one line and sets it; both themes, 375 to 1440', async () => {
  const b = browser!;
  const before = b.errors().length;
  currentApi = euApi;
  const t = en.ui.connections.defaultStrategy;
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
  const world = (await b.evaluate<string>('location.hash')).split('/')[2]!;
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/channels`)}, true)`);
  await settled(b, 'channels');
  await b.waitText(t.title);
  const line = () => b.evaluate<string>(`document.querySelector('.account-default .default-line')?.textContent.trim() ?? ''`);
  assert.equal(await line(), t.line(t.none), 'no default yet — «None», the behaviour before the step');
  const choice = await b.evaluate<{ value: string; label: string; options: number; disabled: boolean; why: string }>(`(() => { const s = document.querySelector('.account-default select');
    const o = [...s.options].find((x) => x.value !== '' && !x.disabled); const button = document.querySelector('.account-default button.primary');
    return { value: o.value, label: o.textContent.trim(), options: s.options.length, disabled: button.disabled, why: button.title }; })()`);
  assert.ok(choice.options >= 2, 'None and at least one strategy to choose');
  assert.deepEqual([choice.disabled, choice.why], [true, en.ui.forms.why.chooseOther], 'nothing changed — the button says why');
  await b.evaluate(`(() => { const s = document.querySelector('.account-default select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(choice.value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await new Promise((x) => setTimeout(x, 200));
  await b.click(t.save, '.account-default button');
  await waitFor(b, `(document.querySelector('.account-default .default-line')?.textContent ?? '').startsWith(${JSON.stringify(`${t.line(choice.label)} · set by `)})`,
    'the line names the strategy and who set it');
  const fits = `(() => { const card = document.querySelector('.card.account').getBoundingClientRect(), s = document.querySelector('.account-default select').getBoundingClientRect();
    return s.left >= card.left - 0.5 && s.right <= card.right + 0.5; })()`;
  for (const scheme of ['light', 'dark'] as const) {
    await b.setColorScheme(scheme);
    for (const width of [1440, 375]) {
      await b.setViewport(width, 900);
      await settled(b, `${scheme} ${width}: channels`);
      const fit = await b.evaluate<{ scrollWidth: number; width: number; out: string[] }>(PAGE_FIT);
      assert.ok(fit.scrollWidth <= fit.width, `${scheme} ${width}: Channels does not scroll sideways — ${fit.out.join('; ')}`);
      assert.equal(await b.evaluate<boolean>(fits), true, `${scheme} ${width}: the select stays inside the account card`);
    }
  }
  await b.setColorScheme('light');
  await b.setViewport(1440, 900);
  // Вернуть «None»: следующие проверки видят мир прежним
  await b.evaluate(`(() => { const s = document.querySelector('.account-default select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ''); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await new Promise((x) => setTimeout(x, 200));
  await b.click(t.save, '.account-default button');
  await waitFor(b, `(document.querySelector('.account-default .default-line')?.textContent ?? '').startsWith(${JSON.stringify(`${t.line(t.none)} · set by `)})`, 'back to «None»');
  assert.deepEqual(b.errors().slice(before), [], 'no page errors');
});

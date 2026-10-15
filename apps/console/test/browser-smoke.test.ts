import assert from 'node:assert/strict';
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
  const connect = (worldId: string) => (worldId === EMPTY_WORLD_ID ? emptyWorldConnect : null);
  // Основной стенд — профиль eu: смоук Kaufland и немецкие проходы шагов 76–86 гоняются на нём (Европа заморожена, не удалена)
  euApi = createStandApi(all, identity, { defaultLocale: 'en', market: 'eu', connect, people: STAND_PEOPLE });
  usApi = createStandApi(all, identity, { market: 'us', connect, people: STAND_PEOPLE });
  extendedApi = createStandApi(all, identity, { market: 'us', connect, extendedRoles: true, people: STAND_PEOPLE });
  currentApi = euApi;
  stand = createStandServer((req) => currentApi(req));
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
    for (const screen of ['products', 'decisions', 'strategies', 'feed', 'rejected', 'bounds', 'stop', 'stock', 'jobs']) {
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
const SCREENS = ['shadow', 'products', 'stock', 'feed', 'decisions', 'rejected', 'dangerous', 'bounds', 'stop', 'connections', 'strategies', 'onboarding', 'compliance', 'jobs', 'cost-import'];
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
const SMALL_TARGETS = `[...document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]), .nav-group a, a.row-link, .tabs a, summary')]
  .filter((el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 43.5)
  .slice(0, 5).map((el) => el.tagName.toLowerCase() + ' «' + (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30) + '» ' + Math.round(el.getBoundingClientRect().height) + 'px')`;

test('step 85: the console works from a 375px phone to a wide monitor — no page errors, no sideways page scroll, 44px touch targets, a drawer for the nav', async () => {
  const b = browser!;
  const before = b.errors().length;
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  // Шаг 93: светлая тема — на всех ширинах, тёмная — на телефоне и мониторе
  const RUNS: ReadonlyArray<readonly ['light' | 'dark', number, number]> = [...WIDTHS.map(([w, h]) => ['light', w, h] as const), ['dark', 375, 812], ['dark', 1440, 900]];
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
    };
    await checkPage('sign-in');
    // Шаг 93: тема действительно та — канва страницы цветом своей темы Primer (`--bgColor-muted`: светлая #f6f8fa, тёмная #151b23)
    assert.equal(await b.evaluate<string>('getComputedStyle(document.body).backgroundColor'), scheme === 'dark' ? 'rgb(21, 27, 35)' : 'rgb(246, 248, 250)', `${scheme} ${width}px: the canvas`);
    await b.click(owner);
    await b.waitText(en.ui.app.worlds);
    await checkPage('workspaces');
    if (narrow) {
      // Шаг 93: шапка телефона вне пространства — знак, язык, тема и выход; немецкие подписи длиннее («Wie das System», «Abmelden»)
      await b.click(de.ui.app.languages.de, '.topbar .lang button');
      await b.waitText(de.ui.app.worlds);
      await checkPage('workspaces, German');
      await b.click(de.ui.app.languages.en, '.topbar .lang button');
      await b.waitText(en.ui.app.worlds);
    }
    const world = (await b.evaluate<string>(`document.querySelector('h3 a').getAttribute('href')`)).split('/')[2]!;
    for (const screen of SCREENS) {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${screen}`)}, true)`);
      await settled(b, `${width}px ${screen}`);
      await checkPage(screen);
    }
    if (width === 1440 && scheme === 'light') {
      // положительный контроль: прежний отступ «карточка после карточки» внутри сетки — правило краснеет на экране остановок
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/stop`)}, true)`);
      await settled(b, `${width}px stop, control`);
      await b.evaluate(`(() => { const st = document.createElement('style'); st.id = 'row-control'; st.textContent = '.cards > .card + .card { margin-top: var(--space-3) !important; }'; document.head.append(st); return true; })()`);
      const bad = await b.evaluate<string[]>(ROW_MISALIGNED);
      await b.evaluate(`(document.getElementById('row-control').remove(), true)`);
      assert.ok(bad.length > 0, 'control: a card pushed down inside a row is caught');
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/cost-import`)}, true)`);
      await settled(b, `${width}px back to cost-import`);
    }
    // навигация: на узком — выдвижная панель за кнопкой меню, на широком — боковая панель на месте, кнопки меню нет
    const nav = () => b.evaluate<{ menu: boolean; sidebar: boolean; screen: string }>(
      `({ menu: !!document.querySelector('.menu-button')?.checkVisibility({ visibilityProperty: true }), sidebar: document.querySelector('.sidebar').checkVisibility({ visibilityProperty: true }), screen: location.hash.split('/')[3] ?? '' })`);
    if (!narrow) {
      assert.deepEqual(await nav(), { menu: false, sidebar: true, screen: 'cost-import' }, `${width}px: the side nav stays in place without a menu button`);
      continue;
    }
    assert.deepEqual(await nav(), { menu: true, sidebar: false, screen: 'cost-import' }, `${width}px: the nav hides behind the menu button`);
    const open = async () => { await b.click(en.ui.app.menu); assert.equal((await nav()).sidebar, true, `${width}px: the menu button opens the drawer`); };
    await open();
    // пункты меню, «← All workspaces», язык и выход видны только в открытой панели — и проверяются в ней
    assert.deepEqual(await b.evaluate<string[]>(SMALL_TARGETS), [], `${width}px, open drawer: touch targets lower than 44px`);
    await b.click(en.ui.app.screens.stock, '.nav-group a');
    assert.deepEqual(await nav(), { menu: true, sidebar: false, screen: 'stock' }, `${width}px: choosing an item navigates and closes the drawer`);
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
  return out.slice(0, 5);
})()`;

test('step 86: every menu item and the heading of its page are the same words — English and German', async () => {
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
  for (const m of [en, de]) {
    if (m === de) {
      await b.click(en.ui.app.languages.de, '.topbar .lang button');
      await b.waitText(de.ui.app.screens.stock);
    }
    const links = await b.evaluate<Array<{ text: string; href: string }>>(
      `[...document.querySelectorAll('.nav-group a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
    assert.ok(links.length >= 12, `${m.locale}: the navigation shows its items — ${links.length}`);
    assert.ok(links.some((l) => l.text === m.ui.app.screens.decisions), `${m.locale}: the navigation speaks the screen language`);
    const mismatches: string[] = [];
    for (const l of links) {
      await b.evaluate(`(location.hash = ${JSON.stringify(l.href)}, true)`);
      await settled(b, `${m.locale} ${l.text}`);
      const heading = await b.evaluate<string>(`(document.querySelector('.world-content h2') ?? document.querySelector('.world-content h3'))?.childNodes[0]?.textContent?.trim() ?? ''`);
      if (heading !== l.text) mismatches.push(`«${l.text}» → «${heading}»`);
      assert.deepEqual(await b.evaluate<string[]>(OUT_OF_BOX), [], `${m.locale} ${l.text}: content sticks out of its frame`);
    }
    assert.deepEqual(mismatches, [], `${scheme} ${m.locale}: a menu item leads to a page with another heading`);
  }
  await b.click(de.ui.app.languages.en, '.topbar .lang button');
  await b.waitText(en.ui.app.screens.stock);
  }
  await b.setColorScheme(null);
  // Положительный контроль [Р-94]: таблица, растянутая за поля карточки, как была до шага 86, — выступ, и правило его видит
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<section class="card" id="out-control"><table style="margin: 0 -24px; width: calc(100% + 48px)"><tbody><tr><td>control</td></tr></tbody></table></section>'), true)`);
  assert.match((await b.evaluate<string[]>(OUT_OF_BOX)).join(' | '), /sticks out of section\.card by 7px/);
  await b.evaluate(`(document.getElementById('out-control').remove(), true)`);
});

/**
 * Шаг 93: тема — свойство устройства. По умолчанию — системная (`prefers-color-scheme`); ручной выбор «светлая» или «тёмная» перебивает
 * систему и переживает перезагрузку; «как система» возвращает системную. Значения — пары Primer: канва `--bgColor-muted`, карточка
 * `--bgColor-default`, текст `--fgColor-default`. Шапка называет человека по имени от поставщика identity, адрес — подсказкой
 */
test('step 93: the theme belongs to the device — system by default, light, dark or system by hand, kept over a reload; the header names the person', async () => {
  const b = browser!;
  await b.setViewport(1440, 900);
  await b.setColorScheme('dark');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  const colours = () => b.evaluate<{ canvas: string; card: string; text: string }>(`(() => { const card = document.querySelector('.card.login') ?? document.querySelector('.card');
    return { canvas: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(card).backgroundColor, text: getComputedStyle(card).color }; })()`);
  const choose = (v: string) => b.evaluate(`(() => { const s = document.querySelector('.topbar .theme-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(v)});
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const DARK = { canvas: 'rgb(21, 27, 35)', card: 'rgb(13, 17, 23)', text: 'rgb(240, 246, 252)' };
  const LIGHT = { canvas: 'rgb(246, 248, 250)', card: 'rgb(255, 255, 255)', text: 'rgb(31, 35, 40)' };
  assert.deepEqual(await colours(), DARK, 'a dark system gets the dark Primer pairs without a choice');
  assert.deepEqual(await b.evaluate<string[]>(`[...document.querySelectorAll('.topbar .theme-select option')].map((o) => o.textContent)`),
    [en.ui.app.theme.system, en.ui.app.theme.light, en.ui.app.theme.dark]);
  await choose('light');
  assert.deepEqual(await colours(), LIGHT, 'the light choice wins over a dark system');
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  assert.deepEqual(await colours(), LIGHT, 'the choice is kept on the device over a reload');
  await choose('system');
  assert.deepEqual(await colours(), DARK, '«system» follows the system again');
  await b.setColorScheme('light');
  await choose('dark');
  assert.deepEqual(await colours(), DARK, 'the dark choice wins over a light system');
  await choose('system');
  assert.deepEqual(await colours(), LIGHT);
  // Шапка: человек по имени, адрес — подсказкой
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  assert.deepEqual(await b.evaluate<{ text: string; title: string }>(`(() => { const u = document.querySelector('.topbar .user'); return { text: u.textContent.trim(), title: u.getAttribute('title') }; })()`),
    { text: 'Alex Porter', title: en.ui.app.login.signedIn('owner@stand.repracer.test') });
  await b.setColorScheme(null);
});

/**
 * Шаг 87 [Р-214]: профиль рынка us — продукт выходит в США. Европейское спрятано, но не удалено: в профиле us нет переключателя языка,
 * вкладки Omnibus, канала Kaufland и витрин ЕС ни на одном экране; рабочие пространства без витрины профиля не показываются; пункт меню
 * по-прежнему равен заголовку страницы. Профиль eu на тех же мирах показывает Европу — положительный контроль правила
 */
const EUROPE = /Kaufland|kaufland\.|amazon\.de|ebay\.de|€|\bEUR\b|Deutsch|Omnibus/;

test('step 87: the us market profile shows no German, no Omnibus, no Kaufland and no European storefront on any screen; eu still does', async () => {
  const b = browser!;
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  const europeOnPage = async () => { const t = await b.evaluate<string>('document.body.innerText'); const found = EUROPE.exec(t); return found ? `«${found[0]}» in …${t.slice(Math.max(0, found.index - 80), found.index + 40)}…` : null; };
  currentApi = usApi;
  try {
    await b.setViewport(1440, 900);
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OWNER);
    assert.equal(await b.evaluate<number>(`document.querySelectorAll('.lang button').length`), 0, 'us: no language switch on sign-in');
    assert.equal(await europeOnPage(), null, 'us: sign-in');
    await b.click(owner);
    await b.waitText(en.ui.app.worlds);
    const titles = await b.evaluate<string[]>(`[...document.querySelectorAll('h3 a')].map((a) => a.textContent.trim())`);
    assert.deepEqual(titles, ['Empty workspace'], 'us: a workspace whose storefronts are all European is not offered; an empty one is');
    await b.click('Empty workspace');
    await settled(b, 'us empty workspace');
    const links = await b.evaluate<Array<{ text: string; href: string }>>(
      `[...document.querySelectorAll('.nav-group a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
    assert.ok(links.length >= 12 && !links.some((l) => l.text === en.ui.app.screens.compliance), `us: no Omnibus in the menu — ${links.map((l) => l.text).join(', ')}`);
    for (const l of links) {
      await b.evaluate(`(location.hash = ${JSON.stringify(l.href)}, true)`);
      await settled(b, `us ${l.text}`);
      const heading = await b.evaluate<string>(`(document.querySelector('.world-content h2') ?? document.querySelector('.world-content h3'))?.childNodes[0]?.textContent?.trim() ?? ''`);
      assert.equal(heading, l.text, `us: the menu item and the heading of its page`);
      assert.equal(await europeOnPage(), null, `us: ${l.text}`);
    }
    // Подключение предлагает витрины США — словами — и только их
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/connections`)}, true)`);
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
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/connections`)}, true)`);
  await settled(b, 'eu connections');
  const eu = await europeOnPage();
  assert.ok(eu !== null && /amazon\.de|Deutsch/.test(eu), `eu: the rule sees Europe — ${eu}`);
  assert.ok(!/\bWalmart\b/.test(await b.evaluate<string>('document.body.innerText')), 'eu: Walmart is a channel of the us market only');
  const euMenu = await b.evaluate<string[]>(`[...document.querySelectorAll('.nav-group a')].map((a) => a.textContent.trim())`);
  assert.ok(euMenu.includes(en.ui.app.screens.compliance), `eu: the same workspace has the Omnibus tab — ${euMenu.join(', ')}`);
});

test('step 88 (Р-213): sign-in offers three roles at 375 and 1440, five with the extended roles flag; the manager does not manage channel accounts; the audit log names roles', async () => {
  const b = browser!;
  const rows = () => b.evaluate<string[]>(`[...document.querySelectorAll('.role-row .role-name')].map((e) => e.textContent.trim())`);
  const can = () => b.evaluate<string[]>(`[...document.querySelectorAll('.role-row .role-can')].map((e) => e.textContent.trim())`);
  currentApi = usApi;
  try {
    for (const width of [375, 1440]) {
      await b.setViewport(width, 900);
      await b.open(pageUrl);
      await b.waitText(en.ui.app.login.roleCan.MANAGER);
      assert.deepEqual(await rows(), ['Owner', 'Manager', 'Viewer'], `${width}: three visible roles`);
      assert.deepEqual(await can(), [en.ui.app.login.roleCan.OWNER, en.ui.app.login.roleCan.MANAGER, en.ui.app.login.roleCan.VIEWER], `${width}: each role says what it may do`);
      assert.ok(await b.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), `${width}: no sideways scroll on sign-in`);
    }
    await b.setViewport(1440, 900);
    // Положительный контроль флага: тот же стенд с расширенными ролями — пять строк, прежние роли за флагом живы
    currentApi = extendedApi;
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.OPERATOR);
    assert.deepEqual(await rows(), ['Owner', 'Manager', 'Viewer', 'Admin', 'Operator'], 'the extended roles flag adds admin and operator');
    currentApi = usApi;
    await b.open(pageUrl);
    await b.waitText(en.ui.app.login.roleCan.MANAGER);
    await b.click(en.ui.app.login.asAccount(en.values.MANAGER));
    await b.waitText(en.ui.app.worlds);
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/connections`)}, true)`);
    await settled(b, 'manager connections');
    const connections = await b.evaluate<string>('document.body.innerText');
    assert.ok(connections.includes(en.ui.connections.noRight), 'the manager reads that channel accounts are the owner’s');
    assert.equal(await b.evaluate<number>(`[...document.querySelectorAll('button')].filter((x) => /^Connect/.test(x.textContent.trim())).length`), 0, 'no connect button for the manager');
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${encodeURIComponent(EMPTY_WORLD_ID)}/stop`)}, true)`);
    await settled(b, 'manager stop');
    assert.ok((await b.evaluate<string>('document.body.innerText')).includes(en.ui.stop.auditTitle), 'the audit log of stops and roles');
  } finally {
    currentApi = euApi;
    await b.setViewport(1440, 900);
  }
});

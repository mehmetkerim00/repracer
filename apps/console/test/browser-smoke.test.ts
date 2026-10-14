import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { messagesFor } from '@repracer/console-model';
import { buildStandWorlds, memoryStandDirectory, STAND_AUDIENCE, STAND_ISSUER } from '@repracer/contract-tests/stand';
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
let stand: ReturnType<typeof createStandServer> | null = null;
let vite: ViteDevServer | null = null;
let browser: Browser | null = null;
let pageUrl = '';
/** Шаг 87: два экземпляра API на одних мирах — профиль eu (Kaufland, немецкий, Omnibus) и профиль us; сервер стенда ходит в текущий */
let euApi: ReturnType<typeof createStandApi>;
let usApi: ReturnType<typeof createStandApi>;
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
  // Шаг 87: рядом — пустое рабочее пространство (онбординг и подключение предлагают каналы и витрины профиля)
  const empty = emptyWorld(worlds[0]!.clock);
  // Счётчики пустого пространства говорят «есть витрина ЕС»: тогда вкладку Omnibus в профиле us прячет ИМЕННО профиль, а в eu она на месте
  const counters = empty.store.worldCounters.bind(empty.store);
  (empty.store as { worldCounters: typeof counters }).worldCounters = async (...args) => ({ ...(await counters(...args)), euStorefronts: true });
  const all = [...worlds, empty];
  const identity: Parameters<typeof createStandApi>[1] = {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(all) }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 },
  };
  const connect = (worldId: string) => (worldId === EMPTY_WORLD_ID ? emptyWorldConnect : null);
  // Основной стенд — профиль eu: смоук Kaufland и немецкие проходы шагов 76–86 гоняются на нём (Европа заморожена, не удалена)
  euApi = createStandApi(all, identity, { defaultLocale: 'en', market: 'eu', connect });
  usApi = createStandApi(all, identity, { market: 'us', connect });
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
  assert.equal(await b.evaluate<string>('document.title'), en.ui.app.title, 'the tab title is the console title, not a Russian placeholder');
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
  for (const screen of ['products', 'decisions', 'strategies', 'feed', 'rejected', 'bounds', 'stop', 'stock', 'jobs']) {
    await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${screen}`)}, true)`);
    await settled(b, screen);
    for (const t of await stickyTables()) assert.ok(t.table <= t.wrap + 1, `${screen}: the table is ${t.table}px wide in a ${t.wrap}px frame — columns hide under the pinned action column`);
  }
  // Положительный контроль правила: в суженной рамке та же таблица товаров обязана НЕ поместиться — иначе проверка выше ничего не мерит
  await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/products`)}, true)`);
  await settled(b, 'products (control)');
  assert.ok((await stickyTables()).length > 0, 'the products screen of the smoke world has a table with a pinned column');
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
const SMALL_TARGETS = `[...document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]), .nav-group a, a.row-link, .tabs a, summary')]
  .filter((el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 43.5)
  .slice(0, 5).map((el) => el.tagName.toLowerCase() + ' «' + (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30) + '» ' + Math.round(el.getBoundingClientRect().height) + 'px')`;

test('step 85: the console works from a 375px phone to a wide monitor — no page errors, no sideways page scroll, 44px touch targets, a drawer for the nav', async () => {
  const b = browser!;
  const before = b.errors().length;
  const owner = en.ui.app.login.asAccount(en.values.OWNER);
  for (const [width, height] of WIDTHS) {
    const narrow = width < 1012;
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
    };
    await checkPage('sign-in');
    await b.click(owner);
    await b.waitText(en.ui.app.worlds);
    await checkPage('workspaces');
    const world = (await b.evaluate<string>(`document.querySelector('h3 a').getAttribute('href')`)).split('/')[2]!;
    for (const screen of SCREENS) {
      await b.evaluate(`(location.hash = ${JSON.stringify(`#/w/${world}/${screen}`)}, true)`);
      await settled(b, `${width}px ${screen}`);
      await checkPage(screen);
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
  const de = messagesFor('de');
  await b.setViewport(1440, 900);
  await b.open(pageUrl);
  await b.waitText(en.ui.app.login.roleCan.OWNER);
  await b.click(en.ui.app.login.asAccount(en.values.OWNER));
  await b.waitText(en.ui.app.worlds);
  await b.click(await b.evaluate<string>(`document.querySelector('h3 a').textContent.trim()`));
  await settled(b, 'first screen');
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
    assert.deepEqual(mismatches, [], `${m.locale}: a menu item leads to a page with another heading`);
  }
  // Положительный контроль [Р-94]: таблица, растянутая за поля карточки, как была до шага 86, — выступ, и правило его видит
  await b.evaluate(`(document.querySelector('.world-content').insertAdjacentHTML('beforeend', '<section class="card" id="out-control"><table style="margin: 0 -24px; width: calc(100% + 48px)"><tbody><tr><td>control</td></tr></tbody></table></section>'), true)`);
  assert.match((await b.evaluate<string[]>(OUT_OF_BOX)).join(' | '), /sticks out of section\.card by 7px/);
  await b.evaluate(`(document.getElementById('out-control').remove(), true)`);
  await b.click(de.ui.app.languages.en, '.topbar .lang button');
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
  const euMenu = await b.evaluate<string[]>(`[...document.querySelectorAll('.nav-group a')].map((a) => a.textContent.trim())`);
  assert.ok(euMenu.includes(en.ui.app.screens.compliance), `eu: the same workspace has the Omnibus tab — ${euMenu.join(', ')}`);
});

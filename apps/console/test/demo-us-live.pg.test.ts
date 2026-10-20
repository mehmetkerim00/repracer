import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { messagesFor, type BoundsView, type ConnectionsView, type DecisionListView, type DecisionTrace, type PriceFeedView, type ShadowView, type UnitRef } from '@repracer/console-model';
import type { StandToken, WorldSummary } from '../src/api-types.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startConsole, type RunningConsole } from '../server/console-service.ts';

/**
 * Шаг 87 [Р-214]: профиль рынка развёртывания us — демо американского продавца: amazon.com и ebay.com, доллары, склад в Делавэре, без
 * Kaufland и без витрин ЕС; немецкого и Omnibus нет. Ниже — прежние утверждения шагов 64–69 о витринах США, теперь на этом демо.
 *
 * Шаг 64: профиль США в демо (`REPRACER_CONSOLE_DEMO_US=on`) — через разворачиваемую консоль, как браузер гостя [Р-136, Р-160]:
 * рядом с Kaufland в демо-тенанте два аккаунта витрин США — eBay EBAY_US и Amazon amazon.com. Оба рождены в тени [Р-176], каталог
 * записан функцией обнаружения [Р-179], вопрос о других инструментах [Р-202] не отвечен и задан по-английски. До шага 64 у демо не
 * было службы подключений вовсе: экран подключений демо был пуст, и показать вопрос было негде. Гость — наблюдатель: ответить не может.
 */

let db: IsolatedDatabase;
let console_: RunningConsole;
let origin = '';

async function call<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, cookie: 'repracer_locale=en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

let env: Record<string, string> = {};
/** Шаг 103 [Р-228]: два новых листинга amazon.com главного демо — с правилом умолчания аккаунта */
const NEW_AMAZON_OFFERS = 2;

before(async () => {
  assert.ok(existsSync(new URL('../dist/index.html', import.meta.url)), 'интерфейс не собран: `npm run build -w apps/console`');
  db = await createIsolatedDatabase('demous');
  const url = (login: Parameters<typeof db.url>[0]) => db.url(login);
  env = {
    REPRACER_MODE: 'stand', REPRACER_CONSOLE_PORT: '0', REPRACER_CONSOLE_METRICS_PORT: '0',
    REPRACER_CONSOLE_DIST: new URL('../dist', import.meta.url).pathname,
    REPRACER_MARKET_PROFILE: 'us',
    REPRACER_CONSOLE_PUBLIC_DEMO: 'on', REPRACER_CONSOLE_DEMO_US: 'on', REPRACER_CONSOLE_HEARTBEAT: 'off', REPRACER_CONSOLE_GUEST_KEY: 'ephemeral',
    REPRACER_CONSOLE_LOCALE: 'en',
    // Шаг 69 (K4): пояс показа демо для клиента из США — его пояс; без него — пояс первой витрины демо (Kaufland de)
    REPRACER_CONSOLE_DEMO_TIME_ZONE: 'America/Los_Angeles',
    // Шаг 68 (K7): неделя тени США прожата при посеве демо — недельное письмо показуемо сразу
    REPRACER_CONSOLE_DEMO_PRESS_DAYS: '7',
    REPRACER_CONSOLE_APP_PG_URL: url('svc_app'), REPRACER_CONSOLE_ADMIN_PG_URL: url('svc_admin'),
    REPRACER_CONSOLE_AUTHENTICATOR_PG_URL: url('svc_authenticator'), REPRACER_CONSOLE_ONBOARDING_PG_URL: url('svc_onboarding'),
    REPRACER_CONSOLE_PROVISIONING_PG_URL: url('svc_provisioning'), REPRACER_CONSOLE_DISPATCHER_PG_URL: url('svc_dispatcher'),
    REPRACER_CONSOLE_STOCK_PG_URL: url('svc_stock'), REPRACER_CONSOLE_SCHEDULER_PG_URL: url('svc_scheduler'),
    REPRACER_CONSOLE_EXPORTER_PG_URL: url('svc_exporter'), REPRACER_CONSOLE_FX_LOADER_PG_URL: url('svc_fx_loader'),
    REPRACER_CONSOLE_BULK_WORKER_PG_URL: url('svc_bulk_worker'),
  };
  console_ = await startConsole(env);
  origin = `http://127.0.0.1:${console_.port}`;
});

after(async () => {
  await console_?.close();
  await db?.drop();
});

/**
 * Шаг 64 (ревью, находка 1): язык развёртывания — язык первого экрана нового браузера. Прогоны шлют куку языка в каждом запросе и
 * этого не видели: консоль региона США с `REPRACER_CONSOLE_LOCALE=en` открывалась по-немецки
 */
test('шаг 64, 87: новый браузер без куки видит язык развёртывания; в профиле us немецкого нет — и кука его не включает', async () => {
  const first = (await (await fetch(`${origin}/api/session`)).json()) as { locale: string; market: { profile: string; locales: string[]; omnibus: boolean } };
  assert.equal(first.locale, 'en', 'первый экран консоли региона США — английский');
  // Шаг 98 [Р-223]: в профиле us — английский, испанский и французский; немецкого нет
  assert.deepEqual(first.market, { profile: 'us', locales: ['en', 'es', 'fr'], omnibus: false }, 'профиль us: английский, испанский и французский, без Omnibus');
  // Шаг 87: немецкий словарь остаётся в репозитории, но профиль us его не предлагает — кука «de» не делает экран немецким
  const chosen = (await (await fetch(`${origin}/api/session`, { headers: { cookie: 'repracer_locale=de' } })).json()) as { locale: string };
  assert.equal(chosen.locale, 'en', 'кука de в профиле us — английский экран');
  const switched = await fetch(`${origin}/api/session/locale`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'de' }) });
  assert.equal(switched.status, 400, 'переключить на немецкий в профиле us нельзя и прямым запросом');
});

test('шаг 64: демо с профилем США — аккаунты eBay US и Amazon US в тени, каталог найден, вопрос о других инструментах задан по-английски', async () => {
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(issued.status, 200);
  const guest = ((await issued.json()) as StandToken).accessToken;
  const worlds = await call<WorldSummary[]>('GET', '/api/worlds', guest);
  const demo = worlds.body.find((w) => w.demo);
  assert.ok(demo, `демо-мир в списке: ${JSON.stringify(worlds.body)}`);
  const screen = await call<ConnectionsView>('GET', `/api/worlds/${encodeURIComponent(demo.id)}/connections`, guest);
  assert.equal(screen.status, 200, JSON.stringify(screen.body).slice(0, 300));
  // Шаг 87: у американского демо аккаунты только витрин США — amazon.com и ebay.com, с шага 89 и walmart.com; Kaufland и Amazon ЕС нет вовсе
  const us = screen.body.accounts.filter((a) => a.marketplaces.includes('EBAY_US') || a.marketplaces.includes('ATVPDKIKX0DER') || a.marketplaces.includes('WALMART_US'));
  assert.deepEqual(us.map((a) => a.channel).sort(), ['AMAZON', 'EBAY', 'WALMART'], `аккаунты витрин США на экране подключений: ${JSON.stringify(screen.body.accounts.map((a) => a.channel))}`);
  assert.equal(screen.body.accounts.length, 3, `кроме витрин США аккаунтов нет: ${JSON.stringify(screen.body.accounts.map((a) => [a.channel, a.marketplaces]))}`);
  for (const a of us) {
    assert.equal(a.state, 'SHADOW', `${a.channel}: аккаунт рождён в тени`);
    // Шаг 103: у amazon.com после прожатой недели появились два новых листинга — их завёл обход каталога с правилом умолчания
    assert.equal(a.offers, a.channel === 'AMAZON' ? 12 + NEW_AMAZON_OFFERS : 12, `${a.channel}: каталог из обнаружения — ${a.progressText}`);
    assert.equal(a.otherTools.question, 'Does another tool update stock or prices in this channel?');
    // Шаг 87: остатки amazon.com ведёт склад демо — владелец ответил «других инструментов нет» и подтвердил запись количества [Р-202];
    // у ebay.com вопрос не отвечен: на нём сценарий показа отвечает «Yes — stock». Шаг 89: у walmart.com запись количества тоже
    // выключена до подтверждения владельца — внешние писатели по умолчанию [Р-202]
    const amazon = a.channel === 'AMAZON';
    assert.equal(a.otherTools.answer, amazon ? 'NONE' : null, `${a.channel}: ответ о других инструментах`);
    assert.equal(a.quantityWrites.confirmed, amazon, `${a.channel}: запись количества ${amazon ? 'подтверждена' : 'выключена до подтверждения владельца'}`);
    // Проход консоли (шаг 64): аккаунт назван словами — «eBay · … · ebay.com», а не кодами канала и витрины
    assert.ok(!/\bEBAY\b|EBAY_US|ATVPDKIKX0DER|WALMART_US|\bWALMART\b/.test(a.label), `${a.channel}: подпись аккаунта кодами: ${a.label}`);
  }
  // Гость демо (техническая роль «только чтение», шаг 98): ответить на вопрос о других инструментах не может [Р-160]
  const answered = await call<{ error: { code: string } }>('POST', `/api/worlds/${encodeURIComponent(demo.id)}/connections/other-tools`, guest,
    { channelAccountId: us[0]!.channelAccountId, answer: 'STOCK' });
  assert.equal(answered.status, 403, JSON.stringify(answered.body));
  // Английский экран — без немецких следов и без евро у витрин США
  const text = JSON.stringify(us);
  assert.ok(!/[äöüßÄÖÜ„“€]/.test(text), `немецкие следы на экране подключений США: ${text.slice(0, 300)}`);
});

/**
 * Шаг 68 (K6, K7, K11, K3, K10): что видит клиент из США в демо — как гость, по HTTP. Решения тени в ДОЛЛАРАХ на ebay.com и amazon.com
 * (до шага 68 тень США молчала: у аккаунтов не было себестоимости, границ и стратегии), «почему эта цена» — настоящее объяснение без
 * заглушки «channel value not kept» и без кодов, неделя тени прожата при посеве и видна письмом за десять минут, вкладка Omnibus — у
 * тенанта с витриной ЕС (у демо — Kaufland), подписи предложений — словами
 */
test('шаг 68: демо США — решения в долларах, «почему эта цена» без заглушки, недельное письмо тени, Omnibus только при витрине ЕС', async () => {
  const en = messagesFor('en');
  const de = messagesFor('de');
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const guest = ((await issued.json()) as StandToken).accessToken;
  const demo = (await call<WorldSummary[]>('GET', '/api/worlds', guest)).body.find((w) => w.demo)!;
  // K3, шаг 87: у американского демо витрины ЕС нет — вкладки Omnibus нет (и профиль us её не предлагает)
  assert.equal(demo.euStorefronts, false, 'американское демо — без витрины ЕС');
  const w = encodeURIComponent(demo.id);
  const placeholder = [en.ui.common.withheld, de.ui.common.withheld];
  // Коды, которых продавец видеть не должен: идентификаторы витрин, ссылки на решения и вопросы
  const codes = /ATVPDKIKX0DER|A1PA6795UKMFR9|EBAY_US|EBAY_DE|Р-\d+|OQ-\d+|\b[AEK]-\d{2}\b/;
  for (const [storefront, channel] of [['amazon.com', 'AMAZON'], ['ebay.com', 'EBAY']] as const) {
    const found = await call<{ items: UnitRef[]; total: number }>('GET', `/api/worlds/${w}/offers?q=${encodeURIComponent(storefront)}`, guest);
    assert.equal(found.status, 200);
    // K10: подпись — название товара и витрина словами; поиск по подписи находит все предложения витрины
    assert.equal(found.body.total, storefront === 'amazon.com' ? 12 + NEW_AMAZON_OFFERS : 12, `${storefront}: поиск по подписи находит предложения витрины — ${JSON.stringify(found.body.items.slice(0, 2))}`);
    assert.ok(found.body.items.every((u) => u.channel === channel && u.label.endsWith(` · ${storefront}`) && !codes.test(u.label)), JSON.stringify(found.body.items[0]));
    let changed: { trace: DecisionTrace; price: string } | null = null;
    for (const unit of found.body.items) {
      const list = await call<DecisionListView>('GET', `/api/worlds/${w}/decisions?writeScopeId=${unit.writeScopeId}`, guest);
      const item = list.body.items.find((d) => d.outcome === en.ui.outcomes.APPROVED);
      if (!item) continue;
      changed = { trace: (await call<DecisionTrace>('GET', `/api/worlds/${w}/decisions/${item.decisionId}`, guest)).body, price: item.price };
      break;
    }
    assert.ok(changed, `${storefront}: тень США приняла решение с изменением цены (K6)`);
    // K6: решение в долларах
    assert.match(changed.price, /^\$\d/, `${storefront}: цена решения в долларах — ${changed.price}`);
    const strategy = changed.trace.steps.find((st) => st.key === 'STRATEGY')!;
    assert.match(strategy.summary, /\$\d/, `${storefront}: строка стратегии с суммами в долларах — ${strategy.summary}`);
    // K11: ни заглушки невыданного значения, ни кодов — во всём объяснении
    const text = JSON.stringify(changed.trace.steps) + changed.trace.headline;
    for (const p of placeholder) assert.ok(!text.includes(p), `${storefront}: заглушка в объяснении — ${text.slice(0, 400)}`);
    const visible = changed.trace.steps.flatMap((st) => [st.summary, ...st.items.flatMap((i) => [i.label, i.value ?? '', i.reason?.title ?? '', i.reason?.text ?? ''])]);
    assert.deepEqual(visible.filter((x) => codes.test(x) || /^[A-Z][A-Z_]{4,}$/.test(x)), [], `${storefront}: коды в объяснении`);
    if (channel === 'AMAZON') {
      // Цена из данных конкурента: подрез и цена конкурента названы суммами — горячее намерение решения ещё хранит их [Р-28]
      assert.ok(strategy.items.some((i) => i.reason && /\$\d+\.\d{2} by \$0\.01/.test(i.reason.text)), `amazon.com: шаг подреза с суммами — ${JSON.stringify(strategy.items)}`);
    }
  }
  // K7: недельное письмо тени — то же письмо, что уходит продавцу, собранное за семь суток прожатой недели, с пометкой синтетики
  const shadow = await call<ShadowView>('GET', `/api/worlds/${w}/shadow`, guest);
  assert.equal(shadow.status, 200);
  const preview = shadow.body.digestPreview;
  assert.ok(preview, 'у демо есть предпросмотр недельного письма');
  assert.equal(preview.synthetic, en.ui.shadow.digest.previewSynthetic);
  assert.match(preview.text, /without the floor you would have sold \$[\d,]+\.\d{2} cheaper/i, `письмо говорит деньгами в долларах: ${preview.text}`);
  // Шаг 76 (предполётный прогон демо): письмо называет магазин так же, как карточка в списке миров, а не служебным заголовком стенда
  assert.ok(preview.text.includes(`"${en.ui.app.demoWorldTitle}"`) && !preview.text.includes('Kaufland (Simulator)'), `имя магазина в письме: ${preview.text.slice(0, 160)}`);
  assert.ok(shadow.body.summary.decisions > 100, `неделя тени: ${shadow.body.summary.decisions} решений`);
  /**
   * Ревью шага 68, находка 9: начало окна сводки — всегда «сейчас − 7 суток», и утверждение о нём было тавтологией. Неделя прожата, когда
   * самые старые решения лежат в прошлых сутках: последняя страница решений предложения amazon.com (страница за концом подтягивается к последней)
   */
  const oneAmazon = (await call<{ items: UnitRef[] }>('GET', `/api/worlds/${w}/offers?q=amazon.com`, guest)).body.items[0]!;
  const oldest = (await call<DecisionListView>('GET', `/api/worlds/${w}/decisions?writeScopeId=${oneAmazon.writeScopeId}&offset=100000`, guest)).body.items.at(-1)!;
  // Шаг 78 (п. 16): удержанное тенью в ленте цен — своя группа на базе: счётчик «held by shadow mode», фильтр отдаёт ровно его, и в
  // «replaced by a newer price» удержанное тенью не попадает (до шага 78 экран сценария говорил «replaced 513» о записях, которых не было)
  const feed = (await call<PriceFeedView>('GET', `/api/worlds/${w}/feed`, guest)).body;
  assert.ok(feed.counts.shadowHeld > 0, `лента демо в тени считает удержанное тенью своей группой: ${JSON.stringify(feed.counts)}`);
  const held = (await call<PriceFeedView>('GET', `/api/worlds/${w}/feed?status=SHADOW_HELD`, guest)).body;
  assert.equal(held.page.total, feed.counts.shadowHeld, 'фильтр «held by shadow mode» отдаёт ровно столько, сколько говорит счётчик');
  const heldText = messagesFor('en').ui.feed.statuses.SHADOW_HELD;
  assert.ok(held.items.length > 0 && held.items.every((i) => i.status === heldText), `строки фильтра — удержанные тенью: ${held.items.slice(0, 3).map((i) => i.status).join(', ')}`);
  const replaced = (await call<PriceFeedView>('GET', `/api/worlds/${w}/feed?status=SUPERSEDED`, guest)).body;
  assert.ok(replaced.items.every((i) => i.status !== heldText), 'в «replaced by a newer price» нет удержанных тенью');
  // Шаг 69 (K4): времена — в поясе продавца с его смещением, внутри системы — UTC; шаг 78 — человечно: «Oct 1, 2026, 17:34 UTC−7»
  const shown = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{2}:\d{2}) UTC([+−])(\d{1,2})(?::(\d{2}))?$/.exec(oldest.decidedAt);
  assert.ok(shown && shown[5] === '−' && ['7', '8'].includes(shown[6]!), `время решения — в поясе Тихоокеанского побережья: ${oldest.decidedAt}`);
  const offsetMs = (Number(shown[6]) * 60 + Number(shown[7] ?? 0)) * 60_000 * (shown[5] === '−' ? -1 : 1);
  const oldestMs = Date.parse(`${shown[1]} ${shown[2]}, ${shown[3]} ${shown[4]} UTC`) - offsetMs;
  assert.ok(Number.isFinite(oldestMs) && Date.now() - oldestMs > 6 * 86_400_000, `самое старое решение amazon.com — в прошлой неделе: ${oldest.decidedAt}`);
  // Р-204: демо-тенант доказательством процедуры границы суток не бывает [Р-151] — хотя неделя тени у него есть
  const [demoTenant] = await db.rows<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_data.tenant WHERE demo`);
  const [ebayUs] = await db.rows<{ channel_account_id: string }>(
    `SELECT channel_account_id FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel = 'EBAY'`, [demoTenant!.tenant_id]);
  const [evidence] = await db.rows<{ shadow_days: number; longest_gap_hours: number; demo: boolean }>(
    `SELECT shadow_days, longest_gap_hours, demo FROM platform.day_boundary_shadow_evidence($1, $2, 'EBAY_US')`, [demoTenant!.tenant_id, ebayUs!.channel_account_id]);
  // Положительный контроль: тень у демо идёт подряд всю прожатую неделю (7 суток прожатия — 6 полных суток от первого решения до последнего;
  // пересчёт раз в сутки — перерыв чуть дольше суток, не больше 36 часов)
  assert.ok(evidence!.shadow_days >= 6 && evidence!.longest_gap_hours <= 36 && evidence!.demo, `положительный контроль: неделя тени у демо есть — ${JSON.stringify(evidence)}`);
  const candidates = await db.rows<{ tenant_id: string }>(`SELECT tenant_id FROM platform.day_boundary_candidates()`);
  assert.ok(!candidates.some((c) => c.tenant_id === demoTenant!.tenant_id), 'демо-тенант — не кандидат процедуры границы суток');
  // K2, K10: свойства витрин США — словами
  assert.ok(shadow.body.properties.every((p) => !codes.test(p.storefrontText) && !/[A-Z]{3,}_[A-Z]/.test(p.valueText)), JSON.stringify(shadow.body.properties));
  // Шаг 69: что видит клиент — в журнал прогона (отчёт шага берёт строки отсюда, а не пересказывает)
  console.log(JSON.stringify({ demoUsSeen: {
    oldestDecision: oldest.decidedAt, offerLabel: oneAmazon.label, summaryLines: shadow.body.summaryLines,
    digestSubject: preview.subject, digestFirstLines: preview.text.split('\n').slice(0, 4),
    properties: shadow.body.properties.map((p) => [p.storefrontText, p.propertyText, p.valueText, p.closesByText]),
  } }, null, 1));
});

/**
 * Шаг 68 (K2, Р-146): каждое значение ревизии витрин, кроме часового пояса, у продавца — словами на обоих языках. Правило читает ВСЕ строки
 * `platform.marketplace_readiness()`, а не только витрины демо: новая витрина или значение без слов красит сборку, а не экран клиента
 */
test('шаг 68: значения ревизии витрин — словами на обоих языках', async () => {
  // Пул закрывает удаление базы прогона
  const { rows } = await db.pool('svc_admin', 1).query(`SELECT DISTINCT value FROM platform.marketplace_readiness() WHERE value IS NOT NULL`);
  const values = rows.map((r) => String(r.value)).filter((v) => !/^[A-Z][a-z]+\/[A-Za-z_]+$/.test(v));
  assert.ok(values.length >= 4, `значения ревизии есть: ${values.join(', ')}`);
  for (const locale of ['en', 'de'] as const) {
    const words = messagesFor(locale).ui.shadow.properties.valueWords;
    assert.deepEqual(values.filter((v) => !words[v]), [], `${locale}: значения без слов`);
  }
});

/**
 * Шаг 64 (ревью, находка 2): консоль, перезапущенная на той же базе, сеет демо заново — прежний демо-тенант с аккаунтами США остаётся
 * в базе, и постоянный внешний идентификатор ронял старт (23505 на `channel_account_external_uq`). Пересев по таймеру — тот же путь
 */
/**
 * Шаг 87 [Р-214]: американское демо — ничего европейского на экранах продавца: ни Kaufland, ни amazon.de и ebay.de, ни евро; склад —
 * «Warehouse Newark, DE»; версия тарифа — месяц действия, а не служебное слово посева
 */
test('шаг 87: демо профиля us — американский продавец без Kaufland, витрин ЕС и евро; склад в Делавэре, тариф по месяцу', async () => {
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const guest = ((await issued.json()) as StandToken).accessToken;
  const worlds = (await call<WorldSummary[]>('GET', '/api/worlds', guest)).body;
  assert.deepEqual(worlds.map((x) => x.demo), [true], `в списке — только американское демо: ${JSON.stringify(worlds.map((x) => x.title))}`);
  const w = encodeURIComponent(worlds[0]!.id);
  const europe = /Kaufland|kaufland\.|amazon\.de|ebay\.de|A1PA6795UKMFR9|EBAY_DE|€|EUR\b/;
  for (const screen of ['shadow', 'products', 'stock', 'feed', 'decisions', 'rejected', 'dangerous', 'bounds', 'stop', 'connections', 'strategies', 'onboarding', 'jobs']) {
    const r = await call<unknown>('GET', `/api/worlds/${w}/${screen}`, guest);
    assert.equal(r.status, 200, `${screen}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const found = europe.exec(JSON.stringify(r.body));
    assert.equal(found, null, `${screen}: европейское на экране американского демо — «${found?.[0]}» в ${JSON.stringify(r.body).slice(Math.max(0, (found?.index ?? 0) - 120), (found?.index ?? 0) + 60)}`);
  }
  // Положительный контроль правила: европейское оно видит
  assert.ok(europe.test(JSON.stringify({ label: 'Plant pot · kaufland.de' })) && europe.test('€12.00'));
  const stock = (await call<{ sources: Array<{ name: string }> }>('GET', `/api/worlds/${w}/stock`, guest)).body;
  assert.deepEqual(stock.sources.map((x) => x.name), ['Warehouse Newark, DE'], 'склад американского продавца');
  const amazon = (await call<{ items: UnitRef[] }>('GET', `/api/worlds/${w}/offers?q=amazon.com`, guest)).body.items[0]!;
  const bounds = (await call<{ feeEstimates: Array<{ text: string }> }>('GET', `/api/worlds/${w}/bounds/${amazon.writeScopeId}`, guest)).body;
  assert.ok(bounds.feeEstimates.some((f) => /\(\d{4}-\d{2}\)$/.test(f.text)) && !bounds.feeEstimates.some((f) => /synthetic/.test(f.text)),
    `версия тарифа — месяц действия: ${JSON.stringify(bounds.feeEstimates)}`);
});

/**
 * Шаг 89: walmart.com в американском демо — 12 предложений в долларах рядом с amazon.com и ebay.com, конкуренты — опрос Buy Box модели
 * канала по правилам настоящего Walmart. Два предложения (03 и 07) Walmart снял с публикации правилом неконкурентной цены: их цена $24.99,
 * тот же товар в другом месте — $19.99. Это видно состоянием у предложения (Offers) и событием журнала (Stop pricing) — с объяснением и без
 * обещания, что движок это починит: решение за владельцем
 */
test('шаг 89: walmart.com в демо — два предложения сняты с публикации неконкурентной ценой: состояние у предложения и событие в журнале', async () => {
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const guest = ((await issued.json()) as StandToken).accessToken;
  const w = encodeURIComponent((await call<WorldSummary[]>('GET', '/api/worlds', guest)).body[0]!.id);
  const products = (await call<{ rows: Array<{ unit: UnitRef; currentPrice: string; channelNotes: Array<{ code: string; label: string; detail: string }> }> }>(
    'GET', `/api/worlds/${w}/products?offset=0&limit=50`, guest)).body;
  const walmart = products.rows.filter((r) => r.unit.label.endsWith('· walmart.com'));
  assert.equal(walmart.length, 12, `предложения walmart.com: ${JSON.stringify(products.rows.map((r) => r.unit.label))}`);
  assert.ok(walmart.every((r) => r.currentPrice.startsWith('$')), 'walmart.com — в долларах');
  const unpublished = walmart.filter((r) => r.channelNotes.some((n) => n.code === 'WALMART_UNPUBLISHED'));
  assert.equal(unpublished.length, 2, `сняты с публикации: ${JSON.stringify(walmart.map((r) => [r.unit.label, r.channelNotes.map((n) => n.code)]))}`);
  for (const r of unpublished) {
    const note = r.channelNotes.find((n) => n.code === 'WALMART_UNPUBLISHED')!;
    assert.equal(note.label, 'Unpublished (uncompetitive price)');
    assert.match(note.detail, /cheaper elsewhere \(\$19\.99\)/, 'объяснение называет цену в другом месте');
    assert.match(note.detail, /PriceTrail does not change the price for you here/, 'и не обещает, что движок это починит');
  }
  // Журнал «Stop pricing»: событие канала — Walmart, какое предложение и почему
  const stop = (await call<{ audit: Array<{ action: string; actor: string; scope: string; detail?: string | null }> }>('GET', `/api/worlds/${w}/stop`, guest)).body;
  const events = stop.audit.filter((a) => a.action === 'Offer unpublished: uncompetitive price');
  assert.equal(events.length, 2, JSON.stringify(stop.audit.map((a) => a.action)));
  assert.ok(events.every((e) => e.actor === 'Walmart' && e.scope.endsWith('· walmart.com') && /\$19\.99/.test(e.detail ?? '')), JSON.stringify(events));
  // Тень считает и walmart.com: аккаунт в тени, решения есть (опрос Buy Box прожатой недели)
  const shadow = (await call<ShadowView>('GET', `/api/worlds/${w}/shadow`, guest)).body;
  const account = shadow.accounts.find((a) => a.label.startsWith('Walmart · '));
  assert.ok(account, `аккаунт walmart.com на экране тени: ${JSON.stringify(shadow.accounts.map((a) => a.label))}`);
  assert.equal(account.writeMode, 'SHADOW');
});

test('шаг 64: перезапуск консоли на той же базе пересевает демо с аккаунтами США, а не падает на старте', async () => {
  // Одна реплика консоли на базу — гарантия шага 57: прежний процесс останавливается, новый стартует на той же базе
  await console_.close();
  console_ = await startConsole(env);
  origin = `http://127.0.0.1:${console_.port}`;
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(issued.status, 200, 'перезапущенный процесс поднял своё демо и выдаёт гостя');
  const guest = ((await issued.json()) as StandToken).accessToken;
  const demo = (await call<WorldSummary[]>('GET', '/api/worlds', guest)).body.find((w) => w.demo)!;
  const screen = await call<ConnectionsView>('GET', `/api/worlds/${encodeURIComponent(demo.id)}/connections`, guest);
  const us = screen.body.accounts.filter((a) => a.marketplaces.includes('EBAY_US') || a.marketplaces.includes('ATVPDKIKX0DER'));
  assert.deepEqual(us.map((a) => [a.channel, a.offers]).sort(), [['AMAZON', 12 + NEW_AMAZON_OFFERS], ['EBAY', 12]], 'у нового демо свои аккаунты США со своим каталогом');
});

/**
 * Шаг 96 (аудит, II): период — 24h / 7d / 30d или свой диапазон дат в поясе пространства — на Shadow mode, Protections и Price changes
 * (обоих видах). Живой прогон через консоль на прожатой неделе демо: окна вложены, у решений исход делит итог без остатка, поиск
 * фильтрует саму таблицу, выгрузка «All N entries as a file» — ровно за период экрана, неверный период — 400, а не «всё»
 */
test('шаг 96: периоды и поиск через консоль — тень, решения с исходом, лента, защита', async () => {
  // Гость демо (техническая роль «только чтение»): читает всё; задание выгрузки ему создать нельзя [Р-160] — выгрузку за период проверяет тест консоли на стенде
  const token = ((await (await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as StandToken).accessToken;
  const demo = (await call<WorldSummary[]>('GET', '/api/worlds', token)).body.find((w) => w.demo)!;
  const w = encodeURIComponent(demo.id);
  const get = async <T>(path: string): Promise<T> => {
    const r = await call<T>('GET', `/api/worlds/${w}/${path}`, token);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  // Тень: окна вложены — сутки ⊆ неделя ⊆ месяц; свой диапазон «вчера» — внутри недели и не пуст на прожатой неделе
  const shadow = async (q: string) => (await get<ShadowView>(`shadow?offset=0&limit=5&${q}`)).summary;
  const [day, week, month] = [await shadow('period=24h'), await shadow('period=7d'), await shadow('period=30d')];
  assert.ok(day.decisions <= week.decisions && week.decisions <= month.decisions && week.decisions > 0, JSON.stringify([day.decisions, week.decisions, month.decisions]));
  const now = Date.parse(week.until);
  const dateOf = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const yesterday = dateOf(now - 86_400_000);
  const one = await shadow(`from=${yesterday}&to=${yesterday}`);
  assert.ok(one.decisions > 0 && one.decisions <= week.decisions, `вчера: ${one.decisions} из ${week.decisions}`);
  // Сутки по поясу пространства: окно — от полуночи Лос-Анджелеса, а не UTC
  assert.equal(dateOf(Date.parse(one.since)), yesterday);
  assert.equal(new Date(Date.parse(one.since)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }).replace(/\D/g, ''), '00');
  assert.equal(Date.parse(one.until) - Date.parse(one.since) >= 23 * 3_600_000, true, 'одни сутки (23–25 часов с учётом перевода часов)');

  // Решения: исход делит итог периода без остатка; каждая строка — своего исхода. Равенство — на ЗАКРЫТОМ диапазоне (до конца вчерашних
  // суток): демо-мир живой, и у пресета окно кончается «сейчас» — решение между запросами ломало равенство (первый прогон шага 96)
  const decisions = (q: string) => get<DecisionListView>(`decisions?offset=0&limit=50&${q}`);
  const closed = `from=${dateOf(now - 6 * 86_400_000)}&to=${yesterday}`;
  const all = await decisions(closed);
  const parts = await Promise.all(['CHANGED', 'NO_CHANGE', 'REJECTED'].map((o) => decisions(`${closed}&outcome=${o}`)));
  assert.equal(parts.reduce((n, p) => n + p.page.total, 0), all.page.total, JSON.stringify(parts.map((p) => p.page.total)));
  assert.ok(parts[0]!.page.total > 0 && parts[1]!.page.total > 0, 'на прожатой неделе есть и изменения, и «без изменения»');
  const en = messagesFor('en');
  assert.ok(parts[1]!.items.every((d) => d.outcome === en.ui.outcomes.NO_CHANGE), JSON.stringify(parts[1]!.items.slice(0, 3).map((d) => d.outcome)));
  // окна пресетов вложены: сутки запрашиваются раньше недели, поэтому новое решение между запросами порядок не ломает
  const dayTotal = (await decisions('period=24h')).page.total;
  assert.ok(dayTotal <= (await decisions('period=7d')).page.total);
  // Поиск по мере ввода: строки — только найденных предложений
  const searched = await decisions(`${closed}&q=water`);
  assert.ok(searched.page.total > 0 && searched.page.total < all.page.total, `поиск «water»: ${searched.page.total} из ${all.page.total}`);
  assert.ok(searched.items.every((d) => /water/i.test(d.unit?.label ?? '')), JSON.stringify(searched.items.slice(0, 3).map((d) => d.unit?.label)));
  assert.deepEqual(searched.search, { total: searched.search!.total, shown: searched.search!.total }, 'все найденные предложения — в фильтре');

  // Лента: окна вложены; поиск фильтрует таблицу; выгрузка — ровно за период и поиск экрана
  const feed = (q: string) => get<PriceFeedView>(`feed?limit=50&${q}`);
  const [feedDay, feedWeek, feedAll] = [await feed('period=24h'), await feed('period=7d'), await feed('')];
  assert.ok(feedDay.page.total <= feedWeek.page.total && feedWeek.page.total <= feedAll.page.total && feedWeek.page.total > 0,
    JSON.stringify([feedDay.page.total, feedWeek.page.total, feedAll.page.total]));
  const feedSearch = await feed('period=7d&q=water');
  assert.ok(feedSearch.page.total > 0 && feedSearch.page.total < feedWeek.page.total && feedSearch.items.every((i) => /water/i.test(i.unit?.label ?? '')),
    `лента, поиск «water»: ${feedSearch.page.total} из ${feedWeek.page.total}`);
  // Шаг 104 [Р-229]: гость публичного демо не выгружает — кнопка видна, но отключена (список миров говорит «нельзя»), маршрут отказывает
  // честной причиной; заданий у гостя нет вовсе [Р-160]
  assert.equal((await call<WorldSummary[]>('GET', '/api/worlds', token)).body.find((x) => x.demo)?.canExport, false, 'the guest of the demo cannot export');
  const guestExport = await call<{ error: { code: string; message: string } }>('POST', `/api/worlds/${w}/exports`, token, { screen: 'price-changes', format: 'csv', query: { period: '24h', q: 'water' } });
  assert.equal(JSON.stringify([guestExport.status, guestExport.body.error.code, guestExport.body.error.message]), JSON.stringify([403, 'EXPORT_NOT_IN_DEMO', 'Export is not available in the public demo']));

  // Защита: отчёт о поле и список остановленного — за период; свой диапазон называется датами
  const report = await get<{ headline: string; clipped: boolean }>(`dangerous?from=${dateOf(now - 3 * 86_400_000)}&to=${dateOf(now)}`);
  assert.match(report.headline, / from [A-Z][a-z]{2} \d+, \d{4} to [A-Z][a-z]{2} \d+, \d{4}/);
  assert.equal(report.clipped, false);
  assert.equal((await get<{ clipped: boolean }>(`dangerous?from=${dateOf(now - 60 * 86_400_000)}&to=${dateOf(now)}`)).clipped, true, 'глубже 30 дней — отрезано и названо');
  await get('rejected?period=24h');
  // Неверный период — 400, а не молчаливое «всё»
  for (const bad of ['shadow?period=5d', `decisions?period=7d&outcome=MAYBE`, `feed?from=${dateOf(now)}&to=${dateOf(now - 86_400_000)}`, 'dangerous?period=7d&days=7', 'rejected?from=2026-02-30&to=2026-03-01']) {
    assert.equal((await call('GET', `/api/worlds/${w}/${bad}`, token)).status, 400, bad);
  }
});

/**
 * Шаг 102 (E) [Р-227]: в демо одно предложение amazon.com в режиме распродажи — себестоимость $11.00, безубыточность $12.95, пол
 * распродажи $10.00, записка «Clearing summer stock». Страница пола называет безубыточность и убыток на штуку, квитанция — пол, убыток и
 * записку; гость демо режим не включает и не выключает (право MANAGE_PRICING у него нет — отказывает и консоль, и база)
 */
test('шаг 102 (E): демо — предложение amazon.com в режиме распродажи: страница пола, квитанция с убытком на штуку, гость не трогает режим', async () => {
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const guest = ((await issued.json()) as StandToken).accessToken;
  const demo = (await call<WorldSummary[]>('GET', '/api/worlds', guest)).body.find((w) => w.demo)!;
  const w = encodeURIComponent(demo.id);
  const found = await call<{ items: UnitRef[]; total: number }>('GET', `/api/worlds/${w}/offers?q=${encodeURIComponent('amazon.com')}`, guest);
  const pages = await Promise.all(found.body.items.map(async (u) => ({ unit: u, view: (await call<BoundsView>('GET', `/api/worlds/${w}/bounds/${u.writeScopeId}`, guest)).body })));
  const cleared = pages.filter((p) => p.view.clearance.pill !== null);
  assert.equal(cleared.length, 1, 'one amazon.com offer of the demo is in clearance');
  const { unit, view } = cleared[0]!;
  const c = view.clearance;
  assert.equal(JSON.stringify([c.pill, c.active?.floor, c.breakEven, c.active?.lossPerUnit, c.active?.note]), JSON.stringify(['Clearance', '$10.00', '$12.95', '$2.95', 'Clearing summer stock']));
  assert.equal(view.effectiveFloor.amount, '$10.00', 'the clearance floor is the floor');
  // Квитанция решения в режиме распродажи: пилюля и строка «пол ниже безубыточности на $2.95 за штуку; кто, когда, зачем»
  const list = await call<DecisionListView>('GET', `/api/worlds/${w}/decisions?writeScopeId=${unit.writeScopeId}`, guest);
  const first = list.body.items[0];
  assert.ok(first, 'the offer in clearance has decisions');
  const trace = (await call<DecisionTrace>('GET', `/api/worlds/${w}/decisions/${first.decisionId}`, guest)).body;
  assert.equal(trace.clearance?.pill, 'Clearance');
  assert.match(trace.clearance?.line ?? '', /^Clearance mode: floor \$10\.00 is below break-even \$12\.95 \(−\$2\.95 per piece\)\. Enabled by .+, note: “Clearing summer stock”\.$/);
  // Гость демо не включает и не выключает режим
  const other = pages.find((p) => p.view.clearance.pill === null)!;
  const enable = await call<{ error: { code: string } }>('POST', `/api/worlds/${w}/bounds/${other.unit.writeScopeId}/clearance`, guest,
    { floorMinor: 900, acknowledged: true, note: 'x', endsAt: null });
  const disable = await call<{ error: { code: string } }>('POST', `/api/worlds/${w}/bounds/${unit.writeScopeId}/clearance/disable`, guest, {});
  assert.equal(JSON.stringify([enable.status, disable.status]), JSON.stringify([403, 403]), 'the guest of the demo cannot touch clearance');
});

/**
 * Шаг 103 [Р-228]: в демо владелец задал стратегию по умолчанию для amazon.com, и после прожатой недели на аккаунте появились два листинга —
 * обход каталога завёл их, правило умолчания назначило стратегию. Через консоль как гость: карточка аккаунта называет умолчание одной
 * строкой (кто задал) и что правило сделало; у ebay.com — «None»; карточка стратегии называет аккаунт; новички — со стратегией и без
 * единого решения о цене (умолчание назначает, но не включает); гость умолчание не меняет
 */
test('шаг 103: демо — стратегия по умолчанию amazon.com, два новых предложения получили её, цены не двигаются, гость не меняет умолчание', async () => {
  const issued = await fetch(`${origin}/api/demo/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const guest = ((await issued.json()) as StandToken).accessToken;
  const demo = (await call<WorldSummary[]>('GET', '/api/worlds', guest)).body.find((w) => w.demo)!;
  const w = encodeURIComponent(demo.id);
  const screen = (await call<ConnectionsView>('GET', `/api/worlds/${w}/connections`, guest)).body;
  const amazon = screen.accounts.find((a) => a.channel === 'AMAZON')!;
  const ebay = screen.accounts.find((a) => a.channel === 'EBAY')!;
  assert.match(amazon.defaultStrategy?.line ?? '', /^Default strategy for new offers: Beat the lowest by 1 cent · set by .+, .+$/, 'the default in one line, with who set it');
  assert.equal(amazon.defaultStrategy?.results, 'Assigned to 2 new offers so far');
  assert.equal(ebay.defaultStrategy?.line, 'Default strategy for new offers: None — assign manually', 'no default on ebay.com — the behaviour before the step');
  assert.equal(JSON.stringify([amazon.defaultStrategy?.canEdit, ebay.defaultStrategy?.canEdit]), JSON.stringify([false, false]), 'the guest only reads');
  // «Win the Buy Box» на amazon.com недоступна (держатель Buy Box не назван, A-29) — в выборе видна с причиной и не выбирается [Р-39]
  const win = amazon.defaultStrategy?.options.find((o) => o.label.startsWith('Win the Buy Box'));
  assert.equal(JSON.stringify([win?.disabled, /not available on this channel: needs .*Buy Box winner/.test(win?.label ?? '')]), JSON.stringify([true, true]), JSON.stringify(win));
  // Карточка стратегии называет аккаунт, для которого она — умолчание
  const strategies = (await call<{ strategies: Array<{ name: string | null; defaultFor: string | null }> }>('GET', `/api/worlds/${w}/strategies`, guest)).body;
  assert.equal(strategies.strategies.find((x) => x.name === 'Beat the lowest by 1 cent')?.defaultFor, 'Default for new offers on: Amazon · amazon.com');
  // Новички — со стратегией и без решений о цене: движок у них выключен, себестоимости нет [Р-131]
  for (const q of ['Bamboo cutting board', 'Pour-over coffee dripper']) {
    const found = (await call<{ items: UnitRef[]; total: number }>('GET', `/api/worlds/${w}/offers?q=${encodeURIComponent(q)}`, guest)).body;
    assert.equal(found.total, 1, `${q}: a new amazon.com offer`);
    const decisions = (await call<DecisionListView>('GET', `/api/worlds/${w}/decisions?writeScopeId=${found.items[0]!.writeScopeId}`, guest)).body;
    assert.equal(decisions.items.length, 0, `${q}: no price decision — the default assigns, it does not switch on`);
  }
  // Гость демо умолчание не меняет
  const changed = await call<{ error: { code: string } }>('POST', `/api/worlds/${w}/connections/default-strategy`, guest, { channelAccountId: ebay.channelAccountId, strategyId: null });
  assert.equal(changed.status, 403, JSON.stringify(changed.body));
});

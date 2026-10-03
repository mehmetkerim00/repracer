import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { messagesFor, type ConnectionsView, type DecisionListView, type DecisionTrace, type ShadowView, type UnitRef } from '@repracer/console-model';
import type { StandToken, WorldSummary } from '../src/api-types.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startConsole, type RunningConsole } from '../server/console-service.ts';

/**
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

before(async () => {
  assert.ok(existsSync(new URL('../dist/index.html', import.meta.url)), 'интерфейс не собран: `npm run build -w apps/console`');
  db = await createIsolatedDatabase('demous');
  const url = (login: Parameters<typeof db.url>[0]) => db.url(login);
  env = {
    REPRACER_MODE: 'stand', REPRACER_CONSOLE_PORT: '0', REPRACER_CONSOLE_METRICS_PORT: '0',
    REPRACER_CONSOLE_DIST: new URL('../dist', import.meta.url).pathname,
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
test('шаг 64: новый браузер без куки видит язык развёртывания; выбранный язык (кука) — сильнее', async () => {
  const first = (await (await fetch(`${origin}/api/session`)).json()) as { locale: string };
  assert.equal(first.locale, 'en', 'первый экран консоли региона США — английский');
  const chosen = (await (await fetch(`${origin}/api/session`, { headers: { cookie: 'repracer_locale=de' } })).json()) as { locale: string };
  assert.equal(chosen.locale, 'de', 'язык, выбранный продавцом, сильнее языка развёртывания');
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
  // Витрины США — по их идентификаторам: рядом в демо живёт ещё аккаунт Amazon ЕС «ожидает доступа» [Р-150]
  const us = screen.body.accounts.filter((a) => a.marketplaces.includes('EBAY_US') || a.marketplaces.includes('ATVPDKIKX0DER'));
  assert.deepEqual(us.map((a) => a.channel).sort(), ['AMAZON', 'EBAY'], `аккаунты витрин США на экране подключений: ${JSON.stringify(screen.body.accounts.map((a) => a.channel))}`);
  for (const a of us) {
    assert.equal(a.state, 'SHADOW', `${a.channel}: аккаунт рождён в тени`);
    assert.equal(a.offers, 12, `${a.channel}: каталог из обнаружения — ${a.progressText}`);
    assert.equal(a.otherTools.answer, null, `${a.channel}: вопрос о других инструментах ещё не отвечен`);
    assert.equal(a.otherTools.question, 'Does another tool update stock or prices in this channel?');
    assert.equal(a.quantityWrites.confirmed, false, `${a.channel}: запись количества выключена до подтверждения владельца`);
    // Проход консоли (шаг 64): аккаунт назван словами — «eBay · … · ebay.com», а не кодами канала и витрины
    assert.ok(!/\bEBAY\b|EBAY_US|ATVPDKIKX0DER/.test(a.label), `${a.channel}: подпись аккаунта кодами: ${a.label}`);
  }
  // Гость — наблюдатель: ответить на вопрос о других инструментах не может [Р-160]
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
  // K3: у демо есть витрина ЕС (Kaufland de) — вкладка Omnibus на месте; без витрин ЕС её нет (прогон пилота США)
  assert.equal(demo.euStorefronts, true, 'демо с Kaufland de — тенант с витриной ЕС');
  const w = encodeURIComponent(demo.id);
  const placeholder = [en.ui.common.withheld, de.ui.common.withheld];
  // Коды, которых продавец видеть не должен: идентификаторы витрин, ссылки на решения и вопросы
  const codes = /ATVPDKIKX0DER|A1PA6795UKMFR9|EBAY_US|EBAY_DE|Р-\d+|OQ-\d+|\b[AEK]-\d{2}\b/;
  for (const [storefront, channel] of [['amazon.com', 'AMAZON'], ['ebay.com', 'EBAY']] as const) {
    const found = await call<{ items: UnitRef[]; total: number }>('GET', `/api/worlds/${w}/offers?q=${encodeURIComponent(storefront)}`, guest);
    assert.equal(found.status, 200);
    // K10: подпись — название товара и витрина словами; поиск по подписи находит все предложения витрины
    assert.equal(found.body.total, 12, `${storefront}: поиск по подписи находит предложения витрины — ${JSON.stringify(found.body.items.slice(0, 2))}`);
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
  assert.ok(shadow.body.summary.decisions > 100, `неделя тени: ${shadow.body.summary.decisions} решений`);
  /**
   * Ревью шага 68, находка 9: начало окна сводки — всегда «сейчас − 7 суток», и утверждение о нём было тавтологией. Неделя прожата, когда
   * самые старые решения лежат в прошлых сутках: последняя страница решений предложения amazon.com (страница за концом подтягивается к последней)
   */
  const oneAmazon = (await call<{ items: UnitRef[] }>('GET', `/api/worlds/${w}/offers?q=amazon.com`, guest)).body.items[0]!;
  const oldest = (await call<DecisionListView>('GET', `/api/worlds/${w}/decisions?writeScopeId=${oneAmazon.writeScopeId}&offset=100000`, guest)).body.items.at(-1)!;
  // Шаг 69 (K4): времена — в поясе продавца с его смещением («2026-10-01 17:34:21 UTC−7»), внутри системы — UTC
  const shown = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC([+−])(\d{1,2})(?::(\d{2}))?$/.exec(oldest.decidedAt);
  assert.ok(shown && shown[3] === '−' && ['7', '8'].includes(shown[4]!), `время решения — в поясе Тихоокеанского побережья: ${oldest.decidedAt}`);
  const offsetMs = (Number(shown[4]) * 60 + Number(shown[5] ?? 0)) * 60_000 * (shown[3] === '−' ? -1 : 1);
  const oldestMs = Date.parse(`${shown[1]}T${shown[2]}Z`) - offsetMs;
  assert.ok(Number.isFinite(oldestMs) && Date.now() - oldestMs > 6 * 86_400_000, `самое старое решение amazon.com — в прошлой неделе: ${oldest.decidedAt}`);
  // Р-204: демо-тенант доказательством процедуры границы суток не бывает [Р-151] — хотя неделя тени у него есть
  const [demoTenant] = await db.rows<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_data.tenant WHERE demo`);
  const [ebayUs] = await db.rows<{ channel_account_id: string }>(
    `SELECT channel_account_id FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel = 'EBAY'`, [demoTenant!.tenant_id]);
  const [evidence] = await db.rows<{ shadow_days: number; days_without_decisions: number; demo: boolean }>(
    `SELECT shadow_days, days_without_decisions, demo FROM platform.day_boundary_shadow_evidence($1, $2, 'EBAY_US')`, [demoTenant!.tenant_id, ebayUs!.channel_account_id]);
  // Положительный контроль: тень у демо идёт каждые сутки прожатой недели (7 суток прожатия — 6 полных суток от первого решения до последнего)
  assert.ok(evidence!.shadow_days >= 6 && evidence!.days_without_decisions === 0 && evidence!.demo, `положительный контроль: неделя тени у демо есть — ${JSON.stringify(evidence)}`);
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
  assert.deepEqual(us.map((a) => a.offers), [12, 12], 'у нового демо свои аккаунты США со своим каталогом');
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import type { ConnectionsView } from '@repracer/console-model';
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

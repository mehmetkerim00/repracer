#!/usr/bin/env node
/**
 * Шаг 108: разведка живой статической песочницы Amazon SP-API. Вне продукта и вне CI: код продукта не меняет, в сборку не входит.
 *
 * Что делает:
 *  1. Обмен LWA (`api.amazon.com`, боевой сервер токенов): refresh_token приложения песочницы → токен доступа. Для сравнения — один обмен
 *     client_credentials (токен без продавца) и попытка прочитать им листинг.
 *  2. Вызовы `sandbox.sellingpartnerapi-na.amazon.com` по операциям наших ролей — Listings Items, Product Pricing, FBA Inventory —
 *     РОВНО с параметрами образцов `x-amzn-api-sandbox.static` из моделей снимка vendor/amazon/sp-api-models/2026-09-29 (статическая
 *     песочница отвечает только на них). FBA Inventory — динамическая: запрос формы адаптера по SKU, созданному шагом 70.
 *  3. Сверка каждого настоящего ответа: (а) с образцом модели байт в байт, (б) со схемой ответа модели — строже модели в одном, как
 *     проверка уведомлений шага 97: поле, которого модель не описывает, — находка; (в) разбором НАСТОЯЩЕГО адаптера (ответ подаётся
 *     адаптеру заглушкой fetch — проверяется разбор, а не форма нашего запроса); (г) с телами ответов той же операции в фикстурах стенда
 *     tests/contract/fixtures/amazon — поля, которых настоящий ответ не несёт или несёт другого вида.
 *
 * Секреты: файл KEY=VALUE вне репозитория (`--secrets`, иначе переменная REPRACER_AMAZON_SANDBOX_ENV, иначе каталог конфигурации
 * пользователя). Имена ключей: AMAZON_SANDBOX_LWA_CLIENT_ID, AMAZON_SANDBOX_LWA_CLIENT_SECRET, AMAZON_SANDBOX_REFRESH_TOKEN. Значения
 * не печатаются и не пишутся: журнал обменов перед записью проверяется на каждое значение и на форму токена Amazon, найденное — отказ.
 *
 * Запуск (из корня репозитория; разбор адаптером требует снятия типов):
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning tools/sp-api-recon.mjs [--secrets <файл>] [--out <каталог>]
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning tools/sp-api-recon.mjs --offline <обмены.json> [--out <каталог>]
 * `--offline` повторяет сверку по сохранённому журналу без сети.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const ROOT = new URL('../', import.meta.url);
const MODELS = new URL('vendor/amazon/sp-api-models/2026-09-29/models/', ROOT);
const FIXTURES = new URL('tests/contract/fixtures/amazon/', ROOT);
const SANDBOX = 'https://sandbox.sellingpartnerapi-na.amazon.com';
const LWA = 'https://api.amazon.com/auth/o2/token';
const USER_AGENT = 'repracer-recon/108 (Language=JavaScript; Platform=Node)';
const PAUSE_MS = 400; // лимит песочницы — 5 в секунду, burst 15 (vendor/amazon/sandbox/2026-10-05/SOURCE.md); идём медленнее

/** Синтетика проекта: продавец шага 70, витрина amazon.com, SKU FBA, созданный шагом 70 в динамической песочнице (7 шт.) */
const SELLER = 'A1SYNSELLER0001';
const US = 'ATVPDKIKX0DER';
const FBA_SKU = 'SYN-FBA-70';

const APIS = [
  { role: 'listings', file: 'listings-items-api-model/listingsItems_2021-08-01.json', ops: ['getListingsItem', 'searchListingsItems', 'patchListingsItem'] },
  { role: 'pricing', file: 'product-pricing-api-model/productPricing_2022-05-01.json', ops: null },
  { role: 'pricing', file: 'product-pricing-api-model/productPricingV0.json', ops: null },
  { role: 'inventory', file: 'fba-inventory-api-model/fbaInventory.json', ops: ['getInventorySummaries'] },
];

/** Что из этого зовёт порт (packages/amazon-adapter) и что только в плане */
const PORT = {
  getListingsItem: 'readBack, чтение перед записью', searchListingsItems: 'discoverOffers', patchListingsItem: 'dispatch',
  getCompetitiveSummary: 'readCompetitors (сверка, Р-121)', getInventorySummaries: 'discoverOffers → количество FBA',
  getItemOffers: 'не зовётся — план A-29 (держатель Buy Box по запросу)',
};

/** Обязательные параметры, которых нет в образце (образец их не ограничивает): синтетика проекта и форма нашего адаптера */
const DEFAULTS = {
  sellerId: SELLER, sku: 'SYN-SKU-108', marketplaceIds: [US], MarketplaceId: US, ItemCondition: 'New', ItemType: 'Asin',
  body: (op) => op === 'patchListingsItem' ? {
    productType: 'PRODUCT',
    patches: [{ op: 'merge', path: '/attributes/purchasable_offer',
      value: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.99 }] }] }] }],
  } : undefined,
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Модели снимка

const loadJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

function walkRef(model, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], model);
}

function loadOperations() {
  const ops = [];
  for (const api of APIS) {
    const model = loadJson(new URL(api.file, MODELS));
    for (const [path, item] of Object.entries(model.paths)) {
      const shared = item.parameters ?? [];
      for (const [verb, op] of Object.entries(item)) {
        if (!op?.operationId || (api.ops && !api.ops.includes(op.operationId))) continue;
        const parameters = [...shared, ...(op.parameters ?? [])].map((p) => (p.$ref ? walkRef(model, p.$ref) : p));
        ops.push({ role: api.role, file: api.file, model, operationId: op.operationId, method: verb.toUpperCase(), path, parameters, responses: op.responses ?? {},
          sandbox: op['x-amzn-api-sandbox'] ?? null });
      }
    }
  }
  return ops;
}

/** Случаи статической песочницы: каждый образец каждого кода ответа */
function sandboxCases(op) {
  const cases = [];
  for (const [status, response] of Object.entries(op.responses)) {
    for (const [i, sample] of (response['x-amzn-api-sandbox']?.static ?? []).entries()) {
      cases.push({ id: `${op.operationId}#${status}.${i}`, kind: 'STATIC_SAMPLE', expectedStatus: Number(status), sampleParameters: sample.request?.parameters ?? {},
        sampleResponse: sample.response });
    }
  }
  return cases;
}

function buildRequest(op, sampleParameters, overrides = {}) {
  let path = op.path;
  const query = {};
  let body;
  const missing = [];
  for (const p of op.parameters) {
    // Образец называет тело запроса `body`, модель — именем параметра (`requests`, `getItemOffersBatchRequestBody`…)
    const sampled = sampleParameters[p.name] ?? (p.in === 'body' ? sampleParameters.body : undefined);
    let value = Object.hasOwn(overrides, p.name) ? overrides[p.name] : sampled?.value;
    if (value === undefined && p.required) {
      const d = DEFAULTS[p.name];
      value = typeof d === 'function' ? d(op.operationId) : d;
    }
    if (value === undefined) { if (p.required) missing.push(p.name); continue; }
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === 'query') query[p.name] = Array.isArray(value) ? value.join(',') : String(value);
    else if (p.in === 'body') body = value;
  }
  return { method: op.method, path, query, ...(body === undefined ? {} : { body }), ...(missing.length ? { missing } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Песочница

function readSecrets(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  const need = ['AMAZON_SANDBOX_LWA_CLIENT_ID', 'AMAZON_SANDBOX_LWA_CLIENT_SECRET', 'AMAZON_SANDBOX_REFRESH_TOKEN'];
  const absent = need.filter((k) => !out[k]);
  if (absent.length) throw new Error(`secrets file lacks ${absent.join(', ')}`);
  if (out.AMAZON_SANDBOX_REGION && out.AMAZON_SANDBOX_REGION.toLowerCase() !== 'na') throw new Error('AMAZON_SANDBOX_REGION is not na: this recon calls the NA sandbox');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (query) => { const s = new URLSearchParams(query).toString(); return s ? `?${s}` : ''; };
const KEEP_HEADERS = ['content-type', 'x-amzn-requestid', 'x-amzn-ratelimit-limit', 'x-amzn-errortype'];

async function lwa(form) {
  const res = await fetch(LWA, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(form).toString() });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function spApi(request, token) {
  const started = performance.now();
  const res = await fetch(`${SANDBOX}${request.path}${qs(request.query)}`, {
    method: request.method,
    headers: { accept: 'application/json', 'x-amz-access-token': token, 'x-amz-date': new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), 'user-agent': USER_AGENT,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await res.text();
  let body = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = { $nonJson: text.slice(0, 300) }; }
  const headers = Object.fromEntries(KEEP_HEADERS.flatMap((h) => (res.headers.get(h) === null ? [] : [[h, res.headers.get(h)]])));
  return { status: res.status, headers, body, durationMs: Math.round(performance.now() - started) };
}

async function runLive(secretsFile) {
  const s = readSecrets(secretsFile);
  const secretValues = [s.AMAZON_SANDBOX_LWA_CLIENT_ID, s.AMAZON_SANDBOX_LWA_CLIENT_SECRET, s.AMAZON_SANDBOX_REFRESH_TOKEN];
  const lwaLog = [];
  const grant = await lwa({ grant_type: 'refresh_token', refresh_token: s.AMAZON_SANDBOX_REFRESH_TOKEN, client_id: s.AMAZON_SANDBOX_LWA_CLIENT_ID,
    client_secret: s.AMAZON_SANDBOX_LWA_CLIENT_SECRET });
  const token = grant.body?.access_token;
  lwaLog.push({ grant: 'refresh_token', status: grant.status, tokenType: grant.body?.token_type ?? null, expiresIn: grant.body?.expires_in ?? null,
    accessTokenForm: typeof token === 'string' ? `${token.slice(0, 5)}… (${token.length} chars)` : null,
    refreshTokenEchoed: grant.body?.refresh_token === undefined ? 'absent' : grant.body.refresh_token === s.AMAZON_SANDBOX_REFRESH_TOKEN ? 'same' : 'different',
    error: grant.body?.error ?? null });
  if (typeof token !== 'string') throw new Error(`LWA refresh_token exchange failed: ${grant.status} ${grant.body?.error ?? ''}`);
  secretValues.push(token);
  // Токен без продавца (client_credentials): документация даёт его только «grantless»-операциям; проверяем, что листинг им не прочитать
  const grantless = await lwa({ grant_type: 'client_credentials', scope: 'sellingpartnerapi::notifications', client_id: s.AMAZON_SANDBOX_LWA_CLIENT_ID,
    client_secret: s.AMAZON_SANDBOX_LWA_CLIENT_SECRET });
  const grantlessToken = grantless.body?.access_token;
  const grantlessEntry = { grant: 'client_credentials (scope sellingpartnerapi::notifications)', status: grantless.status, tokenType: grantless.body?.token_type ?? null,
    expiresIn: grantless.body?.expires_in ?? null, error: grantless.body?.error ?? null };
  if (typeof grantlessToken === 'string') {
    secretValues.push(grantlessToken);
    await sleep(PAUSE_MS);
    const probe = await spApi({ method: 'GET', path: `/listings/2021-08-01/items/${SELLER}/GM-ZDPI-9B4E`, query: { marketplaceIds: US } }, grantlessToken);
    grantlessEntry.listingsWithGrantlessToken = { status: probe.status, errors: probe.body?.errors ?? null };
  }
  lwaLog.push(grantlessEntry);

  const exchanges = [];
  for (const op of loadOperations()) {
    const cases = op.operationId === 'getInventorySummaries'
      ? [FBA_SKU, 'SYN-SKU-108-NONE'].map((sku) => ({ id: `getInventorySummaries#dynamic.${sku}`, kind: 'DYNAMIC', expectedStatus: 200, sampleParameters: {},
        // Ровно форма адаптера (packages/amazon-adapter/src/listing.ts, readFbaQuantities)
        overrides: { details: 'true', granularityType: 'Marketplace', granularityId: US, marketplaceIds: [US], sellerSkus: [sku] } }))
      : sandboxCases(op);
    for (const c of cases) {
      const request = buildRequest(op, c.sampleParameters, c.overrides);
      const entry = { id: c.id, role: op.role, operationId: op.operationId, kind: c.kind, expectedStatus: c.expectedStatus, request };
      if (request.missing) { entry.skipped = `required parameters without a sample value or default: ${request.missing.join(', ')}`; exchanges.push(entry); continue; }
      await sleep(PAUSE_MS);
      let response = await spApi(request, token);
      if (response.status === 429) { await sleep(3000); response = await spApi(request, token); entry.retriedAfter429 = true; }
      exchanges.push({ ...entry, response });
      process.stderr.write(`${c.id}: ${response.status}\n`);
    }
  }
  const log = { recordedAt: new Date().toISOString(), sandbox: SANDBOX, modelsSnapshot: 'vendor/amazon/sp-api-models/2026-09-29', lwa: lwaLog, exchanges };
  // Р-177, Р-148: ни одно значение секрета и ни один токен формы Amazon не уходят в журнал
  const text = JSON.stringify(log, null, 2);
  for (const v of secretValues) if (v && text.includes(v)) throw new Error('refusing to write the log: a secret value is in it');
  if (/Atz[ar]\|(?!syn)[A-Za-z0-9_\-+/=.]{12,}/.test(text)) throw new Error('refusing to write the log: a token-shaped string is in it');
  return log;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Сверка со схемой модели

const isPlaceholder = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$');
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/** Строгая сверка со схемой Swagger 2.0: $ref, allOf, типы, перечисления, обязательные; поле, которого модель не описывает, — находка */
export function modelErrors(model, schema, value) {
  const flatten = (raw, depth = 0) => {
    let s = raw ?? {};
    while (typeof s.$ref === 'string') s = walkRef(model, s.$ref) ?? {};
    if (!Array.isArray(s.allOf) || depth > 20) return s;
    const parts = s.allOf.map((p) => flatten(p, depth + 1));
    const properties = {}; const required = [];
    for (const p of [...parts, s]) { Object.assign(properties, p.properties ?? {}); required.push(...(p.required ?? [])); }
    return { ...s, allOf: undefined, type: s.type ?? parts.find((p) => p.type)?.type ?? 'object', properties, required,
      additionalProperties: s.additionalProperties ?? parts.find((p) => p.additionalProperties !== undefined)?.additionalProperties };
  };
  const out = new Set();
  const check = (raw, v, path) => {
    const s = flatten(raw);
    if (isPlaceholder(v)) return;
    if (Array.isArray(s.enum) && !s.enum.includes(v)) out.add(`${path}: value ${JSON.stringify(v).slice(0, 40)} is not in the model enum`);
    const type = s.type ?? (s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : undefined);
    const k = kindOf(v);
    if (type === 'string') { if (k !== 'string') out.add(`${path}: ${k}, the model says string`); return; }
    if (type === 'integer') { if (k !== 'integer') out.add(`${path}: ${k}, the model says integer`); return; }
    if (type === 'number') { if (k !== 'integer' && k !== 'number') out.add(`${path}: ${k}, the model says number`); return; }
    if (type === 'boolean') { if (k !== 'boolean') out.add(`${path}: ${k}, the model says boolean`); return; }
    if (type === 'array') { if (k !== 'array') out.add(`${path}: ${k}, the model says array`); else if (s.items) for (const x of v) check(s.items, x, `${path}[]`); return; }
    if (type === 'object') {
      if (k !== 'object') { out.add(`${path}: ${k}, the model says object`); return; }
      const props = s.properties ?? {};
      for (const r of s.required ?? []) if (!(r in v)) out.add(`${path}.${r}: required by the model, absent`);
      for (const [key, x] of Object.entries(v)) {
        if (key in props) check(props[key], x, `${path}.${key}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${path}.${key}`);
        else if (!s.properties) continue; // свободный объект модели (например, ItemAttributes)
        else out.add(`${path}.${key}: not in the model`);
      }
    }
  };
  check(schema, value, '$');
  return [...out].sort();
}

/** Пути и виды значений: индексы массивов свёрнуты в [] */
function shapes(v, path = '$', out = new Map()) {
  const k = isPlaceholder(v) ? 'string' : kindOf(v);
  if (!out.has(path)) out.set(path, new Set());
  out.get(path).add(k === 'integer' ? 'number' : k);
  if (k === 'array') for (const x of v) shapes(x, `${path}[]`, out);
  else if (k === 'object') for (const [key, x] of Object.entries(v)) shapes(x, `${path}.${key}`, out);
  return out;
}

function diffPaths(a, b, path = '$', out = []) {
  if (out.length >= 8) return out;
  if (isDeepStrictEqual(a, b)) return out;
  if (kindOf(a) === 'object' && kindOf(b) === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diffPaths(x, b[i], `${path}[${i}]`, out));
  } else out.push(path);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Фикстуры стенда

function fixtureBodies(op, status) {
  const route = new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
  const out = [];
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
    const fx = loadJson(new URL(file, FIXTURES));
    for (const e of fx.exchanges ?? []) {
      if (e.request?.method === op.method && route.test(e.request?.path ?? '') && e.response?.status === status && e.response.body !== undefined) {
        out.push({ file, id: e.id, body: e.response.body });
      }
    }
  }
  return out;
}

function compareWithFixtures(op, status, liveBody) {
  const bodies = fixtureBodies(op, status);
  if (bodies.length === 0) return { fixtures: 0 };
  const schema = op.responses[String(status)]?.schema;
  const outsideModel = new Map();
  for (const b of bodies) for (const e of schema ? modelErrors(op.model, schema, b.body) : []) {
    if (!outsideModel.has(e)) outsideModel.set(e, new Set());
    outsideModel.get(e).add(b.file);
  }
  const live = shapes(liveBody);
  const fixture = new Map();
  for (const b of bodies) for (const [p, kinds] of shapes(b.body)) {
    if (!fixture.has(p)) fixture.set(p, new Set());
    for (const k of kinds) fixture.get(p).add(k);
  }
  const onlyFixtures = [...fixture.keys()].filter((p) => !live.has(p)).sort();
  const onlyLive = [...live.keys()].filter((p) => !fixture.has(p)).sort();
  const kindConflicts = [...fixture].filter(([p, kinds]) => live.has(p) && ![...kinds].some((k) => live.get(p).has(k)))
    .map(([p, kinds]) => `${p}: fixtures ${[...kinds].join('|')}, live ${[...live.get(p)].join('|')}`);
  return { fixtures: bodies.length, files: [...new Set(bodies.map((b) => b.file))].length,
    outsideModel: [...outsideModel].map(([e, files]) => `${e} (${files.size} file${files.size === 1 ? '' : 's'})`),
    onlyFixtures, onlyLive, kindConflicts };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Разбор настоящего ответа адаптером: ответ подаётся заглушкой fetch, обращений к сети нет

const CTX = { tenantId: 'syn-tenant-108', channelAccountId: 'syn-account-108', correlationId: 'recon-108', deadline: '2026-10-29T13:00:00.000Z' };

async function withAdapter(marketplaces, answer, run) {
  const { createAmazonAdapter } = await import(new URL('packages/amazon-adapter/src/index.ts', ROOT));
  const logs = []; const alerts = []; const unexpected = [];
  const account = { tenantId: CTX.tenantId, channelAccountId: CTX.channelAccountId, channel: 'AMAZON', region: 'NA', externalAccountId: SELLER, marketplaces, credentialsRef: 'seller' };
  const deps = {
    accounts: { verify: async () => ({ ok: true, account }) },
    credentials: { get: async (ref) => (ref === 'app' ? { clientId: 'syn-client-108', clientSecret: 'syn-secret-108' } : { refreshToken: 'syn-refresh-108' }) },
    alerts: { raise: async (a) => { alerts.push(a.code); } },
    logger: { log: (e) => logs.push(e.code) },
    now: () => '2026-10-29T12:00:00.000Z',
  };
  const stubFetch = async (url, init) => {
    if (String(url).startsWith('https://lwa.invalid')) return Response.json({ access_token: 'syn-access-108', token_type: 'bearer', expires_in: 3600 });
    const u = new URL(String(url));
    const r = answer(init.method, u.pathname);
    if (!r) { unexpected.push(`${init.method} ${u.pathname}`); return Response.json({ errors: [{ code: 'RECON_STUB', message: 'no recorded answer' }] }, { status: 503 }); }
    return new Response(r.body === null ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createAmazonAdapter({ deps, userAgent: USER_AGENT, applicationCredentialsRef: 'app', fetch: stubFetch, lwaUrl: 'https://lwa.invalid/token',
    endpoints: { NA: 'https://sp-api.invalid' }, sleep: async () => {}, readRetry: { maxAttempts: 1 } });
  let result;
  try { result = await run(adapter); } catch (e) { result = { thrown: e?.error ? `${e.error.code}: ${e.error.message}` : String(e?.message ?? e) }; }
  return { result, logs: [...new Set(logs)], alerts, ...(unexpected.length ? { unexpected } : {}) };
}

const err = (e) => `${e.code}: ${e.message}`;
const scope = (field, sku) => ({ writeScopeId: `ws-${field.toLowerCase()}`, field, scopeKey: `syn|${field}`, identity: { region: 'NA', marketplace: US, externalSku: sku } });

async function portReplay(ex, all) {
  const body = ex.response.body;
  const status = ex.response.status;
  const listing200 = all.find((x) => x.operationId === 'getListingsItem' && x.response?.status === 200)?.response;
  switch (ex.operationId) {
    case 'getListingsItem': {
      const sku = typeof body?.sku === 'string' ? body.sku : 'BadSKU';
      const r = await withAdapter([US], (m) => (m === 'GET' ? { status, body } : null),
        (a) => a.readBack(CTX, [{ writeScope: scope('PRICE', sku), fields: ['PRICE'] }, { writeScope: scope('QUANTITY', sku), fields: ['QUANTITY'] }]));
      return { ...r, result: r.result.thrown ? r.result : { requestedSku: sku,
        observations: r.result.observations.map((o) => o.value.field === 'PRICE' ? `PRICE ${o.value.price.amountMinor} ${o.value.price.currency}` : `QUANTITY ${o.value.quantity}`),
        failures: r.result.failures.map((f) => `${f.writeScopeId}: ${err(f.error)}`) } };
    }
    case 'patchListingsItem': {
      if (!ex.id.endsWith('#200.0') && status === 200) return { note: 'mode=VALIDATION_PREVIEW: the port never sends it' };
      // Чтение перед записью — настоящий ответ getListingsItem; SKU записи — его SKU, иначе разбор остановит сверка Р-205 до PATCH
      if (!listing200) return { note: 'no live getListingsItem answer to read before the write' };
      const sku = String(listing200.body?.sku);
      const write = { channelWriteId: 'w-108', writeScope: scope('PRICE', sku), version: 1, idempotencyKey: 'syn-108', attemptNo: 1,
        value: { field: 'PRICE', price: { amountMinor: 1299, currency: 'USD', basis: 'NET' } } };
      const r = await withAdapter([US], (m) => (m === 'GET' ? listing200 : m === 'PATCH' ? { status, body } : null),
        (a) => a.dispatch(CTX, { batchId: 'b-108', operation: 'patchListingsItem', items: [write], budgetCharges: [], requestCount: 2 }));
      return { ...r, result: r.result.thrown ? r.result : { requestedSku: write.writeScope.identity.externalSku,
        outcomes: r.result.outcomes.map((o) => `${o.status}${o.submissionRef ? ` ${o.submissionRef}` : ''}${o.error ? ` — ${err(o.error)}` : ''}`) } };
    }
    case 'searchListingsItems': {
      const marketplaces = String(ex.request.query.marketplaceIds ?? US).split(',');
      const r = await withAdapter(marketplaces, (m, path) => (m === 'GET' && path.startsWith('/listings/') ? { status, body } : null),
        (a) => a.discoverOffers(CTX, { limit: 20 }));
      return { ...r, result: r.result.thrown ? r.result : { offers: r.result.items.map((o) => ({ sku: o.identity.externalSku, marketplace: o.identity.marketplace,
        asin: o.identity.channelProductRef ?? null, title: o.title ?? null, condition: o.condition, fulfillment: o.fulfillment,
        price: o.currentPrice ? `${o.currentPrice.amountMinor} ${o.currentPrice.currency} ${o.currentPrice.basis}` : null, quantity: o.currentQuantity ?? null,
        isLive: o.isLive ?? null, channelPricing: o.channelPricing })), nextCursor: r.result.nextCursor ? 'present' : null } };
    }
    case 'getCompetitiveSummary': {
      const asin = (ex.request.body?.requests ?? []).map((q) => q.asin).find((a) => /^[A-Z0-9]{10}$/.test(a)) ?? 'B00ZIAODGE';
      const r = await withAdapter([US], (m) => (m === 'POST' ? { status, body } : null),
        (a) => a.readCompetitors(CTX, [{ marketplace: US, channelProductRef: asin, condition: 'new' }]));
      return { ...r, result: r.result.thrown ? r.result : { asin,
        snapshots: r.result.snapshots.map((s) => ({ source: s.source, offers: s.offers.map((o) => `${o.isSelf ? 'self' : o.sellerRef ?? '?'} ${o.price.amountMinor}`
          + `${o.shipping ? `+${o.shipping.amountMinor}` : ''} ${o.price.currency} ${o.fulfillment}${o.condition ? ` ${o.condition}` : ''}`) })),
        failures: r.result.failures.map((f) => err(f.error)) } };
    }
    case 'getInventorySummaries': {
      const { fbaQuantitiesOf } = await import(new URL('packages/amazon-adapter/src/listing.ts', ROOT));
      const sku = ex.request.query.sellerSkus;
      if (status !== 200) return { note: `status ${status}: the adapter skips the part (quantity stays unknown)` };
      const read = fbaQuantitiesOf(body, US, [sku]);
      return { result: { sku, quantities: Object.fromEntries(read.quantities), mismatch: read.mismatch, withoutSku: read.withoutSku } };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Итог

/** Положительный контроль сверки: лишнее поле, неверный вид и отсутствующее обязательное поле обязаны быть найдены */
function selfCheck(ops) {
  const op = ops.find((o) => o.operationId === 'getListingsItem');
  const schema = op.responses['200'].schema;
  const sample = structuredClone(op.responses['200']['x-amzn-api-sandbox'].static[0].response);
  const clean = modelErrors(op.model, schema, sample);
  sample.summaries[0].IsSynthetic = true;
  sample.offers[0].price.amount = 100;
  delete sample.sku;
  const planted = modelErrors(op.model, schema, sample);
  const want = ['$.summaries[].IsSynthetic: not in the model', '$.offers[].price.amount: integer, the model says string', '$.sku: required by the model, absent'];
  const missed = want.filter((w) => !planted.includes(w));
  if (missed.length) throw new Error(`self-check: the model comparison misses ${missed.join('; ')}`);
  return { sampleItselfAgainstModel: clean };
}

async function analyse(log) {
  const ops = loadOperations();
  const control = selfCheck(ops);
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  const rows = [];
  for (const ex of log.exchanges) {
    const op = byId.get(ex.operationId);
    const row = { id: ex.id, role: ex.role, operationId: ex.operationId, port: PORT[ex.operationId] ?? 'не зовётся', kind: ex.kind, expectedStatus: ex.expectedStatus };
    if (ex.skipped) { rows.push({ ...row, skipped: ex.skipped }); continue; }
    const { status, body } = ex.response;
    row.status = status;
    row.rateLimit = ex.response.headers['x-amzn-ratelimit-limit'] ?? null;
    row.durationMs = ex.response.durationMs;
    if (ex.kind === 'STATIC_SAMPLE') {
      const sample = op.responses[String(ex.expectedStatus)]['x-amzn-api-sandbox'].static[Number(ex.id.split('.').pop())].response;
      row.equalsSample = isDeepStrictEqual(body, sample);
      if (!row.equalsSample) row.sampleDiff = diffPaths(sample, body);
    }
    const schema = op.responses[String(status)]?.schema ?? op.responses.default?.schema;
    row.modelIssues = schema && body !== null ? modelErrors(op.model, schema, body) : [];
    if (PORT[ex.operationId] && !PORT[ex.operationId].startsWith('не зовётся')) {
      row.portReplay = await portReplay(ex, log.exchanges);
      row.fixtures = compareWithFixtures(op, status, body);
    }
    rows.push(row);
  }
  return { control, rows };
}

function table(rows) {
  const lines = ['| случай | роль | порт | статус (ждали) | = образцу | вне модели | разбор адаптера |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    if (r.skipped) { lines.push(`| ${r.id} | ${r.role} | ${r.port} | — | — | — | пропущен: ${r.skipped} |`); continue; }
    const replay = r.portReplay?.result?.thrown ? `исключение ${r.portReplay.result.thrown}`
      : r.portReplay?.result ? JSON.stringify(r.portReplay.result).slice(0, 160) : r.portReplay?.note ?? '—';
    lines.push(`| ${r.id} | ${r.role} | ${r.port} | ${r.status} (${r.expectedStatus}) | ${r.equalsSample === undefined ? 'динамическая' : r.equalsSample ? 'да' : `нет: ${r.sampleDiff.join(', ')}`} | ${r.modelIssues.length} | ${replay.replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { secrets: { type: 'string' }, out: { type: 'string' }, offline: { type: 'string' } } });
  if (!process.features?.typescript) {
    throw new Error('run with --experimental-strip-types: the adapter parse needs the TypeScript sources of packages/amazon-adapter');
  }
  const log = values.offline ? loadJson(new URL(values.offline, `file://${process.cwd()}/`))
    : await runLive(values.secrets ?? process.env.REPRACER_AMAZON_SANDBOX_ENV ?? join(homedir(), '.config', 'repracer', 'secrets', 'amazon-sandbox.env'));
  const findings = await analyse(log);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    if (!values.offline) writeFileSync(join(values.out, 'sp-api-recon-exchanges.json'), `${JSON.stringify(log, null, 2)}\n`);
    writeFileSync(join(values.out, 'sp-api-recon-findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  }
  process.stdout.write(`LWA: ${JSON.stringify(log.lwa)}\n\n${table(findings.rows)}\n`);
}

await main();

import { readdirSync, readFileSync } from 'node:fs';

/**
 * Шаг 97 [Р-221]: проверка тела уведомления Amazon по официальной схеме снимка (vendor/amazon/sp-api-models/…/schemas/notifications).
 * СТРОЖЕ схемы в одном: поле, которого схема не описывает, — ошибка, хотя схема допускает лишние свойства (`additionalProperties: true`).
 * Именно лишнее поле (`IsBuyBoxWinner`) прятало дефект разбора: фикстуры несли признак держателя Buy Box, которого в уведомлении нет,
 * и стенд был зелёным там, где настоящий канал признака не даст (A-29). Подстановки стенда (`{"$clockIso": …}`) — строки времени.
 */

type Schema = Record<string, unknown>;

/** Шаг 109: снимок 2026-10-29 (схемы ANY_OFFER_CHANGED и PRICING_HEALTH побайтно те же, что в 2026-09-29) */
export const NOTIFICATION_SCHEMAS = new URL('../../../../vendor/amazon/sp-api-models/2026-10-29/schemas/notifications/', import.meta.url);

export function loadNotificationSchema(file: 'AnyOfferChangedNotification.json' | 'PricingHealthNotification.json'): Schema {
  return JSON.parse(readFileSync(new URL(file, NOTIFICATION_SCHEMAS), 'utf8')) as Schema;
}

/** Подстановка стенда вместо строки: `{ "$clockIso": <смещение> }` и подобные однопольные `$…` */
const isPlaceholder = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Object.keys(v)[0]!.startsWith('$');

export function strictErrors(root: Schema, value: unknown): string[] {
  const resolve = (s: Schema): Schema => {
    const ref = s.$ref;
    if (typeof ref !== 'string') return s;
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    let node: unknown = root;
    for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown>)[part];
    return resolve(node as Schema);
  };
  const check = (raw: Schema, v: unknown, path: string, out: string[]): void => {
    const s = resolve(raw);
    if (Array.isArray(s.anyOf)) {
      const variants = (s.anyOf as Schema[]).map((alt) => { const e: string[] = []; check(alt, v, path, e); return e; });
      if (!variants.some((e) => e.length === 0)) out.push(...variants.reduce((a, b) => (b.length < a.length ? b : a)));
      return;
    }
    const type = s.type;
    if (type === 'string') { if (typeof v !== 'string' && !isPlaceholder(v)) out.push(`${path}: not a string`); return; }
    if (type === 'integer') { if (!Number.isInteger(v)) out.push(`${path}: not an integer`); return; }
    if (type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${path}: not a number`); return; }
    if (type === 'boolean') { if (typeof v !== 'boolean') out.push(`${path}: not a boolean`); return; }
    if (type === 'array') {
      if (!Array.isArray(v)) { out.push(`${path}: not an array`); return; }
      if (s.items) v.forEach((x, i) => check(s.items as Schema, x, `${path}[${i}]`, out));
      return;
    }
    if (type === 'object' || s.properties) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) { out.push(`${path}: not an object`); return; }
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in v)) out.push(`${path}.${r}: required by the schema`);
      for (const [k, x] of Object.entries(v)) {
        if (!(k in props)) out.push(`${path}.${k}: not in the schema`);
        else check(props[k]!, x, `${path}.${k}`, out);
      }
    }
  };
  const out: string[] = [];
  check(root, value, '', out);
  return out;
}

/** Все тела уведомлений Amazon внутри фикстуры (у сценариев они лежат в шагах отправки) */
export function notificationBodies(node: unknown, path = ''): Array<{ path: string; type: 'ANY_OFFER_CHANGED' | 'PRICING_HEALTH'; body: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap((x, i) => notificationBodies(x, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  const o = node as Record<string, unknown>;
  if (o.NotificationType === 'ANY_OFFER_CHANGED') return [{ path, type: 'ANY_OFFER_CHANGED', body: o }];
  if (o.notificationType === 'PRICING_HEALTH') return [{ path, type: 'PRICING_HEALTH', body: o }];
  return Object.entries(o).flatMap(([k, x]) => notificationBodies(x, `${path}.${k}`));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Шаг 109 [A]: тела ОТВЕТОВ SP-API в фикстурах — по схеме ответа операции модели снимка (Swagger 2.0)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Снимок моделей, по которому сверяются ответы. Разведка шага 108 сравнила фикстуры с настоящими ответами песочницы: у 57 из 61 сводки
 * листинга не было обязательных `createdDate` и `lastUpdatedDate` — тот же класс, что 34 тела уведомлений шага 97, но проверка шага 97
 * смотрела только уведомления. Правило теперь держит и ответы API.
 */
export const API_MODELS_SNAPSHOT = new URL('../../../../vendor/amazon/sp-api-models/2026-10-29/models/', import.meta.url);

export interface ApiOperation {
  /** Файл модели относительно каталога моделей снимка */
  file: string;
  operationId: string;
  method: string;
  path: string;
  route: RegExp;
  model: Schema;
  responses: Record<string, { schema?: Schema } & Record<string, unknown>>;
}

/** Все операции моделей снимка: метод, шаблон пути и схемы ответов по коду */
export function loadApiOperations(dir: URL = API_MODELS_SNAPSHOT): ApiOperation[] {
  const ops: ApiOperation[] = [];
  for (const api of readdirSync(dir).sort()) {
    for (const file of readdirSync(new URL(`${api}/`, dir)).filter((f) => f.endsWith('.json')).sort()) {
      const model = JSON.parse(readFileSync(new URL(`${api}/${file}`, dir), 'utf8')) as Schema & { paths?: Record<string, Record<string, Schema>> };
      for (const [path, item] of Object.entries(model.paths ?? {})) {
        for (const [verb, op] of Object.entries(item)) {
          if (typeof op?.operationId !== 'string') continue;
          const route = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
          ops.push({ file: `${api}/${file}`, operationId: op.operationId, method: verb.toUpperCase(), path, route, model,
            responses: (op.responses ?? {}) as ApiOperation['responses'] });
        }
      }
    }
  }
  return ops;
}

/** Операция по методу и пути запроса; неизвестная — null. Два шаблона подходят — берётся тот, где меньше параметров (`/items/{sellerId}` против `/items/{sellerId}/{sku}` различает число частей пути) */
export function operationOf(ops: readonly ApiOperation[], method: string, path: string): ApiOperation | null {
  const hits = ops.filter((o) => o.method === method && o.route.test(path));
  return hits.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0))[0] ?? null;
}

const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/**
 * Строгая сверка значения со схемой модели Swagger 2.0: `$ref`, `allOf`, типы, перечисления, обязательные поля. Строже модели в одном, как
 * уведомления шага 97: поле, которого модель не описывает, — ошибка. Свободный объект модели (без `properties`, например атрибуты
 * листинга `ItemAttributes`) не проверяется внутри; словарь (`additionalProperties` — схема) — по схеме значения. Подстановки стенда
 * (`{"$clockIso": …}`) — строки. Этой же функцией сверяет настоящие ответы разведка песочницы (`tools/sp-api-recon.mjs`)
 */
export function apiModelErrors(model: Schema, schema: Schema, value: unknown): string[] {
  const deref = (raw: Schema | undefined): Schema => {
    let s: Schema = raw ?? {};
    for (let guard = 0; typeof s.$ref === 'string'; guard++) {
      if (!s.$ref.startsWith('#/') || guard > 50) throw new Error(`unsupported $ref ${String(s.$ref)}`);
      s = (s.$ref.slice(2).split('/').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], model) ?? {}) as Schema;
    }
    return s;
  };
  const flatten = (raw: Schema | undefined, depth = 0): Schema => {
    const s = deref(raw);
    if (!Array.isArray(s.allOf) || depth > 20) return s;
    const parts = (s.allOf as Schema[]).map((p) => flatten(p, depth + 1));
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const p of [...parts, s]) { Object.assign(properties, p.properties ?? {}); required.push(...((p.required ?? []) as string[])); }
    return { ...s, allOf: undefined, type: s.type ?? parts.find((p) => p.type)?.type ?? 'object', properties, required,
      additionalProperties: s.additionalProperties ?? parts.find((p) => p.additionalProperties !== undefined)?.additionalProperties };
  };
  const out = new Set<string>();
  const check = (raw: Schema | undefined, v: unknown, path: string): void => {
    const s = flatten(raw);
    if (isPlaceholder(v)) return;
    if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(v)) out.add(`${path}: value ${JSON.stringify(v).slice(0, 40)} is not in the model enum`);
    const type = s.type ?? (s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : undefined);
    const k = kindOf(v);
    if (type === 'string') { if (k !== 'string') out.add(`${path}: ${k}, the model says string`); return; }
    if (type === 'integer') { if (k !== 'integer') out.add(`${path}: ${k}, the model says integer`); return; }
    if (type === 'number') { if (k !== 'integer' && k !== 'number') out.add(`${path}: ${k}, the model says number`); return; }
    if (type === 'boolean') { if (k !== 'boolean') out.add(`${path}: ${k}, the model says boolean`); return; }
    if (type === 'array') {
      if (k !== 'array') out.add(`${path}: ${k}, the model says array`);
      else if (s.items) for (const x of v as unknown[]) check(s.items as Schema, x, `${path}[]`);
      return;
    }
    if (type === 'object') {
      if (k !== 'object') { out.add(`${path}: ${k}, the model says object`); return; }
      const o = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in o)) out.add(`${path}.${r}: required by the model, absent`);
      for (const [key, x] of Object.entries(o)) {
        if (key in props) check(props[key], x, `${path}.${key}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties as Schema, x, `${path}.${key}`);
        else if (!s.properties) continue;
        else out.add(`${path}.${key}: not in the model`);
      }
    }
  };
  check(schema, value, '$');
  return [...out].sort();
}

/** Обмены фикстуры с запросом к SP-API (не к LWA) и ответом: что спросили и что «ответил канал» */
export function apiExchanges(fixture: unknown): Array<{ id: string; method: string; path: string; status: number; body: unknown }> {
  const exchanges = ((fixture as { exchanges?: unknown[] }).exchanges ?? []) as Array<{ id?: string; request?: { method?: string; path?: string }; response?: { status?: number; body?: unknown } }>;
  return exchanges.flatMap((e) => (e.request?.path && e.request.path !== '/auth/o2/token' && e.response && typeof e.response.status === 'number'
    ? [{ id: e.id ?? '?', method: e.request.method ?? 'GET', path: e.request.path, status: e.response.status, body: e.response.body }] : []));
}

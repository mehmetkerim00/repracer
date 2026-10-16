import { readFileSync } from 'node:fs';

/**
 * Шаг 97 [Р-221]: проверка тела уведомления Amazon по официальной схеме снимка (vendor/amazon/sp-api-models/…/schemas/notifications).
 * СТРОЖЕ схемы в одном: поле, которого схема не описывает, — ошибка, хотя схема допускает лишние свойства (`additionalProperties: true`).
 * Именно лишнее поле (`IsBuyBoxWinner`) прятало дефект разбора: фикстуры несли признак держателя Buy Box, которого в уведомлении нет,
 * и стенд был зелёным там, где настоящий канал признака не даст (A-29). Подстановки стенда (`{"$clockIso": …}`) — строки времени.
 */

type Schema = Record<string, unknown>;

export const NOTIFICATION_SCHEMAS = new URL('../../../../vendor/amazon/sp-api-models/2026-09-29/schemas/notifications/', import.meta.url);

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

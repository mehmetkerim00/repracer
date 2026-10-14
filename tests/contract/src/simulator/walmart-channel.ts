import { NEXT_REPLENISHMENT_HEADER, TOKEN_COUNT_HEADER, WALMART_PATHS, type WalmartFetch } from '@repracer/walmart-adapter';

/**
 * Шаг 89: модель Walmart Marketplace на уровне HTTP — канал с состоянием, через который идёт НАСТОЯЩИЙ адаптер Walmart. Снимка
 * спецификации нет (W-01): поведение — со слов владельца (docs/channels/walmart.md), неизвестное — параметр с вопросом W-nn:
 *  - Token API: POST /v3/token по ключу и секрету клиента → токен доступа;
 *  - лимиты — корзина токенов на семейство операций: запрос тратит токен, пополнение с фиксированной скоростью, превышение — 429; в
 *    КАЖДОМ ответе заголовки x-current-token-count и x-next-replenishment-time (мс эпохи — W-07); инвентарь — порядка 200 в минуту
 *    (факт владельца), остальные — параметр;
 *  - фид больше предела — 413 (предел — параметр, W-08);
 *  - цена — одиночное обновление PUT /v3/price; инвентарь — GET/PUT /v3/inventory?sku= (склад по умолчанию, W-04);
 *  - правило неконкурентной цены: у части товаров есть цена того же товара на другой площадке; цена на walmart.com заметно выше неё
 *    (больше чем на порог, W-10) — Walmart снимает листинг с публикации с причиной; цена снова в пределах порога — публикует обратно
 *    (W-11). Причина и цена другой площадки — в ответе о товаре (называет ли их настоящий Walmart — W-10);
 *  - Buy Box: GET /v3/buybox?sku= — три конкурента каждого товара: дрейфующий, подрезающий и волновой (W-05).
 * Все данные синтетические.
 */

export interface WalmartBucketSpec {
  /** Сколько токенов вмещает корзина */
  capacity: number;
  /** Пополнение — токенов в минуту, равномерно */
  perMinute: number;
}

export interface WalmartModelParams {
  buckets: Record<'items' | 'price' | 'inventory' | 'buybox' | 'feeds' | 'token', WalmartBucketSpec>;
  /** W-08: предел тела фида, байт */
  maxFeedBytes: number;
  /** W-10: насколько цена на walmart.com может быть выше цены другой площадки, базисные пункты (1000 = 10 %) */
  uncompetitiveThresholdBp: number;
  /** W-11: публикует ли Walmart листинг обратно, когда цена снова в пределах порога */
  republishWhenCompetitive: boolean;
}

export const WALMART_PARAMETERS: Readonly<Record<string, { question: string; note: string }>> = {
  buckets: { question: 'W-07', note: 'размер и скорость корзин по операциям; инвентарь — порядка 200/мин со слов владельца' },
  maxFeedBytes: { question: 'W-08', note: 'предел тела фида, после которого 413' },
  uncompetitiveThresholdBp: { question: 'W-10', note: 'порог правила неконкурентной цены и называет ли Walmart цену другой площадки' },
  republishWhenCompetitive: { question: 'W-11', note: 'публикует ли Walmart листинг обратно сам после исправления цены' },
};

export function defaultWalmartParams(): WalmartModelParams {
  return {
    buckets: {
      items: { capacity: 60, perMinute: 60 },
      price: { capacity: 60, perMinute: 60 },
      inventory: { capacity: 200, perMinute: 200 },
      buybox: { capacity: 60, perMinute: 60 },
      feeds: { capacity: 10, perMinute: 10 },
      token: { capacity: 60, perMinute: 60 },
    },
    maxFeedBytes: 1024 * 1024,
    uncompetitiveThresholdBp: 1000,
    republishWhenCompetitive: true,
  };
}

/** Поведение конкурента во времени — как три конкурента демо Kaufland: дрейф, подрезчик, волна */
export type WalmartCompetitorBehaviour = 'DRIFT' | 'UNDERCUT' | 'WAVE';

export interface WalmartItemSpec {
  sku: string;
  gtin?: string;
  productName: string;
  priceMinor: number;
  quantity: number;
  /** Цена того же товара на другой площадке — по ней Walmart судит о конкурентности [W-10]; null — нет */
  otherMarketplacePriceMinor: number | null;
  /** Опорная цена конкурентов товара: от неё ходят три поведения */
  competitorBaseMinor: number;
}

export interface WalmartModelSpec {
  seed: number;
  clientId: string;
  clientSecret: string;
  items: WalmartItemSpec[];
  params?: Partial<WalmartModelParams>;
  /** Часы мира: модель живёт на них (виртуальные в тестах, настоящие в демо) */
  nowMs: () => number;
}

interface ItemState extends WalmartItemSpec { published: boolean; reason: string | null }
interface BucketState { tokens: number; lastRefillMs: number }

export interface WalmartSimulatorStats {
  requests: number;
  throttled: number;
  payloadTooLarge: number;
  unpublished: number;
  republished: number;
}

const json = (status: number, body: unknown, headers: Record<string, string>) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const money = (minor: number) => ({ currency: 'USD', amount: Number((minor / 100).toFixed(2)) });
const MINUTE = 60_000;

export class SimulatedWalmartChannel {
  readonly stats: WalmartSimulatorStats = { requests: 0, throttled: 0, payloadTooLarge: 0, unpublished: 0, republished: 0 };
  readonly params: WalmartModelParams;
  private readonly items = new Map<string, ItemState>();
  private readonly buckets = new Map<string, BucketState>();
  private readonly tokens = new Set<string>();
  private readonly spec: WalmartModelSpec;
  private readonly startMs: number;

  constructor(spec: WalmartModelSpec) {
    this.spec = spec;
    this.params = { ...defaultWalmartParams(), ...spec.params, buckets: { ...defaultWalmartParams().buckets, ...spec.params?.buckets } };
    this.startMs = spec.nowMs();
    for (const it of spec.items) {
      const state: ItemState = { ...it, published: true, reason: null };
      this.applyCompetitivenessRule(state);
      this.items.set(it.sku, state);
    }
  }

  /** Состояние товара — для утверждений теста и снимков */
  item(sku: string): Readonly<ItemState> | null {
    const s = this.items.get(sku);
    return s ? { ...s } : null;
  }

  /** W-10, W-11: цена выше цены другой площадки больше чем на порог — снять с публикации; снова в пределах — опубликовать обратно */
  private applyCompetitivenessRule(s: ItemState): void {
    if (s.otherMarketplacePriceMinor === null) return;
    const limit = Math.floor(s.otherMarketplacePriceMinor * (10_000 + this.params.uncompetitiveThresholdBp) / 10_000);
    if (s.priceMinor > limit && s.published) {
      s.published = false;
      s.reason = 'UNCOMPETITIVE_PRICE';
      this.stats.unpublished += 1;
    } else if (s.priceMinor <= limit && !s.published && s.reason === 'UNCOMPETITIVE_PRICE' && this.params.republishWhenCompetitive) {
      s.published = true;
      s.reason = null;
      this.stats.republished += 1;
    }
  }

  /** Корзина семейства: пополнение с фиксированной скоростью, токен на запрос; заголовки — каждому ответу */
  private take(bucket: string): { ok: boolean; headers: Record<string, string> } {
    const spec = this.params.buckets[bucket as keyof WalmartModelParams['buckets']] ?? this.params.buckets.items;
    const now = this.spec.nowMs();
    const intervalMs = MINUTE / spec.perMinute;
    const st = this.buckets.get(bucket) ?? { tokens: spec.capacity, lastRefillMs: now };
    const earned = Math.floor((now - st.lastRefillMs) / intervalMs);
    if (earned > 0) {
      st.tokens = Math.min(spec.capacity, st.tokens + earned);
      st.lastRefillMs = st.tokens === spec.capacity ? now : st.lastRefillMs + earned * intervalMs;
    }
    const ok = st.tokens >= 1;
    if (ok) st.tokens -= 1;
    this.buckets.set(bucket, st);
    const next = st.tokens >= spec.capacity ? now : st.lastRefillMs + intervalMs;
    return { ok, headers: { [TOKEN_COUNT_HEADER]: String(Math.max(0, Math.floor(st.tokens))), [NEXT_REPLENISHMENT_HEADER]: String(Math.ceil(next)) } };
  }

  /** Три конкурента товара в момент `nowMs`: дрейф (медленный шаг), подрезчик (на цент ниже нашей, не ниже 80 % опоры), волна (±10 %) */
  competitorsOf(sku: string): Array<{ sellerRef: string; behaviour: WalmartCompetitorBehaviour; priceMinor: number }> {
    const s = this.items.get(sku);
    if (!s) return [];
    const t = (this.spec.nowMs() - this.startMs) / MINUTE;
    const phase = [...sku].reduce((a, c) => a + c.charCodeAt(0), this.spec.seed) % 360;
    const base = s.competitorBaseMinor;
    const drift = Math.round(base * (1 + 0.06 * Math.sin((t / 600 + phase) / 3)));
    const undercut = Math.max(Math.round(base * 0.8), s.priceMinor - 1);
    const wave = Math.round(base * (1 + 0.1 * Math.sin((t / 90) * Math.PI + phase)));
    return [
      { sellerRef: 'Synthetic Walmart seller A', behaviour: 'DRIFT', priceMinor: drift },
      { sellerRef: 'Synthetic Walmart seller B', behaviour: 'UNDERCUT', priceMinor: undercut },
      { sellerRef: 'Synthetic Walmart seller C', behaviour: 'WAVE', priceMinor: wave },
    ];
  }

  private itemBody(s: ItemState) {
    return {
      sku: s.sku, ...(s.gtin ? { gtin: s.gtin } : {}), productName: s.productName, price: money(s.priceMinor),
      publishedStatus: s.published ? 'PUBLISHED' : 'UNPUBLISHED',
      ...(s.published ? {} : { unpublishedReasons: { reason: [s.reason ?? 'UNKNOWN'] } }),
      ...(!s.published && s.reason === 'UNCOMPETITIVE_PRICE' && s.otherMarketplacePriceMinor !== null ? { referencePrice: money(s.otherMarketplacePriceMinor) } : {}),
    };
  }

  readonly fetch: WalmartFetch = async (url, init) => {
    this.stats.requests += 1;
    const u = new URL(url);
    const path = u.pathname;
    const bucket = path.startsWith(WALMART_PATHS.inventory) ? 'inventory' : path.startsWith(WALMART_PATHS.price) ? 'price'
      : path.startsWith(WALMART_PATHS.buybox) ? 'buybox' : path.startsWith(WALMART_PATHS.feeds) ? 'feeds' : path.startsWith(WALMART_PATHS.token) ? 'token' : 'items';
    const quota = this.take(bucket);
    if (!quota.ok) {
      this.stats.throttled += 1;
      return json(429, { errors: [{ code: 'SYN_TOO_MANY_REQUESTS' }] }, quota.headers);
    }
    const h = quota.headers;
    if (path === WALMART_PATHS.token && init.method === 'POST') {
      const basic = (init.headers.authorization ?? '').replace(/^Basic /, '');
      const [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      if (id !== this.spec.clientId || secret !== this.spec.clientSecret) return json(401, { errors: [{ code: 'SYN_UNAUTHORIZED' }] }, h);
      const token = `syn-walmart-token-${this.tokens.size + 1}`;
      this.tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 900 }, h);
    }
    if (!this.tokens.has(init.headers['WM_SEC.ACCESS_TOKEN'] ?? '')) return json(401, { errors: [{ code: 'SYN_UNAUTHORIZED' }] }, h);
    if (path === WALMART_PATHS.feeds && init.method === 'POST') {
      if (Buffer.byteLength(init.body ?? '', 'utf8') > this.params.maxFeedBytes) {
        this.stats.payloadTooLarge += 1;
        return json(413, { errors: [{ code: 'SYN_PAYLOAD_TOO_LARGE' }] }, h);
      }
      return json(202, { feedId: `syn-feed-${this.stats.requests}` }, h);
    }
    if (path === WALMART_PATHS.items && init.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit') ?? '50')));
      const from = Number(u.searchParams.get('nextCursor') ?? '0');
      const all = [...this.items.values()];
      const page = all.slice(from, from + limit);
      return json(200, { ItemResponse: page.map((s) => this.itemBody(s)), totalItems: all.length, ...(from + limit < all.length ? { nextCursor: String(from + limit) } : {}) }, h);
    }
    if (path.startsWith(`${WALMART_PATHS.items}/`) && init.method === 'GET') {
      const s = this.items.get(decodeURIComponent(path.slice(WALMART_PATHS.items.length + 1)));
      return s ? json(200, this.itemBody(s), h) : json(404, { errors: [{ code: 'SYN_NOT_FOUND' }] }, h);
    }
    if (path === WALMART_PATHS.price && init.method === 'PUT') {
      const b = JSON.parse(init.body ?? '{}') as { sku?: string; pricing?: Array<{ currentPrice?: { currency?: string; amount?: number } }> };
      const s = b.sku ? this.items.get(b.sku) : undefined;
      const p = b.pricing?.[0]?.currentPrice;
      if (!s) return json(404, { errors: [{ code: 'SYN_NOT_FOUND' }] }, h);
      if (p?.currency !== 'USD' || typeof p.amount !== 'number' || !(p.amount > 0)) return json(400, { errors: [{ code: 'SYN_INVALID_PRICE' }] }, h);
      s.priceMinor = Math.round(p.amount * 100);
      this.applyCompetitivenessRule(s);
      return json(200, { ItemPriceResponse: { sku: s.sku, message: 'Thank you. Your price has been updated.' } }, h);
    }
    if (path === WALMART_PATHS.inventory) {
      const s = this.items.get(u.searchParams.get('sku') ?? '');
      if (!s) return json(404, { errors: [{ code: 'SYN_NOT_FOUND' }] }, h);
      if (init.method === 'GET') return json(200, { sku: s.sku, quantity: { unit: 'EACH', amount: s.quantity } }, h);
      if (init.method === 'PUT') {
        const b = JSON.parse(init.body ?? '{}') as { quantity?: { amount?: number } };
        if (!Number.isInteger(b.quantity?.amount) || (b.quantity?.amount ?? -1) < 0) return json(400, { errors: [{ code: 'SYN_INVALID_QUANTITY' }] }, h);
        s.quantity = b.quantity!.amount!;
        return json(200, { sku: s.sku, quantity: { unit: 'EACH', amount: s.quantity } }, h);
      }
    }
    if (path === WALMART_PATHS.buybox && init.method === 'GET') {
      const s = this.items.get(u.searchParams.get('sku') ?? '');
      if (!s) return json(404, { errors: [{ code: 'SYN_NOT_FOUND' }] }, h);
      const offers = [...this.competitorsOf(s.sku).map((c) => ({ sellerRef: c.sellerRef, isSelf: false, priceMinor: c.priceMinor })),
        ...(s.published ? [{ sellerRef: 'self', isSelf: true, priceMinor: s.priceMinor }] : [])].sort((a, b) => a.priceMinor - b.priceMinor);
      const winner = offers[0]!;
      return json(200, {
        sku: s.sku, observedAt: new Date(this.spec.nowMs()).toISOString(), buyBox: { price: money(winner.priceMinor), isSelf: winner.isSelf },
        offers: offers.map((o) => ({ sellerRef: o.isSelf ? undefined : o.sellerRef, isSelf: o.isSelf, price: money(o.priceMinor) })),
      }, h);
    }
    return json(404, { errors: [{ code: 'SYN_UNKNOWN_OPERATION' }] }, h);
  };
}

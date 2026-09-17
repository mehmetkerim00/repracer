import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import type { ClickHouseHttp } from './clickhouse.ts';

/**
 * История снимков конкурентов для бэктеста [Р-38, Р-20, Р-23]. Читает только шлюз аналитики ролью repracer_tenant_reader: строки
 * ограничены политикой tenant_isolation по настройке SQL_tenant_id (020), запрос дополнительно фильтрует tenant_id явно.
 * Путь решения о цене этот модуль не использует [Р-22].
 *
 * Окно — не больше 18 месяцев и не старше 18 месяцев от текущего момента: данные канала дольше не хранятся [Р-3, Р-38],
 * а Amazon Information старше срока использовать нельзя, даже если строка ещё не удалена TTL.
 */

export const BACKTEST_WINDOW_MONTHS = 18;

export interface HistoryWindow { from: string; to: string }

function monthsBefore(iso: string, months: number): number {
  const d = new Date(iso);
  const shifted = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  return shifted.getTime();
}

/** Р-38: окно бэктеста ≤ 18 месяцев и внутри срока хранения данных канала; нарушение — ошибка до любого чтения */
export function assertBacktestWindow(window: HistoryWindow, now: string): void {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error('backtest window must have from < to');
  if (to > Date.parse(now)) throw new Error('backtest window cannot end in the future');
  if (from < monthsBefore(window.to, BACKTEST_WINDOW_MONTHS)) throw new Error(`backtest window is longer than ${BACKTEST_WINDOW_MONTHS} months (Р-38)`);
  if (from < monthsBefore(now, BACKTEST_WINDOW_MONTHS)) throw new Error(`backtest window starts earlier than ${BACKTEST_WINDOW_MONTHS} months ago: channel data is not kept longer (Р-3, Р-38)`);
}

/** Строка repracer_analytics.competitor_snapshot (010, 030, 050) */
export interface CompetitorSnapshotRow {
  tenant_id: string;
  competitor_snapshot_id: string;
  received_at: string;
  observed_at: string;
  channel_account_id: string;
  channel: string;
  marketplace: string;
  channel_product_ref: string;
  condition: string;
  currency: string;
  price_basis: string;
  source: string;
  source_event_id: string | null;
  /** Шаг 24 (090): вердикт проверки входов — ACCEPT, REJECT, HALT_CHANNEL */
  sanity_verdict: string;
  completeness: string;
  completeness_n: number | null;
  buybox_amount_minor: number | null;
  buybox_shipping_minor: number | null;
  buybox_is_self: boolean | null;
  channel_suggested_amount_minor: number | null;
  'offers.seller_ref': string[];
  'offers.amount_minor': number[];
  'offers.shipping_minor': number[];
  'offers.condition': string[];
  'offers.fulfillment': string[];
  'offers.is_self': boolean[];
  'offers.rank': Array<number | null>;
  'offers.delivery_min_days': Array<number | null>;
  'offers.delivery_max_days': Array<number | null>;
  'offers.feedback_count': Array<number | null>;
  'offers.feedback_pct': Array<number | null>;
  offer_counts: Record<string, number>;
  data_class: string;
}

/** Снимок → строка ClickHouse. Писатель — exportCompetitorSnapshotsDay (шаг 24) из журнала пути решения */
export function competitorSnapshotRow(
  tenantId: string, channelAccountId: string, channel: 'KAUFLAND' | 'AMAZON', snapshotId: string, snapshot: CompetitorSnapshot, receivedAt: string,
  sanityVerdict: 'ACCEPT' | 'REJECT' | 'HALT_CHANNEL' = 'ACCEPT',
): CompetitorSnapshotRow {
  const currency = snapshot.buybox?.price.currency ?? snapshot.offers[0]?.price.currency;
  const basis = snapshot.buybox?.price.basis ?? snapshot.offers[0]?.price.basis;
  // Валюта строки не подставляется по умолчанию (у столбца DEFAULT 'EUR', 050): пустой снимок без валюты не пишется [Р-71]
  if (!currency || !basis) throw new Error('competitor snapshot without prices has no currency: not written');
  const o = snapshot.offers;
  // Находка 2 ревью шага 21: доставка Buy Box — у предложения-победителя (первый ранг или та же цена и сторона); снимок её отдельно не несёт
  const winner = snapshot.buybox
    ? o.find((x) => x.rank === 1 && x.isSelf === snapshot.buybox!.isSelf) ?? o.find((x) => x.isSelf === snapshot.buybox!.isSelf && x.price.amountMinor === snapshot.buybox!.price.amountMinor)
    : undefined;
  return {
    tenant_id: tenantId, competitor_snapshot_id: snapshotId, received_at: receivedAt, observed_at: snapshot.observedAt,
    channel_account_id: channelAccountId, channel, marketplace: snapshot.marketplace, channel_product_ref: snapshot.channelProductRef,
    condition: snapshot.condition, currency, price_basis: basis, source: snapshot.source, source_event_id: snapshot.sourceEventId ?? null, sanity_verdict: sanityVerdict,
    completeness: snapshot.completeness.kind, completeness_n: snapshot.completeness.kind === 'TOP_N' ? snapshot.completeness.n : null,
    buybox_amount_minor: snapshot.buybox?.price.amountMinor ?? null, buybox_shipping_minor: winner?.shipping?.amountMinor ?? null, buybox_is_self: snapshot.buybox?.isSelf ?? null,
    channel_suggested_amount_minor: snapshot.channelSuggestedPrice?.amountMinor ?? null,
    'offers.seller_ref': o.map((x) => x.sellerRef ?? ''), 'offers.amount_minor': o.map((x) => x.price.amountMinor),
    'offers.shipping_minor': o.map((x) => x.shipping?.amountMinor ?? 0), 'offers.condition': o.map((x) => x.condition ?? snapshot.condition),
    'offers.fulfillment': o.map((x) => x.fulfillment ?? ''), 'offers.is_self': o.map((x) => x.isSelf), 'offers.rank': o.map((x) => x.rank ?? null),
    'offers.delivery_min_days': o.map((x) => x.deliveryDays?.min ?? null), 'offers.delivery_max_days': o.map((x) => x.deliveryDays?.max ?? null),
    'offers.feedback_count': o.map(() => null), 'offers.feedback_pct': o.map(() => null),
    offer_counts: {}, data_class: channel === 'AMAZON' ? 'AMAZON_INFO' : 'CHANNEL_INFO',
  };
}

export function competitorSnapshotFromRow(row: CompetitorSnapshotRow): CompetitorSnapshot {
  const basis = row.price_basis === 'NET' ? 'NET' : 'GROSS';
  const money = (amountMinor: number) => ({ amountMinor, currency: row.currency, basis } as const);
  const offers: CompetitorOffer[] = row['offers.amount_minor'].map((amount, i) => ({
    ...(row['offers.rank'][i] != null ? { rank: row['offers.rank'][i]! } : {}),
    ...(row['offers.seller_ref'][i] ? { sellerRef: row['offers.seller_ref'][i]! } : {}),
    isSelf: row['offers.is_self'][i] ?? false,
    price: money(amount),
    shipping: money(row['offers.shipping_minor'][i] ?? 0),
    totalPrice: money(amount + (row['offers.shipping_minor'][i] ?? 0)),
    ...(row['offers.condition'][i] ? { condition: row['offers.condition'][i]! } : {}),
    ...(row['offers.fulfillment'][i] ? { fulfillment: row['offers.fulfillment'][i]! } : {}),
    deliveryDays: { min: row['offers.delivery_min_days'][i] ?? null, max: row['offers.delivery_max_days'][i] ?? null },
  }));
  const completeness = row.completeness === 'TOP_N' ? { kind: 'TOP_N' as const, n: row.completeness_n ?? offers.length }
    : row.completeness === 'FULL' ? { kind: 'FULL' as const } : { kind: 'CHEAPEST_ONLY' as const };
  // ClickHouse отдаёт DateTime64 как «YYYY-MM-DD hh:mm:ss.sss» в UTC
  const iso = (v: string) => (v.includes('T') ? new Date(v).toISOString() : new Date(`${v.replace(' ', 'T')}Z`).toISOString());
  return {
    marketplace: row.marketplace, channelProductRef: row.channel_product_ref, condition: row.condition, source: row.source,
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    observedAt: iso(row.observed_at), completeness,
    ...(row.buybox_amount_minor != null ? { buybox: { price: money(row.buybox_amount_minor), isSelf: row.buybox_is_self ?? false } } : {}),
    offers,
    ...(row.channel_suggested_amount_minor != null ? { channelSuggestedPrice: money(row.channel_suggested_amount_minor) } : {}),
  };
}

const HISTORY_SQL = `
SELECT *
  FROM repracer_analytics.competitor_snapshot FINAL
 WHERE tenant_id = toUUID({tenant:String})
   AND channel_account_id = toUUID({account:String})
   AND observed_at >= parseDateTime64BestEffort({from:String}, 3) AND observed_at < parseDateTime64BestEffort({to:String}, 3)
 ORDER BY observed_at, competitor_snapshot_id`;

/**
 * История одного тенанта и аккаунта за окно. reader — логин роли repracer_tenant_reader; SQL_tenant_id ставится тем же тенантом,
 * так что политика строк и явный фильтр совпадают. Объединения тенантов нет [Р-23].
 */
export async function readCompetitorHistory(
  reader: ClickHouseHttp, tenantId: string, channelAccountId: string, window: HistoryWindow, now: string,
): Promise<CompetitorSnapshot[]> {
  assertBacktestWindow(window, now);
  const rows = await reader.rows<CompetitorSnapshotRow>(HISTORY_SQL, {
    SQL_tenant_id: tenantId, param_tenant: tenantId, param_account: channelAccountId, param_from: window.from, param_to: window.to,
  });
  return rows.map(competitorSnapshotFromRow);
}

import type { FieldWrite, Instant, OfferIdentity, PriceBasis, WriteOutcome, WriteValue } from '@repracer/channel-port';
import { floorCauseFromDatabase, priceBasisMismatch, sellerActionFor } from '@repracer/pricing-model';
import {
  planOutcomeTransition,
  planReconciliationTransition,
  type ClaimResult,
  type DueScope,
  type OutcomeTransition,
  type PriceBasisHalt,
  type RecordedOutcome,
  type Reconciliation,
  type RetryPolicy,
  type WriteQueueStore,
  type WriteReason,
} from '@repracer/write-dispatcher';
import { inTenant, type PgPool, type Tx } from './db.ts';

/**
 * Очередь записей в каналы на PostgreSQL [Р-64]. Состояние записи и единицы ведут триггеры channel_write (0008, 0018,
 * 0036): одна запись в полёте, отправляется только последняя версия, пол, потолок и остановка перепроверяются при
 * отправке. Здесь — захват под блокировкой строки единицы и перевод отказа триггера в завершение записи с причиной.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const iso = (v: unknown): Instant => (v instanceof Date ? v.toISOString() : String(v));

const WRITE_ROW = `
SELECT w.channel_write_id, w.write_scope_id, w.field, w.amount_minor, w.currency, w.price_basis, w.quantity, w.version,
       w.idempotency_key, w.status, w.attempt_count, w.next_attempt_at, w.dispatched_at, w.accepted_at, w.budget_scope_key, w.budget_day,
       s.scope_key, s.channel_account_id,
       m.marketplace, m.region, m.external_sku, m.external_offer_id, m.external_listing_id, m.external_unit_id
  FROM tenant_data.channel_write w
  JOIN tenant_data.write_scope s ON s.tenant_id = w.tenant_id AND s.write_scope_id = w.write_scope_id
  LEFT JOIN LATERAL (
    SELECT om.marketplace, om.region, om.external_sku, om.external_offer_id, om.external_listing_id, om.external_unit_id
      FROM tenant_data.offer_mapping om
     WHERE om.tenant_id = w.tenant_id AND (om.price_write_scope_id = w.write_scope_id OR om.quantity_write_scope_id = w.write_scope_id)
     ORDER BY om.created_at
     LIMIT 1) m ON true
 WHERE w.tenant_id = $1`;

function toWrite(r: Row): FieldWrite {
  const identity: OfferIdentity = {};
  if (r.region) identity.region = r.region;
  if (r.marketplace) identity.marketplace = r.marketplace;
  if (r.external_sku) identity.externalSku = r.external_sku;
  if (r.field === 'QUANTITY' && r.external_offer_id) identity.externalOfferId = r.external_offer_id;
  if (r.external_listing_id) identity.externalListingId = r.external_listing_id;
  if (r.external_unit_id) identity.externalUnitId = r.external_unit_id;
  const money = { amountMinor: Number(r.amount_minor), currency: r.currency as string, basis: r.price_basis as PriceBasis };
  const value: WriteValue = r.field === 'QUANTITY' ? { field: 'QUANTITY', quantity: Number(r.quantity) }
    : r.field === 'PRICE' ? { field: 'PRICE', price: money }
    : { field: 'CHANNEL_MIN_PRICE', minPrice: money };
  return {
    channelWriteId: r.channel_write_id as FieldWrite['channelWriteId'],
    writeScope: {
      writeScopeId: r.write_scope_id as FieldWrite['writeScope']['writeScopeId'],
      field: r.field === 'QUANTITY' ? 'QUANTITY' : 'PRICE',
      scopeKey: r.scope_key,
      identity,
      ...(r.budget_scope_key ? { budgetScopeKey: r.budget_scope_key } : {}),
    },
    version: Number(r.version),
    idempotencyKey: r.idempotency_key,
    value,
    attemptNo: Number(r.attempt_count),
  };
}

/** Отказ триггера при переводе в отправку — завершение записи с причиной; null — не отказ проверки, ошибка пробрасывается */
function dispatchRefusal(error: unknown, write: Row): { status: 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED' | 'BLOCKED'; reason: WriteReason } | null {
  const e = error as { code?: string; message?: string; constraint?: string };
  const message = e.message ?? '';
  const currency = write.currency as string;
  // Находка 7 шага 15 [Р-65, 0055]: повтор записи с бюджетом правок при неподтверждённой границе суток витрины — завершение с причиной.
  // Раньше отказ не распознавался: захват пробрасывал ошибку, обход диспетчера падал на каждом круге, запись висела без алерта (Р-64)
  let m = /retry of a budgeted write: the day boundary of storefront (\S+) is not confirmed/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_BUDGET_DAY_UNCONFIRMED', params: { marketplace: m[1]! } } };
  // Р-83 (0051): пол вычислен заново — min_price и пол маржи; пол не вычисляется — отдельное сообщение (не <NULL> в числе)
  m = /value (\d+) is below effective price floor (\d+) \(min_price (\d+), margin floor (\d+|none), min margin (\d+|none) bp\)/.exec(message);
  if (m) {
    return {
      status: 'DISCARDED_STALE',
      reason: {
        code: 'WRITE_BLOCKED_BY_BOUND_RECHECK',
        params: {
          amountMinor: Number(m[1]), floorMinor: Number(m[2]), ceilingMinor: null, violated: 'FLOOR', minMinor: Number(m[3]),
          ...(m[4] !== 'none' ? { marginFloorMinor: Number(m[4]) } : {}), ...(m[5] !== 'none' ? { minMarginBp: Number(m[5]) } : {}), currency,
        },
      },
    };
  }
  m = /price floor of write_scope \S+ cannot be computed [^:]*: (\w+)/.exec(message);
  if (m) {
    return {
      status: 'DISCARDED_STALE',
      reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor: Number(write.amount_minor), floorMinor: null, ceilingMinor: null, violated: 'FLOOR_UNRESOLVABLE', cause: floorCauseFromDatabase(m[1]!), currency } },
    };
  }
  m = /value (\d+) is below effective min_price (\d+)/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor: Number(m[1]), floorMinor: Number(m[2]), ceilingMinor: null, violated: 'FLOOR', currency } } };
  m = /value (\d+) is above effective max_price (\d+)/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor: Number(m[1]), floorMinor: null, ceilingMinor: Number(m[2]), violated: 'CEILING', currency } } };
  // Р-69: остановка человеком — никакая цена не уходит
  m = /price_stop ([0-9a-f-]{36})/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'PRICING_STOPPED', params: { stopId: m[1]!, stage: 'DISPATCH' } } };
  m = /pricing_halt ([0-9a-f-]{36})/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'CHANNEL_HALTED', params: { stage: 'DISPATCH', haltId: m[1]! } } };
  m = /pricing_mode changed to (\w+)/.exec(message);
  if (m) return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_PRICING_MODE_CHANGED', params: { mode: m[1]! } } };
  if ((e.constraint ?? '').includes('edit_budget') || message.includes('edit_budget')) {
    return { status: 'BUDGET_EXHAUSTED', reason: { code: 'WRITE_EDIT_BUDGET_EXHAUSTED', params: { source: 'DATABASE', ...(write.budget_day ? { budgetDay: String(write.budget_day).slice(0, 10) } : {}) } } };
  }
  m = /write_scope \S+ is (\w+): write cannot proceed/.exec(message);
  if (m) {
    const code = `SCOPE_${m[1]}`;
    return { status: 'BLOCKED', reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code, action: sellerActionFor(code) } } };
  }
  return null;
}

export interface PgWriteQueueStoreOptions {
  /**
   * Пул роли с repracer_dispatcher для обхода всех тенантов (maintenance.due_write_scopes). Без него dueScopes недоступен:
   * путь решения пользуется только захватом и записью итога в контексте своего тенанта.
   */
  scanPool?: PgPool;
}

export class PgWriteQueueStore implements WriteQueueStore {
  private readonly pool: PgPool;
  private readonly scanPool: PgPool | null;

  constructor(pool: PgPool, options: PgWriteQueueStoreOptions = {}) {
    this.pool = pool;
    this.scanPool = options.scanPool ?? null;
  }

  async claimNext(tenantId: string, writeScopeId: string, now: Instant, policy: RetryPolicy): Promise<ClaimResult> {
    return inTenant(this.pool, tenantId, async (tx) => {
      // Блокировка строки единицы упорядочивает захват с фиксацией решения и завершением записи в полёте
      const { rows: [ss] } = await tx.query(
        `SELECT in_flight_write_id, latest_version_created FROM tenant_data.write_scope_sync_state
          WHERE tenant_id = $1 AND write_scope_id = $2 FOR UPDATE`, [tenantId, writeScopeId]);
      if (!ss) return { kind: 'IDLE' };
      if (ss.in_flight_write_id) {
        const { rows: [f] } = await tx.query(`${WRITE_ROW} AND w.channel_write_id = $2`, [tenantId, ss.in_flight_write_id]);
        if (!f) return { kind: 'IDLE' };
        const since = iso(f.accepted_at ?? f.dispatched_at);
        const reconcileDue = f.next_attempt_at
          ? Date.parse(iso(f.next_attempt_at)) <= Date.parse(now)
          : Date.parse(since) + policy.inFlightTimeoutMs <= Date.parse(now);
        return { kind: 'IN_FLIGHT', channelAccountId: f.channel_account_id, write: toWrite(f), status: f.status, since, reconcileDue };
      }
      for (let guard = 0; guard < 16; guard++) {
        const { rows: [c] } = await tx.query(
          `${WRITE_ROW} AND w.write_scope_id = $2 AND w.status IN ('PENDING', 'FAILED') ORDER BY w.version DESC LIMIT 1`, [tenantId, writeScopeId]);
        if (!c) return { kind: 'IDLE' };
        if (Number(c.version) < Number(ss.latest_version_created)) {
          // Вставка новой версии вытесняет старые (0036); здесь — только защита от записи, созданной до неё
          const reason = { code: 'WRITE_SUPERSEDED_BY_NEWER_VERSION', params: { newerVersion: Number(ss.latest_version_created) } };
          await this.end(tx, tenantId, c.channel_write_id, 'DISCARDED_STALE', reason);
          continue;
        }
        if (c.status === 'FAILED') {
          // Без срока — ждёт разбора человеком (единица BLOCKED, алерт поднят при записи итога)
          if (!c.next_attempt_at) return { kind: 'IDLE' };
          if (Date.parse(iso(c.next_attempt_at)) > Date.parse(now)) return { kind: 'RETRY_LATER', channelWriteId: c.channel_write_id, at: iso(c.next_attempt_at) };
          if (Number(c.attempt_count) >= policy.maxAttempts) {
            const reason = { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: Number(c.attempt_count), code: 'MAX_ATTEMPTS' } };
            await this.end(tx, tenantId, c.channel_write_id, 'DISCARDED_STALE', reason);
            return { kind: 'ENDED', channelWriteId: c.channel_write_id, status: 'DISCARDED_STALE', reason };
          }
        }
        await tx.query('SAVEPOINT claim');
        try {
          const { rows: [claimed] } = await tx.query(
            `UPDATE tenant_data.channel_write
                SET status = 'DISPATCHED', attempt_count = attempt_count + 1, dispatched_at = $3, next_attempt_at = NULL
              WHERE tenant_id = $1 AND channel_write_id = $2
              RETURNING attempt_count`, [tenantId, c.channel_write_id, now]);
          await tx.query('RELEASE SAVEPOINT claim');
          return { kind: 'DISPATCH', channelAccountId: c.channel_account_id, write: toWrite({ ...c, attempt_count: claimed!.attempt_count }) };
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT claim');
          const refusal = dispatchRefusal(error, c);
          if (!refusal) throw error;
          if (refusal.status === 'BLOCKED') {
            if (c.status === 'PENDING') {
              await tx.query(`UPDATE tenant_data.channel_write SET status = 'BLOCKED', last_error_code = $3 WHERE tenant_id = $1 AND channel_write_id = $2`,
                [tenantId, c.channel_write_id, String(refusal.reason.params.code)]);
            }
          } else {
            await this.end(tx, tenantId, c.channel_write_id, refusal.status, refusal.reason);
          }
          return { kind: 'ENDED', channelWriteId: c.channel_write_id, status: refusal.status, reason: refusal.reason };
        }
      }
      return { kind: 'IDLE' };
    });
  }

  /** Завершение неотправленной записи (PENDING или FAILED) с причиной */
  private async end(tx: Tx, tenantId: string, channelWriteId: string, status: 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED', reason: WriteReason): Promise<void> {
    await tx.query(
      `UPDATE tenant_data.channel_write SET status = $3, end_reason = $4, end_params = $5, next_attempt_at = NULL
        WHERE tenant_id = $1 AND channel_write_id = $2`,
      [tenantId, channelWriteId, status, reason.code, JSON.stringify(reason.params)]);
  }

  async recordOutcome(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome> {
    return inTenant(this.pool, tenantId, async (tx) => {
      const current = await this.lockWrite(tx, tenantId, write);
      if (!current || current.status !== 'DISPATCHED') return this.unchanged(tx, tenantId, write, current);
      const transition = planOutcomeTransition(outcome, Number(current.attempt_count), now, policy);
      return this.apply(tx, tenantId, write, 'DISPATCHED', transition, now);
    });
  }

  async recordReconciliation(tenantId: string, write: FieldWrite, result: Reconciliation, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome> {
    return inTenant(this.pool, tenantId, async (tx) => {
      const current = await this.lockWrite(tx, tenantId, write);
      if (!current || (current.status !== 'DISPATCHED' && current.status !== 'ACCEPTED')) return this.unchanged(tx, tenantId, write, current);
      const since = iso(current.accepted_at ?? current.dispatched_at);
      const transition = planReconciliationTransition(current.status, result, Number(current.attempt_count), since, now, policy);
      return this.apply(tx, tenantId, write, current.status, transition, now);
    });
  }

  async dueScopes(now: Instant, options: { pendingMinAgeMs: number; inFlightTimeoutMs: number; limit: number }): Promise<DueScope[]> {
    if (!this.scanPool) throw new Error('PgWriteQueueStore: dueScopes requires a scan pool with the repracer_dispatcher role');
    const { rows } = await this.scanPool.query(
      `SELECT tenant_id, write_scope_id, due_kind, due_since
         FROM maintenance.due_write_scopes($1::timestamptz, make_interval(secs => $2::float8 / 1000), make_interval(secs => $3::float8 / 1000), $4::int)`,
      [now, options.pendingMinAgeMs, options.inFlightTimeoutMs, options.limit]);
    return rows.map((r) => ({ tenantId: r.tenant_id, writeScopeId: r.write_scope_id, dueKind: r.due_kind, dueSince: iso(r.due_since) }));
  }

  async checkPriceBasis(tenantId: string, write: FieldWrite, observedMinor: number, now: Instant): Promise<PriceBasisHalt | null> {
    if (write.value.field !== 'PRICE') return null;
    const sentMinor = write.value.price.amountMinor;
    const currency = write.value.price.currency;
    return inTenant(this.pool, tenantId, async (tx) => {
      // Ставка — та же, что у пола маржи: товара и страны витрины, только в режиме НДС [Р-53, Р-58]
      const { rows: [sc] } = await tx.query(
        `SELECT s.channel_account_id, s.channel, m.marketplace,
                CASE WHEN s.tax_regime = 'VAT_INCLUDED' THEN tenant_data.effective_vat_rate_bp($1, s.product_id,
                  (SELECT mk.country FROM platform.marketplace mk WHERE mk.channel = s.channel AND mk.marketplace = m.marketplace)) END AS vat_rate_bp
           FROM tenant_data.write_scope s
           JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
          WHERE s.tenant_id = $1 AND s.write_scope_id = $2
          ORDER BY m.created_at LIMIT 1`, [tenantId, write.writeScope.writeScopeId]);
      if (!sc) return null;
      const vatRateBp = sc.vat_rate_bp === null ? null : Number(sc.vat_rate_bp);
      const basisError = priceBasisMismatch(sentMinor, observedMinor, vatRateBp);
      if (!basisError) return null;
      const reason: WriteReason = {
        code: 'CHANNEL_PRICE_BASIS_MISMATCH',
        params: { basisError, vatRateBp: vatRateBp!, sentMinor, observedMinor, currency, writeScopeId: write.writeScope.writeScopeId, marketplace: sc.marketplace },
      };
      // Р-116: остановка витрины — все цены, снимает только человек (0080); повтор той же причины не создаёт вторую остановку
      await tx.query(
        `INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, details, halted_at)
         VALUES ($1, $2, $3, $4, 'CHANNEL_PRICE_BASIS_MISMATCH', $5, $6)
         ON CONFLICT (tenant_id, channel_account_id, (COALESCE(marketplace, '*')), reason_code) WHERE released_at IS NULL DO NOTHING`,
        [tenantId, sc.channel_account_id, sc.channel, sc.marketplace, JSON.stringify(reason.params), now]);
      const { rows: [h] } = await tx.query(
        `SELECT pricing_halt_id FROM channel_data.pricing_halt
          WHERE tenant_id = $1 AND channel_account_id = $2 AND marketplace = $3 AND reason_code = 'CHANNEL_PRICE_BASIS_MISMATCH' AND released_at IS NULL`,
        [tenantId, sc.channel_account_id, sc.marketplace]);
      return h ? { haltId: h.pricing_halt_id, reason } : null;
    });
  }

  private async lockWrite(tx: Tx, tenantId: string, write: FieldWrite): Promise<Row | null> {
    const { rows: [r] } = await tx.query(
      `SELECT status, attempt_count, dispatched_at, accepted_at FROM tenant_data.channel_write
        WHERE tenant_id = $1 AND channel_write_id = $2 FOR UPDATE`, [tenantId, write.channelWriteId]);
    return r ?? null;
  }

  private async scopeState(tx: Tx, tenantId: string, write: FieldWrite): Promise<{ slotFreed: boolean; queuedWaiting: boolean }> {
    const { rows: [ss] } = await tx.query(
      `SELECT ss.in_flight_write_id IS NULL AS free,
              EXISTS (SELECT 1 FROM tenant_data.channel_write w
                       WHERE w.tenant_id = ss.tenant_id AND w.write_scope_id = ss.write_scope_id AND w.status = 'PENDING') AS queued
         FROM tenant_data.write_scope_sync_state ss WHERE ss.tenant_id = $1 AND ss.write_scope_id = $2`,
      [tenantId, write.writeScope.writeScopeId]);
    const slotFreed = ss?.free === true;
    return { slotFreed, queuedWaiting: slotFreed && ss?.queued === true };
  }

  /** Итог уже записан (повтор события, завершение другой транзакцией) или запись ушла в историю */
  private async unchanged(tx: Tx, tenantId: string, write: FieldWrite, current: Row | null): Promise<RecordedOutcome> {
    const status = (current?.status ?? 'APPLIED') as RecordedOutcome['status'];
    return { status, ...(await this.scopeState(tx, tenantId, write)), nextAttemptAt: null, reason: null, scopeBlocked: false };
  }

  private async apply(tx: Tx, tenantId: string, write: FieldWrite, from: 'DISPATCHED' | 'ACCEPTED', t: OutcomeTransition, now: Instant): Promise<RecordedOutcome> {
    const id = write.channelWriteId;
    const set = (sql: string, params: unknown[] = []) => tx.query(`UPDATE tenant_data.channel_write SET ${sql} WHERE tenant_id = $1 AND channel_write_id = $2`, [tenantId, id, ...params]);
    let status: RecordedOutcome['status'];
    let nextAttemptAt: Instant | null = null;
    let reason: WriteReason | null = null;
    let scopeBlocked = false;
    switch (t.to) {
      case 'ACCEPTED':
        if (from === 'DISPATCHED') await set(`status = 'ACCEPTED', accepted_at = $3, next_attempt_at = NULL`, [now]);
        if (t.applied) await set(`status = 'APPLIED', applied_at = $3, finished_at = $3, next_attempt_at = NULL`, [now]);
        status = t.applied ? 'APPLIED' : 'ACCEPTED';
        reason = t.reason;
        break;
      case 'RETRY':
        await set(`status = 'FAILED', last_error_code = $3, next_attempt_at = $4`, [t.errorCode, t.nextAttemptAt]);
        status = 'FAILED';
        nextAttemptAt = t.nextAttemptAt;
        reason = t.reason;
        break;
      case 'RECONCILE':
        await set(`last_error_code = $3, next_attempt_at = $4`, [t.errorCode, t.nextAttemptAt]);
        status = from;
        nextAttemptAt = t.nextAttemptAt;
        break;
      case 'DISCARD':
        await set(`status = 'FAILED', last_error_code = $3, next_attempt_at = NULL`, [t.errorCode]);
        await set(`status = 'DISCARDED_STALE', end_reason = $3, end_params = $4`, [t.reason.code, JSON.stringify(t.reason.params)]);
        status = 'DISCARDED_STALE';
        reason = t.reason;
        break;
      case 'BUDGET_EXHAUSTED':
        await set(`status = 'BUDGET_EXHAUSTED', last_error_code = $3, end_reason = $4, end_params = $5, next_attempt_at = NULL`,
          [t.errorCode, t.reason.code, JSON.stringify(t.reason.params)]);
        status = 'BUDGET_EXHAUSTED';
        reason = t.reason;
        break;
      case 'BLOCK_SCOPE':
        await set(`status = 'FAILED', last_error_code = $3, next_attempt_at = NULL`, [t.errorCode]);
        await tx.query(`UPDATE tenant_data.write_scope SET status = 'BLOCKED' WHERE tenant_id = $1 AND write_scope_id = $2`,
          [tenantId, write.writeScope.writeScopeId]);
        status = 'FAILED';
        reason = t.reason;
        scopeBlocked = true;
        break;
      case 'UNRESOLVED':
        // D1: сверка прекращается; отправленная запись — FAILED без срока, принятая остаётся принятой; единица — до разбора человеком
        if (from === 'DISPATCHED') await set(`status = 'FAILED', last_error_code = $3, next_attempt_at = NULL`, [t.errorCode]);
        else await set(`last_error_code = $3, next_attempt_at = NULL`, [t.errorCode]);
        await tx.query(`UPDATE tenant_data.write_scope SET status = 'BLOCKED' WHERE tenant_id = $1 AND write_scope_id = $2`,
          [tenantId, write.writeScope.writeScopeId]);
        status = from === 'DISPATCHED' ? 'FAILED' : 'ACCEPTED';
        reason = t.reason;
        scopeBlocked = true;
        break;
      case 'NOT_APPLIED':
        await set(`status = 'NOT_APPLIED', finished_at = $3, next_attempt_at = NULL`, [now]);
        status = 'NOT_APPLIED';
        reason = t.reason;
        break;
    }
    return { status, ...(await this.scopeState(tx, tenantId, write)), nextAttemptAt, reason, scopeBlocked };
  }
}

import { createHash, randomBytes } from 'node:crypto';
import type { Instant, OrderLine } from '@repracer/channel-port';
import {
  availableOf, publishedQuantity, type CreateStockSourceResult, type EnableStockSyncInput, type EnableStockSyncResult, type InboundStockOutcome, type InboundStockRow,
  type OrderLinesOutcome, type RecalculationOutcome, type StockActor, type StockChannelRow, type StockDivergenceRow, type StockImportOutcome, type StockImportRow,
  type StockPage, type StockRow, type StockSourceMode, type StockSourceRow, type StockStore,
} from '@repracer/stock-sync';
import { inTenant, type PgPool, type Tx } from './db.ts';

type Row = Record<string, any>;
const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;

export interface PgStockStoreOptions {
  /** Административная роль: источники, ключи, буферы, единицы записи, импорт — от имени человека [Р-97] */
  adminPool: PgPool;
  /** Роль остатков `svc_stock` [Р-102, Р-105]: пулы Inbound API, резервации, записи количества */
  stockPool: PgPool;
  /** Ключ Inbound API → тенант до установки контекста тенанта: функция резолвера (0013), исполнять её вправе роль приложения */
  resolverPool?: PgPool;
}

/**
 * Хранилище остатков на PostgreSQL. Всё, что может выразить база, выражает база: доступный остаток — пулы минус
 * открытые резервации; публикуемое количество — одно правило (`publishedQuantity`); записи количества — через
 * `channel_write` с водяными знаками версий (`write_scope_sync_state`); отгрузка — CONSUMED, и движение ORDER_SHIPPED
 * вставляет триггер базы, а не код.
 */
export class PgStockStore implements StockStore {
  private readonly options: PgStockStoreOptions;
  constructor(options: PgStockStoreOptions) { this.options = options; }

  async stockSources(tenantId: string): Promise<StockSourceRow[]> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT s.stock_source_id, s.mode, s.name, s.status, s.created_at,
                (SELECT count(*) FROM tenant_data.stock_pool p WHERE p.tenant_id = s.tenant_id AND p.stock_source_id = s.stock_source_id AND (p.on_hand > 0 OR p.source_as_of IS NOT NULL))::int AS products,
                EXISTS (SELECT 1 FROM tenant_data.inbound_api_key k WHERE k.tenant_id = s.tenant_id AND k.stock_source_id = s.stock_source_id AND k.revoked_at IS NULL) AS has_key
           FROM tenant_data.stock_source s WHERE s.tenant_id = $1 ORDER BY s.created_at`, [tenantId]);
      return rows.map((r) => ({ stockSourceId: r.stock_source_id, mode: r.mode, name: r.name, status: r.status, createdAt: iso(r.created_at), products: Number(r.products), hasKey: r.has_key === true }));
    });
  }

  async createStockSource(tenantId: string, input: { mode: StockSourceMode; name: string }, actor: StockActor): Promise<CreateStockSourceResult> {
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        const { rows: [s] } = await tx.query(`INSERT INTO tenant_data.stock_source (tenant_id, mode, name) VALUES ($1, $2, $3) RETURNING stock_source_id`, [tenantId, input.mode, input.name]);
        if (input.mode !== 'INBOUND_API') return { status: 'CREATED', stockSourceId: s!.stock_source_id, apiKey: null };
        /**
         * Ключ показывается один раз: в базе — префикс (уникален на платформе, по нему ключ находится до контекста тенанта)
         * и SHA-256 всего ключа. Утечка базы ключей не даёт.
         */
        const prefix = `rpk_${randomBytes(6).toString('hex')}`;
        const apiKey = `${prefix}.${randomBytes(24).toString('hex')}`;
        await tx.query(`INSERT INTO tenant_data.inbound_api_key (tenant_id, stock_source_id, key_prefix, key_sha256, created_by_membership_id) VALUES ($1, $2, $3, decode($4, 'hex'), $5)`,
          [tenantId, s!.stock_source_id, prefix, createHash('sha256').update(apiKey).digest('hex'), actor.membershipId]);
        return { status: 'CREATED', stockSourceId: s!.stock_source_id, apiKey };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  async importStock(tenantId: string, stockSourceId: string, rows: readonly StockImportRow[], actor: StockActor): Promise<StockImportOutcome | { status: 'FORBIDDEN' | 'NOT_INTERNAL_POOL' }> {
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        const { rows: [source] } = await tx.query(`SELECT mode FROM tenant_data.stock_source WHERE tenant_id = $1 AND stock_source_id = $2 AND status = 'ACTIVE'`, [tenantId, stockSourceId]);
        if (!source || source.mode !== 'INTERNAL_POOL') return { status: 'NOT_INTERNAL_POOL' as const };
        const out: StockImportOutcome = { status: 'APPLIED', matched: 0, changed: 0, unmatched: [], productIds: [] };
        const seen = new Set<string>();
        // Чем продавец называет товар: артикул у канала, ссылка на товар канала, EAN, наш SKU — как у импорта себестоимости
        const { rows: targets } = await tx.query(
          `SELECT p.product_id, unnest(array_remove(ARRAY[p.sku, p.gtin, om.external_unit_id, om.external_sku, om.channel_product_ref], NULL)) AS key
             FROM tenant_data.product p LEFT JOIN tenant_data.offer_mapping om ON om.tenant_id = p.tenant_id AND om.product_id = p.product_id AND om.status = 'ACTIVE'
            WHERE p.tenant_id = $1`, [tenantId]);
        const byKey = new Map<string, string>();
        for (const t of targets) byKey.set(String(t.key), t.product_id);
        for (const r of rows) {
          if (seen.has(r.sku)) { out.unmatched.push({ sku: r.sku, reason: 'DUPLICATE_SKU' }); continue; }
          seen.add(r.sku);
          if (!Number.isSafeInteger(r.quantity) || r.quantity < 0) { out.unmatched.push({ sku: r.sku, reason: 'BAD_QUANTITY' }); continue; }
          const productId = byKey.get(r.sku);
          if (!productId) { out.unmatched.push({ sku: r.sku, reason: 'UNKNOWN_SKU' }); continue; }
          out.matched += 1;
          const { rows: [pool] } = await tx.query(
            `INSERT INTO tenant_data.stock_pool (tenant_id, stock_source_id, source_mode, product_id) VALUES ($1, $2, 'INTERNAL_POOL', $3)
             ON CONFLICT (tenant_id, stock_source_id, product_id, location_ref) DO UPDATE SET location_ref = tenant_data.stock_pool.location_ref
             RETURNING stock_pool_id, on_hand`, [tenantId, stockSourceId, productId]);
          const delta = r.quantity - Number(pool!.on_hand);
          if (delta === 0) continue;
          // Инвентаризация: внутренний пул меняется только движением [0007]; равный остаток движения не создаёт
          await tx.query(`INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, created_by_membership_id, occurred_at) VALUES ($1, $2, $3, 'STOCKTAKE', $4, now())`,
            [tenantId, pool!.stock_pool_id, delta, actor.membershipId]);
          out.changed += 1;
          out.productIds.push(productId);
        }
        return out;
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  async inboundStock(tenantId: string, stockSourceId: string, rows: readonly InboundStockRow[]): Promise<InboundStockOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const out: InboundStockOutcome = { applied: 0, stale: 0, unknownSkus: [], productIds: [] };
      for (const r of rows) {
        const { rows: [p] } = await tx.query(
          `SELECT p.product_id FROM tenant_data.product p
            WHERE p.tenant_id = $1 AND (p.sku = $2 OR p.gtin = $2 OR EXISTS (SELECT 1 FROM tenant_data.offer_mapping om WHERE om.tenant_id = p.tenant_id AND om.product_id = p.product_id
                                                                         AND om.status = 'ACTIVE' AND $2 IN (om.external_unit_id, om.external_sku, om.channel_product_ref)))
            LIMIT 1`, [tenantId, r.sku]);
        if (!p) { out.unknownSkus.push(r.sku); continue; }
        /**
         * INV-10: значение не новее известного не применяется — страж базы `stock_pool_guard` отказывает, здесь отказ
         * превращается в «устарело» без прерывания остальных строк (точка сохранения).
         */
        await tx.query('SAVEPOINT inbound_row');
        try {
          await tx.query(
            `INSERT INTO tenant_data.stock_pool (tenant_id, stock_source_id, source_mode, product_id, on_hand, source_as_of)
             VALUES ($1, $2, 'INBOUND_API', $3, $4, $5)
             ON CONFLICT (tenant_id, stock_source_id, product_id, location_ref) DO UPDATE SET on_hand = EXCLUDED.on_hand, source_as_of = EXCLUDED.source_as_of`,
            [tenantId, stockSourceId, p.product_id, r.quantity, r.asOf]);
          await tx.query('RELEASE SAVEPOINT inbound_row');
          out.applied += 1;
          out.productIds.push(p.product_id);
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT inbound_row');
          if (!/stale stock update/.test(String((error as Error).message))) throw error;
          out.stale += 1;
        }
      }
      return out;
    });
  }

  async resolveInboundKey(keyPrefix: string, keySha256Hex: string): Promise<{ tenantId: string; stockSourceId: string } | null> {
    // Функция резолвера (0013) исполняется административной ролью: ключ ищется ДО контекста тенанта
    const { rows: [r] } = await (this.options.resolverPool ?? this.options.adminPool).query(`SELECT tenant_id, stock_source_id FROM security.resolve_inbound_api_key($1, decode($2, 'hex'))`, [keyPrefix, keySha256Hex]);
    return r ? { tenantId: r.tenant_id, stockSourceId: r.stock_source_id } : null;
  }

  async enableStockSync(tenantId: string, channelAccountId: string, input: EnableStockSyncInput, actor: StockActor): Promise<EnableStockSyncResult> {
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        // Предложения, остаток которых ведём мы (MERCHANT), у этого аккаунта; идентичность единицы — по возможности канала
        const { rows: offers } = await tx.query(
          `SELECT om.offer_mapping_id, om.product_id, om.channel, om.region, om.marketplace, om.external_offer_id, om.external_sku, om.external_unit_id, om.external_listing_id, om.quantity_write_scope_id,
                  om.channel_offer_key
             FROM tenant_data.offer_mapping om
            WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT'
            ORDER BY om.created_at`, [tenantId, channelAccountId]);
        if (offers.length === 0) return { status: 'NO_OFFERS' as const };
        const channel = offers[0]!.channel as string;
        const { rows: [cap] } = await tx.query(
          `SELECT capability_id, version, write_scope_kind, write_scope_key_template, budget_scope_attribute, requires_side_effects_ack
             FROM platform.channel_capability WHERE channel = $1 AND field = 'QUANTITY' AND status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1`, [channel]);
        if (!cap) throw new Error(`no ACTIVE ${channel} QUANTITY capability`);
        // Буфер аккаунта [Р-6] — новая версия; страж базы требует его у каждой включённой единицы
        const { rows: [last] } = await tx.query(`SELECT coalesce(max(version), 0)::int AS v FROM tenant_data.stock_allocation WHERE tenant_id = $1 AND scope_type = 'CHANNEL_ACCOUNT' AND channel_account_id = $2`, [tenantId, channelAccountId]);
        await tx.query(
          `INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, max_quantity, min_quantity_to_list, is_active, version, created_by_membership_id)
           VALUES ($1, 'CHANNEL_ACCOUNT', $2, $3, $4, $5, true, $6, $7)`,
          [tenantId, channelAccountId, input.bufferUnits, input.maxQuantity, input.minQuantityToList, Number(last!.v) + 1, actor.membershipId]);
        let created = 0; let awaitingAck = 0;
        // Kaufland: единица — аккаунт + id_offer, ОБЩАЯ для витрин [Р-35]: витрины одного оффера делят одну единицу
        const scopeByKey = new Map<string, string>();
        for (const o of offers) {
          let writeScopeId: string | null = o.quantity_write_scope_id ?? null;
          const identity = { region: o.region, marketplace: o.marketplace, external_offer_id: o.external_offer_id, external_sku: o.external_sku, external_unit_id: o.external_unit_id, external_listing_id: o.external_listing_id };
          const template = cap.write_scope_key_template as string[];
          const key = template.map((k) => (k === 'channel_account' ? channelAccountId : String((identity as Record<string, unknown>)[k] ?? ''))).join('|');
          if (!writeScopeId && scopeByKey.has(key)) writeScopeId = scopeByKey.get(key)!;
          if (!writeScopeId) {
            if (template.includes('external_offer_id') && !o.external_offer_id) continue; // без id_offer единицы остатка у Kaufland нет (0027)
            const { rows: [s] } = await tx.query(
              `INSERT INTO tenant_data.write_scope
                 (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind, scope_key, status, quantity_sync_enabled, budget_scope_key)
               VALUES ($1, $2, $3, 'QUANTITY', $4, $5, $6, $7, tenant_data.derive_scope_key($8::jsonb, $9::text[]), 'ACTIVE', false, $10)
               RETURNING write_scope_id`,
              [tenantId, channelAccountId, channel, o.product_id, cap.capability_id, cap.version, cap.write_scope_kind, JSON.stringify(identity), template,
               cap.budget_scope_attribute ? (identity as Record<string, string | null>)[cap.budget_scope_attribute as string] ?? null : null]);
            writeScopeId = s!.write_scope_id;
            created += 1;
          }
          scopeByKey.set(key, writeScopeId!);
          await tx.query(`UPDATE tenant_data.offer_mapping SET quantity_write_scope_id = $3 WHERE tenant_id = $1 AND offer_mapping_id = $2 AND quantity_write_scope_id IS DISTINCT FROM $3`,
            [tenantId, o.offer_mapping_id, writeScopeId]);
          // INV-11: побочный эффект (Amazon EU — весь регион) подтверждает человек; без подтверждения единица есть, синхронизации нет
          if (cap.requires_side_effects_ack === true && !input.acknowledgeSideEffects) { awaitingAck += 1; continue; }
          await tx.query(
            `UPDATE tenant_data.write_scope SET quantity_sync_enabled = true,
                    side_effects_ack_membership_id = CASE WHEN requires_side_effects_ack THEN $3 ELSE side_effects_ack_membership_id END,
                    side_effects_ack_at = CASE WHEN requires_side_effects_ack THEN now() ELSE side_effects_ack_at END
              WHERE tenant_id = $1 AND write_scope_id = $2 AND NOT quantity_sync_enabled`, [tenantId, writeScopeId, actor.membershipId]);
        }
        return { status: 'ENABLED' as const, scopes: scopeByKey.size, created, awaitingAck };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /** Доступный остаток и буфер каждой включённой единицы QUANTITY (SQL один на все вызовы) */
  private static readonly TARGETS_SQL = `
    WITH stock AS (
      SELECT p.product_id, coalesce(sum(p.on_hand), 0)::int AS on_hand FROM tenant_data.stock_pool p WHERE p.tenant_id = $1 GROUP BY p.product_id
    ), reserved AS (
      SELECT r.product_id, coalesce(sum(r.quantity), 0)::int AS reserved FROM channel_data.reservation r
       WHERE r.tenant_id = $1 AND r.status IN ('CREATED', 'CONFIRMED_BY_SOURCE') GROUP BY r.product_id
    ), allocation AS (
      SELECT DISTINCT ON (a.channel_account_id) a.channel_account_id, a.buffer_units, a.max_quantity, a.min_quantity_to_list, a.is_active
        FROM tenant_data.stock_allocation a WHERE a.tenant_id = $1 AND a.scope_type = 'CHANNEL_ACCOUNT' ORDER BY a.channel_account_id, a.version DESC
    )
    SELECT s.write_scope_id, s.product_id, s.channel_account_id, s.quantity_sync_enabled,
           coalesce(st.on_hand, 0) AS on_hand, coalesce(rv.reserved, 0) AS reserved,
           a.buffer_units, a.max_quantity, a.min_quantity_to_list, a.is_active AS allocation_active,
           ss.last_sent_quantity, ss.latest_version_created, ss.in_flight_write_id,
           -- Последнее СОЗДАННОЕ значение (ждущее или ушедшее): повторный пересчёт без изменений не плодит версий
           coalesce((SELECT w.quantity FROM tenant_data.channel_write w WHERE w.tenant_id = s.tenant_id AND w.write_scope_id = s.write_scope_id AND w.version = ss.latest_version_created),
                    (SELECT h.quantity FROM tenant_data.channel_write_history h WHERE h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id AND h.version = ss.latest_version_created)) AS last_quantity
      FROM tenant_data.write_scope s
      LEFT JOIN stock st ON st.product_id = s.product_id
      LEFT JOIN reserved rv ON rv.product_id = s.product_id
      LEFT JOIN allocation a ON a.channel_account_id = s.channel_account_id
      LEFT JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
     WHERE s.tenant_id = $1 AND s.field = 'QUANTITY' AND s.status <> 'RETIRED'`;

  async recalculate(tenantId: string, productIds: readonly string[] | null, now: Instant): Promise<RecalculationOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const { rows } = await tx.query(`${PgStockStore.TARGETS_SQL} AND s.quantity_sync_enabled AND ($2::uuid[] IS NULL OR s.product_id = ANY($2)) ORDER BY s.write_scope_id`,
        [tenantId, productIds ? [...productIds] : null]);
      const out: RecalculationOutcome = { writes: [], unchanged: 0 };
      for (const r of rows) {
        if (r.allocation_active !== true) continue;
        const q = publishedQuantity(availableOf(Number(r.on_hand), Number(r.reserved)), { bufferUnits: Number(r.buffer_units), maxQuantity: r.max_quantity === null ? null : Number(r.max_quantity), minQuantityToList: Number(r.min_quantity_to_list) });
        if (r.last_quantity !== null && r.last_quantity !== undefined && Number(r.last_quantity) === q) { out.unchanged += 1; continue; }
        const version = Number(r.latest_version_created ?? 0) + 1;
        // Новая версия вытесняет ждущую сама (триггеры channel_write); в полёте остаётся одна запись на единицу [Р-64]
        await tx.query(
          `INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, quantity, version, origin, idempotency_key, created_at)
           VALUES ($1, $2, 'QUANTITY', $3, $4, 'STOCK_RECALC', $5, $6::timestamptz)`,
          [tenantId, r.write_scope_id, q, version, `stock:${r.write_scope_id}:${version}`, now]);
        out.writes.push({ writeScopeId: r.write_scope_id, quantity: q, version });
      }
      return out;
    });
  }

  async recordOrderLines(tenantId: string, channelAccountId: string, lines: readonly OrderLine[], now: Instant): Promise<OrderLinesOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const out: OrderLinesOutcome = { created: 0, consumed: 0, released: 0, unknownOffers: 0, productIds: [] };
      const touched = new Set<string>();
      for (const line of lines) {
        const id = line.identity;
        const { rows: [offer] } = await tx.query(
          `SELECT om.product_id, om.channel FROM tenant_data.offer_mapping om
            WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE'
              AND (($3::text IS NOT NULL AND om.external_offer_id = $3) OR ($4::text IS NOT NULL AND om.external_sku = $4) OR ($5::text IS NOT NULL AND om.external_unit_id = $5))
            LIMIT 1`, [tenantId, channelAccountId, id.externalOfferId ?? null, id.externalSku ?? null, id.externalUnitId ?? null]);
        if (!offer) { out.unknownOffers += 1; continue; }
        const { rows: [existing] } = await tx.query(
          `SELECT reservation_id, status, stock_pool_id FROM channel_data.reservation WHERE tenant_id = $1 AND channel_account_id = $2 AND channel_order_line_ref = $3 AND product_id = $4`,
          [tenantId, channelAccountId, line.externalOrderLineRef, offer.product_id]);
        if (!existing) {
          if (line.status === 'CANCELLED' || line.status === 'RETURNED') continue;
          // Пул товара с наибольшим остатком; товар без пула резервировать негде — строка ждёт остатка
          const { rows: [pool] } = await tx.query(`SELECT stock_pool_id, source_mode, stock_source_id FROM tenant_data.stock_pool WHERE tenant_id = $1 AND product_id = $2 ORDER BY on_hand DESC LIMIT 1`, [tenantId, offer.product_id]);
          if (!pool) { out.unknownOffers += 1; continue; }
          const { rows: [r] } = await tx.query(
            `INSERT INTO channel_data.reservation (tenant_id, stock_pool_id, source_mode, product_id, quantity, channel_account_id, channel, channel_order_ref, channel_order_line_ref, order_created_at, managed_listing, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'CREATED') RETURNING reservation_id`,
            [tenantId, pool.stock_pool_id, pool.source_mode, offer.product_id, line.quantity, channelAccountId, offer.channel, line.externalOrderRef, line.externalOrderLineRef, line.orderedAt]);
          out.created += 1; touched.add(offer.product_id);
          /**
           * Р-25: подтверждает источник. У внутреннего пула источник — мы сами: резервация подтверждается сразу, тем же
           * источником; у Inbound API её подтвердит вызов `confirm_reservations_by_source` с номером заказа.
           */
          if (pool.source_mode === 'INTERNAL_POOL') {
            await tx.query(`UPDATE channel_data.reservation SET status = 'CONFIRMED_BY_SOURCE', confirmed_at = now(), confirmed_by_stock_source_id = $3, confirmed_external_order_ref = $4 WHERE tenant_id = $1 AND reservation_id = $2`,
              [tenantId, r!.reservation_id, pool.stock_source_id, line.externalOrderRef]);
          }
          if (line.status === 'SHIPPED') await this.consume(tx, tenantId, r!.reservation_id, out, offer.product_id, touched);
          continue;
        }
        if (existing.status === 'CONSUMED' || existing.status === 'RELEASED') continue;
        if (line.status === 'SHIPPED' && existing.status === 'CONFIRMED_BY_SOURCE') await this.consume(tx, tenantId, existing.reservation_id, out, offer.product_id, touched);
        else if (line.status === 'CANCELLED') {
          await tx.query(`UPDATE channel_data.reservation SET status = 'RELEASED', released_at = now(), release_reason = 'ORDER_CANCELLED' WHERE tenant_id = $1 AND reservation_id = $2`, [tenantId, existing.reservation_id]);
          out.released += 1; touched.add(offer.product_id);
        }
      }
      out.productIds = [...touched];
      return out;
    });
  }

  /** Отгрузка: CONSUMED; движение ORDER_SHIPPED во внутреннем пуле вставляет триггер базы (0020), а не код */
  private async consume(tx: Tx, tenantId: string, reservationId: string, out: OrderLinesOutcome, productId: string, touched: Set<string>): Promise<void> {
    await tx.query(`UPDATE channel_data.reservation SET status = 'CONSUMED', consumed_at = now() WHERE tenant_id = $1 AND reservation_id = $2`, [tenantId, reservationId]);
    out.consumed += 1; touched.add(productId);
  }

  private static readonly CHANNEL_ROWS_SQL = `
    SELECT t.*, ca.channel,
           (SELECT array_agg(DISTINCT om.marketplace ORDER BY om.marketplace) FROM tenant_data.offer_mapping om WHERE om.tenant_id = $1 AND om.quantity_write_scope_id = t.write_scope_id) AS marketplaces,
           cap.requires_side_effects_ack, cap.side_effects, ws.side_effects_ack_at,
           lw.quantity AS sent_quantity, lw.status AS sent_status, lw.at AS sent_at, lw.version AS sent_version, lw.last_error_code AS sent_error,
           lw.finished AS sent_finished,
           ap.quantity AS confirmed_quantity, ap.accepted_at AS confirmed_at
      FROM (${'__TARGETS__'}) t
      JOIN tenant_data.write_scope ws ON ws.tenant_id = $1 AND ws.write_scope_id = t.write_scope_id
      JOIN tenant_data.channel_account ca ON ca.tenant_id = $1 AND ca.channel_account_id = t.channel_account_id
      JOIN platform.channel_capability cap ON cap.capability_id = ws.capability_id AND cap.version = ws.capability_version
      LEFT JOIN LATERAL (
        SELECT u.quantity, u.status, u.at, u.version, u.last_error_code, u.finished FROM (
          SELECT w.quantity, w.status, coalesce(w.accepted_at, w.dispatched_at, w.created_at) AS at, w.version, w.last_error_code, false AS finished
            FROM tenant_data.channel_write w WHERE w.tenant_id = $1 AND w.write_scope_id = t.write_scope_id AND w.field = 'QUANTITY'
          UNION ALL
          SELECT h.quantity, h.final_status, coalesce(h.accepted_at, h.dispatched_at, h.created_at), h.version, h.last_error_code, true
            FROM tenant_data.channel_write_history h WHERE h.tenant_id = $1 AND h.write_scope_id = t.write_scope_id AND h.field = 'QUANTITY'
        ) u ORDER BY u.version DESC LIMIT 1) lw ON true
      LEFT JOIN LATERAL (
        SELECT h.quantity, h.accepted_at FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = $1 AND h.write_scope_id = t.write_scope_id AND h.field = 'QUANTITY' AND h.final_status = 'APPLIED'
         ORDER BY h.version DESC LIMIT 1) ap ON true`;

  private channelRow(r: Row): StockChannelRow {
    const allocation = { bufferUnits: Number(r.buffer_units ?? 0), maxQuantity: r.max_quantity === null || r.max_quantity === undefined ? null : Number(r.max_quantity), minQuantityToList: Number(r.min_quantity_to_list ?? 0) };
    const finishedNotApplied = r.sent_finished === true && r.sent_status !== 'APPLIED' && r.sent_status !== 'SUPERSEDED';
    return {
      writeScopeId: r.write_scope_id, channelAccountId: r.channel_account_id, channel: r.channel, marketplaces: (r.marketplaces ?? []) as string[],
      syncEnabled: r.quantity_sync_enabled === true,
      published: publishedQuantity(availableOf(Number(r.on_hand), Number(r.reserved)), allocation),
      sent: r.sent_quantity === null || r.sent_quantity === undefined ? null : { quantity: Number(r.sent_quantity), status: r.sent_status, at: iso(r.sent_at), version: Number(r.sent_version) },
      confirmed: r.confirmed_quantity === null || r.confirmed_quantity === undefined ? null : { quantity: Number(r.confirmed_quantity), at: iso(r.confirmed_at) },
      divergence: finishedNotApplied ? { status: r.sent_status, since: iso(r.sent_at), errorCode: r.sent_error ?? null } : null,
      sideEffects: { requiresAck: r.requires_side_effects_ack === true, acknowledged: r.side_effects_ack_at !== null && r.side_effects_ack_at !== undefined, text: r.side_effects ?? null },
    };
  }

  async stockPage(tenantId: string, query: { offset: number; limit: number }): Promise<StockPage> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      // Страница товаров — по каталогу (единицы записи цены и остатка — предложения), итог и сводка — агрегатом [Р-154]
      const { rows: products } = await tx.query(
        `SELECT p.product_id, p.sku, p.gtin,
                coalesce((SELECT sum(sp.on_hand) FROM tenant_data.stock_pool sp WHERE sp.tenant_id = p.tenant_id AND sp.product_id = p.product_id), 0)::int AS on_hand,
                coalesce((SELECT sum(r.quantity) FROM channel_data.reservation r WHERE r.tenant_id = p.tenant_id AND r.product_id = p.product_id AND r.status IN ('CREATED', 'CONFIRMED_BY_SOURCE')), 0)::int AS reserved
           FROM tenant_data.product p WHERE p.tenant_id = $1 ORDER BY p.sku, p.product_id LIMIT $2 OFFSET $3`, [tenantId, query.limit, query.offset]);
      const ids = products.map((p) => p.product_id as string);
      const { rows: channels } = ids.length === 0 ? { rows: [] as Row[] } : await tx.query(
        PgStockStore.CHANNEL_ROWS_SQL.replace('__TARGETS__', `${PgStockStore.TARGETS_SQL} AND s.product_id = ANY($2::uuid[])`) + ' ORDER BY ca.channel, t.write_scope_id', [tenantId, ids]);
      const byProduct = new Map<string, StockChannelRow[]>();
      for (const c of channels) byProduct.set(c.product_id, [...(byProduct.get(c.product_id) ?? []), this.channelRow(c)]);
      const items: StockRow[] = products.map((p) => ({
        productId: p.product_id, sku: p.sku, gtin: p.gtin ?? null, onHand: Number(p.on_hand), reserved: Number(p.reserved), available: availableOf(Number(p.on_hand), Number(p.reserved)),
        channels: byProduct.get(p.product_id) ?? [],
      }));
      const { rows: [s] } = await tx.query(
        `SELECT (SELECT count(*) FROM tenant_data.product p WHERE p.tenant_id = $1)::int AS products,
                (SELECT count(DISTINCT sp.product_id) FROM tenant_data.stock_pool sp WHERE sp.tenant_id = $1 AND sp.on_hand > 0)::int AS with_stock,
                (SELECT count(*) FROM tenant_data.write_scope s WHERE s.tenant_id = $1 AND s.field = 'QUANTITY' AND s.status <> 'RETIRED' AND s.quantity_sync_enabled)::int AS synced,
                (SELECT count(*) FROM tenant_data.channel_write w WHERE w.tenant_id = $1 AND w.field = 'QUANTITY' AND w.status IN ('PENDING', 'DISPATCHED', 'ACCEPTED', 'FAILED', 'BLOCKED'))::int AS pending,
                (SELECT count(*) FROM channel_data.reservation r WHERE r.tenant_id = $1 AND r.status IN ('CREATED', 'CONFIRMED_BY_SOURCE'))::int AS open_reservations,
                (SELECT count(*) FROM tenant_data.write_scope_sync_state ss JOIN tenant_data.write_scope s ON s.tenant_id = ss.tenant_id AND s.write_scope_id = ss.write_scope_id
                  WHERE ss.tenant_id = $1 AND s.field = 'QUANTITY' AND ss.latest_version_dispatched > 0 AND ss.in_flight_write_id IS NULL AND ss.latest_version_applied < ss.latest_version_dispatched)::int AS diverged`,
        [tenantId]);
      return {
        items, total: Number(s!.products),
        summary: { products: Number(s!.products), withStock: Number(s!.with_stock), synced: Number(s!.synced), pendingWrites: Number(s!.pending), diverged: Number(s!.diverged), openReservations: Number(s!.open_reservations) },
      };
    });
  }

  async stockDivergences(tenantId: string, limit: number): Promise<StockDivergenceRow[]> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      // Расхождение: последняя отправленная версия завершена НЕ применением — по водяным знакам, затем подробности строки
      const { rows } = await tx.query(
        PgStockStore.CHANNEL_ROWS_SQL.replace('__TARGETS__', `${PgStockStore.TARGETS_SQL} AND ss.latest_version_dispatched > 0 AND ss.in_flight_write_id IS NULL AND ss.latest_version_applied < ss.latest_version_dispatched`)
        + ` ORDER BY lw.at DESC LIMIT $2`, [tenantId, limit]);
      const { rows: skus } = await tx.query(`SELECT product_id, sku FROM tenant_data.product WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`, [tenantId, rows.map((r) => r.product_id)]);
      const skuOf = new Map(skus.map((s) => [s.product_id, s.sku as string]));
      return rows.map((r) => {
        const c = this.channelRow(r);
        return { writeScopeId: c.writeScopeId, productId: r.product_id, sku: skuOf.get(r.product_id) ?? '', channel: c.channel, marketplaces: c.marketplaces,
          sent: c.sent?.quantity ?? 0, confirmed: c.confirmed?.quantity ?? null, status: c.sent?.status ?? 'UNKNOWN', errorCode: c.divergence?.errorCode ?? null, since: c.sent?.at ?? iso(new Date()) };
      });
    });
  }
}

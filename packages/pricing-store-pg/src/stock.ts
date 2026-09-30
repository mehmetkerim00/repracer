import { createHash, randomBytes } from 'node:crypto';
import { systemClock } from '@repracer/channel-port';
import type { Instant, OrderLine } from '@repracer/channel-port';
import {
  type AnswerOtherToolsResult, type ConfirmOrdersOutcome, type ConfirmQuantityWritesResult, type DecideReturnOutcome, type QuantityWritesState, type OrderReturnRow, type OtherTools,
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
        /**
         * Один ключ — один товар. Артикул, подошедший ДВУМ товарам (чужой EAN в графе артикула, два активных предложения),
         * не применяется вовсе: количество, ушедшее не тому товару, дороже пропущенной строки [Р-138].
         */
        const byKey = new Map<string, string | null>();
        for (const t of targets) {
          const key = String(t.key);
          const known = byKey.get(key);
          byKey.set(key, known === undefined || known === t.product_id ? t.product_id : null);
        }
        for (const r of rows) {
          if (seen.has(r.sku)) { out.unmatched.push({ sku: r.sku, reason: 'DUPLICATE_SKU' }); continue; }
          seen.add(r.sku);
          if (!Number.isSafeInteger(r.quantity) || r.quantity < 0) { out.unmatched.push({ sku: r.sku, reason: 'BAD_QUANTITY' }); continue; }
          const productId = byKey.get(r.sku);
          if (productId === undefined) { out.unmatched.push({ sku: r.sku, reason: 'UNKNOWN_SKU' }); continue; }
          if (productId === null) { out.unmatched.push({ sku: r.sku, reason: 'AMBIGUOUS_SKU' }); continue; }
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
      const out: InboundStockOutcome = { applied: 0, stale: 0, unknownSkus: [], productIds: [], recognizedProductIds: [] };
      for (const r of rows) {
        const { rows: [p] } = await tx.query(
          `SELECT p.product_id FROM tenant_data.product p
            WHERE p.tenant_id = $1 AND (p.sku = $2 OR p.gtin = $2 OR EXISTS (SELECT 1 FROM tenant_data.offer_mapping om WHERE om.tenant_id = p.tenant_id AND om.product_id = p.product_id
                                                                         AND om.status = 'ACTIVE' AND $2 IN (om.external_unit_id, om.external_sku, om.channel_product_ref)))
            LIMIT 1`, [tenantId, r.sku]);
        if (!p) { out.unknownSkus.push(r.sku); continue; }
        out.recognizedProductIds.push(p.product_id);
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
        const { rows: [acc] } = await tx.query(`SELECT channel, quantity_writes_confirmed, other_tools FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2`, [tenantId, channelAccountId]);
        if (!acc) return { status: 'NO_OFFERS' as const };
        // Шаг 60 [Р-202]: запись количества выключена, пока владелец не подтвердил, что другие инструменты количество здесь не ведут (страж — база)
        if (!acc.quantity_writes_confirmed) return { status: 'NOT_CONFIRMED' as const, otherTools: (acc.other_tools as OtherTools | null) ?? null };
        const { rows: [cap] } = await tx.query(
          `SELECT capability_id, version, write_scope_kind, write_scope_key_template, budget_scope_attribute, requires_side_effects_ack
             FROM platform.channel_capability WHERE channel = $1 AND field = 'QUANTITY' AND status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1`, [acc.channel]);
        if (!cap) throw new Error(`no ACTIVE ${acc.channel} QUANTITY capability`);
        const template = cap.write_scope_key_template as string[];
        const { rows: [n] } = await tx.query(
          `SELECT count(*)::int AS offers FROM tenant_data.offer_mapping om WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT'`,
          [tenantId, channelAccountId]);
        if (Number(n!.offers) === 0) return { status: 'NO_OFFERS' as const };
        // Буфер аккаунта [Р-6] — новая версия; страж базы требует его у каждой включённой единицы
        await tx.query(
          `INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, max_quantity, min_quantity_to_list, is_active, version, created_by_membership_id)
           VALUES ($1, 'CHANNEL_ACCOUNT', $2, $3, $4, $5, true,
                   (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.stock_allocation WHERE tenant_id = $1 AND scope_type = 'CHANNEL_ACCOUNT' AND channel_account_id = $2), $6)`,
          [tenantId, channelAccountId, input.bufferUnits, input.maxQuantity, input.minQuantityToList, actor.membershipId]);
        /**
         * Единицы записи QUANTITY — одним оператором на все предложения: у Kaufland витрины одного id_offer делят ОДНУ
         * единицу [Р-35], поэтому ключ единицы считается по шаблону возможности канала и берётся по одному на ключ. Предложение
         * без атрибута ключа (Kaufland без id_offer, 0027) единицы не получает — и остаток у него не синхронизируется.
         */
        const identitySql = `jsonb_build_object('region', om.region, 'marketplace', om.marketplace, 'external_offer_id', om.external_offer_id, 'external_sku', om.external_sku,
                                                'external_unit_id', om.external_unit_id, 'external_listing_id', om.external_listing_id)`;
        const keyAttrs = template.filter((k) => k !== 'channel_account');
        const keyPresent = keyAttrs.map((k) => `om.${k} IS NOT NULL`).join(' AND ') || 'true';
        const { rows: [ins] } = await tx.query(
          `WITH candidates AS (
             SELECT DISTINCT ON (tenant_data.derive_scope_key(${identitySql}, $6::text[])) om.product_id, ${identitySql} AS identity
               FROM tenant_data.offer_mapping om
              WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT'
                AND om.quantity_write_scope_id IS NULL AND ${keyPresent}
                AND NOT EXISTS (SELECT 1 FROM tenant_data.write_scope s WHERE s.tenant_id = om.tenant_id AND s.channel_account_id = om.channel_account_id AND s.field = 'QUANTITY'
                                  AND s.scope_key = tenant_data.derive_scope_key(${identitySql}, $6::text[]))
              ORDER BY tenant_data.derive_scope_key(${identitySql}, $6::text[]), om.created_at),
           created AS (
             INSERT INTO tenant_data.write_scope
               (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind, scope_key, status, quantity_sync_enabled, budget_scope_key)
             SELECT $1, $2, $3, 'QUANTITY', c.product_id, $4, $5, $7, tenant_data.derive_scope_key(c.identity, $6::text[]), 'ACTIVE', false,
                    CASE WHEN $8::text IS NULL THEN NULL ELSE c.identity ->> $8 END
               FROM candidates c
             RETURNING write_scope_id)
           SELECT count(*)::int AS n FROM created`,
          [tenantId, channelAccountId, acc.channel, cap.capability_id, cap.version, template, cap.write_scope_kind, cap.budget_scope_attribute ?? null]);
        // Предложения ссылаются на свою единицу — и новые, и те, чья единица уже была (повторное включение)
        await tx.query(
          `UPDATE tenant_data.offer_mapping om SET quantity_write_scope_id = s.write_scope_id
             FROM tenant_data.write_scope s
            WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT' AND om.quantity_write_scope_id IS NULL
              AND s.tenant_id = om.tenant_id AND s.channel_account_id = om.channel_account_id AND s.field = 'QUANTITY' AND s.status <> 'RETIRED'
              AND s.scope_key = tenant_data.derive_scope_key(${identitySql}, $3::text[])`, [tenantId, channelAccountId, template]);
        const { rows: [scopes] } = await tx.query(
          `SELECT count(*)::int AS n FROM tenant_data.write_scope s WHERE s.tenant_id = $1 AND s.channel_account_id = $2 AND s.field = 'QUANTITY' AND s.status <> 'RETIRED'`, [tenantId, channelAccountId]);
        // INV-11: побочный эффект (Amazon EU — весь регион) подтверждает человек; без подтверждения единицы есть, синхронизации нет
        if (cap.requires_side_effects_ack === true && !input.acknowledgeSideEffects) return { status: 'ENABLED' as const, scopes: Number(scopes!.n), created: Number(ins!.n), awaitingAck: Number(scopes!.n) };
        await tx.query(
          `UPDATE tenant_data.write_scope SET quantity_sync_enabled = true,
                  side_effects_ack_membership_id = CASE WHEN requires_side_effects_ack THEN $3 ELSE side_effects_ack_membership_id END,
                  side_effects_ack_at = CASE WHEN requires_side_effects_ack THEN now() ELSE side_effects_ack_at END
            WHERE tenant_id = $1 AND channel_account_id = $2 AND field = 'QUANTITY' AND status <> 'RETIRED' AND NOT quantity_sync_enabled`, [tenantId, channelAccountId, actor.membershipId]);
        return { status: 'ENABLED' as const, scopes: Number(scopes!.n), created: Number(ins!.n), awaitingAck: 0 };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /**
   * Шаг 52 (п. 8): день бюджета записи `h` уже прошёл по поясу её витрины — бюджет правок обновился [Р-19, Р-65]. У боевой записи день есть
   * всегда (Р-188: без подтверждённой границы суток записи с бюджетом не создаются), у теневой его нет — и она никогда не BUDGET_EXHAUSTED
   */
  private static readonly BUDGET_DAY_PASSED_SQL = `(
      -- Ревью шага 52, находка 2: канал (второй слой eBay — скользящие 24 часа) назвал, когда бюджет обновится, — это время прошло.
      -- Шаг 55 (ревью шага 53, находка 6): ИЛИ-ИЛИ по источнику отказа — названное каналом время решает само; смена суток витрины не
      -- обновляет окно канала, которое ещё не прошло (иначе в полночь — лишний цикл отказа)
      (h.end_params ->> 'resetsAt') IS NOT NULL AND (h.end_params ->> 'resetsAt')::timestamptz <= now()
      OR (h.end_params ->> 'resetsAt') IS NULL AND h.budget_day IS NOT NULL AND h.budget_day < (
      SELECT (now() AT TIME ZONE m.time_zone)::date FROM tenant_data.offer_mapping om
        JOIN platform.marketplace m ON m.channel = s.channel AND m.marketplace = om.marketplace
       WHERE om.tenant_id = s.tenant_id AND om.quantity_write_scope_id = s.write_scope_id AND m.time_zone IS NOT NULL
       ORDER BY om.created_at LIMIT 1))`;

  /** Доступный остаток и буфер каждой включённой единицы QUANTITY (SQL один на все вызовы) */
  /**
   * Шаг 59 [Р-200]: что вычитается из пула как зарезервированное — открытые резервации И отгруженные по источнику Inbound API, пока источник
   * не прислал остаток с `asOf` позже подтверждения заказа. Остаток источника не наш [Р-6]: при отгрузке мы его не уменьшаем, но и не даём
   * доступному вырасти на уехавший товар до его присылки. Одно условие — во всех местах, где считается «зарезервировано»
   */
  static readonly RESERVED_SQL = `(r.status IN ('CREATED', 'CONFIRMED_BY_SOURCE')
    OR r.status = 'CONSUMED' AND r.source_mode = 'INBOUND_API'
       AND NOT EXISTS (SELECT 1 FROM tenant_data.stock_pool sp WHERE sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id
                         AND sp.source_as_of > r.confirmed_at))`;

  private static readonly TARGETS_SQL = `
    WITH stock AS (
      SELECT p.product_id, coalesce(sum(p.on_hand), 0)::int AS on_hand FROM tenant_data.stock_pool p WHERE p.tenant_id = $1 GROUP BY p.product_id
    ), reserved AS (
      SELECT r.product_id, coalesce(sum(r.quantity), 0)::int AS reserved FROM channel_data.reservation r
       WHERE r.tenant_id = $1 AND ${PgStockStore.RESERVED_SQL} GROUP BY r.product_id
    ), allocation AS (
      SELECT DISTINCT ON (a.channel_account_id) a.channel_account_id, a.buffer_units, a.max_quantity, a.min_quantity_to_list, a.is_active
        FROM tenant_data.stock_allocation a WHERE a.tenant_id = $1 AND a.scope_type = 'CHANNEL_ACCOUNT' ORDER BY a.channel_account_id, a.version DESC
    )
    SELECT s.write_scope_id, s.product_id, s.channel_account_id, s.quantity_sync_enabled,
           coalesce(st.on_hand, 0) AS on_hand, coalesce(rv.reserved, 0) AS reserved,
           a.buffer_units, a.max_quantity, a.min_quantity_to_list, a.is_active AS allocation_active,
           ss.last_sent_quantity, ss.latest_version_created, ss.in_flight_write_id,
           -- Последнее СОЗДАННОЕ значение (ждущее или ушедшее): повторный пересчёт без изменений не плодит версий.
           -- Ревью шага 51, находки 2–3: версия, которую канал отверг или не применил (DISCARDED_STALE, NOT_APPLIED), значением канала не стала —
           -- она не считается «уже созданной», и пересчёт создаёт новую версию того же количества. Иначе после отказа (у eBay — любой 4xx на
           -- значение, шаг 51) количество в канале застревало до следующего изменения остатка
           coalesce((SELECT w.quantity FROM tenant_data.channel_write w WHERE w.tenant_id = s.tenant_id AND w.write_scope_id = s.write_scope_id AND w.version = ss.latest_version_created),
                    /**
                     * Последняя версия в истории считается значением канала, если она ДОШЛА до канала (APPLIED), упёрлась в бюджет, который ещё
                     * не обновился (новая запись ушла бы в тот же исчерпанный бюджет), или удержана тенью, ПОКА аккаунт в тени. Шаг 54 (ревью
                     * шага 53, находка 5): после перевода в бой удержанная тенью версия значением канала не является — канал её не видел.
                     */
                    (SELECT h.quantity FROM tenant_data.channel_write_history h WHERE h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id
                        AND h.field = 'QUANTITY' AND h.version = ss.latest_version_created
                        AND (h.final_status = 'APPLIED'
                             OR h.final_status = 'SHADOW_HELD' AND EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                                  WHERE ca.tenant_id = s.tenant_id AND ca.channel_account_id = s.channel_account_id AND ca.write_mode = 'SHADOW')
                             OR h.final_status = 'BUDGET_EXHAUSTED' AND NOT ${PgStockStore.BUDGET_DAY_PASSED_SQL})),
                    /**
                     * Шаг 53 (ревью шага 52, находка 11): иначе — последняя ПРИМЕНЁННАЯ версия, то есть то, что канал держит. Шаг 54 (ревью шага 53,
                     * находка 4): только если КАЖДАЯ версия после неё до канала точно не дошла. Шаг 55 (ревью шага 54, находка 1): «точно не дошла» —
                     * не отправлялась вовсе ИЛИ была ровно ОДНА попытка и канал ответил на неё отказом 4xx, не приняв: после 5xx или таймаута запрос
                     * мог примениться, и следующий 4xx этого не отменяет. Иначе значение канала неизвестно (NULL), и запись создаётся — уменьшение
                     * остатка не блокируется никогда [инвариант 5]. Ревью шага 54, находка 3: сравнивается только ПОСЛЕДНЯЯ применённая версия
                     * (одна строка по индексу 0148), а не перебор всех применённых
                     */
                    (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tenant_data.channel_write_history x
                                   WHERE x.tenant_id = s.tenant_id AND x.write_scope_id = s.write_scope_id AND x.field = 'QUANTITY' AND x.version > a.version
                                     AND NOT (x.dispatched_at IS NULL
                                              OR x.final_status = 'DISCARDED_STALE' AND x.accepted_at IS NULL AND x.attempt_count = 1
                                                 AND x.end_reason = 'WRITE_NOT_ACCEPTED_BY_CHANNEL'
                                                 AND (x.end_params ->> 'httpStatus')::int BETWEEN 400 AND 499))
                                 THEN a.quantity END
                       FROM (SELECT h.quantity, h.version FROM tenant_data.channel_write_history h
                              WHERE h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id AND h.field = 'QUANTITY' AND h.final_status = 'APPLIED'
                              ORDER BY h.version DESC LIMIT 1) a)) AS last_quantity
      FROM tenant_data.write_scope s
      LEFT JOIN stock st ON st.product_id = s.product_id
      LEFT JOIN reserved rv ON rv.product_id = s.product_id
      LEFT JOIN allocation a ON a.channel_account_id = s.channel_account_id
      LEFT JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
     WHERE s.tenant_id = $1 AND s.field = 'QUANTITY' AND s.status <> 'RETIRED'`;

  /**
   * Публикуемое количество в SQL — то же правило, что `publishedQuantity` (§3.27); равенство двух записей правила
   * утверждает тест хранилища: у каждой единицы страницы `published` (код) равен количеству созданной записи (SQL).
   */
  private static readonly PUBLISHED_SQL = `
    CASE WHEN least(greatest(0, greatest(0, on_hand - reserved) - buffer_units), coalesce(max_quantity, 2147483647)) < min_quantity_to_list THEN 0
         ELSE least(greatest(0, greatest(0, on_hand - reserved) - buffer_units), coalesce(max_quantity, 2147483647)) END`;

  /**
   * `now` базе не нужен: время строки записи ставит триггер `channel_write_before_insert` часами базы, и переданное
   * значение он перезаписал бы (находка 21 ревью шага 35 — параметр уходил в столбец и ни на что не влиял). Параметр
   * остаётся в порте для хранилища в памяти, у которого своих часов нет.
   */
  async recalculate(tenantId: string, productIds: readonly string[] | null, _now: Instant, options: { lockTimeoutMs?: number } = {}): Promise<RecalculationOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      /**
       * Шаг 59 (ревью шага 58, находка 3): ожидающий пересчёт держит соединение пула; у Inbound API (синхронный запрос склада, пул консоли
       * на два соединения) ожидание ограничено — отказ `55P03` становится 503 с Retry-After, а не очередью, занявшей пул всех тенантов
       */
      if (options.lockTimeoutMs !== undefined) await tx.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.trunc(options.lockTimeoutMs))}ms'`);
      /**
       * Шаг 58 (ревью шага 57, находка 1): пересчёты тенанта идут ПО ОЧЕРЕДИ. Работа заказов, Inbound API (`propagate`), импорт остатков и
       * включение синхронизации считали следующую версию записи одной единицы из одной и той же «последней»; проигравший получал отказ
       * триггера «version … is not greater», а повтор его запроса видел строку уже учтённой и не пересчитывал ничего — завышенное количество
       * оставалось в канале. Блокировка транзакции на тенанта: второй пересчёт ждёт первого и затем читает свежий снимок (READ COMMITTED,
       * новый оператор). Одна блокировка, а не по единицам: взаимоблокировки пересекающихся наборов нет. Длительность — замер задания long
       * (`bulk-dispatch.pg.test.ts`: пересчёт 10 000 единиц без изменений и с 10 000 изменений)
       */
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('repracer.stock_recalculate:' || $1::text, 0))", [tenantId]);
      // Одним оператором на все изменившиеся единицы: новая версия вытесняет ждущую сама (триггеры channel_write) [Р-64]
      const { rows } = await tx.query(
        `WITH t AS (${PgStockStore.TARGETS_SQL} AND s.quantity_sync_enabled AND ($2::uuid[] IS NULL OR s.product_id = ANY($2))),
         target AS (SELECT t.write_scope_id, t.last_quantity, coalesce(t.latest_version_created, 0) + 1 AS version, ${PgStockStore.PUBLISHED_SQL} AS q FROM t WHERE t.allocation_active),
         created AS (
           INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, quantity, version, origin, idempotency_key)
           -- Время строки ставит триггер channel_write_before_insert часами базы
          SELECT $1, g.write_scope_id, 'QUANTITY', g.q, g.version, 'STOCK_RECALC', 'stock:' || g.write_scope_id || ':' || g.version
             FROM target g WHERE g.last_quantity IS NULL OR g.last_quantity <> g.q
           RETURNING write_scope_id, quantity, version)
         SELECT (SELECT json_agg(json_build_object('writeScopeId', c.write_scope_id, 'quantity', c.quantity, 'version', c.version)) FROM created c) AS writes,
                (SELECT count(*) FROM target g WHERE g.last_quantity = g.q)::int AS unchanged`,
        [tenantId, productIds ? [...productIds] : null]);
      const r = rows[0]!;
      return { writes: ((r.writes ?? []) as Array<{ writeScopeId: string; quantity: number; version: number }>).map((w) => ({ ...w, quantity: Number(w.quantity), version: Number(w.version) })), unchanged: Number(r.unchanged) };
    });
  }

  /**
   * Р-157 (шаг 36, OQ-217): источник Inbound API сообщает «заказ учтён» — резервации этого заказа переходят в
   * CONFIRMED_BY_SOURCE функцией базы `confirm_reservations_by_source` (она же сверяет, что пул принадлежит источнику).
   * Повтор вызова безвреден: уже подтверждённые заказы названы отдельно, как и заказы, которых у источника нет.
   */
  async confirmInboundOrders(tenantId: string, stockSourceId: string, orderRefs: readonly string[]): Promise<ConfirmOrdersOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const out: ConfirmOrdersOutcome = { confirmed: 0, alreadyConfirmed: [], releasedOrders: [], unknownOrders: [] };
      // Повтор одного номера в одном запросе — один заказ, а не два [находка 27 ревью шага 36]
      for (const ref of [...new Set(orderRefs)]) {
        const { rows: [r] } = await tx.query(`SELECT channel_data.confirm_reservations_by_source($1, $2) AS n`, [stockSourceId, ref]);
        const n = Number(r!.n);
        if (n > 0) { out.confirmed += n; continue; }
        // Ноль подтверждённых — либо заказ уже закрыт, либо его резерваций у этого источника нет; продавцу это разные вещи
        /**
         * Ноль подтверждённых — три РАЗНЫХ случая, и складу они не одно и то же [находка 8 ревью шага 36]: заказ уже
         * подтверждён (и, может быть, списан), его резерв СНЯТ (отменён или освобождён по сроку — товар мог уйти
         * другому покупателю), или резерваций этого заказа у источника нет вовсе.
         */
        const { rows: [known] } = await tx.query(
          `SELECT count(*) FILTER (WHERE r.status IN ('CONFIRMED_BY_SOURCE', 'CONSUMED'))::int AS confirmed,
                  count(*) FILTER (WHERE r.status = 'RELEASED')::int AS released
             FROM channel_data.reservation r JOIN tenant_data.stock_pool sp
                  ON sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id
            WHERE r.tenant_id = $1 AND r.channel_order_ref = $2 AND sp.stock_source_id = $3`, [tenantId, ref, stockSourceId]);
        if (Number(known!.confirmed) > 0) out.alreadyConfirmed.push(ref);
        else if (Number(known!.released) > 0) out.releasedOrders.push(ref);
        else out.unknownOrders.push(ref);
      }
      return out;
    });
  }

  /**
   * Шаг 52 (п. 8): товары аккаунта, у которых последняя запись количества упёрлась в бюджет правок прошлого дня витрины, и (шаг 54)
   * удержана тенью, когда аккаунт уже в бою. Их пересчитывает работа чтения заказов — значение уходит в канал без новых заказов,
   * а не ждёт изменения остатка
   */
  async budgetRolledOverProducts(tenantId: string, channelAccountId: string): Promise<string[]> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      /**
       * Ревью шага 54, находка 2: товар берётся, только если его цель ОТЛИЧАЕТСЯ от того, что держит канал. Без этого товар, у которого
       * цель совпала с прежним применённым значением, пересчитывался каждые 5 минут бессрочно (новой версии нет — последняя так и
       * остаётся удержанной тенью), а у аккаунта из тени это весь каталог
       */
      const { rows } = await tx.query(
        `WITH candidates AS (
           SELECT s.write_scope_id FROM tenant_data.write_scope s
             JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
             JOIN tenant_data.channel_write_history h ON h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id
                  AND h.field = 'QUANTITY' AND h.version = ss.latest_version_created
            WHERE s.tenant_id = $1 AND s.channel_account_id = $2 AND s.field = 'QUANTITY' AND s.quantity_sync_enabled AND s.status <> 'RETIRED'
              AND (h.final_status = 'BUDGET_EXHAUSTED' AND ${PgStockStore.BUDGET_DAY_PASSED_SQL}
                   -- Шаг 54 (ревью шага 53, находка 5): аккаунт переведён в бой, а последняя версия удержана тенью — канал её не видел
                   OR h.final_status = 'SHADOW_HELD' AND EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                        WHERE ca.tenant_id = s.tenant_id AND ca.channel_account_id = s.channel_account_id AND ca.write_mode = 'LIVE'))
         )
         -- Ревью шага 55, находка 7: цели — только кандидатов (внутри подзапроса, а не по всему каталогу тенанта) и только с включённым
         -- распределением: при выключенном пересчёт (recalculate) записи не создаёт, и товар возвращался бы каждые 5 минут бессрочно
         SELECT DISTINCT t.product_id FROM (${PgStockStore.TARGETS_SQL} AND s.write_scope_id IN (SELECT write_scope_id FROM candidates)) t
          WHERE t.allocation_active AND t.in_flight_write_id IS NULL
            AND t.last_quantity IS DISTINCT FROM (${PgStockStore.PUBLISHED_SQL})`, [tenantId, channelAccountId]);
      return rows.map((r) => String(r.product_id));
    });
  }

  async quantityWritesState(tenantId: string, channelAccountId: string): Promise<QuantityWritesState | null> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      const { rows: [a] } = await tx.query(`SELECT external_account_id, other_tools, quantity_writes_confirmed FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2`,
        [tenantId, channelAccountId]);
      return a ? { externalAccountId: String(a.external_account_id), otherTools: (a.other_tools as OtherTools | null) ?? null, confirmed: a.quantity_writes_confirmed === true } : null;
    });
  }

  /** Шаг 60 [Р-202]: ответ владельца о других инструментах канала; автор и время ставит база, противоречие подтверждению отклоняет она же */
  async answerOtherTools(tenantId: string, channelAccountId: string, answer: OtherTools, actor: StockActor): Promise<AnswerOtherToolsResult> {
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        const { rowCount } = await tx.query(`UPDATE tenant_data.channel_account SET other_tools = $3 WHERE tenant_id = $1 AND channel_account_id = $2`, [tenantId, channelAccountId, answer]);
        return rowCount ? { status: 'ANSWERED' as const } : { status: 'NOT_FOUND' as const };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      const message = String((error as Error).message ?? '');
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      if (/would make two writers/.test(message)) return { status: 'CONFLICT', reason: 'QUANTITY_WRITES_CONFIRMED' };
      throw error;
    }
  }

  /** Шаг 60 [Р-202]: подтверждение записи количества — строка журнала; кто, чем и после какого ответа — проверяет база, её отказы разобраны */
  async confirmQuantityWrites(tenantId: string, channelAccountId: string, typedConfirmation: string, actor: StockActor): Promise<ConfirmQuantityWritesResult> {
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        const { rows: [a] } = await tx.query(`SELECT quantity_writes_confirmed FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2`, [tenantId, channelAccountId]);
        if (!a) return { status: 'NOT_FOUND' as const };
        if (a.quantity_writes_confirmed) return { status: 'ALREADY_CONFIRMED' as const };
        await tx.query(
          `INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id) VALUES ($1, $2, $3, $4)`,
          [tenantId, channelAccountId, typedConfirmation, actor.membershipId]);
        return { status: 'CONFIRMED' as const };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      const message = String((error as Error).message ?? '');
      if (/only the owner confirms/.test(message)) return { status: 'NOT_OWNER' };
      if (/does not name the channel account/.test(message)) return { status: 'CONFIRMATION_MISMATCH' };
      if (/answer first whether another tool/.test(message)) return { status: 'ANSWER_FIRST' };
      if (/another tool updates stock in this channel/.test(message)) return { status: 'OTHER_TOOL_MANAGES_STOCK' };
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /** Шаг 59 [Р-199]: возвраты тенанта — ждущие решения первыми */
  async listReturns(tenantId: string, limit: number): Promise<OrderReturnRow[]> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT o.order_return_id, o.product_id, p.sku, o.channel, o.channel_order_line_ref, o.quantity, o.source_mode, o.status, o.reported_at, o.decided_at, o.note
           FROM channel_data.order_return o JOIN tenant_data.product p ON p.tenant_id = o.tenant_id AND p.product_id = o.product_id
          WHERE o.tenant_id = $1
          ORDER BY (o.status = 'PENDING') DESC, o.reported_at DESC LIMIT $2`, [tenantId, Math.max(1, Math.min(limit, 500))]);
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)) as Instant;
      return rows.map((r) => ({
        orderReturnId: String(r.order_return_id), productId: String(r.product_id), sku: String(r.sku), channel: String(r.channel),
        channelOrderLineRef: String(r.channel_order_line_ref), quantity: Number(r.quantity), sourceMode: String(r.source_mode),
        status: r.status as OrderReturnRow['status'], reportedAt: iso(r.reported_at), decidedAt: r.decided_at ? iso(r.decided_at) : null, note: (r.note as string | null) ?? null,
      }));
    });
  }

  /**
   * Шаг 59 [Р-199]: «принять на склад» — движение RETURN во внутренний пул возврата на его количество, с автором; «не принимать» — только
   * решение. Одна транзакция: движение без решения или решение без движения база не примет (страж 0156). Права — MANAGE_CATALOG у базы
   */
  async decideReturn(tenantId: string, orderReturnId: string, decision: { accept: boolean; note: string | null }, actor: StockActor): Promise<DecideReturnOutcome> {
    // Не идентификатор — не найдено, а не 22P02 из базы (консоль проверяет и сама; хранилище не полагается на вызывающего)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderReturnId)) return { status: 'NOT_FOUND' };
    try {
      return await inTenant(this.options.adminPool, tenantId, async (tx) => {
        const { rows: [r] } = await tx.query(
          `SELECT status, stock_pool_id, quantity, product_id FROM channel_data.order_return WHERE tenant_id = $1 AND order_return_id = $2 FOR UPDATE`, [tenantId, orderReturnId]);
        if (!r) return { status: 'NOT_FOUND' as const };
        if (r.status !== 'PENDING') return { status: 'NOT_PENDING' as const };
        let movement: string | null = null;
        if (decision.accept) {
          const { rows: [m] } = await tx.query(
            `INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, created_by_membership_id, occurred_at)
             VALUES ($1, $2, $3, 'RETURN', $4, now()) RETURNING stock_movement_id`, [tenantId, r.stock_pool_id, r.quantity, actor.membershipId]);
          movement = String(m!.stock_movement_id);
        }
        await tx.query(
          `UPDATE channel_data.order_return SET status = $3, stock_movement_id = $4, decided_by_membership_id = $5, decided_at = now(), note = $6
            WHERE tenant_id = $1 AND order_return_id = $2`,
          [tenantId, orderReturnId, decision.accept ? 'ACCEPTED' : 'DISMISSED', movement, actor.membershipId, decision.note?.slice(0, 500) ?? null]);
        return { status: 'DECIDED' as const, productId: String(r.product_id), accepted: decision.accept };
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /**
   * Шаг 59 [Р-200]: источники Inbound API, молчащие сутки после подтверждения отгруженного заказа, — вычитание отгруженного держится, но
   * о том, что источник не прислал остаток, продавец должен узнать. Отметка ставится на резервацию: WARNING один раз, а не каждые 5 минут.
   * Время — часы базы, как у `confirmed_at`
   */
  async markSilentInboundSources(tenantId: string): Promise<Array<{ stockSourceId: string; reservations: number; oldestConfirmedAt: Instant }>> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const { rows } = await tx.query(
        `WITH marked AS (
           UPDATE channel_data.reservation r SET source_silence_alerted_at = now()
            WHERE r.tenant_id = $1 AND r.status = 'CONSUMED' AND r.source_mode = 'INBOUND_API' AND r.source_silence_alerted_at IS NULL
              AND r.confirmed_at < now() - interval '24 hours'
              AND NOT EXISTS (SELECT 1 FROM tenant_data.stock_pool sp WHERE sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id AND sp.source_as_of > r.confirmed_at)
           RETURNING r.stock_pool_id, r.confirmed_at)
         SELECT p.stock_source_id, count(*)::int AS reservations, min(m.confirmed_at) AS oldest
           FROM marked m JOIN tenant_data.stock_pool p ON p.tenant_id = $1 AND p.stock_pool_id = m.stock_pool_id
          GROUP BY p.stock_source_id`, [tenantId]);
      return rows.map((r) => ({ stockSourceId: String(r.stock_source_id), reservations: Number(r.reservations),
        oldestConfirmedAt: (r.oldest instanceof Date ? r.oldest.toISOString() : String(r.oldest)) as Instant }));
    });
  }

  async recordOrderLines(tenantId: string, channelAccountId: string, lines: readonly OrderLine[], now: Instant): Promise<OrderLinesOutcome> {
    return inTenant(this.options.stockPool, tenantId, async (tx) => {
      const out: OrderLinesOutcome = { created: 0, consumed: 0, released: 0, unknownOffers: 0, awaitingConfirmation: 0, returns: 0, productIds: [] };
      const touched = new Set<string>();
      for (const line of lines) {
        const id = line.identity;
        const { rows: [offer] } = await tx.query(
          `SELECT om.product_id, om.channel FROM tenant_data.offer_mapping om
            WHERE om.tenant_id = $1 AND om.channel_account_id = $2 AND om.status = 'ACTIVE'
              AND (($3::text IS NOT NULL AND om.external_offer_id = $3) OR ($4::text IS NOT NULL AND om.external_sku = $4) OR ($5::text IS NOT NULL AND om.external_unit_id = $5))
            LIMIT 1`, [tenantId, channelAccountId, id.externalOfferId ?? null, id.externalSku ?? null, id.externalUnitId ?? null]);
        if (!offer) { out.unknownOffers += 1; continue; }
        touched.add(offer.product_id); // шаг 57: пересчёт — у всех сопоставленных строк, см. OrderLinesOutcome.productIds
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
          // Отгрузка по только что созданной резервации: списать пул можно лишь после подтверждения источником [Р-25]
          if (line.status === 'SHIPPED') {
            if (pool.source_mode === 'INTERNAL_POOL') await this.consume(tx, tenantId, r!.reservation_id, out, offer.product_id, touched);
            else await this.reportShipped(tx, tenantId, r!.reservation_id, out);
          }
          continue;
        }
        /**
         * Шаг 59 [Р-199]: «возвращено» по отгруженной резервации — строка возврата: у внутреннего пула её ставит на полку человек, у
         * источника Inbound API — только сведения. Возврат, пришедший раньше отгрузки (опрос не застал `sent`), сначала закрывает отгрузку:
         * раньше такая строка не делала ничего, и резервация висела до алерта Р-30 (найдено разбором каналов шага 59)
         */
        if (line.status === 'RETURNED') {
          if (existing.status === 'RELEASED') continue;
          if (existing.status === 'CONFIRMED_BY_SOURCE') await this.consume(tx, tenantId, existing.reservation_id, out, offer.product_id, touched);
          else if (existing.status === 'CREATED') await this.reportShipped(tx, tenantId, existing.reservation_id, out);
          const { rowCount } = await tx.query(
            `INSERT INTO channel_data.order_return (tenant_id, reservation_id, product_id, stock_pool_id, source_mode, quantity, channel, channel_order_line_ref, status)
             SELECT r.tenant_id, r.reservation_id, r.product_id, r.stock_pool_id, r.source_mode, r.quantity, r.channel, r.channel_order_line_ref,
                    CASE WHEN r.source_mode = 'INTERNAL_POOL' THEN 'PENDING' ELSE 'INFO_ONLY' END
               FROM channel_data.reservation r WHERE r.tenant_id = $1 AND r.reservation_id = $2
             ON CONFLICT (tenant_id, reservation_id) DO NOTHING`, [tenantId, existing.reservation_id]);
          out.returns += rowCount ?? 0;
          continue;
        }
        if (existing.status === 'CONSUMED' || existing.status === 'RELEASED') continue;
        if (line.status === 'SHIPPED' && existing.status === 'CONFIRMED_BY_SOURCE') await this.consume(tx, tenantId, existing.reservation_id, out, offer.product_id, touched);
        // Р-157: отгружено, но источник заказ ещё не подтвердил — факт отгрузки ЗАПОМИНАЕТСЯ, иначе подтверждение
        // придёт позже и закрывать будет нечего (находка 7 ревью шага 36)
        else if (line.status === 'SHIPPED') await this.reportShipped(tx, tenantId, existing.reservation_id, out);
        else if (line.status === 'CANCELLED') {
          await tx.query(`UPDATE channel_data.reservation SET status = 'RELEASED', released_at = now(), release_reason = 'ORDER_CANCELLED' WHERE tenant_id = $1 AND reservation_id = $2`, [tenantId, existing.reservation_id]);
          out.released += 1; touched.add(offer.product_id);
        }
      }
      out.productIds = [...touched];
      return out;
    });
  }

  /**
   * Канал сообщил об отгрузке по резервации, которую источник ещё не подтвердил [Р-157]. Пул списать нельзя — остаток
   * источника не наш [Р-6], — но факт запоминается: подтверждение закроет такую резервацию сразу (0122).
   */
  private async reportShipped(tx: Tx, tenantId: string, reservationId: string, out: OrderLinesOutcome): Promise<void> {
    await tx.query(
      `UPDATE channel_data.reservation SET shipped_reported_at = coalesce(shipped_reported_at, now())
        WHERE tenant_id = $1 AND reservation_id = $2 AND status IN ('CREATED', 'CONFIRMED_BY_SOURCE')`, [tenantId, reservationId]);
    out.awaitingConfirmation += 1;
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
           coalesce(${'__DIVERGED__'}, false) AS diverged,
           ap.quantity AS confirmed_quantity, ap.accepted_at AS confirmed_at, ap.confirmed_by_own_record AS confirmed_own_record
      FROM (${'__TARGETS__'}) t
      JOIN tenant_data.write_scope ws ON ws.tenant_id = $1 AND ws.write_scope_id = t.write_scope_id
      JOIN tenant_data.channel_account ca ON ca.tenant_id = $1 AND ca.channel_account_id = t.channel_account_id
      JOIN platform.channel_capability cap ON cap.capability_id = ws.capability_id AND cap.version = ws.capability_version
      LEFT JOIN LATERAL (${'__LAST_WRITE__'}) lw ON true
      LEFT JOIN LATERAL (
        SELECT h.quantity, h.accepted_at, h.confirmed_by_own_record FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = $1 AND h.write_scope_id = t.write_scope_id AND h.field = 'QUANTITY' AND h.final_status = 'APPLIED'
         ORDER BY h.version DESC LIMIT 1) ap ON true`;

  /**
   * ПОСЛЕДНЯЯ запись остатка единицы: в полёте и завершённые в одном порядке версий. Один текст на все три места, где
   * расхождение показывается (бейдж строки, список, счётчик сводки), — иначе они разойдутся [находка 11 ревью шага 35].
   */
  private static readonly LAST_WRITE_SQL = `
        SELECT u.quantity, u.status, u.at, u.version, u.last_error_code, u.finished FROM (
          SELECT w.quantity, w.status, coalesce(w.accepted_at, w.dispatched_at, w.created_at) AS at, w.version, w.last_error_code, false AS finished
            FROM tenant_data.channel_write w WHERE w.tenant_id = $1 AND w.write_scope_id = t.write_scope_id AND w.field = 'QUANTITY'
          UNION ALL
          SELECT h.quantity, h.final_status, coalesce(h.accepted_at, h.dispatched_at, h.created_at), h.version, h.last_error_code, true
            FROM tenant_data.channel_write_history h WHERE h.tenant_id = $1 AND h.write_scope_id = t.write_scope_id AND h.field = 'QUANTITY'
        ) u ORDER BY u.version DESC LIMIT 1`;

  /**
   * ОДНО определение расхождения: последняя запись единицы ЗАВЕРШЕНА не применением и не вытеснением, и повтора уже нет
   * (записи в полёте у единицы не осталось — пока она есть, продавцу показывают ход, а не расхождение). Считается в SQL,
   * как и публикуемое количество; в памяти то же правило — `InMemoryStockStore.channelRow`.
   */
  private static readonly DIVERGED_SQL = `lw.finished AND lw.status NOT IN ('APPLIED', 'SUPERSEDED')
    AND NOT EXISTS (SELECT 1 FROM tenant_data.channel_write w WHERE w.tenant_id = $1 AND w.write_scope_id = t.write_scope_id AND w.field = 'QUANTITY')`;

  /**
   * Кандидаты в расхождение — по водяным знакам единицы (одна таблица, без подробностей): на каталоге целевого клиента
   * подробности по всем 10 000 единицам стоили 5,7 с при пустом результате [Р-154]. Окончательное решение — всё равно
   * `DIVERGED_SQL`: кандидат, у которого расхождения нет, из списка и из счёта выпадает.
   */
  private static readonly DIVERGENCE_CANDIDATES_SQL = `
    SELECT ss.write_scope_id FROM tenant_data.write_scope_sync_state ss
      JOIN tenant_data.write_scope s ON s.tenant_id = ss.tenant_id AND s.write_scope_id = ss.write_scope_id AND s.field = 'QUANTITY' AND s.status <> 'RETIRED'
     WHERE ss.tenant_id = $1 AND ss.latest_version_dispatched > 0 AND ss.latest_version_applied < ss.latest_version_dispatched
       AND NOT EXISTS (SELECT 1 FROM tenant_data.channel_write w WHERE w.tenant_id = ss.tenant_id AND w.write_scope_id = ss.write_scope_id)`;

  /** Счёт расхождений для сводки экрана: те же кандидаты и то же правило, что у списка */
  private static divergedCountSql(): string {
    return `(SELECT count(*) FROM (${PgStockStore.DIVERGENCE_CANDIDATES_SQL}) t
               JOIN LATERAL (${PgStockStore.LAST_WRITE_SQL}) lw ON true
              WHERE ${PgStockStore.DIVERGED_SQL})::int`;
  }

  private static channelRowsSql(): string {
    return PgStockStore.CHANNEL_ROWS_SQL.replace('__DIVERGED__', PgStockStore.DIVERGED_SQL).replace('__LAST_WRITE__', PgStockStore.LAST_WRITE_SQL);
  }

  private channelRow(r: Row): StockChannelRow {
    const allocation = { bufferUnits: Number(r.buffer_units ?? 0), maxQuantity: r.max_quantity === null || r.max_quantity === undefined ? null : Number(r.max_quantity), minQuantityToList: Number(r.min_quantity_to_list ?? 0) };
    const diverged = r.diverged === true;
    return {
      writeScopeId: r.write_scope_id, channelAccountId: r.channel_account_id, channel: r.channel, marketplaces: (r.marketplaces ?? []) as string[],
      syncEnabled: r.quantity_sync_enabled === true,
      published: publishedQuantity(availableOf(Number(r.on_hand), Number(r.reserved)), allocation),
      sent: r.sent_quantity === null || r.sent_quantity === undefined ? null : { quantity: Number(r.sent_quantity), status: r.sent_status, at: iso(r.sent_at), version: Number(r.sent_version) },
      confirmed: r.confirmed_quantity === null || r.confirmed_quantity === undefined ? null
        : { quantity: Number(r.confirmed_quantity), at: iso(r.confirmed_at), ...(r.confirmed_own_record === true ? { ownRecordOnly: true } : {}) },
      divergence: diverged ? { status: r.sent_status, since: iso(r.sent_at), errorCode: r.sent_error ?? null } : null,
      sideEffects: { requiresAck: r.requires_side_effects_ack === true, acknowledged: r.side_effects_ack_at !== null && r.side_effects_ack_at !== undefined, text: r.side_effects ?? null },
    };
  }

  async stockPage(tenantId: string, query: { offset: number; limit: number }): Promise<StockPage> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      // Страница товаров — по каталогу (единицы записи цены и остатка — предложения), итог и сводка — агрегатом [Р-154]
      const { rows: products } = await tx.query(
        `SELECT p.product_id, p.sku, p.gtin,
                coalesce((SELECT sum(sp.on_hand) FROM tenant_data.stock_pool sp WHERE sp.tenant_id = p.tenant_id AND sp.product_id = p.product_id), 0)::int AS on_hand,
                coalesce((SELECT sum(r.quantity) FROM channel_data.reservation r WHERE r.tenant_id = p.tenant_id AND r.product_id = p.product_id AND ${PgStockStore.RESERVED_SQL}), 0)::int AS reserved
           FROM tenant_data.product p WHERE p.tenant_id = $1 ORDER BY p.sku, p.product_id LIMIT $2 OFFSET $3`, [tenantId, query.limit, query.offset]);
      const ids = products.map((p) => p.product_id as string);
      const { rows: channels } = ids.length === 0 ? { rows: [] as Row[] } : await tx.query(
        PgStockStore.channelRowsSql().replace('__TARGETS__', `${PgStockStore.TARGETS_SQL} AND s.product_id = ANY($2::uuid[])`) + ' ORDER BY ca.channel, t.write_scope_id', [tenantId, ids]);
      const byProduct = new Map<string, StockChannelRow[]>();
      for (const c of channels) byProduct.set(c.product_id, [...(byProduct.get(c.product_id) ?? []), this.channelRow(c)]);
      // Шаг 52: количество, которым управляет канал (FBA), — последнее наблюдение каждого предложения CHANNEL товара, только чтение
      const { rows: managed } = ids.length === 0 ? { rows: [] as Row[] } : await tx.query(
        `SELECT om.product_id, om.channel, om.marketplace, o.quantity, o.observed_at
           FROM tenant_data.offer_mapping om
           -- Р-196: проекция текущего значения предложения (0146)
           JOIN channel_data.channel_quantity_current o ON o.tenant_id = om.tenant_id AND o.offer_mapping_id = om.offer_mapping_id
          WHERE om.tenant_id = $1 AND om.product_id = ANY($2::uuid[]) AND om.fulfillment = 'CHANNEL' AND om.status <> 'ENDED'
          ORDER BY om.channel, om.marketplace`, [tenantId, ids]);
      const managedOf = new Map<string, NonNullable<StockRow['channelManaged']>>();
      for (const m of managed) managedOf.set(m.product_id, [...(managedOf.get(m.product_id) ?? []), { channel: m.channel, marketplace: m.marketplace, quantity: Number(m.quantity), observedAt: iso(m.observed_at) }]);
      const items: StockRow[] = products.map((p) => ({
        productId: p.product_id, sku: p.sku, gtin: p.gtin ?? null, onHand: Number(p.on_hand), reserved: Number(p.reserved), available: availableOf(Number(p.on_hand), Number(p.reserved)),
        channels: byProduct.get(p.product_id) ?? [],
        ...(managedOf.has(p.product_id) ? { channelManaged: managedOf.get(p.product_id)! } : {}),
      }));
      const { rows: [s] } = await tx.query(
        `SELECT (SELECT count(*) FROM tenant_data.product p WHERE p.tenant_id = $1)::int AS products,
                (SELECT count(DISTINCT sp.product_id) FROM tenant_data.stock_pool sp WHERE sp.tenant_id = $1 AND sp.on_hand > 0)::int AS with_stock,
                (SELECT count(*) FROM tenant_data.write_scope s WHERE s.tenant_id = $1 AND s.field = 'QUANTITY' AND s.status <> 'RETIRED' AND s.quantity_sync_enabled)::int AS synced,
                (SELECT count(*) FROM tenant_data.channel_write w WHERE w.tenant_id = $1 AND w.field = 'QUANTITY' AND w.status IN ('PENDING', 'DISPATCHED', 'ACCEPTED', 'FAILED', 'BLOCKED'))::int AS pending,
                (SELECT count(*) FROM channel_data.reservation r WHERE r.tenant_id = $1 AND r.status IN ('CREATED', 'CONFIRMED_BY_SOURCE'))::int AS open_reservations,
                -- Расхождение — ТО ЖЕ правило и те же кандидаты, что у списка расхождений
                ${PgStockStore.divergedCountSql()} AS diverged`,
        [tenantId]);
      return {
        items, total: Number(s!.products),
        summary: { products: Number(s!.products), withStock: Number(s!.with_stock), synced: Number(s!.synced), pendingWrites: Number(s!.pending), diverged: Number(s!.diverged), openReservations: Number(s!.open_reservations) },
      };
    });
  }

  async stockDivergences(tenantId: string, limit: number): Promise<StockDivergenceRow[]> {
    return inTenant(this.options.adminPool, tenantId, async (tx) => {
      const { rows: candidates } = await tx.query(
        `${PgStockStore.DIVERGENCE_CANDIDATES_SQL} ORDER BY ss.updated_at DESC LIMIT $2`, [tenantId, limit]);
      if (candidates.length === 0) return [];
      const { rows } = await tx.query(
        PgStockStore.channelRowsSql().replace('__TARGETS__', `${PgStockStore.TARGETS_SQL} AND s.write_scope_id = ANY($2::uuid[])`) + ` ORDER BY lw.at DESC`,
        [tenantId, candidates.map((c) => c.write_scope_id)]);
      const { rows: skus } = await tx.query(`SELECT product_id, sku FROM tenant_data.product WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`, [tenantId, rows.map((r) => r.product_id)]);
      const skuOf = new Map(skus.map((s) => [s.product_id, s.sku as string]));
      return rows.map((r) => {
        const c = this.channelRow(r);
        return { writeScopeId: c.writeScopeId, productId: r.product_id, sku: skuOf.get(r.product_id) ?? '', channel: c.channel, marketplaces: c.marketplaces,
          sent: c.sent?.quantity ?? 0, confirmed: c.confirmed?.quantity ?? null, status: c.sent?.status ?? 'UNKNOWN', errorCode: c.divergence?.errorCode ?? null, since: c.sent?.at ?? systemClock.now() };
      });
    });
  }
}

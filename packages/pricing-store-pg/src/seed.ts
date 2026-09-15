import { randomUUID } from 'node:crypto';
import type { Instant } from '@repracer/channel-port';
import type { CostInputs } from '@repracer/pricing-model';
import { DEFAULT_MEMBERS, standUserOf, type MemorySeed, type MemorySeedScope, type PricingStore, type SeedBound } from '@repracer/pricing-pipeline';

type SeedAccount = NonNullable<MemorySeed['accounts']>[number];
import { inTenant, type PgPool, type Tx } from './db.ts';

/**
 * Посев синтетического мира стенда в реальную схему и перевод идентификаторов сценария в UUID.
 * Только для стенда и замеров: данные синтетические, каждый посев — новый тенант, аккаунт и пользователь.
 * Всё пишется ролью приложения через RLS, как в работе, — без обхода триггеров и политик.
 */

/** Членство владельца в сценариях (ручное снятие остановки) */
export const OWNER_MEMBERSHIP_ALIAS = 'membership-owner';

export class IdMap {
  private readonly toDbIds = new Map<string, string>();
  private readonly fromDbIds = new Map<string, string>();

  alias(fixtureId: string, dbId: string): void {
    this.toDbIds.set(fixtureId, dbId);
    this.fromDbIds.set(dbId, fixtureId);
  }

  dbId(fixtureId: string): string {
    const id = this.toDbIds.get(fixtureId);
    if (!id) throw new Error(`unknown fixture id ${fixtureId}`);
    return id;
  }

  toDb<T>(value: T): T {
    return deepMapStrings(value, (s) => this.toDbIds.get(s) ?? s) as T;
  }

  fromDb<T>(value: T): T {
    return deepMapStrings(value, (s) => this.fromDbIds.get(s) ?? s) as T;
  }
}

function deepMapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, f));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepMapStrings(v, f)]));
  }
  return value;
}

type Row = Record<string, any>;

type Hooks = Partial<Record<keyof PricingStore, (...fixtureArgs: any[]) => Promise<void>>>;

/** Хранилище в идентификаторах сценария; before — действия до вызова (например, параллельное изменение границ) */
export function translateStore<T extends object = PricingStore>(inner: T, ids: IdMap, before: Hooks = {}): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const hook = before[prop as keyof PricingStore];
        if (hook) await hook(...args);
        return ids.fromDb(await value.apply(target, ids.toDb(args)));
      };
    },
  });
}

export interface SeedWorldInput {
  /** Роль загрузчика курсов (repracer_fx_loader) — только для seed.fxRates [Р-61] */
  fxLoaderPool?: PgPool;
  fixtureTenantId: string;
  fixtureChannelAccountId: string;
  marketplaces: string[];
  clock: Instant;
  seed: MemorySeed;
  /** Существующие пользователи для членств сценария (псевдоним членства → user_id): один вход во все миры стенда [OQ-128, Р-9] */
  memberUsers?: Readonly<Record<string, string>>;
}

export interface SeededPricingWorld {
  tenantId: string;
  userId: string;
  ownerMembershipId: string;
  channelAccountId: string;
  ids: IdMap;
  setBound(writeScopeId: string, bound: 'min' | 'max', value: SeedBound | null): Promise<void>;
  setCost(writeScopeId: string, cost: CostInputs | null): Promise<void>;
  /** Подключить аккаунт с предложениями в уже существующий тенант — как подключение продавцом после посева */
  connectAccount(account: SeedAccount, scopes: MemorySeedScope[]): Promise<void>;
}

interface ScopeInfo {
  writeScopeId: string;
  productId: string;
  channel: string;
  channelAccountId: string;
  marketplace: string;
  currency: string;
  basis: string;
}

const shift = (at: Instant, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const DAY_MS = 86_400_000;

async function insertBound(tx: Tx, tenantId: string, membershipId: string, bound: 'min' | 'max', s: ScopeInfo, value: { amountMinor: number; isActive: boolean; currency?: string; basis?: string }): Promise<string> {
  const table = bound === 'min' ? 'min_price' : 'max_price';
  if ((value.currency ?? s.currency) !== s.currency || (value.basis ?? s.basis) !== s.basis) {
    throw new Error(`${table} with another currency or basis is not representable: the schema ties bounds to the write scope (FK)`);
  }
  const { rows } = await tx.query(
    `INSERT INTO tenant_data.${table} (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, is_active, version, created_by_membership_id)
     VALUES ($1, 'WRITE_SCOPE', $2, $3, $4, $5, $6,
             (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.${table} WHERE tenant_id = $1 AND scope_type = 'WRITE_SCOPE' AND write_scope_id = $2), $7)
     RETURNING ${table}_id AS id`,
    [tenantId, s.writeScopeId, s.currency, s.basis, value.amountMinor, value.isActive, membershipId],
  );
  return rows[0]!.id;
}

async function insertCost(tx: Tx, tenantId: string, membershipId: string, s: ScopeInfo, cost: CostInputs, validFrom: Instant): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
     VALUES ($1, $2, $7, $8, (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.cost_profile
                               WHERE tenant_id = $1 AND product_id = $2 AND channel_account_id = $7 AND marketplace = $8),
             $3, $4, $5, 'MANUAL', $6)
     RETURNING cost_profile_id`,
    [tenantId, s.productId, validFrom, cost.currency, cost.unitCostMinor, membershipId, s.channelAccountId, s.marketplace],
  );
  await tx.query(
    `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
     VALUES ($1, $2, 'FEE_SCHEDULE', $3, 'synthetic', $4, $4::timestamptz + interval '365 days')
     ON CONFLICT (tenant_id, write_scope_id, source) DO UPDATE
       SET fee_model = EXCLUDED.fee_model, computed_at = EXCLUDED.computed_at, valid_until = EXCLUDED.valid_until`,
    [tenantId, s.writeScopeId, JSON.stringify({ feeRateBp: cost.feeRateBp, fixedFeeMinor: cost.fixedFeeMinor }), validFrom],
  );
  // Р-53: ставка объявляется на товаре, только если отличается от ставки страны витрины по умолчанию; в режиме налога с продаж ставки нет [Р-58]
  if (cost.tax.regime === 'VAT_INCLUDED' && cost.tax.vatRateBp !== null) {
    await tx.query(
      `WITH c AS (SELECT country FROM platform.marketplace WHERE channel = $5 AND marketplace = $6)
       INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id)
       SELECT $1, $2, c.country, $3::int,
              (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.product_vat_rate v WHERE v.tenant_id = $1 AND v.product_id = $2 AND v.country = c.country), $4
         FROM c
        WHERE $3::int IS DISTINCT FROM tenant_data.effective_vat_rate_bp($1, $2, c.country)`,
      [tenantId, s.productId, cost.tax.vatRateBp, membershipId, s.channel, s.marketplace],
    );
  }
  return rows[0]!.cost_profile_id;
}

export async function seedPricingWorld(pool: PgPool, input: SeedWorldInput): Promise<SeededPricingWorld> {
  // Курсы ЕЦБ — справочник платформы: загружает роль загрузчика, курс дня неизменяем (повторный посев того же дня — без изменений)
  if (input.seed.fxRates?.length) {
    if (!input.fxLoaderPool) throw new Error('seed.fxRates requires fxLoaderPool (repracer_fx_loader)');
    for (const q of input.seed.fxRates) {
      await input.fxLoaderPool.query(
        `INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, available_from, source_ref)
         VALUES ('ECB', $1, 'EUR', $2, $3::numeric / 1000000, $4, 'contract stand seed') ON CONFLICT DO NOTHING`,
        [q.rateDate, q.quote, q.rateMicros, q.availableFrom]);
    }
  }
  const { seed, clock } = input;
  const ids = new IdMap();
  const tenantId: string = randomUUID();
  const userId: string = input.memberUsers?.[OWNER_MEMBERSHIP_ALIAS] ?? randomUUID();
  const membershipId: string = randomUUID();
  const accountId: string = randomUUID();
  ids.alias(input.fixtureTenantId, tenantId);
  ids.alias(input.fixtureChannelAccountId, accountId);
  ids.alias(OWNER_MEMBERSHIP_ALIAS, membershipId);
  // Пользователи участников: действия человека несут пользователя сессии (находка 4)
  ids.alias(standUserOf(OWNER_MEMBERSHIP_ALIAS), userId);
  const tag = tenantId.slice(0, 8);
  const scopes = new Map<string, ScopeInfo>();

  const accounts = new Map<string, { id: string; channel: string; region: string | null }>([[input.fixtureChannelAccountId, { id: accountId, channel: 'KAUFLAND', region: null }]]);
  /** Подключение аккаунта канала: при посеве и позже, в существующий тенант (Р-70: подключение при действующей остановке) */
  const connectAccountRow = async (tx: Tx, a: SeedAccount, externalAccountId: string): Promise<void> => {
    const id: string = randomUUID();
    ids.alias(a.channelAccountId, id);
    accounts.set(a.channelAccountId, { id, channel: a.channel, region: a.region ?? null });
    await tx.query(
      `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'secret-ref:synthetic', $7)`,
      [tenantId, id, a.channel, a.region ?? null, externalAccountId, a.marketplaces, membershipId],
    );
  };
  const capabilities = new Map<string, Row>();
  const capabilityOf = async (tx: Tx, channel: string): Promise<Row> => {
    const cached = capabilities.get(channel);
    if (cached) return cached;
    const { rows: [cap] } = await tx.query(
      `SELECT capability_id, version, write_scope_kind, write_scope_key_template FROM platform.channel_capability
        WHERE channel = $1 AND field = 'PRICE' AND status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1`,
      [channel],
    );
    if (!cap) throw new Error(`no ACTIVE ${channel} PRICE capability: run packages/pricing-store-pg/test/setup.sql`);
    capabilities.set(channel, cap);
    return cap;
  };

  const products = new Map<string, string>();
  const strategies = new Map<string, string>();
  const seedScope = async (tx: Tx, s: MemorySeedScope): Promise<void> => {
    if ((s.changesLastHour ?? 0) > 0) throw new Error('seed changesLastHour is memory-only: on PostgreSQL changes are counted from price_history');
    if (s.pricingMode === 'KAUFLAND_SMART_PRICING') throw new Error('KAUFLAND_SMART_PRICING scopes are not seeded on PostgreSQL');
    let productId = products.get(s.productId);
    if (!productId) {
      productId = randomUUID();
      await tx.query(`INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin) VALUES ($1, $2, $3, 'SIMPLE', $4)`,
        [tenantId, productId, `syn-${s.productId}`, s.gtin ?? null]);
      products.set(s.productId, productId);
      ids.alias(s.productId, productId);
    }
    const account = accounts.get(s.channelAccountId);
    if (!account) throw new Error(`scope ${s.writeScopeId}: unknown channel account ${s.channelAccountId} (add it to seed.accounts)`);
    const cap = await capabilityOf(tx, account.channel);
    const info: ScopeInfo = { writeScopeId: randomUUID(), productId, channel: account.channel, channelAccountId: account.id, marketplace: s.marketplace, currency: s.currency, basis: s.basis };
    scopes.set(s.writeScopeId, info);
    ids.alias(s.writeScopeId, info.writeScopeId);
    // Идентичность предложения по шаблону возможности канала: Kaufland — unit, Amazon — регион и SKU
    const kaufland = account.channel === 'KAUFLAND';
    const identity = {
      region: account.region, marketplace: s.marketplace,
      external_unit_id: kaufland ? s.externalUnitId : null, external_sku: kaufland ? null : `syn-sku-${s.externalUnitId}`,
    };
    await tx.query(
      `INSERT INTO tenant_data.write_scope
         (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
          scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode, status)
       VALUES ($1, $2, $3, $4, 'PRICE', $5, $6, $7, $8, tenant_data.derive_scope_key($9::jsonb, $10::text[]), $11, $12, $13, 'OFF', $14)`,
      [tenantId, info.writeScopeId, account.id, account.channel, productId, cap.capability_id, cap.version, cap.write_scope_kind,
       JSON.stringify(identity), cap.write_scope_key_template, s.currency, s.basis,
       s.taxRegime ?? (s.basis === 'GROSS' ? 'VAT_INCLUDED' : 'SALES_TAX_EXCLUDED'), s.status ?? 'ACTIVE'],
    );
    await tx.query(
      `INSERT INTO tenant_data.offer_mapping
         (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key, external_unit_id, external_sku, channel_product_ref, condition, status, price_write_scope_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE', $12)`,
      [tenantId, productId, account.id, account.channel, account.region, s.marketplace, `offer:${s.externalUnitId}`, identity.external_unit_id, identity.external_sku,
       s.channelProductRef, s.condition.toUpperCase(), info.writeScopeId],
    );

    let strategyId: string | null = null;
    if (s.strategy) {
      strategyId = strategies.get(s.strategy.strategyId) ?? null;
      if (!strategyId) {
        strategyId = randomUUID();
        strategies.set(s.strategy.strategyId, strategyId);
        ids.alias(s.strategy.strategyId, strategyId);
        for (let v = 1; v <= s.strategy.version; v++) {
          await tx.query(
            `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
            [tenantId, strategyId, v, s.strategy.strategyId, s.strategy.params.type,
             JSON.stringify({ ...s.strategy.params, deadbandMinor: s.strategy.deadbandMinor }), ['COMPETITOR_CHANGE', 'COST_CHANGE', 'SCHEDULE'], membershipId],
          );
        }
      }
    }

    for (const [bound, value] of [['min', s.minPrice], ['max', s.maxPrice]] as const) {
      if (!value) continue;
      const id = await insertBound(tx, tenantId, membershipId, bound, info, {
        amountMinor: value.amountMinor, isActive: value.isActive !== false,
        ...(value.currency ? { currency: value.currency } : {}), ...(value.basis ? { basis: value.basis } : {}),
      });
      ids.alias(value.id, id);
    }
    if (s.cost) ids.alias(s.cost.costProfileId, await insertCost(tx, tenantId, membershipId, info, s.cost, shift(clock, -DAY_MS)));
    const g = s.guardrails;
    if (g && (g.minMarginBp != null || g.maxStepChangeBp != null || g.maxChangesPerHour != null)) {
      const { rows: [row] } = await tx.query(
        `INSERT INTO tenant_data.guardrail
           (tenant_id, scope_type, write_scope_id, min_margin_bp, max_step_change_bp, max_changes_per_hour, on_violation, version, created_by_membership_id)
         VALUES ($1, 'WRITE_SCOPE', $2, $3, $4, $5, $6, 1, $7) RETURNING guardrail_id`,
        [tenantId, info.writeScopeId, g.minMarginBp ?? null, g.maxStepChangeBp ?? null, g.maxChangesPerHour ?? null, g.onViolation ?? 'HOLD', membershipId],
      );
      if (g.guardrailIds?.[0]) ids.alias(g.guardrailIds[0], row!.guardrail_id);
    }
    if (s.currentPriceMinor !== null) {
      await tx.query(
        `INSERT INTO channel_data.observed_channel_state (tenant_id, write_scope_id, field, observed_amount_minor, observed_at, received_at, source, sync_status)
         VALUES ($1, $2, 'PRICE', $3, $4, $4, 'READBACK', 'IN_SYNC')`,
        [tenantId, info.writeScopeId, s.currentPriceMinor, clock],
      );
    }
    // Р-77: стратегия хранится независимо от режима; движок без стратегии не включается (write_scope_engine_has_strategy)
    if (strategyId || s.pricingMode === 'ENGINE') {
      await tx.query(
        `UPDATE tenant_data.write_scope SET pricing_mode = $5, pricing_strategy_id = $3, pricing_strategy_version = $4
          WHERE tenant_id = $1 AND write_scope_id = $2`,
        [tenantId, info.writeScopeId, strategyId, strategyId ? s.strategy!.version : null, s.pricingMode],
      );
    }
    };


  await inTenant(pool, tenantId, async (tx) => {
    if (!input.memberUsers?.[OWNER_MEMBERSHIP_ALIAS]) {
      await tx.query('INSERT INTO platform.app_user (user_id, email) VALUES ($1, $2)', [userId, `owner-${tag}@example.test`]);
    }
    await tx.query(`INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES ($1, $2, 'EU')`, [tenantId, `Synthetic tenant ${tag}`]);
    await tx.query(`INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE')`,
      [tenantId, membershipId, userId]);
    await tx.query(
      `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
       VALUES ($1, $2, 'KAUFLAND', $3, $4, 'secret-ref:synthetic', $5)`,
      [tenantId, accountId, `syn-${tag}`, input.marketplaces, membershipId],
    );
    for (const a of seed.accounts ?? []) await connectAccountRow(tx, a, `syn-${a.channel.toLowerCase()}-${tag}`);
    for (const s of seed.scopes) await seedScope(tx, s);
    const gtinOf = (marketplace: string, ref: string, condition: string) =>
      seed.scopes.find((s) => s.marketplace === marketplace && s.channelProductRef === ref && s.condition === condition)?.gtin ?? null;
    const splitKey = (key: string) => {
      const [marketplace, ref, condition] = key.split('|');
      return { marketplace: marketplace!, ref: ref!, condition: condition! };
    };

    for (const [key, st] of Object.entries(seed.competitorState ?? {})) {
      const k = splitKey(key);
      const { rows: [mk] } = await tx.query(`SELECT currency, price_basis FROM platform.marketplace WHERE channel = 'KAUFLAND' AND marketplace = $1`, [k.marketplace]);
      if (!mk) throw new Error(`competitorState seed: storefront ${k.marketplace} is not in platform.marketplace`);
      const offers = st.lowestMinor !== null ? [{ isSelf: false, price: { amountMinor: st.lowestMinor, currency: mk.currency, basis: mk.price_basis } }] : [];
      await tx.query(
        `INSERT INTO channel_data.competitor_state
           (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, competitor_snapshot_id,
            observed_at, received_at, buybox_amount_minor, buybox_is_self, lowest_landed_minor, offer_count, offers, completeness, gtin, currency, price_basis)
         VALUES ($1, $2, 'KAUFLAND', $3, $4, $5, 'KAUFLAND_BUYBOX', gen_random_uuid(), $6, $6, $7, false, $8, $9, $10, 'FULL', $11, $12, $13)`,
        [tenantId, accountId, k.marketplace, k.ref, k.condition.toUpperCase(), st.observedAt, st.buyboxMinor, st.lowestMinor, offers.length,
         JSON.stringify(offers), gtinOf(k.marketplace, k.ref, k.condition), mk.currency, mk.price_basis],
      );
    }
    for (const [key, days] of Object.entries(seed.competitorDaily ?? {})) {
      const k = splitKey(key);
      for (const d of days) {
        await tx.query(
          `INSERT INTO channel_data.competitor_price_daily
             (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, price_day,
              buybox_min_minor, buybox_max_minor, buybox_last_minor, samples, updated_at)
           VALUES ($1, $2, 'KAUFLAND', $3, $4, $5, $6, $7, $8, $8, 1, $9)`,
          [tenantId, accountId, k.marketplace, k.ref, k.condition.toUpperCase(), d.day, d.minMinor, d.maxMinor, clock],
        );
      }
    }
    const otherAccounts = new Map<string, string>();
    for (const [key, refs] of Object.entries(seed.crossChannel ?? {})) {
      const k = splitKey(key);
      const gtin = gtinOf(k.marketplace, k.ref, k.condition);
      if (!gtin) throw new Error(`crossChannel seed for ${key} requires the scope gtin`);
      for (const [i, ref] of refs.entries()) {
        let refAccount = accountId;
        let source = 'KAUFLAND_BUYBOX';
        if (ref.channel === 'AMAZON') {
          source = 'AMAZON_COMPETITIVE_SUMMARY';
          refAccount = otherAccounts.get('AMAZON') ?? randomUUID();
          if (!otherAccounts.has('AMAZON')) {
            otherAccounts.set('AMAZON', refAccount);
            await tx.query(
              `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
               VALUES ($1, $2, 'AMAZON', 'EU', $3, $4, 'secret-ref:synthetic', $5)`,
              [tenantId, refAccount, `syn-amz-${tag}`, [ref.marketplace], membershipId],
            );
          }
        } else if (ref.channel !== 'KAUFLAND') {
          throw new Error(`crossChannel seed: channel ${ref.channel} has no competitor source in the schema`);
        }
        await tx.query(
          `INSERT INTO channel_data.competitor_state
             (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, competitor_snapshot_id,
              observed_at, received_at, buybox_amount_minor, buybox_is_self, offer_count, offers, completeness, gtin, currency, price_basis)
           VALUES ($1, $2, $3, $4, $5, 'NEW', $6, gen_random_uuid(), $7, $7, $8, false, 1, $9, 'FULL', $10, $11, 'GROSS')`,
          [tenantId, refAccount, ref.channel, ref.marketplace, `xref-${k.ref}-${i}`, source, ref.observedAt, ref.referenceMinor,
           JSON.stringify([{ isSelf: false, price: { amountMinor: ref.referenceMinor, currency: ref.currency, basis: 'GROSS' } }]), gtin, ref.currency],
        );
      }
    }
    for (const m of seed.moves ?? []) {
      const cut = m.productRef.lastIndexOf('|');
      await tx.query(
        // Журнал движений и проекция последнего движения товара, из которой путь читает окно сдвига [OQ-93]
        `WITH mv AS (
           INSERT INTO channel_data.competitor_move
             (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'ACCEPT', $8) RETURNING 1)
         INSERT INTO channel_data.competitor_move_latest AS l
           (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'ACCEPT', $8)
         ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition) DO UPDATE SET
           observed_at = EXCLUDED.observed_at, evaluated_at = EXCLUDED.evaluated_at, move_bp = EXCLUDED.move_bp, seller_ref = EXCLUDED.seller_ref
         WHERE l.evaluated_at <= EXCLUDED.evaluated_at`,
        [tenantId, accountId, m.marketplace, m.productRef.slice(0, cut), m.productRef.slice(cut + 1).toUpperCase(), m.evaluatedAt, m.moveBp, m.sellerRef ?? null],
      );
    }
    for (const h of seed.halts ?? []) {
      await tx.query(
        `INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, halted_at, review_window)
         VALUES ($1, $2, 'KAUFLAND', $3, 'CHANNEL_MASS_SHIFT', $4, make_interval(secs => $5))`,
        [tenantId, accountId, h.marketplace, h.haltedAt, h.reviewWindowSeconds ?? 1800],
      );
    }
  }, userId);

  // Участники стенда (DEFAULT_MEMBERS): у каждого свой пользователь; пользователь создаётся только в своей сессии (app_user_signup)
  const memberUsers = new Map<string, string>([[OWNER_MEMBERSHIP_ALIAS, userId]]);
  for (const m of seed.members ?? DEFAULT_MEMBERS) {
    if (m.membershipId === OWNER_MEMBERSHIP_ALIAS) continue;
    const existingUser = input.memberUsers?.[m.membershipId];
    const otherUser: string = existingUser ?? randomUUID();
    const otherMembership: string = randomUUID();
    await inTenant(pool, tenantId, async (tx) => {
      if (!existingUser) await tx.query('INSERT INTO platform.app_user (user_id, email) VALUES ($1, $2)', [otherUser, `${m.role.toLowerCase()}-${tag}@example.test`]);
      await tx.query(`INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status) VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [tenantId, otherMembership, otherUser, m.role]);
    }, otherUser);
    ids.alias(m.membershipId, otherMembership);
    ids.alias(m.userId ?? standUserOf(m.membershipId), otherUser);
    memberUsers.set(m.membershipId, otherUser);
  }
  // Остановки человеком сценария [Р-69, Р-70]: от сессии автора — триггер прав сверяет пользователя
  for (const st of seed.stops ?? []) {
    const alias = st.membershipId ?? OWNER_MEMBERSHIP_ALIAS;
    const account = st.scope === 'TENANT' ? null : (st.channelAccountId ? ids.dbId(st.channelAccountId) : accountId);
    await inTenant(pool, tenantId, (tx) => tx.query(
      `INSERT INTO tenant_data.price_stop (tenant_id, scope_type, channel_account_id, marketplace, stopped_at, stopped_by_membership_id, stop_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, st.scope, account, st.scope === 'STOREFRONT' ? st.marketplace ?? null : null, st.stoppedAt, ids.dbId(alias), st.note ?? 'Synthetic stop of the scenario'],
    ), memberUsers.get(alias));
  }

  const scopeInfo = (fixtureWs: string) => {
    const info = scopes.get(fixtureWs);
    if (!info) throw new Error(`unknown write scope ${fixtureWs}`);
    return info;
  };

  return {
    tenantId, userId, ownerMembershipId: membershipId, channelAccountId: accountId, ids,
    async setBound(fixtureWs, bound, value) {
      const info = scopeInfo(fixtureWs);
      const id = await inTenant(pool, tenantId, async (tx) => {
        let amountMinor = value?.amountMinor;
        if (amountMinor === undefined) {
          // Снятие границы — новая неактивная версия (append-only)
          const table = bound === 'min' ? 'min_price' : 'max_price';
          const { rows } = await tx.query(
            `SELECT amount_minor FROM tenant_data.${table} WHERE tenant_id = $1 AND scope_type = 'WRITE_SCOPE' AND write_scope_id = $2 ORDER BY version DESC LIMIT 1`,
            [tenantId, info.writeScopeId],
          );
          amountMinor = rows[0]?.amount_minor ?? 1;
        }
        return insertBound(tx, tenantId, membershipId, bound, info, {
          amountMinor: amountMinor!, isActive: value ? value.isActive !== false : false,
          ...(value?.currency ? { currency: value.currency } : {}), ...(value?.basis ? { basis: value.basis } : {}),
        });
      }, userId);
      if (value) ids.alias(value.id, id);
    },
    async setCost(fixtureWs, cost) {
      if (!cost) throw new Error('setCost(null) is not representable: cost_profile is append-only');
      const info = scopeInfo(fixtureWs);
      const id = await inTenant(pool, tenantId, (tx) => insertCost(tx, tenantId, membershipId, info, cost, clock), userId);
      ids.alias(cost.costProfileId, id);
    },
    async connectAccount(account, newScopes) {
      await inTenant(pool, tenantId, async (tx) => {
        await connectAccountRow(tx, account, `syn-${account.channel.toLowerCase()}-${tag}-${accounts.size}`);
        for (const s of newScopes) await seedScope(tx, s);
      });
    },
  };
}

import type { Instant } from '@repracer/channel-port';
import { inTenant, type PgPool } from './db.ts';

/**
 * Р-169…Р-171 (шаг 41): чтение теневого режима для консоли и для недельного дайджеста.
 *
 * Экран показывает то, чего продавец не видел бы иначе: что движок СДЕЛАЛ БЫ, будь канал боевым. Числа считает база
 * агрегатом [Р-154] — экран не тянет все решения тенанта ради шести счётчиков, а список удержанных записей приходит
 * страницей. Суммы остаются суммами с валютой [Р-71]; чисел «сколько бы заработали» здесь нет: это было бы гадание.
 */

export interface ShadowSummary {
  since: Instant;
  until: Instant;
  /** Решений всего в тени за период */
  decisions: number;
  /** Из них таких, где цена изменилась бы */
  changes: number;
  /** Пол удержал цену N раз (Р-117): решение было прижато к полу */
  floorHeld: number;
  /** Потолок удержал цену N раз */
  ceilingHeld: number;
  /** Записей удержано тенью — всего и по видам */
  heldWrites: number;
  heldPriceWrites: number;
  /** «Остаток разошёлся бы M раз»: удержанные записи количества */
  heldQuantityWrites: number;
  /** Из удержанных записей — столько израсходовали бы внешний бюджет правок [Р-171] */
  wouldSpendBudget: number;
}

export interface ShadowAccountRow {
  channelAccountId: string;
  channel: string;
  displayName: string | null;
  externalAccountId: string;
  writeMode: 'SHADOW' | 'LIVE';
  /** Состояние доступов [Р-150]: канал, который ждёт ключей, тенью не считается — писать он не может и так */
  authStatus: string;
  /** Последнее переключение режима: когда и кем [Р-170] */
  changedAt: Instant | null;
  changedByMembershipId: string | null;
  changedFrom: 'SHADOW' | 'LIVE' | null;
  /** Объём: предложения аккаунта и включённые единицы записи цены */
  offers: number;
  engineScopes: number;
}

export interface ShadowWriteRow {
  channelWriteId: string;
  writeScopeId: string;
  channel: string;
  channelAccountId: string;
  sku: string | null;
  field: string;
  amountMinor: number | null;
  currency: string | null;
  quantity: number | null;
  priceDecisionId: string | null;
  wouldSpendBudget: boolean;
  finishedAt: Instant;
}

export interface ShadowPage {
  summary: ShadowSummary;
  rows: ShadowWriteRow[];
  total: number;
  accounts: ShadowAccountRow[];
}

export interface ShadowModeChange {
  channelAccountId: string;
  toMode: 'SHADOW' | 'LIVE';
  /** Набранный продавцом внешний идентификатор аккаунта — только при включении боя [Р-170] */
  typedConfirmation?: string;
  note?: string;
  membershipId: string;
  userId: string;
  mfa: boolean;
}

export type ShadowModeResult =
  | { status: 'SWITCHED'; mode: 'SHADOW' | 'LIVE' }
  | { status: 'MFA_REQUIRED' }
  | { status: 'NOT_OWNER' }
  | { status: 'CONFIRMATION_MISMATCH' }
  | { status: 'MODE_MISMATCH'; mode: 'SHADOW' | 'LIVE' }
  | { status: 'FORBIDDEN' };

const num = (v: unknown): number => Number(v ?? 0);

export class PgShadowStore {
  private readonly pools: { adminPool: PgPool };

  constructor(pools: { adminPool: PgPool }) {
    this.pools = pools;
  }

  /**
   * Сводка и страница удержанных записей. `sinceDays` — окно отчёта; по умолчанию неделя, как у дайджеста [Р-171].
   */
  async shadowPage(tenantId: string, now: Instant, query: { offset: number; limit: number; sinceDays?: number }): Promise<ShadowPage> {
    const sinceDays = query.sinceDays ?? 7;
    const since = new Date(Date.parse(now) - sinceDays * 86_400_000).toISOString();
    return inTenant(this.pools.adminPool, tenantId, async (tx) => {
      const [decisions, held, list, accounts] = await Promise.all([
        // Решения тени: считает база, и только по окну отчёта [Р-154]
        tx.query(
          /**
           * Находка 3 ревью шага 41: исходов `CLAMPED_FLOOR`/`CLAMPED_CEILING` не производит НИ ОДНА строка кода — Р-44
           * говорит «выход за границу — отказ, не округление», — и два числа сводки были структурными нулями. Считается
           * то, что видно столбцами: цена пришла РОВНО на пол (или на потолок), то есть границу определила его.
           */
          `SELECT count(*)::int AS decisions,
                  count(*) FILTER (WHERE d.outcome = 'APPROVED')::int AS changes,
                  count(*) FILTER (WHERE d.final_amount_minor IS NOT NULL AND d.final_amount_minor = d.effective_floor_minor)::int AS floor_held,
                  count(*) FILTER (WHERE d.final_amount_minor IS NOT NULL AND d.final_amount_minor = d.effective_ceiling_minor)::int AS ceiling_held
             FROM channel_data.price_decision d
            WHERE d.tenant_id = $1 AND d.shadow AND d.decided_at >= $2`, [tenantId, since]),
        tx.query(
          `SELECT count(*)::int AS held,
                  count(*) FILTER (WHERE h.field <> 'QUANTITY')::int AS held_price,
                  count(*) FILTER (WHERE h.field = 'QUANTITY')::int AS held_quantity,
                  count(*) FILTER (WHERE h.would_spend_budget)::int AS would_spend
             FROM tenant_data.channel_write_history h
            WHERE h.tenant_id = $1 AND h.final_status = 'SHADOW_HELD' AND h.finished_at >= $2`, [tenantId, since]),
        tx.query(
          `SELECT h.channel_write_id, h.write_scope_id, ws.channel, ws.channel_account_id, p.sku, h.field,
                  h.amount_minor, h.currency, h.quantity, h.price_decision_id, h.would_spend_budget, h.finished_at
             FROM tenant_data.channel_write_history h
             JOIN tenant_data.write_scope ws ON ws.tenant_id = h.tenant_id AND ws.write_scope_id = h.write_scope_id
             LEFT JOIN tenant_data.product p ON p.tenant_id = ws.tenant_id AND p.product_id = ws.product_id
            WHERE h.tenant_id = $1 AND h.final_status = 'SHADOW_HELD' AND h.finished_at >= $2
            ORDER BY h.finished_at DESC, h.channel_write_id
            LIMIT $3 OFFSET $4`, [tenantId, since, query.limit, query.offset]),
        // Режим каждого аккаунта и последнее переключение [Р-170]
        tx.query(
          `SELECT ca.channel_account_id, ca.channel, ca.display_name, ca.external_account_id, ca.write_mode, ca.auth_status,
                  c.changed_at, c.changed_by_membership_id, c.from_mode,
                  (SELECT count(*)::int FROM tenant_data.offer_mapping om
                    WHERE om.tenant_id = ca.tenant_id AND om.channel_account_id = ca.channel_account_id) AS offers,
                  (SELECT count(*)::int FROM tenant_data.write_scope ws
                    WHERE ws.tenant_id = ca.tenant_id AND ws.channel_account_id = ca.channel_account_id
                      AND ws.field = 'PRICE' AND ws.pricing_mode = 'ENGINE') AS engine_scopes
             FROM tenant_data.channel_account ca
             LEFT JOIN LATERAL (
               SELECT mc.changed_at, mc.changed_by_membership_id, mc.from_mode
                 FROM tenant_data.channel_write_mode_change mc
                WHERE mc.tenant_id = ca.tenant_id AND mc.channel_account_id = ca.channel_account_id
                ORDER BY mc.changed_at DESC LIMIT 1) c ON true
            WHERE ca.tenant_id = $1 AND ca.disconnected_at IS NULL
            ORDER BY ca.connected_at`, [tenantId]),
      ]);
      const d = decisions.rows[0] ?? {};
      const h = held.rows[0] ?? {};
      return {
        summary: {
          since, until: now,
          decisions: num(d.decisions), changes: num(d.changes), floorHeld: num(d.floor_held), ceilingHeld: num(d.ceiling_held),
          heldWrites: num(h.held), heldPriceWrites: num(h.held_price), heldQuantityWrites: num(h.held_quantity),
          wouldSpendBudget: num(h.would_spend),
        },
        total: num(h.held),
        rows: list.rows.map((r) => ({
          channelWriteId: r.channel_write_id as string, writeScopeId: r.write_scope_id as string, channel: r.channel as string,
          channelAccountId: r.channel_account_id as string, sku: (r.sku as string | null) ?? null, field: r.field as string,
          amountMinor: r.amount_minor === null ? null : Number(r.amount_minor), currency: (r.currency as string | null) ?? null,
          quantity: r.quantity === null ? null : Number(r.quantity), priceDecisionId: (r.price_decision_id as string | null) ?? null,
          wouldSpendBudget: Boolean(r.would_spend_budget), finishedAt: r.finished_at as Instant,
        })),
        accounts: accounts.rows.map((r) => ({
          channelAccountId: r.channel_account_id as string, channel: r.channel as string,
          displayName: (r.display_name as string | null) ?? null, externalAccountId: r.external_account_id as string,
          writeMode: r.write_mode as 'SHADOW' | 'LIVE', authStatus: r.auth_status as string, changedAt: (r.changed_at as Instant | null) ?? null,
          changedByMembershipId: (r.changed_by_membership_id as string | null) ?? null,
          changedFrom: (r.from_mode as 'SHADOW' | 'LIVE' | null) ?? null,
          offers: num(r.offers), engineScopes: num(r.engine_scopes),
        })),
      };
    });
  }

  /**
   * Переключение режима [Р-170]. Ни одной проверки прав здесь нет намеренно [Р-104]: роль, второй фактор, текущий режим и
   * набранное подтверждение проверяет БАЗА, а её отказы разбираются по причинам — консоль показывает именно их.
   */
  async switchWriteMode(tenantId: string, change: ShadowModeChange): Promise<ShadowModeResult> {
    try {
      return await inTenant(this.pools.adminPool, tenantId, async (tx) => {
        const { rows: [account] } = await tx.query(
          `SELECT write_mode FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2`,
          [tenantId, change.channelAccountId]);
        const current = (account?.write_mode as 'SHADOW' | 'LIVE' | undefined) ?? null;
        if (current === null) return { status: 'FORBIDDEN' } as ShadowModeResult;
        if (current === change.toMode) return { status: 'MODE_MISMATCH', mode: current } as ShadowModeResult;
        await tx.query(
          `INSERT INTO tenant_data.channel_write_mode_change
             (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, change.channelAccountId, current, change.toMode, change.membershipId,
            change.toMode === 'LIVE' ? (change.typedConfirmation ?? '') : null, change.note ?? null]);
        return { status: 'SWITCHED', mode: change.toMode } as ShadowModeResult;
      }, change.userId, { mfa: change.mfa });
    } catch (error) {
      const message = (error as { message?: string }).message ?? '';
      if (/requires a second factor/.test(message)) return { status: 'MFA_REQUIRED' };
      /**
       * Находка 5 ревью шага 41: у отказа «в тень переводит владелец ИЛИ администратор» текст другой, и он не
       * распознавался — наблюдатель получал 500 вместо 403. Оба отказа о роли ловятся одним выражением.
       */
      if (/only the owner (switches|or an admin switches)/.test(message)) return { status: 'NOT_OWNER' };
      if (/typed confirmation does not name/.test(message)) return { status: 'CONFIRMATION_MISMATCH' };
      // Находка 6: режим брался из воздуха — теперь из самого отказа базы, иначе продавец читает «уже в бою» о теневом аккаунте
      const mismatch = /is in (SHADOW|LIVE) mode, not in/.exec(message);
      if (mismatch) return { status: 'MODE_MISMATCH', mode: mismatch[1] as 'SHADOW' | 'LIVE' };
      if (/permission denied|insufficient/i.test(message)) return { status: 'FORBIDDEN' };
      throw error;
    }
  }
}

/**
 * Цели недельного дайджеста тени [Р-171]. Роль — доставка писем (`repracer_alert_delivery`): она видит имя тенанта, его
 * язык, адрес владельца и ЧИСЛА, и ничего больше. Границу держит функция базы `platform.shadow_digest_targets`.
 */
export interface ShadowDigestTarget {
  tenantId: string;
  tenantName: string;
  locale: string;
  ownerEmail: string | null;
  shadowAccounts: number;
  decisions: number;
  changes: number;
  floorHeld: number;
  ceilingHeld: number;
  heldWrites: number;
  heldPriceWrites: number;
  heldQuantityWrites: number;
  wouldSpendBudget: number;
}

export class PgShadowDigestStore {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async targets(sinceDays: number): Promise<ShadowDigestTarget[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM platform.shadow_digest_targets(make_interval(days => $1))`, [sinceDays]);
    return rows.map((r) => ({
      tenantId: r.tenant_id as string, tenantName: r.tenant_name as string, locale: r.locale as string,
      ownerEmail: (r.owner_email as string | null) ?? null, shadowAccounts: num(r.shadow_accounts),
      decisions: num(r.decisions), changes: num(r.changes), floorHeld: num(r.floor_held), ceilingHeld: num(r.ceiling_held),
      heldWrites: num(r.held_writes), heldPriceWrites: num(r.held_price_writes),
      heldQuantityWrites: num(r.held_quantity_writes), wouldSpendBudget: num(r.would_spend_budget),
    }));
  }
}

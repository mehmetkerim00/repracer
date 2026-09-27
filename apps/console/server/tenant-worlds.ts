import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import type { LiveWorld } from '@repracer/contract-tests/stand';
import type { Principal } from '@repracer/identity';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { createPricingPipeline, type WorldCounters } from '@repracer/pricing-pipeline';
import { PgAlertSink, PgPricingStore, PgShadowStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createStockPipeline } from '@repracer/stock-sync';

/**
 * Шаг 44 [Р-178]: мир КАЖДОГО тенанта в работе. До шага 44 разворачиваемая консоль знала один мир — демо, и продавец с
 * настоящим входом видел пустой список (OQ-234). Теперь мир строится из членства пользователя (с шага 45 — указатель
 * с кэшем по отпечатку членств и только запрошенный мир, Р-182):
 * какие тенанты — решает база (`security.console_tenant_worlds`: клиентские, не демо, членство не гостевое), консоль
 * лишь собирает экраны поверх тех же хранилищ, что у мира стенда.
 *
 * Чего у мира тенанта в консоли НЕТ: адаптера канала. Всё, что ходит в канал, делают процессы планировщика и
 * диспетчера; экран, которому нужен был бы канал напрямую, получает отказ `CHANNEL_NOT_IN_CONSOLE`, а не молчаливый пропуск.
 */

export const TENANT_WORLD_PREFIX = 'tenant-';

/**
 * Р-182 (шаг 45): миры пользователя — УКАЗАТЕЛЬ, а не собранные миры. Список показывает счётчики всех тенантов одним
 * обращением к базе (`worldSummaries`), а мир собирается только тот, в который пришёл запрос (`open`).
 */
export interface TenantWorldIndex {
  entries: ReadonlyArray<{ id: string; tenantId: string; title: string }>;
  summaries(): Promise<Map<string, WorldCounters & { awaitingAccess: number }>>;
  open(worldId: string): Promise<LiveWorld | null>;
}

/** Срок записи кэша: страховка для того, чего членство не меняет (переименование, закрытие тенанта); членство — сразу */
const INDEX_TTL_MS = 60_000;
const INDEX_MAX_USERS = 10_000;

export interface TenantWorldPools {
  /** Роль входа: только она исполняет функцию списка миров пользователя */
  authenticator: PgPool;
  app: PgPool;
  admin: PgPool;
  bulkWorker: PgPool;
  stock: PgPool;
}

const noChannel = (): never => { throw Object.assign(new Error('CHANNEL_NOT_IN_CONSOLE: channel calls are made by the scheduler and the dispatcher'), { code: 'CHANNEL_NOT_IN_CONSOLE' }); };
/** Адаптер без канала, но СО СВОИМ описанием: доступность стратегии и снятие остановок — свойства канала (находка 14 ревью шага 44) */
const consoleAdapter = (channel: string) => new Proxy({ descriptor: channel === 'AMAZON' ? AMAZON_DESCRIPTOR : KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
  get: (target, key) => (key in target ? target[key as string] : noChannel),
}) as never;

export function createTenantWorlds(pools: TenantWorldPools, now: () => string = () => new Date().toISOString()) {
  const store = new PgPricingStore(pools.app, { adminPool: pools.admin, bulkWorkerPool: pools.bulkWorker });
  const stock = new PgStockStore({ adminPool: pools.admin, stockPool: pools.stock });
  const shadow = new PgShadowStore({ adminPool: pools.admin });
  /**
   * Находка 5 ревью шага 44: алерт мира тенанта — строка в базе, как у планировщика и диспетчера: остановку цен
   * человеком [Р-69] доставка отправит владельцу письмом [Р-156]. Журнал процесса получает его тоже.
   */
  const alerts = new PgAlertSink(pools.app, { raise: async (a) => { console.log(JSON.stringify({ level: 'ALERT', code: a.code, severity: a.severity })); } });
  const pipelines = new Map<string, ReturnType<typeof createPricingPipeline>>();
  const pipelineOf = (channel: string) => {
    let p = pipelines.get(channel);
    if (!p) {
      p = createPricingPipeline({ store: store as never, adapter: consoleAdapter(channel), alerts, logger: { log: () => undefined }, now: now as never });
      pipelines.set(channel, p);
    }
    return p;
  };
  // Р-152: изменения остатка из Inbound API пересчитываются сразу; записи отправит диспетчер [Р-64]
  const stockPipeline = createStockPipeline({ store: stock, now: now as never });
  const clock = { iso: now, nowMs: () => Date.parse(now()) } as never;
  const cache = new Map<string, { fingerprint: string; at: number; rows: Array<{ id: string; tenantId: string; title: string }> }>();

  const world = async (tenantId: string, name: string): Promise<LiveWorld> => {
    const rows = await store.channelAccounts(tenantId);
    const accounts = rows.map((a) => ({
      channelAccountId: a.channelAccountId, channel: a.channel, marketplaces: [...a.marketplaces],
      haltRelease: (a.channel === 'AMAZON' ? AMAZON_DESCRIPTOR : KAUFLAND_DESCRIPTOR).haltRelease.kind,
    }));
    const id = `${TENANT_WORLD_PREFIX}${tenantId}`;
    // Путь решения мира — по каналу аккаунта вызова: каждый метод получает контекст первым аргументом
    const channelOf = (channelAccountId: string) => accounts.find((a) => a.channelAccountId === channelAccountId)?.channel ?? 'KAUFLAND';
    const pipeline = new Proxy({}, {
      get: (_t, method) => (ctx: { channelAccountId: string }, ...rest: unknown[]) =>
        (pipelineOf(channelOf(ctx.channelAccountId)) as unknown as Record<string, (...a: unknown[]) => unknown>)[method as string]!(ctx, ...rest),
    });
    return {
      id, title: name, description: '', tenantId, accounts, identityTenantId: tenantId, membershipAlias: (m) => m, failures: [],
      store: store as never, stock, stockPipeline, shadow, pipeline: pipeline as never, clock,
      callContext: (channelAccountId) => ({ tenantId: tenantId as never, channelAccountId: channelAccountId as never, correlationId: `console:${id}`, deadline: now() as never }),
      view: async (viewer) => ({
        id, title: name, description: '', tenantId, now: now(), accounts, viewer: { ...viewer },
        state: await store.readConsoleState(tenantId, now() as never),
      }) as never,
    };
  };

  return {
    /**
     * Находка 4 ревью шага 44: Inbound API остатков — ключ источника находит тенанта, и мир строится по нему. Без этого
     * склад продавца получал 401 всегда: миры тенантов в списке миров стенда не лежат.
     */
    async inbound(prefix: string, sha256Hex: string): Promise<{ tenantId: string; stockSourceId: string; world: LiveWorld } | null> {
      const r = await stock.resolveInboundKey(prefix, sha256Hex);
      return r ? { ...r, world: await world(r.tenantId, '') } : null;
    },
    /**
     * Миры пользователя: по его членствам из базы, без демо и без гостевых членств [Р-178].
     *
     * Р-182: список тенантов пользователя кэшируется, а ключ записи — ОТПЕЧАТОК ЧЛЕНСТВ из principal, который вход
     * читает из базы при каждом запросе (`resolve_external_identity`). Поэтому изменение членства — новое, отозванное,
     * смена роли — меняет ключ, и следующий же запрос строит список заново, на любой реплике: устаревший мир опаснее
     * медленного. Даже устаревшая запись не открывает мир без членства — роль в мире берётся из свежего principal.
     */
    async worldsFor(principal: Principal): Promise<TenantWorldIndex> {
      const fingerprint = principal.memberships.map((x) => `${x.tenantId}:${x.membershipId}:${x.role}`).sort().join('|');
      let entry = cache.get(principal.userId);
      if (!entry || entry.fingerprint !== fingerprint || Date.now() - entry.at > INDEX_TTL_MS) {
        const { rows } = await pools.authenticator.query('SELECT tenant_id, tenant_name FROM security.console_tenant_worlds($1)', [principal.userId]);
        entry = { fingerprint, at: Date.now(), rows: rows.map((r) => ({ id: `${TENANT_WORLD_PREFIX}${r.tenant_id as string}`, tenantId: r.tenant_id as string, title: r.tenant_name as string })) };
        cache.delete(principal.userId);
        if (cache.size >= INDEX_MAX_USERS) cache.delete(cache.keys().next().value!);
        cache.set(principal.userId, entry);
      }
      const rowsOf = entry.rows;
      return {
        entries: rowsOf,
        summaries: () => store.worldSummaries(rowsOf.map((r) => r.tenantId), now() as never),
        // Аккаунты мира читаются при каждом открытии: канал мог быть подключён минуту назад, и кэшировать их нечем сверить
        open: async (worldId) => {
          const hit = rowsOf.find((r) => r.id === worldId);
          return hit ? world(hit.tenantId, hit.title) : null;
        },
      };
    },
  };
}

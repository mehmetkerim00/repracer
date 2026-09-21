import type { PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { VirtualClock } from '../harness/world.ts';
import type { CompetitorBehaviour } from '../simulator/kaufland-channel.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct } from './kaufland-world.ts';

/**
 * Р-151 (шаг 34): демо-тенант — отдельный тенант на симуляторе канала шага 21 вместо живого канала. Данные синтетические,
 * путь настоящий: те же экраны, тот же движок, те же решения с объяснениями. Служит двум целям: показу продавцу и живому
 * прогону онбординга целиком.
 *
 * Сценарий: 200 предложений одной витрины, у каждого три конкурента —
 *   1. «дрейф» — случайное блуждание цены (RANDOM_WALK), рынок, который просто живёт;
 *   2. «война» — подрезчик, отвечающий на нашу цену с задержкой (UNDERCUT_SELF) — периодические ценовые войны рождаются
 *      именно здесь: как только мы подрезаем, он подрезает нас, пока не упрётся в свой пол;
 *   3. «по расписанию» — раз в два часа резко снижает цену на полчаса и возвращается (SCHEDULE): периодические волны,
 *      которые видно на экране решений как серию отклонений и остановок.
 *
 * Чего здесь НЕТ, и это надо знать, показывая демо: спроса и продаж (ни выручки, ни конверсии), настоящего правила Buy Box,
 * входа и выхода продавцов; все K-вопросы модели остаются открытыми — поведение задано параметром, а не фактом о канале.
 */

export const DEMO_OFFERS = 200;
const HOUR = 3_600_000;

/** Конкурентов у предложения РОВНО три [Р-151]: дрейф, война, расписание. Начальные цены вокруг 18,50 € — как у наших */
export const DEMO_COMPETITORS_PER_OFFER = 3;

/** Первый конкурент мира — тот, которого `kauflandLiveWorld` заводит у каждого товара: в демо он дрейфует */
export const DEMO_DRIFT: CompetitorBehaviour = { kind: 'RANDOM_WALK', everyMs: 20 * 60_000, volatilityBp: 120, minMinor: 1500, maxMinor: 2400 } as CompetitorBehaviour;

/**
 * Остальные два. Первая редакция возвращала отсюда всех троих, а мир добавлял к ним своего неподвижного — конкурентов
 * выходило четыре при заявленных трёх (ревью шага 34, находка 12).
 */
export function demoCompetitors(idProduct: number): NonNullable<LiveProduct['moreCompetitors']> {
  const base = 1850 + (idProduct % 7) * 10;
  // Волна каждые два часа: на сороковой минуте цена падает на 8 %, через полчаса возвращается — первая видна уже в первый час
  const wave = Array.from({ length: 24 }, (_, i) => [
    { atOffsetMs: i * 2 * HOUR + 40 * 60_000, priceMinor: Math.round(base * 0.92) },
    { atOffsetMs: i * 2 * HOUR + 70 * 60_000, priceMinor: base + 20 },
  ]).flat();
  return [
    { sellerRef: `Demo War ${idProduct}`, startMinor: base + 10,
      behaviour: { kind: 'UNDERCUT_SELF', undercutMinor: 5, reactionMs: 15 * 60_000, floorMinor: Math.round(base * 0.85), ceilingMinor: base + 200 } as CompetitorBehaviour },
    { sellerRef: `Demo Wave ${idProduct}`, startMinor: base + 20,
      behaviour: { kind: 'SCHEDULE', points: wave } as CompetitorBehaviour },
  ];
}

/**
 * Предложения демо. `bare` — как пришли с канала, до онбординга: без границ, себестоимости и стратегии. Это режим живого
 * прогона онбординга; для показа продавцу мир после прогона выглядит так же, как после настоящего пути.
 */
export function demoProducts(options: { bare: boolean }): LiveProduct[] {
  return Array.from({ length: DEMO_OFFERS }, (_, i) => {
    // Единица Kaufland — число БЕЗ ведущих нулей: адаптер берёт её из последних шести цифр товара и отклоняет «000001» как
    // неверную (первый прогон демо: 2710 записей цены отброшены VALIDATION, до канала не дошла ни одна)
    const idProduct = 340_100_001 + i;
    return {
      cls: i % 5 === 0 ? 'HOT' : 'WARM', idProduct, marketplace: 'de',
      behaviour: DEMO_DRIFT, competitorStartMinor: 1850 + (i % 7) * 10 + 30,
      pastMovesEveryMinutes: i % 5 === 0 ? 30 : 180,
      ...(options.bare ? { bare: true } : { pricingMode: 'ENGINE' as const, costMinor: 1000 + (i % 9) * 25 }),
      moreCompetitors: demoCompetitors(idProduct),
    };
  });
}

/** Часы, которые не двигают — они идут сами: `advance` ничего не делает, пауза ждёт по-настоящему */
class WallClock extends VirtualClock {
  constructor() { super(new Date().toISOString()); }
  override nowMs(): number { return Date.now(); }
  override iso(offsetMs = 0): string { return new Date(Date.now() + offsetMs).toISOString(); }
  override advance(): void { /* настоящее время идёт само */ }
  override sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
}

export interface DemoWorld {
  live: KauflandLiveWorld;
  clock: VirtualClock;
  /** Прогнать демо вперёд на N виртуальных часов настоящим планировщиком: опрос конкурентов, решения, записи в канал */
  advance(hours: number): Promise<void>;
}

export async function demoWorld(input: {
  tag: number; startIso: string; bare: boolean; seed?: number;
  appPool: PgPool; adminPool: PgPool; provisioningPool: PgPool; dispatcherPool: PgPool; schedulerPool: PgPool; exporterPool: PgPool;
  /**
   * Часы мира — НАСТОЯЩИЕ (стенд для показа продавцу). Живой прогон идёт на виртуальных и проживает два часа за минуты; стенд
   * так не может: консоль пишет по часам базы, и мир, отставший от них, считает только что внесённую себестоимость ещё не
   * действующей, а убежавший вперёд расходится с базой во всём, что она считает по `now()` (ревью шага 34, находка 9).
   */
  wallClock?: boolean;
  /** Существующие пользователи стенда (псевдоним членства → user_id): владелец демо — тот же человек, что входит на стенд */
  memberUsers?: Readonly<Record<string, string>>;
  memberEmails?: Readonly<Record<string, string>>;
  joinMember?: Parameters<typeof kauflandLiveWorld>[0]['joinMember'];
}): Promise<DemoWorld> {
  const clock = input.wallClock ? new WallClock() : new VirtualClock(input.startIso);
  const live = await kauflandLiveWorld({
    tag: input.tag, clock, products: demoProducts({ bare: input.bare }), seed: input.seed ?? input.tag, demo: true,
    ...(input.memberUsers ? { memberUsers: input.memberUsers } : {}), ...(input.memberEmails ? { memberEmails: input.memberEmails } : {}),
    ...(input.joinMember ? { joinMember: input.joinMember } : {}),
    appPool: input.appPool, adminPool: input.adminPool, provisioningPool: input.provisioningPool, dispatcherPool: input.dispatcherPool,
    // Р-150: рядом с рабочим Kaufland — Amazon без доступа, с перечнем того, чего не хватает
    awaitingAccounts: [{ channelAccountId: `acc-amazon-awaiting-${input.tag}`, channel: 'AMAZON', region: 'EU', marketplaces: ['de'],
      awaitingAccess: ['NOTIFICATION_QUEUE', 'SELLER_AUTHORIZATION'] }],
  });
  const base = pgJobDeps({
    schedulerPool: input.schedulerPool, exporterPool: input.exporterPool, ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'KAUFLAND' ? live.adapter.descriptor : null),
    pipelineFor: () => live.pipelineForDbIds(),
    reconcileEnabled: () => false,
  });
  // ClickHouse в демо нет: выгрузка суток сообщает о провале, как в живом прогоне планировщика
  /**
   * Планировщик — платформенный и берёт ВСЕ активные аккаунты базы. Демо ведёт только свой: иначе путь решения демо
   * получал бы чужие аккаунты, и адаптер честно отвечал бы «аккаунт не найден» [Р-31] на каждый такт.
   */
  const ownAccount = live.seeded.channelAccountId;
  const deps: JobDeps = {
    ...base,
    accounts: async () => (await base.accounts()).filter((a) => a.channelAccountId === ownAccount),
    exportDay: async () => { throw new Error('CLICKHOUSE_NOT_IN_DEMO'); },
  };
  return {
    live, clock,
    async advance(hours) {
      const endMs = clock.nowMs() + hours * HOUR;
      const scheduler = createScheduler({
        state: new PgSchedulerState(input.schedulerPool), source: jobSource(deps), owner: `demo-${input.tag}`, now: () => clock.iso(),
        alerts: { raise: async () => undefined },
      });
      const running = runScheduler(scheduler, {
        tickMs: 30_000, clockMs: () => clock.nowMs(), logger: { log: () => {} },
        sleep: async (ms) => { await clock.sleep(ms); await live.betweenTicks(); },
        shouldStop: () => clock.nowMs() >= endMs,
      });
      await running.finished;
    },
  };
}

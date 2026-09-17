import type { AdapterCallContext, AdapterLogger } from '@repracer/channel-port';

/**
 * Консервативные правила адаптера Amazon: поведение, выбранное из-за факта API, которого снимок и страницы документации не
 * подтверждают. Код пишется в журнал при срабатывании; question — вопрос в channel-capabilities.md §9.
 */
export interface ConservativeRule { question: string | null; behaviour: string; whenAnswered: string }

export const AMAZON_CONSERVATIVE_RULES = {
  AMZ_C01_TWO_LEVEL_BUDGET: {
    question: 'A-09',
    behaviour: 'Бюджет запросов на двух уровнях: пара аккаунт–приложение и приложение (общий для всех тенантов процесса); запрос не отправляется, если исчерпан любой. Burst уровня приложения не документирован — принят равным burst пары',
    whenAnswered: 'Задать документированный burst приложения; общий бюджет приложения для нескольких экземпляров — в общем хранилище (OQ-78)',
  },
  AMZ_C02_NO_TRANSPORT_RETRY_FOR_WRITES: {
    question: 'A-06',
    behaviour: 'patchListingsItem не повторяется транспортом после тайм-аута и 5xx: исход OUTCOME_UNKNOWN, ядро сверяет обратным чтением',
    whenAnswered: 'Если повтор той же отправки безопасен и не меняет порядок применения — разрешить транспортный повтор',
  },
  AMZ_C03_READ_BEFORE_PRICE_WRITE: {
    question: null,
    behaviour: 'Перед записью цены getListingsItem читает атрибуты оффера: правило автоматического ценообразования [Р-115] или границы цены канала [Р-114] — запись не отправляется, единица требует человека',
    whenAnswered: '— (решения Р-114, Р-115)',
  },
  AMZ_C04_OUR_PRICE_VALUE_WITH_TAX: {
    question: 'A-02',
    behaviour: 'Цена пишется в our_price.schedule.value_with_tax для всех витрин, как в примерах страницы manage-purchasable-offer; для amazon.com смысл «with tax» при цене без налога с продаж не подтверждён',
    whenAnswered: 'Для витрин без налога в цене — перейти на подтверждённое поле; сверка базы цены [Р-116] остаётся',
  },
  AMZ_C05_CONFIRMATION_WINDOW: {
    question: 'A-06',
    behaviour: 'Принятая запись (ACCEPTED) подтверждается обратным чтением; пока значение не совпало — PENDING, после окна 30 минут — NOT_APPLIED',
    whenAnswered: 'Окно — по ответу о предельном времени применения',
  },
  AMZ_C06_MULTI_MARKETPLACE_ISSUES: {
    question: 'A-11',
    behaviour: 'Один PATCH цены на несколько витрин региона: INVALID отклоняет все витрины; ошибка ERROR с marketplaceIds — только эти витрины; ошибка ERROR без marketplaceIds — все',
    whenAnswered: 'Если принятая отправка применяется частично — сверка по витринам остаётся, правило разбора ошибок уточняется',
  },
  AMZ_C07_COMPETITOR_PULL_UNAVAILABLE: {
    question: null,
    behaviour: 'Опрос конкурентов не выполняется: getCompetitiveSummary — 0.033 запроса в секунду, burst 1 (CLAUDE.md); конкуренты — только ANY_OFFER_CHANGED',
    whenAnswered: '—',
  },
  AMZ_C08_NOTIFICATION_NOT_SIGNED: {
    question: 'A-12',
    behaviour: 'Уведомление приходит из очереди без подписи: принимается, только если SellerId уведомления равен аккаунту из сообщения [Р-31]; повтор — тот же NotificationId',
    whenAnswered: 'Если канал доставки даёт проверяемую подлинность — проверять её до разбора',
  },
  AMZ_C09_PRODUCT_TYPE_FROM_SUMMARIES: {
    question: 'A-10',
    behaviour: 'productType запроса PATCH берётся из summaries оффера (чтение перед записью); примеры документации используют значение PRODUCT, но его пригодность для любого оффера не подтверждена',
    whenAnswered: 'Если PRODUCT подходит для записи цены и остатка любого оффера — чтение перед записью остаётся только ради Р-115',
  },
  AMZ_C10_RATE_LIMIT_HEADER: {
    question: null,
    behaviour: 'Заголовок x-amzn-RateLimit-Limit (лимит пары аккаунт–приложение) заменяет скорость пары в бюджете; уровень приложения заголовок не описывает',
    whenAnswered: '—',
  },
} as const satisfies Record<string, ConservativeRule>;

export type AmazonConservativeRuleCode = keyof typeof AMAZON_CONSERVATIVE_RULES;

export function logConservative(
  logger: AdapterLogger,
  ctx: Pick<AdapterCallContext, 'correlationId' | 'tenantId' | 'channelAccountId'> | undefined,
  code: AmazonConservativeRuleCode,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const rule: ConservativeRule = AMAZON_CONSERVATIVE_RULES[code];
  logger.log({
    level: 'WARN', code, message: rule.behaviour, ...(rule.question ? { question: rule.question } : {}),
    ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}),
    details,
  });
}

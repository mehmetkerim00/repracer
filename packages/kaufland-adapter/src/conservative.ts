import type { AdapterCallContext, AdapterLogger } from '@repracer/channel-port';

/**
 * Реестр консервативных правил адаптера Kaufland. Каждое правило — поведение, выбранное из-за факта API, который
 * документация не подтверждает. Код правила пишется в журнал при каждом срабатывании; question — вопрос в поддержку
 * (docs/channel-capabilities.md §7), после ответа на который правило пересматривается.
 */
export interface ConservativeRule {
  question: string | null;
  behaviour: string;
  whenAnswered: string;
}

export const CONSERVATIVE_RULES = {
  KFL_C01_REQUEST_BUDGET: {
    question: 'K-04',
    behaviour: 'Клиентский бюджет запросов ниже документированных 111 rps: на продавца и отдельно общий на партнёра; при нехватке запрос не отправляется',
    whenAnswered: 'Лимит на продавца — поднять бюджет продавца, снять общий бюджет партнёра; лимит на партнёра — общий бюджет становится основным и распределяется между тенантами',
  },
  KFL_C02_NO_TRANSPORT_RETRY_FOR_WRITES: {
    question: 'K-14',
    behaviour: 'Записи (PATCH, POST bulk) не повторяются транспортом после тайм-аута и 5xx; исход OUTCOME_UNKNOWN, ядро делает обратное чтение',
    whenAnswered: 'Если повтор идентичного PATCH безопасен — разрешить транспортный повтор для записей',
  },
  KFL_C03_QUANTITY_WITHOUT_LISTING_PRICE: {
    question: 'K-13',
    behaviour: 'Запись остатка отправляется без listing_price (иначе адаптер записал бы цену мимо Price Gate); отказ канала из-за listing_price — REQUIRES_HUMAN',
    whenAnswered: 'Если listing_price обязателен — остаток пишется только вместе с последней подтверждённой ценой, решение фиксируется в ADR',
  },
  KFL_C04_SMART_PRICING_REFUSED: {
    question: 'K-07',
    behaviour: 'Запись CHANNEL_MIN_PRICE (minimum_price) отклоняется всегда [Р-41]',
    whenAnswered: 'После проверки гипотезы нейтрализации на тестовом аккаунте и нового решения',
  },
  KFL_C05_MINIMUM_PRICE_OBSERVED: {
    question: 'K-08',
    behaviour: 'minimum_price > 0 в данных unit означает, что Smart Pricing включён вне системы: алерт CRITICAL',
    whenAnswered: 'Уточнить, какие изменения цены Smart Pricing сопровождаются событием',
  },
  KFL_C06_BUYBOX_PRICE_UNITS: {
    question: 'K-17',
    behaviour: 'GET /buybox возвращает price как number (double) «в валюте витрины»; значение считается в основных единицах и округляется до центов',
    whenAnswered: 'Если price уже в центах — убрать умножение на 100',
  },
  KFL_C07_WEBHOOK_SIGNATURE_VARIANT: {
    question: 'K-02',
    behaviour: 'Подпись уведомления проверяется только документированным способом: POST, полный URL запроса, сырое тело, Shop-Timestamp, секрет продавца; иначе отказ',
    whenAnswered: 'Заменить вариант подписи на подтверждённый (например, секрет партнёра)',
  },
  KFL_C08_CONFIRM_TIME_GRANULARITY: {
    question: 'K-15',
    behaviour: 'Подтверждение сравнивает значение, а не время: несовпадение в пределах окна после отправки — PENDING, после окна — NOT_APPLIED',
    whenAnswered: 'Если date_lastchange_iso надёжен — различать «не применено» и «перезаписано позже» по времени',
  },
  KFL_C09_BULK_ITEM_MISSING: {
    question: null,
    behaviour: 'Ответ 207 без записи по отправленному unit — исход записи неизвестен (OUTCOME_UNKNOWN)',
    whenAnswered: '—',
  },
  KFL_C10_PRICE_BASIS_GROSS_ASSUMED: {
    question: 'K-12',
    behaviour: 'Цены DE и AT считаются брутто; запись с базой NET отклоняется',
    whenAnswered: 'Если listing_price нетто — пересчитать базу в описании канала и в Gate',
  },
  KFL_C11_NO_EDIT_BUDGET: {
    question: 'K-05',
    behaviour: 'Лимит правок одного unit не документирован: бюджет правок не объявлен; 422 action-not-allowed на запись — REQUIRES_HUMAN до выяснения причины',
    whenAnswered: 'Если лимит есть — объявить EditBudgetRule в описании канала',
  },
  KFL_C12_WEBHOOK_TIMESTAMP_WINDOW: {
    question: 'K-03',
    behaviour: 'Shop-Timestamp — время события, повторы идут до ~12 ч: принимаются уведомления не старше 13 ч и не из будущего больше чем на 5 мин',
    whenAnswered: 'Сузить окно, если время подписи отличается от времени события',
  },
  KFL_C13_ORDER_DECREMENT_UNKNOWN: {
    question: 'K-11',
    behaviour: 'Уменьшает ли Kaufland amount при заказе — неизвестно: заказ порождает RESOURCE_CHANGED, остаток подтверждается обратным чтением',
    whenAnswered: 'Если канал уменьшает amount сам — ожидаемое уменьшение не считается расхождением',
  },
  KFL_C14_SHARED_QUANTITY_PROPAGATION: {
    question: 'K-06',
    behaviour: 'Остаток пишется через один unit-носитель id_offer; подтверждение читает все unit с этим id_offer на витринах аккаунта и требует совпадения',
    whenAnswered: 'Если распространение синхронное — достаточно чтения носителя',
  },
  KFL_C15_UNKNOWN_EVENT: {
    question: null,
    behaviour: 'Неизвестное событие уведомления превращается в RESOURCE_CHANGED без данных',
    whenAnswered: '—',
  },
  KFL_C16_UNITS_STATUS_ON_DEMAND: {
    question: 'K-04',
    behaviour: 'POST /units/status вызывается только для unit с is_live = false и порциями по 20',
    whenAnswered: 'Разрешить регулярные проверки, если лимит позволяет',
  },
  KFL_C17_SUBSCRIPTION_EVENT_NOT_IN_SPEC: {
    question: 'K-18',
    behaviour: 'item_unit_* и buy_box_changed есть в документации push-notifications, но не в перечне event_name спецификации 2.44.0: подписка пробуется, отказ канала — подписка неактивна, подтверждение и конкуренты идут опросом',
    whenAnswered: 'Если события доступны — убрать запасной опрос из расписания; если нет — Р-36 пересматривается',
  },
  KFL_C18_BUYBOX_IS_SELF_BY_ID_UNIT: {
    question: null,
    behaviour: 'Своё предложение в /buybox и buy_box_changed определяется по наличию id_unit (документация: идентификаторы видны только владельцу); без id_unit предложение считается чужим',
    whenAnswered: '—',
  },
  KFL_C19_NOTIFICATION_WITHOUT_PAYLOAD: {
    question: null,
    behaviour: 'Уведомление item_unit_* или buy_box_changed без payload — RESOURCE_CHANGED с идентичностью из resource: конкуренты — опрос GET /buybox, unit — обратное чтение (Р-46, выбор по факту доставки)',
    whenAnswered: '—',
  },
} as const satisfies Record<string, ConservativeRule>;

export type ConservativeRuleCode = keyof typeof CONSERVATIVE_RULES;

export function logConservative(
  logger: AdapterLogger,
  ctx: Pick<AdapterCallContext, 'correlationId' | 'tenantId' | 'channelAccountId'> | undefined,
  code: ConservativeRuleCode,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const rule: ConservativeRule = CONSERVATIVE_RULES[code];
  logger.log({
    level: 'WARN',
    code,
    message: rule.behaviour,
    ...(rule.question ? { question: rule.question } : {}),
    ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}),
    details,
  });
}

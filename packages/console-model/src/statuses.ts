import type { Tone } from './world.ts';

/**
 * Шаг 137 (BUG-03 и UX-08 отчёта Мердана «QA-A Bug & Findings Report 1.0»; решение владельца): ОДИН словарь статусов цены у Protections,
 * журнала решений и квитанции «Why this price». До шага Protections называл «corrected» и цель стратегии, поставленную на границу (цена
 * стала равна границе), и отказ Gate в пределах 10 % от границы (цена не менялась) — продавец читал отказ как поправку, а сводка
 * «corrected» считала отказы. Теперь у каждого случая своё слово, и выводится оно здесь одним правилом:
 *  - ADJUSTED_TO_LIMIT — цель стратегии поставлена на границу (минимум, пол маржи, пол распродажи, максимум): цена = граница;
 *  - REJECTED — Gate отклонил предложение, цена осталась прежней (больше 10 % за границей — ещё и «dangerous» [Р-73]);
 *  - BLOCKED — пауза: остановка человеком, неактивная единица, ограничители шага и частоты, запись остановлена перепроверкой при
 *    отправке, снимок отклонён проверкой входов или витрина остановлена;
 *  - HELD_IN_SHADOW — решение одобрено, но аккаунт в тени: в канал не ушло ничего [Р-169];
 *  - APPROVED_LIVE — решение одобрено у аккаунта в бою; дошло ли до магазина — шаги «отправка» и «подтверждение» квитанции;
 *  - NO_CHANGE — менять цену не нужно.
 */
export type PriceStatus = 'APPROVED_LIVE' | 'HELD_IN_SHADOW' | 'NO_CHANGE' | 'ADJUSTED_TO_LIMIT' | 'REJECTED' | 'BLOCKED';

export const PRICE_STATUS_TONE: Readonly<Record<PriceStatus, Tone>> = {
  APPROVED_LIVE: 'ok', HELD_IN_SHADOW: 'warn', NO_CHANGE: 'off', ADJUSTED_TO_LIMIT: 'progress', REJECTED: 'stop', BLOCKED: 'off',
};

/**
 * Статус решения: исход Gate и судьба цены. Тень — из последней записи решения (удержана тенью), а без записи — из признака решения
 * (`price_decision.shadow`): журнал решений записей не читает
 */
export function decisionStatus(d: { outcome: string; shadow?: boolean | null }, lastWriteStatus: string | null = null): PriceStatus {
  if (d.outcome === 'NO_CHANGE') return 'NO_CHANGE';
  if (d.outcome === 'REJECTED') return 'REJECTED';
  if (d.outcome === 'HELD') return 'BLOCKED';
  if (lastWriteStatus === 'SHADOW_HELD') return 'HELD_IN_SHADOW';
  return lastWriteStatus === null && d.shadow === true ? 'HELD_IN_SHADOW' : 'APPROVED_LIVE';
}

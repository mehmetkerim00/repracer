import type { Instant } from '@repracer/channel-port';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';

/**
 * Шаг 116 [Р-241]: журнал о решениях, а не о чтениях. Строка «без изменения» пишется при смене состояния единицы и не реже раза в сутки; между ними — живая
 * строка со счётчиком. Сутки — не вкус: доказательство границы суток требует перерыв между решениями не больше 36 часов [Р-204], пересчёт по расписанию ищет
 * единицы без решения за 24 часа, а горячее намерение живёт 3 суток, и квитанция сохраняет фразу с суммами [Р-28]
 */
export const NO_CHANGE_PULSE_SECONDS = 86_400;

/** Живая строка единицы: состояние последней строки журнала и сколько оценок с тем же состоянием схлопнуто после неё */
export interface NoChangeLive {
  /** NULL — последняя строка журнала изменила цену или отказала: следующее «без изменения» пишется */
  state: string | null;
  decidedAt: Instant;
  repeats: number;
  lastEvaluatedAt: Instant;
}

/**
 * Что у причины делает её ДРУГОЙ для продавца: чего не хватило стратегии и с какой стороны рамка. Суммы и возраст сюда не входят: цель стратегии идёт от цены
 * конкурента, и иначе каждое её движение снова давало бы строку. Причина «держателя нет» названа одним кодом намеренно: опрос называет большинство, уведомление
 * держателя не называет, и на одном предложении они чередуются
 */
const REASON_DETAIL_KEYS = ['unmet', 'missing', 'side', 'cause'] as const;

/** Состояние единицы: причина, цена удержания, версия стратегии, пол и потолок. Смена любого из них — новая строка журнала */
export function noChangeStateOf(
  intent: Pick<PriceIntentDraft, 'reason' | 'proposedMinor' | 'strategyId' | 'strategyVersion'>,
  decision: Pick<PriceDecisionDraft, 'effectiveFloorMinor' | 'effectiveCeilingMinor'>,
): string {
  const params = intent.reason.params as Record<string, unknown>;
  const detail = REASON_DETAIL_KEYS.map((k) => (typeof params[k] === 'string' ? params[k] : '')).join(',');
  return [intent.reason.code, detail, intent.proposedMinor, `${intent.strategyId}:${intent.strategyVersion}`, decision.effectiveFloorMinor, decision.effectiveCeilingMinor].join('|');
}

/** Оценка повторяет последнюю строку: то же состояние, и суточный пульс ещё не наступил */
export function repeatsNoChange(previous: NoChangeLive | null | undefined, state: string, now: Instant): boolean {
  return Boolean(previous) && previous!.state === state && Date.parse(now) - Date.parse(previous!.decidedAt) < NO_CHANGE_PULSE_SECONDS * 1000;
}

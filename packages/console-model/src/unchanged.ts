import type { DecisionPage } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';
import { periodPhrase, type Period } from './period.ts';
import { decisionItems, type DecisionListItem, type DecisionTrace } from './trace.ts';
import { unitOf, type ConsoleDecision, type ConsoleScope, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Шаг 169 (#36, решение владельца 2026-11-18): «Why didn't my price change?» — ответ только из СОХРАНЁННЫХ решений предложения за период.
 * Фраза сути — заголовок квитанции последнего решения (те же слова, что «Why this price»); «с какого времени» — цепочка последних решений с
 * той же сохранённой причиной; проверки — счётчик живой строки [Р-241]. Никакой причинности задним числом: решений нет — так и сказано, с
 * объяснением, когда решения появляются. Доказательства — квитанция последнего решения и строки журнала, свёрнуты.
 */

export type UnchangedState = 'UNCHANGED' | 'CHANGED' | 'NONE';

export interface UnchangedView {
  worldId: string;
  unit: UnitRef;
  periodPhrase: string;
  /** Период глубже хранения решений — отрезан и назван */
  clipped: boolean;
  state: UnchangedState;
  /** Строка сути над фразой: «The price stayed as it was — the latest decision in the last 7 days:» */
  lead: string | null;
  /** Заголовок квитанции последнего решения; у NONE — «No decision was computed …» */
  headline: string;
  status: { label: string; tone: Tone } | null;
  /** Факты из тех же строк: с какого времени, сколько проверок, последнее изменение, отправка */
  facts: string[];
  decisionId: string | null;
  evidence: DecisionTrace | null;
  history: DecisionListItem[];
  /** Сколько решений за период всего (журнал показывает первые) */
  total: number;
  /** Когда решения появляются — только у NONE */
  noneText: string | null;
}

/** Решение оставило цену магазина прежней: без изменения, отказ, пауза или одобрено в тени [Р-169] */
function keptPrice(d: ConsoleDecision, trace: DecisionTrace | null = null): boolean {
  if (d.outcome !== 'APPROVED') return true;
  return d.shadow === true || trace?.status.code === 'HELD_IN_SHADOW';
}

/** Ключ сохранённой причины: исход и код причины строки — ничего не выводится */
function storedReasonKey(d: ConsoleDecision): string {
  return `${d.outcome}:${d.noChangeReason ?? d.rejectionReason ?? d.reason.code}`;
}

export function unchangedView(
  world: StandWorld, scope: ConsoleScope, page: DecisionPage, latest: DecisionTrace | null, m: Messages, period: Period, clipped: boolean,
): UnchangedView {
  const t = m.ui.unchanged;
  const phrase = periodPhrase(period, m);
  const items = page.items as readonly ConsoleDecision[];
  const history = decisionItems(world, items, m);
  const base = { worldId: world.id, unit: unitOf(world, scope, m), periodPhrase: phrase, clipped, history, total: page.total };
  const first = items[0];
  if (!first) {
    return { ...base, state: 'NONE', lead: null, headline: t.none(phrase), status: null, facts: [], decisionId: null, evidence: null, noneText: t.noneWhen };
  }
  const evidence = latest && latest.decisionId === first.decisionId ? latest : null;
  const state: UnchangedState = keptPrice(first, evidence) ? 'UNCHANGED' : 'CHANGED';
  const facts: string[] = [];
  if (state === 'UNCHANGED') {
    // Цепочка последних решений с той же сохранённой причиной; дошла до конца выборки — «не позже», старше ничего не угадывается
    const key = storedReasonKey(first);
    let run = 0;
    while (run + 1 < items.length && storedReasonKey(items[run + 1]!) === key) run += 1;
    const oldest = items[run]!;
    facts.push(run + 1 === items.length ? t.sinceAtLeast(m.when(oldest.decidedAt)) : t.since(m.when(oldest.decidedAt)));
    if (history[0]?.checks) facts.push(history[0].checks);
    const changed = items.findIndex((d) => !keptPrice(d));
    if (changed >= 0) facts.push(t.lastChange(history[changed]!.price, m.when(items[changed]!.decidedAt)));
  } else if (evidence?.summary?.sending) {
    // Одобрено в бою: дошла ли цена до магазина — строка отправки квитанции, а не догадка
    facts.push(evidence.summary.sending);
  }
  return {
    ...base, state, lead: t.lead[state](phrase),
    headline: evidence?.headline ?? history[0]!.reason,
    status: evidence ? { label: evidence.status.label, tone: evidence.status.tone } : { label: history[0]!.outcome, tone: history[0]!.tone },
    facts, decisionId: first.decisionId, evidence, noneText: null,
  };
}

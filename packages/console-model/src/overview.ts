import type { DecisionCause, DecisionCauseCount, OfferMoneyFilter } from '@repracer/pricing-pipeline/store';
import { DECISION_CAUSES, OFFER_MONEY_FILTERS } from '@repracer/pricing-pipeline/store';
import { breakEvenOf } from './bounds.ts';
import type { Messages } from './i18n/index.ts';
import { periodPhrase, periodSearch, type Period } from './period.ts';
import type { StatusLineView } from './status-line.ts';
import type { ConsoleScope, StandWorld, Tone } from './world.ts';

/**
 * Шаг 171 (#34, ярус 2; решение владельца 2026-11-18): Daily Overview — первый пункт меню, четыре вопроса:
 *  - всё ли работает — части строки состояния (режим, остановки, свежесть) с их ссылками;
 *  - что изменилось и почему — решения окна по причине (`decisionCause`: одна причина на решение), решения и уникальные предложения, клик —
 *    журнал с фильтром причины того же окна;
 *  - где риск — опасные предложения, остановленные границами (Р-73), и аккаунты со старыми данными конкурентов;
 *  - что требует действия — причины «требует внимания» строки состояния и финансовые исключения (распродажа, цена ниже безубыточности).
 * Окно шага 171 — последние 24 часа (fallback владельца); «Since your last visit» — шаг 172. Никакой генерации текста: только группировка
 * сохранённого. Раскладка Live заложена (`layout`), не построена — пилот в тени
 */

export type OverviewLayout = 'SHADOW' | 'LIVE';

export interface OverviewLine {
  text: string;
  tone: Tone;
  /** Части адреса экрана рабочего пространства (`href(worldId, ...target)`) */
  target: string[];
  /** Число строки — ровно `total` её выборки; null — строка не о числе (режим, свежесть) */
  count: number | null;
}

export interface OverviewCauseGroup extends OverviewLine {
  cause: DecisionCause;
  title: string;
  decisions: number;
  offers: number;
}

export interface OverviewView {
  worldId: string;
  /** «In the last 24 hours» — окно всех карточек */
  windowText: string;
  /** Почему окно такое: отметки визита ещё нет */
  windowNote: string;
  layout: OverviewLayout;
  /** У пространства в бою или смешанного — раскладка Live ещё не построена, сказано словами */
  liveNote: string | null;
  working: OverviewLine[];
  changed: { lead: string; groups: OverviewCauseGroup[]; empty: string | null; total: number };
  risk: { items: OverviewLine[]; empty: string | null };
  action: { items: OverviewLine[]; empty: string | null };
}

export interface OverviewInput {
  worldId: string;
  period: Period;
  status: StatusLineView;
  causes: readonly DecisionCauseCount[];
  /** Опасные предложения окна, остановленные границами — число отчёта Protections того же периода */
  dangerous: number;
  money: Readonly<Record<OfferMoneyFilter, number>>;
}

/**
 * Шаг 171 (#34): финансовые исключения предложения — правило фильтра Money без базы: режим распродажи действует; цена ниже безубыточности
 * вне распродажи (как `MONEY_SQL` хранилища PostgreSQL)
 */
export function moneyExceptions(world: StandWorld, scope: ConsoleScope): OfferMoneyFilter[] {
  if (scope.clearance) return ['CLEARANCE'];
  const breakEven = breakEvenOf(scope, world);
  return scope.currentPriceMinor !== null && breakEven !== null && scope.currentPriceMinor < breakEven ? ['BELOW_BREAK_EVEN'] : [];
}

/** Итоги финансовых исключений по каталогу мира — правилом экрана; на PostgreSQL их считает база (`consoleCatalogFacts.money`) */
export function moneyCounts(world: StandWorld): Record<OfferMoneyFilter, number> {
  const out = Object.fromEntries(OFFER_MONEY_FILTERS.map((x) => [x, 0])) as Record<OfferMoneyFilter, number>;
  for (const scope of world.state.scopes) for (const x of moneyExceptions(world, scope)) out[x] += 1;
  return out;
}

export function overviewView(input: OverviewInput, m: Messages): OverviewView {
  const t = m.ui.overview;
  const phrase = periodPhrase(input.period, m);
  const window = periodSearch(input.period);
  const st = input.status;
  const layout: OverviewLayout = st.mode.kind === 'SENDING' || st.mode.kind === 'MIXED' ? 'LIVE' : 'SHADOW';
  const working: OverviewLine[] = [
    { text: st.mode.text, tone: st.mode.tone, target: st.mode.target, count: null },
    { text: st.stops.text, tone: st.stops.tone, target: st.stops.target, count: st.stops.count },
    ...st.freshness.map((f) => ({ text: `${f.text} · ${f.levelText}`, tone: f.tone, target: f.target, count: null })),
  ];
  const groups = DECISION_CAUSES.flatMap((cause): OverviewCauseGroup[] => {
    const c = input.causes.find((x) => x.cause === cause);
    if (!c || c.decisions === 0) return [];
    return [{ cause, title: t.causes[cause], decisions: c.decisions, offers: c.offers, text: t.counted(c.decisions, c.offers), count: c.decisions,
      tone: cause === 'STOPS' || cause === 'DATA_QUALITY' ? 'warn' : 'off', target: ['feed', 'decisions', window, cause] }];
  });
  const total = groups.reduce((n, g) => n + g.decisions, 0);
  const stale = st.freshness.filter((f) => f.level === 'STALE');
  const risk: OverviewLine[] = [
    ...(input.dangerous > 0 ? [{ text: t.risk.dangerous(input.dangerous), tone: 'stop' as Tone, target: ['protections', 'rules', window], count: input.dangerous }] : []),
    ...stale.map((f) => ({ text: t.risk.stale(f.text), tone: 'stop' as Tone, target: f.target, count: null })),
  ];
  const action: OverviewLine[] = [
    ...st.attention.reasons.map((r) => ({ text: r.text, tone: 'warn' as Tone, target: r.target, count: r.count })),
    ...OFFER_MONEY_FILTERS.filter((x) => input.money[x] > 0).map((x) => ({
      text: t.money[x](input.money[x]), tone: (x === 'BELOW_BREAK_EVEN' ? 'stop' : 'warn') as Tone,
      target: ['products', 'filter', new URLSearchParams({ money: x }).toString()], count: input.money[x],
    })),
  ];
  return {
    worldId: input.worldId, windowText: t.window(phrase), windowNote: t.windowNote, layout,
    liveNote: layout === 'LIVE' ? t.liveNote : null,
    working,
    changed: { lead: layout === 'SHADOW' ? t.changedShadow(phrase) : t.changedLive(phrase), groups, total, empty: groups.length === 0 ? t.noChanges(phrase) : null },
    risk: { items: risk, empty: risk.length === 0 ? t.noRisk(phrase) : null },
    action: { items: action, empty: action.length === 0 ? t.noAction : null },
  };
}

import type { Messages } from './i18n/index.ts';
import { channelNotes } from './products.ts';
import { storefrontName, type ConsoleScope, type StandWorld, type Tone } from './world.ts';
import { STRATEGY_STALENESS_SECONDS } from '@repracer/pricing-model';
import { ATTENTION_FILTERS, ATTENTION_REASONS, type AttentionCounts, type AttentionFilter, type AttentionReason } from '@repracer/pricing-pipeline/store';

/**
 * Шаг 146 (#34, ярус 1): строка состояния продавца — на каждом экране рабочего пространства. Четыре части: режим цен, действующие
 * остановки, свежесть данных конкурентов по аккаунту и «требует внимания» по причинам. Всё — из данных, которые консоль уже хранит; каждое
 * число ведёт ровно в ту выборку, из которой посчитано (спецификация — docs/evidence/step146-status-line.md)
 */

export { ATTENTION_FILTERS, ATTENTION_REASONS };
export type { AttentionCounts, AttentionFilter, AttentionReason };

/** Свежесть: не старше свежести стратегии (15 минут) — fresh; не старше часа (цель круга опроса пилота, Р-240) — ageing; иначе stale */
export const FRESH_SECONDS = STRATEGY_STALENESS_SECONDS;
export const AGEING_SECONDS = 3600;
export type FreshnessLevel = 'FRESH' | 'AGEING' | 'STALE';

/** Предложение без единого чтения — stale: его цена ждёт данных */
export function freshnessLevel(ageSeconds: number | null, unread: number): FreshnessLevel {
  if (unread > 0 || ageSeconds === null) return 'STALE';
  return ageSeconds <= FRESH_SECONDS ? 'FRESH' : ageSeconds <= AGEING_SECONDS ? 'AGEING' : 'STALE';
}

/** Включённые предложения аккаунта со стратегией из данных конкурентов и их самое давнее последнее чтение (`competitor_state.observed_at`) */
export interface FreshnessRow {
  channelAccountId: string;
  counted: number;
  /** Из них без единого принятого чтения */
  unread: number;
  oldestAt: string | null;
}

export interface StatusLineInput {
  worldId: string;
  now: string;
  accounts: ReadonlyArray<{ channelAccountId: string; channel: string; marketplaces: readonly string[]; authStatus: string; writeMode: 'SHADOW' | 'LIVE' }>;
  /** Действующая остановка человеком всего пространства — кто и когда (как на Stop pricing) */
  tenantStop: { by: string; stoppedAt: string } | null;
  /** Действующие остановки трёх видов — ровно те, что Stop pricing показывает действующими */
  activeStops: number;
  /** null — хранилище свежести не знает (тогда части нет) */
  freshness: readonly FreshnessRow[] | null;
  attention: AttentionCounts;
}

export type StatusMode = 'STOPPED' | 'SHADOW' | 'SENDING' | 'MIXED' | 'NONE';
const LEVEL_TONE: Readonly<Record<FreshnessLevel, Tone>> = { FRESH: 'ok', AGEING: 'warn', STALE: 'stop' };

export interface StatusLineView {
  worldId: string;
  /** Куда ведёт часть — части адреса экрана рабочего пространства (`href(worldId, ...target)`) */
  mode: { kind: StatusMode; text: string; tone: Tone; target: string[] };
  stops: { count: number; text: string; tone: Tone; target: string[] };
  freshness: Array<{ channelAccountId: string; account: string; text: string; level: FreshnessLevel; levelText: string; tone: Tone; target: string[] }>;
  attention: { count: number; text: string; tone: Tone; target: string[]; reasons: Array<{ code: AttentionReason; count: number; text: string; target: string[] }> };
}

/** Возраст словами: «4 min», «2 h 2 min» */
function ageText(seconds: number, m: Messages): string {
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? m.ui.statusLine.minutes(minutes) : m.ui.statusLine.hours(Math.floor(minutes / 60), minutes % 60);
}

export type FreshnessItem = StatusLineView['freshness'][number];

/**
 * Свежесть по аккаунтам — одна функция у строки состояния и у карточки аккаунта на Channels (куда ведёт ссылка строки): тот же текст тем же
 * расчётом. Аккаунт без включённых предложений со стратегией из данных конкурентов — не показывается
 */
export function freshnessItems(input: Pick<StatusLineInput, 'now' | 'accounts' | 'freshness'>, m: Messages): FreshnessItem[] {
  const t = m.ui.statusLine;
  const nowMs = Date.parse(input.now);
  return (input.freshness ?? []).filter((f) => f.counted > 0).flatMap((f) => {
    const a = input.accounts.find((x) => x.channelAccountId === f.channelAccountId);
    if (!a) return [];
    const account = a.marketplaces.map((id) => storefrontName(a.channel, id, m)).join(', ');
    const age = f.oldestAt ? Math.max(0, Math.round((nowMs - Date.parse(f.oldestAt)) / 1000)) : null;
    const level = freshnessLevel(age, f.unread);
    return [{
      channelAccountId: f.channelAccountId, account, level, levelText: t.levels[level], tone: LEVEL_TONE[level], target: ['channels'],
      text: f.unread > 0 || age === null ? t.unread(account, f.unread) : t.oldest(account, ageText(age, m)),
    }];
  });
}

export function statusLineView(input: StatusLineInput, m: Messages): StatusLineView {
  const t = m.ui.statusLine;
  const connected = input.accounts.filter((a) => a.authStatus === 'ACTIVE');
  const live = connected.filter((a) => a.writeMode === 'LIVE').length;
  const mode: StatusLineView['mode'] = input.tenantStop
    ? { kind: 'STOPPED', text: t.mode.stopped(input.tenantStop.by, m.when(input.tenantStop.stoppedAt)), tone: 'stop', target: ['stop'] }
    : connected.length === 0 ? { kind: 'NONE', text: t.mode.none, tone: 'off', target: ['channels'] }
      : live === 0 ? { kind: 'SHADOW', text: t.mode.shadow, tone: 'warn', target: ['shadow'] }
        : live === connected.length ? { kind: 'SENDING', text: t.mode.sending, tone: 'ok', target: ['channels'] }
          : { kind: 'MIXED', text: t.mode.mixed(live, connected.length, connected.length - live), tone: 'warn', target: ['channels'] };
  const freshness = freshnessItems(input, m);
  const a = input.attention;
  return {
    worldId: input.worldId,
    mode,
    stops: { count: input.activeStops, text: input.activeStops === 0 ? t.noStops : t.stops(input.activeStops), tone: input.activeStops === 0 ? 'off' : 'stop', target: ['stop'] },
    freshness,
    attention: {
      count: a.any, text: a.any === 0 ? t.nothing : t.attention(a.any), tone: a.any === 0 ? 'off' : 'warn', target: ['products', 'attention', 'ANY'],
      reasons: ATTENTION_REASONS.filter((r) => a.byReason[r] > 0).map((r) => ({ code: r, count: a.byReason[r], text: `${a.byReason[r]} ${t.reasonNames[r]}`, target: ['products', 'attention', r] })),
    },
  };
}

/**
 * Причины одного предложения — правило экрана без базы. Наблюдения канала — те же, что пилюли Offers (`channelNotes`): Automate Pricing,
 * рамки Amazon без значений (в тени и в бою), не продаётся на Amazon, снят с публикации Walmart. Себестоимость не готова — у предложения
 * нет `cost` (себестоимость, курс и действующая оценка комиссии — то же, что `tenant_data.write_scope_cost_ready`). Выключено — режим OFF и
 * последняя строка журнала выключения — OFF (Р-242); никогда не включённое предложение «выключенным» не считается
 */
export function attentionReasons(world: StandWorld, scope: ConsoleScope, m: Messages): AttentionReason[] {
  const codes = new Set(channelNotes(world, scope, m).flatMap((n) => { const r = attentionReasonOfNote(n.code); return r ? [r] : []; }));
  const reasons: AttentionReason[] = [];
  if (scope.cost === null) reasons.push('NO_UNIT_COST');
  for (const r of ['AUTOMATED_PRICING', 'CHANNEL_BOUNDS', 'NOT_BUYABLE'] as const) if (codes.has(r)) reasons.push(r);
  if (scope.pricingMode === 'OFF' && scope.pricingSwitch?.action === 'OFF') reasons.push('TURNED_OFF');
  return reasons;
}

/**
 * Шаг 174: какая заметка канала — причина внимания. Одно правило у строки состояния и у колонки Health Offers: жёлтая строка называет свою
 * причину в Health (наблюдение Мердана, QA-A Testing 2.0 — строка была жёлтой, а Health пуст)
 */
export function attentionReasonOfNote(code: string): AttentionReason | null {
  return code === 'AUTOMATED_PRICING' ? 'AUTOMATED_PRICING'
    : code === 'CHANNEL_BOUNDS' || code === 'CHANNEL_BOUNDS_LIVE' ? 'CHANNEL_BOUNDS'
    : code === 'LISTING_NOT_BUYABLE' || code === 'WALMART_UNPUBLISHED' ? 'NOT_BUYABLE'
    : null;
}

/** Фильтр Offers без базы: предложение проходит, если у него есть эта причина (ANY — любая) */
export function matchesAttention(reasons: readonly AttentionReason[], filter: AttentionFilter): boolean {
  return filter === 'ANY' ? reasons.length > 0 : reasons.includes(filter);
}

/** Итоги «требует внимания» по каталогу целиком — правилом экрана; на PostgreSQL их считает база тем же правилом */
export function attentionCounts(world: StandWorld, m: Messages): AttentionCounts {
  const byReason: Record<AttentionReason, number> = { NO_UNIT_COST: 0, AUTOMATED_PRICING: 0, CHANNEL_BOUNDS: 0, NOT_BUYABLE: 0, TURNED_OFF: 0 };
  let any = 0;
  for (const scope of world.state.scopes) {
    const reasons = attentionReasons(world, scope, m);
    if (reasons.length > 0) any += 1;
    for (const r of reasons) byReason[r] += 1;
  }
  return { any, byReason };
}

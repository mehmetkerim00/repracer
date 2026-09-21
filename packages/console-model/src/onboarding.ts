import type { ChannelAccountRow, OnboardingProgressRow, OnboardingStep, OnboardingStepStatus } from '@repracer/pricing-pipeline';
import { ONBOARDING_STEPS } from '@repracer/pricing-pipeline';
import { can } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import type { StandWorld } from './world.ts';

/**
 * Р-149 (шаг 34): онбординг — направляемый путь, а не набор экранов. Экран показывает шаги в порядке, состояние каждого,
 * ВЫВЕДЕННОЕ из данных (а не из галочек), и место, с которого путь продолжается. Пропустить себестоимость нельзя [Р-131] —
 * можно только сузить набор предложений: и это единственное, что экран пишет сам.
 */

export interface OnboardingStepView {
  step: OnboardingStep;
  title: string;
  hint: string;
  done: boolean;
  current: boolean;
  /** «7 из 200» — сколько предложений набора прошло шаг */
  progress: string;
  doneCount: number;
  totalCount: number;
  /** Только у шага канала: хотя бы один аккаунт ждёт доступа [Р-150] */
  awaiting: boolean;
  /** Куда идти, чтобы сделать шаг — экран консоли */
  goTo: { screen: string; label: string } | null;
}

/**
 * Итог задания включения, как его видит экран [Р-147: наружу идёт только `view`]. Отказанные предложения названы
 * ПОИМЁННО и с причиной словами — «не включено 50, смотрите список» без списка продавцу ничего не говорит.
 */
export interface EnableResultView {
  enabled: number;
  already: number;
  skipped: number;
  byCode: Array<{ code: string; title: string; count: number }>;
  /** Первые пятьдесят отказанных: название предложения и причины словами словаря */
  examples: Array<{ writeScopeId: string; label: string; reasons: string[] }>;
}

export interface ChannelAccountView {
  channelAccountId: string;
  channel: string;
  label: string;
  status: ChannelAccountRow['authStatus'];
  statusText: string;
  /** Р-150: чего не хватает, чтобы канал заработал, — перечнем, а не ошибкой и не пустотой. Код — для проверки, текст — продавцу */
  blockers: Array<{ code: ChannelAccountRow['accessBlockers'][number]; text: string }>;
  awaitingHint: string | null;
}

export interface OnboardingView {
  worldId: string;
  demo: boolean;
  intro: string;
  steps: OnboardingStepView[];
  /** Шаг, с которого путь продолжается: первый незавершённый */
  resumeAt: OnboardingStep | 'DONE';
  resumeText: string;
  channels: ChannelAccountView[];
  /** Сужение набора [Р-131]: предложено, когда себестоимость есть не у всех */
  narrowing: { offered: boolean; withCost: number; total: number; narrowedTo: number | null; hint: string } | null;
  /** Сужать набор вправе тот, кто правит цены */
  canLead: boolean;
  /** Включать движок — своё право [Р-143]: оператор включает, хотя цен не правит */
  canEnable: boolean;
  /** Сколько предложений набора включит последний шаг */
  enableCount: number;
}

const GO_TO: Record<Exclude<OnboardingStep, 'TENANT'>, string> = { CHANNEL: 'onboarding', COSTS: 'cost-import', BOUNDS: 'bounds', STRATEGY: 'strategies', ENABLE: 'products' };

export function onboardingView(world: StandWorld, progress: OnboardingProgressRow | null, status: OnboardingStepStatus[],
  accounts: ChannelAccountRow[], m: Messages): OnboardingView {
  const t = m.ui.onboarding;
  const byStep = new Map(status.map((s) => [s.step, s]));
  const firstOpen = ONBOARDING_STEPS.find((s) => !(byStep.get(s)?.done ?? false)) ?? null;
  const resumeAt: OnboardingStep | 'DONE' = firstOpen ?? 'DONE';
  const steps: OnboardingStepView[] = ONBOARDING_STEPS.map((step) => {
    const s = byStep.get(step) ?? { step, doneCount: 0, totalCount: 0, done: false, awaiting: false };
    return {
      step, title: t.steps[step], hint: t.stepHints[step], done: s.done, current: step === resumeAt,
      progress: t.progress(s.doneCount, s.totalCount), doneCount: s.doneCount, totalCount: s.totalCount, awaiting: s.awaiting,
      goTo: step === 'TENANT' ? null : { screen: GO_TO[step], label: t.goTo[step] },
    };
  });
  const costs = byStep.get('COSTS');
  const narrowing = costs && costs.totalCount > 0 && costs.doneCount < costs.totalCount
    ? { offered: costs.doneCount > 0, withCost: costs.doneCount, total: costs.totalCount, narrowedTo: progress?.scopeWriteScopeIds?.length ?? null, hint: t.narrowHint(costs.doneCount, costs.totalCount) }
    : progress?.scopeWriteScopeIds ? { offered: false, withCost: costs?.doneCount ?? 0, total: costs?.totalCount ?? 0, narrowedTo: progress.scopeWriteScopeIds.length, hint: t.narrowed(progress.scopeWriteScopeIds.length) }
      : null;
  const channels: ChannelAccountView[] = accounts.map((a) => ({
    channelAccountId: a.channelAccountId, channel: a.channel, label: a.displayName ?? `${a.channel} · ${a.marketplaces.join(', ')}`,
    status: a.authStatus, statusText: t.channels.status[a.authStatus],
    blockers: a.accessBlockers.map((code) => ({ code, text: t.channels.blockers[code] })),
    awaitingHint: a.authStatus === 'AWAITING_ACCESS' ? t.channels.awaitingHint : null,
  }));
  const enable = byStep.get('ENABLE');
  return {
    worldId: world.id, demo: world.demo === true, intro: world.demo === true ? `${t.demoIntro} ${t.intro}` : t.intro, steps, resumeAt,
    resumeText: resumeAt === 'DONE' ? t.completed : t.resumeAt(t.steps[resumeAt]),
    channels, narrowing, canLead: can(world.viewer.role, 'MANAGE_PRICING'), canEnable: can(world.viewer.role, 'ENABLE_REPRICING'),
    enableCount: enable ? enable.totalCount - enable.doneCount : 0,
  };
}

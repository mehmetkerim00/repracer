import type { Scenario } from '../harness/scenario.ts';
import { asin, convertKauflandScenario } from './build.ts';

type PipelineExpect = { writes?: Array<{ status?: string }>; competitorState?: Record<string, Record<string, unknown>>; halts?: unknown[]; haltReviews?: unknown[] };

/** Запись Amazon принимается асинхронно: после PATCH ACCEPTED запись ждёт обратного чтения, APPLIED не наступает сразу */
function acceptedNotYetApplied(...indexes: number[]) {
  return (s: Scenario) => {
    const writes = (s.expect!.pipeline as PipelineExpect).writes!;
    for (const i of indexes) writes[i]!.status = 'ACCEPTED';
    s.description += ' Amazon: patchListingsItem отвечает ACCEPTED, применение подтверждает обратное чтение — запись в конце сценария ACCEPTED, а не APPLIED.';
  };
}

function stepExpect(s: Scenario, id: string, expect: unknown) {
  const step = s.steps.find((x) => x.id === id)!;
  (step as { expect?: unknown }).expect = expect;
}

/** Обязательные сценарии пути решения: те же, что у Kaufland, с поправками асинхронной записи Amazon */
export const PIPELINE_CONVERSIONS: ReadonlyArray<{ file: string; kaufland: string; id: string; title: string; patch?: (s: Scenario) => void }> = [
  { file: 'pipeline-sanity-x100-high.json', kaufland: 'pipeline-sanity-x100-high.json', id: 'amazon/pipeline/sanity-x100-high', title: 'Цена конкурента ×100 в уведомлении: снимок отклонён, второй товар проходит', patch: acceptedNotYetApplied(0) },
  { file: 'pipeline-sanity-x100-low.json', kaufland: 'pipeline-sanity-x100-low.json', id: 'amazon/pipeline/sanity-x100-low', title: 'Цена конкурента ×0.01 в уведомлении: снимок отклонён' },
  { file: 'pipeline-mass-shift-halt.json', kaufland: 'pipeline-mass-shift-halt.json', id: 'amazon/pipeline/mass-shift-halt', title: 'Массовый сдвиг цен витрины: остановка витрины', patch: acceptedNotYetApplied(0, 1) },
  { file: 'pipeline-above-max-price.json', kaufland: 'pipeline-above-max-price.json', id: 'amazon/pipeline/above-max-price', title: 'Цена выше max_price: Gate отклоняет', patch: acceptedNotYetApplied(0) },
  { file: 'pipeline-max-price-missing.json', kaufland: 'pipeline-max-price-missing.json', id: 'amazon/pipeline/max-price-missing', title: 'Без max_price репрайсинг не включается' },
  { file: 'pipeline-bound-unresolvable.json', kaufland: 'pipeline-bound-unresolvable.json', id: 'amazon/pipeline/bound-unresolvable', title: 'Граница не вычисляется: оценка не выполняется, алерт' },
  { file: 'pipeline-oq90-own-price-trap.json', kaufland: 'pipeline-oq90-own-price-trap.json', id: 'amazon/pipeline/oq90-own-price-trap', title: 'Наша цена — не якорь проверки входов', patch: acceptedNotYetApplied(0) },
  { file: 'pipeline-cold-start-cost-anchor.json', kaufland: 'pipeline-cold-start-cost-anchor.json', id: 'amazon/pipeline/cold-start-cost-anchor', title: 'Холодный старт: якорь — себестоимость', patch: acceptedNotYetApplied(0) },
  {
    file: 'pipeline-halt-auto-release.json', kaufland: 'pipeline-halt-auto-release.json', id: 'amazon/pipeline/halt-auto-release',
    title: 'Р-119: автоматическое снятие остановки витрины по выборке на Amazon неприменимо — свойство канала',
    patch: (s) => {
      s.description = 'Преобразован из kaufland/pipeline-halt-auto-release.json. Р-52 снимает остановку по свежей независимой выборке, а выборка — это опрос конкурентов. У Amazon опроса нет: getCompetitiveSummary — 0.033 запроса в секунду [AMZ_C07]. Р-119: это свойство канала (ChannelDescriptor.haltRelease = MANUAL_ONLY, platform.channel_behaviour), а не пробел — проверка остановок не пробует читать конкурентов и не пишет провал выборки; остановку снимает только человек.';
      s.exchanges = [];
      s.tags = [...s.tags, 'r119'];
      stepExpect(s, 'review-due-halt', [{ outcome: 'MANUAL_ONLY', sampleSize: 0, failedCount: 0, snapshots: [], failures: [] }]);
      s.expect = { noAlerts: true, logs: [{ code: 'HALT_RELEASE_MANUAL_ONLY', count: 1 }, { code: 'HALT_REVIEW_FAILED', count: 0 }],
        pipeline: { halts: [{ reasonCode: 'CHANNEL_MASS_SHIFT', releasedKind: null }], haltReviews: [], writes: [] } };
    },
  },
  {
    file: 'pipeline-halt-review-failed-manual-release.json', kaufland: 'pipeline-halt-review-failed-manual-release.json', id: 'amazon/pipeline/halt-manual-release',
    title: 'Р-119: выборки нет — остановку витрины снимает человек с заметкой',
    patch: (s) => {
      s.description += ' Amazon [Р-119]: проверка остановок выборку не пробует — канал снимает остановку только вручную; ручное снятие работает так же.';
      stepExpect(s, 'review-due-halt', [{ outcome: 'MANUAL_ONLY', sampleSize: 0, failedCount: 0, snapshots: [], failures: [] }]);
      const expect = s.expect as { logs: Array<{ code: string; count?: number }>; pipeline: PipelineExpect };
      expect.logs = [{ code: 'HALT_RELEASE_MANUAL_ONLY', count: 1 }, { code: 'HALT_REVIEW_FAILED', count: 0 }, { code: 'HALT_MANUALLY_RELEASED', count: 1 }];
      expect.pipeline.haltReviews = [{ kind: 'MANUAL_RELEASE', outcome: 'RELEASED' }];
      s.exchanges = [];
    },
  },
  {
    file: 'pipeline-bounds-version-changed.json', kaufland: 'pipeline-bounds-version-changed.json', id: 'amazon/pipeline/bounds-version-changed', title: 'Границы изменились между чтением и фиксацией: пересчёт',
    patch: (s) => {
      acceptedNotYetApplied(0)(s);
      // Подсказки цены канала (Kaufland target_price) в ANY_OFFER_CHANGED нет
      for (const state of Object.values((s.expect!.pipeline as PipelineExpect).competitorState ?? {})) delete state.suggestedMinor;
    },
  },
  { file: 'pipeline-tax-regimes-margin-floor.json', kaufland: 'pipeline-tax-regimes-margin-floor.json', id: 'amazon/pipeline/tax-regimes-margin-floor', title: 'НДС в цене amazon.de и налог с продаж amazon.com: пол маржи' },
  ...(['pipeline-write-queue-second-not-lost.json', 'pipeline-write-superseded-with-reason.json'] as const).map((k) => ({
    file: k, kaufland: k, id: `amazon/pipeline/${k.replace(/^pipeline-|\.json$/g, '')}`,
    title: k.includes('queue') ? 'Вторая цена ждёт первую в полёте и не теряется' : 'Устаревшая ждущая цена вытесняется с причиной',
    patch: (s: Scenario) => {
      s.description += ' Amazon: последняя отправка обхода — ACCEPTED без применения, единица остаётся в полёте до обратного чтения, поэтому шага IDLE нет.';
      const step = s.steps.find((x) => x.id === 'dispatcher-sweep') as { expect: { reports: Array<{ steps: Array<{ action: string; recorded?: string }> }> } };
      const steps = step.expect.reports[0]!.steps;
      steps.pop();
      steps[steps.length - 1]!.recorded = 'ACCEPTED';
      const writes = (s.expect!.pipeline as PipelineExpect).writes!;
      writes[writes.length - 1]!.status = 'ACCEPTED';
    },
  })),
  { file: 'pipeline-fx-usd-floor-eur-cost.json', kaufland: 'pipeline-fx-usd-floor-eur-cost.json', id: 'amazon/pipeline/fx-usd-floor-eur-cost', title: 'Пол amazon.com в USD при себестоимости в EUR' },
  { file: 'pipeline-fx-cross-channel-anchor-converted.json', kaufland: 'pipeline-fx-cross-channel-anchor-converted.json', id: 'amazon/pipeline/fx-cross-channel-anchor', title: 'Якорь «тот же EAN» в другой валюте переводится по курсу', patch: acceptedNotYetApplied(0) },
];

export function buildPipelineScenarios(): Array<{ file: string; scenario: Scenario }> {
  return PIPELINE_CONVERSIONS.map((c) => {
    const { scenario } = convertKauflandScenario(c.kaufland, c.id, c.title);
    c.patch?.(scenario);
    return { file: c.file, scenario };
  });
}

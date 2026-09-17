import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import type { Exchange, Scenario, Step } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';
import { amazonWorld, DE, patchPriceExchange, preReadExchange, readBackExchange, sku, tokenExchange } from './build.ts';

/**
 * Сценарии ядра с адаптером Amazon (шаг 22): Р-115 — правило автоматического ценообразования канала блокирует единицу записи и
 * при записи, и при обратном чтении; Р-116 — применённая цена отличается от отправленной на ставку НДС: остановка витрины, любая
 * цена удерживается, снятие — только человеком. Данные синтетические.
 */

const SOURCES = [
  'vendor/amazon/sp-api-models/2026-09-16/models/listings-items-api-model/listingsItems_2021-08-01.json',
  'https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md',
  'docs/decisions.md#Р-115',
  'docs/decisions.md#Р-116',
];

const ACCOUNT = '20000000-0000-4000-8000-000000000001';

function fixedScope(unit: number, priceMinor: number, currentMinor: number): MemorySeedScope {
  return {
    writeScopeId: `ws-price-de-${unit}`, productId: `prod-${unit}`, channelAccountId: ACCOUNT, marketplace: DE, externalUnitId: sku(unit),
    channelProductRef: `B0${String(unit).padStart(8, '0')}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
    strategy: { strategyId: `st-fixed-${priceMinor}`, version: 1, params: { type: 'FIXED', priceMinor }, deadbandMinor: 0 },
    currentPriceMinor: currentMinor, minPrice: { amountMinor: 1000, id: `min-${unit}` }, maxPrice: { amountMinor: 5000, id: `max-${unit}` },
    // Ставка НДС товара [Р-53] — ей сверяется база цены при обратном чтении [Р-116]
    cost: { currency: 'EUR', costProfileId: `cp-${unit}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  };
}

function scenario(id: string, title: string, description: string, tags: string[], scopes: MemorySeedScope[], steps: Step[], exchanges: Exchange[], expect: Scenario['expect']): Scenario {
  return {
    format: SCENARIO_FORMAT, id, channel: 'AMAZON', apiVersion: 'listings-items-2021-08-01', title, description, tags,
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: SOURCES },
    world: amazonWorld({ pricing: { scopes, marketplaces: { [DE]: { currency: 'EUR', basis: 'GROSS' } } } } as never),
    steps, exchanges, expect,
  };
}

const recompute = (id: string, unit: number, expect: unknown): Step => ({ id, kind: 'pipelineRecompute', writeScopeId: `ws-price-de-${unit}`, trigger: { type: 'COST_CHANGE' }, expect } as Step);

export function buildCoreScenarios(): Array<{ file: string; scenario: Scenario }> {
  const basis = scenario(
    'amazon/pipeline/price-basis-mismatch-halt',
    'Р-116, Р-118: применённая цена больше отправленной ровно на НДС — недоверие каналу, фиксированная цена удерживается, снятие только человеком',
    'Фиксированная цена 19.99 уходит в amazon.de и принята асинхронно. Обратное чтение после окна: our_price 19.99 как отправлено, но цена покупки в offers — 23.79, то есть 19.99 × 1.19. Канал считает нашу сумму нетто [A-02]: каждая следующая цена будет выше на ту же долю — сломана трансляция цены в канал. Диспетчер ставит ОСТАНОВКУ ПО НЕДОВЕРИЮ КАНАЛУ [Р-118] и CRITICAL-алерт. Это не остановка витрины Р-51: удерживается и фиксированная цена второго товара; проверка остановок её не касается. Снять её не может ни оператор, ни владелец без второго фактора; владелец со вторым фактором и заметкой снимает — после этого цена второго товара уходит.',
    ['pipeline', 'dispatcher', 'r116', 'r118', 'mandatory:price-basis-readback'],
    [fixedScope(8101, 1999, 1850), fixedScope(8102, 2100, 2000)],
    [
      recompute('first-fixed-price-accepted', 8101, { decision: { outcome: 'APPROVED', finalMinor: 1999 } }),
      { id: 'in-flight-window-passes', kind: 'advanceClock', ms: 121_000 },
      { id: 'readback-shows-tax-added', kind: 'pipelineDispatchDue', expect: { due: 1, reports: [{ writeScopeId: 'ws-price-de-8101', steps: [
        { action: 'RECONCILED', version: 1, result: 'APPLIED', recorded: 'APPLIED' }, { action: 'CHANNEL_DISTRUSTED' }, { action: 'IDLE' }] }] } } as Step,
      recompute('second-fixed-price-held', 8102, { decision: { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' } }),
      { id: 'halt-review-does-not-touch-distrust', kind: 'pipelineReviewHalts', sampleSize: 5, expect: [] } as Step,
      { id: 'operator-cannot-release', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-operator', note: 'Operator tries to release the distrust' } as Step,
      { id: 'owner-without-second-factor-cannot-release', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-owner', mfa: false, note: 'Owner without a second factor' } as Step,
      recompute('still-held-after-refused-releases', 8102, { decision: { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' } }),
      { id: 'owner-releases-after-fixing-price-settings', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-owner', note: 'Preisbasis im Kanalkonto geprüft und korrigiert', expect: { released: true } } as Step,
      recompute('second-fixed-price-after-release', 8102, { decision: { outcome: 'APPROVED', finalMinor: 2100 } }),
    ],
    [
      tokenExchange(),
      preReadExchange('pre-read-8101', sku(8101), [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-8101-1999', sku(8101), [{ minor: 1999 }]),
      readBackExchange('readback-8101-net-treated', sku(8101), [{ priceMinor: 1999, purchaseMinor: 2379 }]),
      preReadExchange('pre-read-8102', sku(8102), [{ priceMinor: 2000 }]),
      patchPriceExchange('patch-8102-2100', sku(8102), [{ minor: 2100 }]),
    ],
    {
      alerts: [{ code: 'PRICING_CHANNEL_DISTRUSTED', severity: 'CRITICAL', count: 1 }, { code: 'PRICING_CHANNEL_TRUST_RESTORED', severity: 'WARNING', count: 1 }],
      pipeline: {
        halts: [],
        distrusts: [{ reasonCode: 'PRICE_BASIS_MISMATCH', released: true }],
        decisions: [
          { outcome: 'APPROVED', finalMinor: 1999 }, { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' }, { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' },
          { outcome: 'APPROVED', finalMinor: 2100 },
        ],
        writes: [{ amountMinor: 1999, status: 'APPLIED' }, { amountMinor: 2100, status: 'ACCEPTED' }],
      },
    },
  );

  const repricer = scenario(
    'amazon/pipeline/channel-repricer-blocks-scope',
    'Р-115: правило автоматического ценообразования Amazon у оффера — единица записи блокируется, продавец получает действие',
    'Первый товар: чтение перед записью показывает привязку automated_pricing_merchandising_rule_plan — PATCH не отправляется, запись отклонена CHANNEL_REPRICER_ACTIVE (REQUIRES_HUMAN), единица BLOCKED, CRITICAL-алерт с кодом и действием «выключить репрайсер канала». Второй товар: запись принята, а правило привязано в кабинете позже — изменения правил асинхронны, поэтому обратное чтение getListingsItem видит его уже после записи: сверка не повторяется час, единица блокируется сразу, принятая запись остаётся принятой.',
    ['pipeline', 'dispatcher', 'r115', 'mandatory:channel-repricer-pipeline'],
    [fixedScope(8201, 1999, 1850), fixedScope(8202, 2100, 2000)],
    [
      recompute('repricer-rule-before-write', 8201, { decision: { outcome: 'APPROVED', finalMinor: 1999 } }),
      recompute('scope-blocked-next-decision-held', 8201, { decision: { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE' } }),
      recompute('second-accepted', 8202, { decision: { outcome: 'APPROVED', finalMinor: 2100 } }),
      { id: 'in-flight-window-passes', kind: 'advanceClock', ms: 121_000 },
      { id: 'readback-sees-rule-after-write', kind: 'pipelineDispatchDue', expect: { due: 1, reports: [{ writeScopeId: 'ws-price-de-8202', steps: [
        { action: 'RECONCILED', version: 1, result: 'UNKNOWN', recorded: 'ACCEPTED' }] }] } } as Step,
      recompute('second-scope-blocked-next-decision-held', 8202, { decision: { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE' } }),
    ],
    [
      tokenExchange(),
      preReadExchange('pre-read-8201-rule', sku(8201), [{ priceMinor: 1850, rulePlan: true }]),
      preReadExchange('pre-read-8202', sku(8202), [{ priceMinor: 2000 }]),
      patchPriceExchange('patch-8202-2100', sku(8202), [{ minor: 2100 }]),
      readBackExchange('readback-8202-rule', sku(8202), [{ priceMinor: 2100, rulePlan: true }]),
    ],
    {
      alerts: [{ code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', count: 2, details: { code: 'CHANNEL_REPRICER_ACTIVE' } }],
      pipeline: {
        decisions: [
          { outcome: 'APPROVED', finalMinor: 1999 }, { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE', reasonParams: { status: 'BLOCKED', blockedByErrorCode: 'CHANNEL_REPRICER_ACTIVE', action: 'DISABLE_CHANNEL_REPRICER' } },
          { outcome: 'APPROVED', finalMinor: 2100 }, { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE', reasonParams: { status: 'BLOCKED', blockedByErrorCode: 'CHANNEL_REPRICER_ACTIVE', action: 'DISABLE_CHANNEL_REPRICER' } },
        ],
        writes: [{ amountMinor: 1999, status: 'FAILED' }, { amountMinor: 2100, status: 'ACCEPTED' }],
      },
    },
  );

  return [
    { file: 'pipeline-price-basis-mismatch-halt.json', scenario: basis },
    { file: 'pipeline-channel-repricer-blocks-scope.json', scenario: repricer },
  ];
}

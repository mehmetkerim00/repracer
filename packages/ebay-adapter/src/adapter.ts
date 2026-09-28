import type { AdapterDependencies, ChannelAdapter, SupportsListingMigration } from '@repracer/channel-port';
import { EBAY_DESCRIPTOR } from './descriptor.ts';
import { dispatchEbay } from './dispatch.ts';
import { discoverOffersEbay, handleInboundEbay, readCompetitorsEbay, readOrderLinesEbay } from './listing.ts';
import { migrateEbay, preflightEbay } from './migration.ts';
import { planEbayDispatch } from './planning.ts';
import { confirmEbay, readBackEbay } from './readback.ts';
import { openSession, resolveOptions, type EbayAdapterOptions } from './session.ts';

/** Адаптер eBay (шаг 39, Р-162…Р-164): Inventory API — цена и количество предложения; миграция — только через SupportsListingMigration */
export function createEbayAdapter(input: EbayAdapterOptions): ChannelAdapter & SupportsListingMigration {
  if (input.scopes.length === 0) throw new Error('EBAY_SCOPES_REQUIRED');
  const options = resolveOptions(input);
  return {
    descriptor: EBAY_DESCRIPTOR,
    async planDispatch(ctx, writes) {
      const opened = await openSession(options, ctx);
      if (!opened.ok) return { batches: [], rejected: writes.map((w) => ({ channelWriteId: w.channelWriteId, error: opened.error })) };
      return planEbayDispatch(ctx, opened.session.account, writes, options.deps.logger, options.environment);
    },
    dispatch: (ctx, batch) => dispatchEbay(options, ctx, batch),
    readBack: (ctx, requests) => readBackEbay(options, ctx, requests),
    confirm: (ctx, requests) => confirmEbay(options, ctx, requests),
    readCompetitors: (ctx, queries) => readCompetitorsEbay(options, ctx, queries),
    discoverOffers: (ctx, page) => discoverOffersEbay(options, ctx, page),
    readOrderLines: (ctx, window) => readOrderLinesEbay(options, ctx, window),
    handleInbound: (delivery) => handleInboundEbay(options, delivery),
    preflight: (ctx, listingIds) => preflightEbay(options, ctx, listingIds),
    migrate: (ctx, proofs) => migrateEbay(options, ctx, proofs),
  };
}

/**
 * Фабрика: бюджет запросов, бюджет правок и кэш токенов создаются ОДИН раз на фабрику (или приходят в config) — адаптеры, созданные
 * ею для разных зависимостей, делят их. Иначе каждый адаптер начинал бы с пустого бюджета правок листинга [EBAY_C08].
 */
export function ebayAdapterFactory(config: Omit<EbayAdapterOptions, 'deps'>) {
  const state = resolveOptions({ ...config, deps: null as never });
  const shared = { requestBudget: state.requestBudget, editLedger: state.editLedger, tokenCache: state.tokenCache, vatAlertedAccounts: state.vatAlertedAccounts,
    browseUnavailableLogged: state.browseUnavailableLogged };
  return (deps: AdapterDependencies): ChannelAdapter & SupportsListingMigration => createEbayAdapter({ ...config, ...shared, deps });
}

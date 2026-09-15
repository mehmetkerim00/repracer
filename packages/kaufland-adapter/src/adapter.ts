import type {
  AdapterDependencies,
  ChannelAdapter,
  SupportsAsyncReports,
  SupportsPushSubscriptions,
} from '@repracer/channel-port';
import { readCompetitorsKaufland } from './competitors.ts';
import { KAUFLAND_DESCRIPTOR } from './descriptor.ts';
import { dispatchKaufland } from './dispatch.ts';
import { handleInboundKaufland } from './inbound.ts';
import { discoverOffersKaufland, readOrderLinesKaufland } from './listing.ts';
import { planKauflandDispatch } from './planning.ts';
import { confirmKaufland, readBackKaufland } from './readback.ts';
import { openSession, type KauflandAdapterOptions } from './session.ts';
import { ensureSubscriptionsKaufland, pollReportKaufland, requestReportKaufland } from './subscriptions.ts';

export type KauflandAdapter = ChannelAdapter & SupportsPushSubscriptions & SupportsAsyncReports;

export function createKauflandAdapter(options: KauflandAdapterOptions): KauflandAdapter {
  return {
    descriptor: KAUFLAND_DESCRIPTOR,

    async planDispatch(ctx, writes) {
      const opened = await openSession(options, ctx);
      if (!opened.ok) {
        return { batches: [], rejected: writes.map((w) => ({ channelWriteId: w.channelWriteId, error: opened.error })) };
      }
      return planKauflandDispatch(ctx, opened.session.account, writes, options.deps.logger);
    },
    dispatch: (ctx, batch) => dispatchKaufland(options, ctx, batch),
    readBack: (ctx, requests) => readBackKaufland(options, ctx, requests),
    confirm: (ctx, requests) => confirmKaufland(options, ctx, requests),
    readCompetitors: (ctx, queries) => readCompetitorsKaufland(options, ctx, queries),
    discoverOffers: (ctx, page) => discoverOffersKaufland(options, ctx, page),
    readOrderLines: (ctx, window) => readOrderLinesKaufland(options, ctx, window),
    handleInbound: (delivery) => handleInboundKaufland(options, delivery),
    ensureSubscriptions: (ctx, desired) => ensureSubscriptionsKaufland(options, ctx, desired),
    requestReport: (ctx, reportType, marketplace) => requestReportKaufland(options, ctx, reportType, marketplace),
    pollReport: (ctx, handle) => pollReportKaufland(options, ctx, handle),
  };
}

/** Фабрика в форме порта: конфигурация платформы фиксируется, зависимости ядра передаются при создании */
export function kauflandAdapterFactory(config: Omit<KauflandAdapterOptions, 'deps'>) {
  return (deps: AdapterDependencies): KauflandAdapter => createKauflandAdapter({ ...config, deps });
}

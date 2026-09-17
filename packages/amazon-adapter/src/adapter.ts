import type { AdapterDependencies, ChannelAdapter } from '@repracer/channel-port';
import { AMAZON_DESCRIPTOR } from './descriptor.ts';
import { dispatchAmazon } from './dispatch.ts';
import { handleInboundAmazon } from './inbound.ts';
import { discoverOffersAmazon, readCompetitorsAmazon, readOrderLinesAmazon } from './listing.ts';
import { planAmazonDispatch } from './planning.ts';
import { confirmAmazon, readBackAmazon } from './readback.ts';
import { openSession, type AmazonAdapterOptions } from './session.ts';

export function createAmazonAdapter(options: AmazonAdapterOptions): ChannelAdapter {
  return {
    descriptor: AMAZON_DESCRIPTOR,
    async planDispatch(ctx, writes) {
      const opened = await openSession(options, ctx);
      if (!opened.ok) return { batches: [], rejected: writes.map((w) => ({ channelWriteId: w.channelWriteId, error: opened.error })) };
      return planAmazonDispatch(ctx, opened.session.account, writes, options.deps.logger);
    },
    dispatch: (ctx, batch) => dispatchAmazon(options, ctx, batch),
    readBack: (ctx, requests) => readBackAmazon(options, ctx, requests),
    confirm: (ctx, requests) => confirmAmazon(options, ctx, requests),
    readCompetitors: (ctx, queries) => readCompetitorsAmazon(options, ctx, queries),
    discoverOffers: (ctx, page) => discoverOffersAmazon(options, ctx, page),
    readOrderLines: (ctx, window) => readOrderLinesAmazon(options, ctx, window),
    handleInbound: (delivery) => handleInboundAmazon(options, delivery),
  };
}

export function amazonAdapterFactory(config: Omit<AmazonAdapterOptions, 'deps'>) {
  return (deps: AdapterDependencies): ChannelAdapter => createAmazonAdapter({ ...config, deps });
}

export { counterfactual, LIES, runBacktest, type BacktestInput, type BacktestReport, type MetricsBundle, type ScopeMetrics } from './backtest.ts';
export { syntheticHistory, syntheticSnapshots, type RecordedHistory, type SyntheticMarket, type SyntheticProduct } from './history.ts';
export { BATCH_LIE, DEFAULT_SAMPLE, MemoryCatalogJobStore, runCatalogJob, runSampleBacktest, selectBacktestSample, type BacktestSample, type CatalogBacktestInput, type CatalogJobState, type CatalogJobStore, type RevenueEstimate, type RevenueSource, type SampleOptions } from './catalog.ts';

export { SimulatedKauflandChannel, type CompetitorBehaviour, type KauflandChannelModelSpec, type SimCompetitorSpec, type SimUnitSpec, type SimulatorStats } from './kaufland-channel.ts';
export { AMAZON_DE, AMAZON_SIM_DESCRIPTOR_US, AMAZON_US, SimulatedAmazonPort, type AmazonPortModelSpec } from './amazon-port.ts';
export { SimulatedEbayChannel, ebayGetItemXml, type EbayChannelModelSpec, type SimEbayListingSpec, type EbaySimulatorStats } from './ebay-channel.ts';
export { AMAZON_PARAMETERS, defaultAmazonParams, defaultEbayParams, defaultKauflandParams, EBAY_PARAMETERS, KAUFLAND_PARAMETERS, type AmazonModelParams, type EbayModelParams, type KauflandModelParams, type ParameterSpec } from './params.ts';
export { SeededRandom } from './random.ts';
/** Шаг 47: транспорт fetch поверх модели канала — для адаптера, собранного вне стенда сценариев (прогон пилота eBay) */
export { channelFetch, type TraceEntry } from '../harness/channel.ts';

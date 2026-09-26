export { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct, type ProductClass } from './kaufland-world.ts';
export { demoWorld, nextNineUtc, demoProducts, demoCompetitors, DEMO_OFFERS, DEMO_ON_HAND, DEMO_COMPETITORS_PER_OFFER, type DemoWorld } from './demo-world.ts';
// Шаг 42 [Р-172]: мир Amazon, в том числе витрина США (USD, нетто, граница суток неизвестна)
export { amazonLiveWorld, type AmazonLiveWorld } from './amazon-world.ts';
// Часы виртуального мира: прогону нужен собственный ход времени
export { VirtualClock } from '../harness/world.ts';

import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import type { ChannelDescriptor, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { EBAY_DESCRIPTOR } from '@repracer/ebay-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { WALMART_DESCRIPTOR } from '@repracer/walmart-adapter';
import { strategyAvailability } from '@repracer/pricing-pipeline';
import type { StrategyDefinition } from '@repracer/pricing-model';

/**
 * Описание канала по его коду — одно место для консоли (мир тенанта, демо). Шаг 68: до него консоль знала два канала, и аккаунт eBay
 * получал описание Kaufland — доступность стратегии, снятие остановки выборкой [Р-119] и повтор записи [Р-193] были бы чужими.
 * Неизвестный канал — отказ, а не подстановка соседнего
 */
export function descriptorOf(channel: string): ChannelDescriptor {
  switch (channel) {
    case 'KAUFLAND': return KAUFLAND_DESCRIPTOR;
    case 'AMAZON': return AMAZON_DESCRIPTOR;
    case 'EBAY': return EBAY_DESCRIPTOR;
    // Шаг 89: Walmart — на симуляторе, по правилам настоящего Walmart (docs/channels/walmart.md)
    case 'WALMART': return WALMART_DESCRIPTOR;
    default: throw new Error(`no channel descriptor for ${channel}`);
  }
}

const noChannel = (): never => { throw Object.assign(new Error('CHANNEL_NOT_IN_CONSOLE: channel calls are made by the scheduler and the dispatcher'), { code: 'CHANNEL_NOT_IN_CONSOLE' }); };

/**
 * Ревью шага 68, находка 7: как снимается системная остановка у канала, которого консоль ещё не знает (OTTO допускает база), —
 * только человеком: это строже, а не мягче. Отказ здесь ронял бы список миров и обход тенантов исполнителя заданий целиком
 */
export function haltReleaseOf(channel: string): 'SAMPLE' | 'MANUAL_ONLY' {
  try {
    return descriptorOf(channel).haltRelease.kind;
  } catch {
    return 'MANUAL_ONLY';
  }
}

/** Адаптер без канала, но СО СВОИМ описанием: доступность стратегии и снятие остановок — свойства канала (находка 14 ревью шага 44) */
export const consoleAdapter = (channel: string) => new Proxy({ descriptor: descriptorOf(channel) } as Record<string, unknown>, {
  get: (target, key) => (key in target ? target[key as string] : noChannel),
}) as never;

/**
 * Шаг 99 [Р-225, Р-39]: даёт ли канал данные, нужные стратегии, — по источникам конкурентов из описания канала, как экран конкурентов и
 * предпросмотр. Импорт стратегий называет недоступную стратегию строкой файла с причиной, а не отказом базы на применении
 */
export function strategyAvailableOn(channel: string, params: StrategyDefinition['params']): { available: true } | { available: false; unmet: Record<string, string[]> } {
  let sources: CompetitorSourceDescriptor[];
  try { sources = (descriptorOf(channel).competitorSources ?? []).filter((x) => x.availability !== 'UNAVAILABLE'); } catch { sources = []; }
  const a = strategyAvailability(params, sources);
  return a.available ? { available: true } : { available: false, unmet: a.unmet };
}

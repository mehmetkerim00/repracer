import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import type { ChannelDescriptor } from '@repracer/channel-port';
import { EBAY_DESCRIPTOR } from '@repracer/ebay-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';

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

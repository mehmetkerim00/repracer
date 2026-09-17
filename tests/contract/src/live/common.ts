import type { AdapterCallContext } from '@repracer/channel-port';
import type { PricingPipeline } from '@repracer/pricing-pipeline';
import type { SeededPricingWorld } from '@repracer/pricing-store-pg';
import type { Sink, VirtualClock } from '../harness/world.ts';

/** Событие мира (алерт или запись журнала) с моментом виртуальных часов — с точностью до такта планировщика */
export interface StampedEvent { kind: 'alert' | 'log'; code: string; atMs: number; details: Record<string, unknown> }

export function stamped(sink: Sink, clock: VirtualClock): { list: StampedEvent[]; stamp(): void } {
  const list: StampedEvent[] = [];
  let alerts = 0;
  let logs = 0;
  return {
    list,
    stamp() {
      for (; alerts < sink.alerts.length; alerts++) list.push({ kind: 'alert', code: sink.alerts[alerts]!.code, atMs: clock.nowMs(), details: { ...sink.alerts[alerts]!.details } });
      // Журнал адаптера за сутки — сотни тысяч строк; проверке нужны только коды остановок и отказов
      for (; logs < sink.logs.length; logs++) {
        const l = sink.logs[logs]!;
        if (/HALT|REJECT|SMART_PRICING/.test(l.code)) list.push({ kind: 'log', code: l.code, atMs: clock.nowMs(), details: { ...(l.details ?? {}) } });
      }
      sink.logs.length = 0;
      logs = 0;
    },
  };
}

/** Планировщик называет тенанта и аккаунт идентификаторами базы; мир сценария — идентификаторами фикстуры */
export function dbIdPipeline(pipeline: PricingPipeline, seeded: SeededPricingWorld): PricingPipeline {
  return new Proxy(pipeline, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (ctx: AdapterCallContext, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(target, seeded.ids.fromDb(ctx), ...rest);
    },
  });
}

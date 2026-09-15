import type {
  AdapterDependencies,
  AdapterLogEntry,
  ChannelAccountId,
  TenantId,
} from '@repracer/channel-port';
import type { World } from './scenario.ts';

/** Виртуальные часы: время двигают только шаги сценария и паузы клиента между повторами */
export class VirtualClock {
  private ms: number;

  constructor(startIso: string) {
    const ms = Date.parse(startIso);
    if (Number.isNaN(ms)) throw new Error(`invalid clock start ${startIso}`);
    this.ms = ms;
  }

  nowMs(): number { return this.ms; }
  iso(offsetMs = 0): string { return new Date(this.ms + offsetMs).toISOString(); }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`clock can only move forward (got ${ms})`);
    this.ms += ms;
  }
  /** Пауза клиента: не ждёт реального времени, сдвигает виртуальное */
  sleep = async (ms: number): Promise<void> => { this.advance(ms); };
}

export interface RaisedAlert {
  code: string;
  severity: 'WARNING' | 'CRITICAL';
  tenantId?: string;
  channelAccountId?: string;
  correlationId?: string;
  details: Readonly<Record<string, string | number | boolean>>;
}

export interface Sink {
  logs: AdapterLogEntry[];
  alerts: RaisedAlert[];
}

export const SELLER_CREDENTIALS_REF = 'cred:seller';
export const PARTNER_CREDENTIALS_REF = 'cred:partner';

/** Зависимости ядра, собранные из мира сценария. Каталог аккаунтов проверяет тенант так же, как ядро [Р-31]. */
export function worldDependencies(world: World, clock: VirtualClock, sink: Sink): AdapterDependencies {
  return {
    accounts: {
      async verify(tenantId: TenantId, channelAccountId: ChannelAccountId) {
        if (world.directory === 'NOT_FOUND' || channelAccountId !== world.channelAccountId) return { ok: false, reason: 'NOT_FOUND' };
        if (world.directory === 'DISCONNECTED') return { ok: false, reason: 'DISCONNECTED' };
        if (tenantId !== world.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
        return {
          ok: true,
          account: {
            tenantId,
            channelAccountId,
            channel: (world.account.channel ?? 'KAUFLAND') as 'KAUFLAND',
            externalAccountId: world.account.externalAccountId,
            marketplaces: [...world.account.marketplaces],
            credentialsRef: SELLER_CREDENTIALS_REF,
          },
        };
      },
    },
    credentials: {
      async get(ref: string) {
        if (ref === SELLER_CREDENTIALS_REF) return { ...world.credentials.seller };
        if (ref === PARTNER_CREDENTIALS_REF && world.credentials.partner) return { ...world.credentials.partner };
        return {};
      },
    },
    alerts: { async raise(alert) { sink.alerts.push(alert); } },
    logger: { log(entry) { sink.logs.push(entry); } },
    now: () => clock.iso(),
  };
}

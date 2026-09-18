import type { Instant } from '@repracer/channel-port';

/**
 * Р-126 (шаг 25): состояние периодической работы. Срок следующего запуска сдвигается только после успешного запуска — пропущенный
 * запуск не теряется. EVERY_SLOT — каждый пропущенный слот выполняется по очереди (выгрузка суток: каждые сутки нужны); LATEST — один
 * запуск за все пропущенные слоты, их число пишется (опрос: нужен только свежий).
 */
export type CatchUp = 'EVERY_SLOT' | 'LATEST';
export type RunOutcome = 'SUCCEEDED' | 'FAILED';

export interface JobScope { tenantId: string; channelAccountId: string }

/** Р-133 (шаг 28): CHANNEL — работа ходит в канал с лимитами; INTERNAL — только в наши хранилища */
export type RetryKind = 'CHANNEL' | 'INTERNAL';

export interface JobRegistration {
  jobKey: string;
  jobName: string;
  scope: JobScope | null;
  catchUp: CatchUp;
  retryKind: RetryKind;
  intervalSeconds: number;
  /** Первый слот, если работы ещё нет в состоянии */
  firstDueAt: Instant;
  /** Момент регистрации по часам планировщика: отставание новой работы не считается от слота до её появления (шаг 26) */
  registeredAt: Instant;
}

export type LagLevel = 'OK' | 'WARNING' | 'CRITICAL';

export interface JobState extends JobRegistration {
  nextDueAt: Instant;
  runsCompleted: number;
  coalescedSlots: number;
  consecutiveFailures: number;
  leaseOwner: string | null;
  leaseUntil: Instant | null;
  lastStartedAt: Instant | null;
  lastFinishedAt: Instant | null;
  lastOutcome: RunOutcome | null;
  lastError: string | null;
  /** Риск 31 (шаг 26): уровень отставания, о котором уже сообщено, — в хранилище, общий для процессов и перезапусков */
  lagLevel: LagLevel;
}

export interface RunRecord {
  jobKey: string;
  jobName: string;
  slotAt: Instant;
  owner: string;
  startedAt: Instant;
  finishedAt: Instant;
  outcome: RunOutcome;
  lagSeconds: number;
  items: number | null;
  errorCode: string | null;
}

export interface FinishInput {
  outcome: RunOutcome;
  nextDueAt: Instant;
  coalesced: number;
  error: string | null;
  run: RunRecord;
}

export interface SchedulerStateStore {
  /** Работа появляется в состоянии; у существующей меняется только интервал (число аккаунтов Amazon меняет темп сверки) */
  ensure(registration: JobRegistration): Promise<void>;
  list(): Promise<JobState[]>;
  /**
   * Занять работу, срок которой наступил к now и аренда которой свободна или истекла. Истечение аренды — по часам хранилища:
   * упавший планировщик не держит работу дольше аренды. null — работа занята другим или не наступила
   */
  claim(jobKey: string, owner: string, now: Instant, leaseSeconds: number): Promise<JobState | null>;
  /** Итог запуска и освобождение аренды; аренда потеряна (истекла и занята другим) — исключение LEASE_LOST, итог не пишется */
  finish(jobKey: string, owner: string, input: FinishInput): Promise<void>;
  runs(jobKey?: string): Promise<RunRecord[]>;
  /** Продление действующей аренды владельцем во время долгого запуска; false — аренда потеряна (ревью шага 25, находка 6) */
  renew(jobKey: string, owner: string, leaseSeconds: number): Promise<boolean>;
  /** Работы, которых нет среди действующих, без журнала запусков и без изменений olderThanDays суток, удаляются (отключённые аккаунты) */
  prune(activeJobKeys: readonly string[], olderThanDays: number): Promise<number>;
  /**
   * Смена уровня отставания, если он всё ещё from: true — сменил этот вызов (алерт поднимает он), false — уровень уже сменил другой
   * процесс или перезапуск (алерт не повторяется)
   */
  setLagLevel(jobKey: string, from: LagLevel, to: LagLevel): Promise<boolean>;
}

export class LeaseLostError extends Error {
  constructor(jobKey: string) {
    super(`LEASE_LOST: scheduled job ${jobKey} lease is no longer held`);
  }
}

/** Двойник в памяти: истечение аренды — по часам clock (в PostgreSQL — по часам базы) */
export class MemorySchedulerState implements SchedulerStateStore {
  readonly jobs = new Map<string, JobState>();
  readonly runLog: RunRecord[] = [];

  private readonly clock: () => Instant;

  constructor(clock: () => Instant) {
    this.clock = clock;
  }

  async ensure(r: JobRegistration): Promise<void> {
    const existing = this.jobs.get(r.jobKey);
    if (existing) {
      existing.intervalSeconds = r.intervalSeconds;
      return;
    }
    this.jobs.set(r.jobKey, {
      ...r, nextDueAt: r.firstDueAt, runsCompleted: 0, coalescedSlots: 0, consecutiveFailures: 0, leaseOwner: null, leaseUntil: null,
      lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, lastError: null, lagLevel: 'OK',
    });
  }

  async list(): Promise<JobState[]> {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  async claim(jobKey: string, owner: string, now: Instant, leaseSeconds: number): Promise<JobState | null> {
    const j = this.jobs.get(jobKey);
    if (!j || Date.parse(j.nextDueAt) > Date.parse(now)) return null;
    const wall = Date.parse(this.clock());
    if (j.leaseOwner !== null && Date.parse(j.leaseUntil!) > wall) return null;
    j.leaseOwner = owner;
    j.leaseUntil = new Date(wall + leaseSeconds * 1000).toISOString();
    j.lastStartedAt = now;
    return { ...j };
  }

  async finish(jobKey: string, owner: string, input: FinishInput): Promise<void> {
    const j = this.jobs.get(jobKey);
    if (!j || j.leaseOwner !== owner) throw new LeaseLostError(jobKey);
    j.leaseOwner = null;
    j.leaseUntil = null;
    j.nextDueAt = input.nextDueAt;
    j.lastFinishedAt = input.run.finishedAt;
    j.lastOutcome = input.outcome;
    j.lastError = input.error;
    if (input.outcome === 'SUCCEEDED') {
      j.runsCompleted += 1;
      j.coalescedSlots += input.coalesced;
      j.consecutiveFailures = 0;
    } else {
      j.consecutiveFailures += 1;
    }
    this.runLog.push(input.run);
  }

  async runs(jobKey?: string): Promise<RunRecord[]> {
    return this.runLog.filter((r) => !jobKey || r.jobKey === jobKey);
  }

  async renew(jobKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const j = this.jobs.get(jobKey);
    const wall = Date.parse(this.clock());
    if (!j || j.leaseOwner !== owner || Date.parse(j.leaseUntil!) <= wall) return false;
    j.leaseUntil = new Date(wall + leaseSeconds * 1000).toISOString();
    return true;
  }

  async setLagLevel(jobKey: string, from: LagLevel, to: LagLevel): Promise<boolean> {
    const j = this.jobs.get(jobKey);
    if (!j || j.lagLevel !== from) return false;
    j.lagLevel = to;
    return true;
  }

  async prune(activeJobKeys: readonly string[], olderThanDays: number): Promise<number> {
    const active = new Set(activeJobKeys);
    const before = Date.parse(this.clock()) - olderThanDays * 86_400_000;
    let n = 0;
    for (const [key, j] of this.jobs) {
      if (active.has(key) || this.runLog.some((r) => r.jobKey === key) || Date.parse(j.lastFinishedAt ?? j.firstDueAt) > before) continue;
      this.jobs.delete(key);
      n++;
    }
    return n;
  }
}

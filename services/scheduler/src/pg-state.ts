import type { Instant } from '@repracer/channel-port';
import type { PgPool } from '@repracer/pricing-store-pg';
import { LeaseLostError, type FinishInput, type JobRegistration, type JobState, type RunRecord, type SchedulerStateStore } from './state.ts';

/**
 * Р-126: состояние планировщика в PostgreSQL (0090) — роль svc_scheduler. Занятие работы — один UPDATE с условием на срок и свободную
 * аренду: второй планировщик ждёт блокировку строки и после неё условие уже ложно. Перехват действующей аренды отклоняет триггер
 * scheduled_job_lease_guard. Итог и строка журнала запусков — одна транзакция.
 */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function row(r: Record<string, unknown>): JobState {
  return {
    jobKey: String(r.job_key), jobName: String(r.job_name),
    scope: r.scope_tenant_id ? { tenantId: String(r.scope_tenant_id), channelAccountId: String(r.scope_account_id) } : null,
    catchUp: r.catch_up as JobState['catchUp'], intervalSeconds: Number(r.interval_seconds), firstDueAt: iso(r.created_at)!,
    nextDueAt: iso(r.next_due_at)!, runsCompleted: Number(r.runs_completed), coalescedSlots: Number(r.coalesced_slots),
    consecutiveFailures: Number(r.consecutive_failures), retryKind: (r.retry_kind as JobState['retryKind']) ?? 'CHANNEL', leaseOwner: (r.lease_owner as string | null) ?? null, leaseUntil: iso(r.lease_until),
    lastStartedAt: iso(r.last_started_at), lastFinishedAt: iso(r.last_finished_at), lastOutcome: (r.last_outcome as JobState['lastOutcome']) ?? null,
    lastError: (r.last_error as string | null) ?? null, registeredAt: iso(r.registered_at)!, lagLevel: r.lag_level as JobState['lagLevel'],
  };
}

export class PgSchedulerState implements SchedulerStateStore {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async ensure(r: JobRegistration): Promise<void> {
    await this.pool.query(
      `INSERT INTO maintenance.scheduled_job (job_key, job_name, scope_tenant_id, scope_account_id, catch_up, interval_seconds, next_due_at, registered_at, retry_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_key) DO UPDATE SET interval_seconds = EXCLUDED.interval_seconds, retry_kind = EXCLUDED.retry_kind
        WHERE maintenance.scheduled_job.interval_seconds IS DISTINCT FROM EXCLUDED.interval_seconds
           OR maintenance.scheduled_job.retry_kind IS DISTINCT FROM EXCLUDED.retry_kind`,
      [r.jobKey, r.jobName, r.scope?.tenantId ?? null, r.scope?.channelAccountId ?? null, r.catchUp, r.intervalSeconds, r.firstDueAt, r.registeredAt, r.retryKind]);
  }

  async list(): Promise<JobState[]> {
    const { rows } = await this.pool.query('SELECT * FROM maintenance.scheduled_job ORDER BY next_due_at, job_key');
    return rows.map(row);
  }

  async claim(jobKey: string, owner: string, now: Instant, leaseSeconds: number): Promise<JobState | null> {
    const { rows: [r] } = await this.pool.query(
      `UPDATE maintenance.scheduled_job
          SET lease_owner = $2, lease_until = now() + make_interval(secs => $4), last_started_at = $3
        WHERE job_key = $1 AND next_due_at <= $3::timestamptz AND (lease_owner IS NULL OR lease_until <= now())
        RETURNING *`, [jobKey, owner, now, leaseSeconds]);
    return r ? row(r) : null;
  }

  async finish(jobKey: string, owner: string, input: FinishInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Освобождение действующей аренды — только владельцем (scheduled_job_lease_guard)
      await client.query(`SELECT set_config('repracer.scheduler_owner', $1, true)`, [owner]);
      const ok = input.outcome === 'SUCCEEDED';
      const { rowCount } = await client.query(
        `UPDATE maintenance.scheduled_job
            SET lease_owner = NULL, lease_until = NULL, next_due_at = $3, last_finished_at = $4, last_outcome = $5, last_error = $6,
                runs_completed = runs_completed + $7, coalesced_slots = coalesced_slots + $8,
                consecutive_failures = CASE WHEN $9 THEN 0 ELSE consecutive_failures + 1 END
          WHERE job_key = $1 AND lease_owner = $2`,
        [jobKey, owner, input.nextDueAt, input.run.finishedAt, input.outcome, input.error, ok ? 1 : 0, ok ? input.coalesced : 0, ok]);
      if (rowCount !== 1) throw new LeaseLostError(jobKey);
      const run: RunRecord = input.run;
      await client.query(
        `INSERT INTO maintenance.scheduled_job_run (job_key, job_name, slot_at, owner, started_at, finished_at, outcome, lag_seconds, items, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [run.jobKey, run.jobName, run.slotAt, run.owner, run.startedAt, run.finishedAt, run.outcome, run.lagSeconds, run.items, run.errorCode]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(jobKey: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE maintenance.scheduled_job SET lease_until = now() + make_interval(secs => $3)
        WHERE job_key = $1 AND lease_owner = $2 AND lease_until > now()`, [jobKey, owner, leaseSeconds]);
    return rowCount === 1;
  }

  async setLagLevel(jobKey: string, from: JobState['lagLevel'], to: JobState['lagLevel']): Promise<boolean> {
    // Сравнение со старым уровнем — в том же UPDATE: из двух процессов уровень меняет и алерт поднимает один
    const { rowCount } = await this.pool.query(`UPDATE maintenance.scheduled_job SET lag_level = $3 WHERE job_key = $1 AND lag_level = $2`, [jobKey, from, to]);
    return rowCount === 1;
  }

  /** Риск 31 (шаг 26): часы базы — срок работы сравнивается с ними, а не с часами процесса */
  async databaseNow(): Promise<Instant> {
    const { rows: [r] } = await this.pool.query('SELECT now() AS n');
    return new Date(r.n).toISOString();
  }

  async prune(activeJobKeys: readonly string[], olderThanDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM maintenance.scheduled_job j
        WHERE NOT (j.job_key = ANY ($1::text[])) AND j.lease_owner IS NULL AND j.updated_at < now() - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM maintenance.scheduled_job_run r WHERE r.job_key = j.job_key)`, [activeJobKeys, olderThanDays]);
    return rowCount ?? 0;
  }

  async runs(jobKey?: string): Promise<RunRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM maintenance.scheduled_job_run WHERE $1::text IS NULL OR job_key = $1 ORDER BY started_at, slot_at`, [jobKey ?? null]);
    return rows.map((r) => ({
      jobKey: r.job_key, jobName: r.job_name, slotAt: iso(r.slot_at)!, owner: r.owner, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at)!,
      outcome: r.outcome, lagSeconds: Number(r.lag_seconds), items: r.items === null ? null : Number(r.items), errorCode: r.error_code,
    }));
  }
}

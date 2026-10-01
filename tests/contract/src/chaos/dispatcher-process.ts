import { systemClock, type AdapterDependencies, type ChannelAdapter } from '@repracer/channel-port';
import { conservativeBudget, createKauflandAdapter } from '@repracer/kaufland-adapter';
import { createPool, PgAlertSink, PgWriteQueueStore } from '@repracer/pricing-store-pg';
import { createWriteDispatcher } from '@repracer/write-dispatcher';
import { channelCredentialsProvider, credentialsFromFiles, jsonSink, pgAccountDirectory } from '../../../../packages/service-runtime/src/index.ts';

/**
 * Шаг 65 (хаос): диспетчер записей ОТДЕЛЬНЫМ процессом — то, что делает обход-страховка `services/pricing-worker` (`worker.ts`:
 * `createWriteDispatcher` + `sweep` раз в интервал), но без брокера: процесс пути решения без Kafka не стартует, а брокера на машине
 * прогона нет. Отправка, повтор, сверка неизвестного итога обратным чтением и разбор записей в полёте после убийства процесса — те же
 * функции ядра и та же очередь в базе; отличается только то, что сигнал «единица свободна» приходит обходом, а не событием брокера.
 * Адрес модели канала — `REPRACER_KAUFLAND_BASE_URL`, как у планировщика стенда; учётные данные — файлом, как в работе. Только для прогона.
 */
const env = process.env;
const required = (name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const sink = jsonSink();
const appPool = createPool(required('REPRACER_CHAOS_APP_PG_URL'), { max: 6, applicationName: 'repracer-chaos-dispatcher' });
const scanPool = createPool(required('REPRACER_CHAOS_DISPATCHER_PG_URL'), { max: 2, applicationName: 'repracer-chaos-dispatcher-sweep' });
const alerts = new PgAlertSink(appPool, sink.alerts);
const deps: AdapterDependencies = {
  accounts: pgAccountDirectory(appPool),
  credentials: channelCredentialsProvider({ files: credentialsFromFiles(required('REPRACER_CHANNEL_SECRETS_DIR')), vault: null, amazonApplication: null }),
  alerts,
  logger: sink.logger,
  now: systemClock.now,
};
const adapter: ChannelAdapter = createKauflandAdapter({
  deps, userAgent: 'repracer-chaos/1.0', subscriptionFallbackEmail: 'ops@example.invalid', budget: conservativeBudget(),
  buyBoxChangedAccess: 'NOT_GRANTED', baseUrl: required('REPRACER_KAUFLAND_BASE_URL'),
});
const dispatcher = createWriteDispatcher({
  store: new PgWriteQueueStore(appPool, { scanPool }), adapterFor: () => adapter, alerts, now: systemClock.now,
});
const sweepMs = Number(env.REPRACER_CHAOS_SWEEP_MS ?? 1000);

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
// Процесс готов: родитель ждёт эту строку, прежде чем считать диспетчер живым
console.log(JSON.stringify({ level: 'INFO', code: 'CHAOS_DISPATCHER_READY', pid: process.pid }));
while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, sweepMs));
  try {
    const swept = await dispatcher.sweep({ pendingMinAgeMs: 0 });
    if (swept.due > 0) console.log(JSON.stringify({ level: 'INFO', code: 'CHAOS_DISPATCHER_SWEEP', due: swept.due }));
  } catch (error) {
    console.log(JSON.stringify({ level: 'ERROR', code: 'WRITE_DISPATCH_SWEEP_FAILED', error: String((error as Error)?.message ?? error).slice(0, 200) }));
  }
}
await appPool.end();
await scanPool.end();

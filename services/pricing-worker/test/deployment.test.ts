import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AdapterDependencies, ChannelAccountId, TenantId } from '@repracer/channel-port';
import { ConfigError } from '@repracer/service-runtime';
import { loadWorkerConfig } from '../src/config.ts';
import { channelAdapters } from '../src/main.ts';

/**
 * OQ-190 (шаг 27): развёртывание диспетчера записей — часть репозитория. Проверяется то, на что опирается развёртывание: конфигурация
 * читает секреты файлами и отказывает при пропуске, адаптер выбирается по каналу аккаунта из каталога [Р-31], а compose запускает
 * именно ту точку входа, которая здесь собирается.
 */

const ENV = {
  REPRACER_KAFKA_BROKERS: 'redpanda-1:9092, redpanda-2:9092',
  REPRACER_APP_PG_URL_FILE: '/run/secrets/app_pg_url',
  REPRACER_DISPATCHER_PG_URL_FILE: '/run/secrets/dispatcher_pg_url',
  REPRACER_CHANNEL_SECRETS_DIR: '/run/secrets/channels',
  REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid',
  REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application',
} as const;
const FILES: Record<string, string> = {
  '/run/secrets/app_pg_url': 'postgres://svc_app@db/repracer',
  '/run/secrets/dispatcher_pg_url': 'postgres://svc_dispatcher@db/repracer',
  '/run/secrets/relay_pg_url': 'postgres://svc_relay@db/repracer',
};
const read = (p: string) => {
  const v = FILES[p];
  if (v === undefined) throw new Error('no file');
  return v;
};

test('OQ-190: the worker configuration reads secrets from files; the relay address is optional, the broker list is not', () => {
  const config = loadWorkerConfig({ ...ENV, REPRACER_WORKER_ID: 'worker-eu-1' }, read);
  assert.equal(config.pgUrl, 'postgres://svc_app@db/repracer');
  assert.equal(config.relayPgUrl, null, 'an instance without the relay address does not run the relay (Р-34)');
  assert.deepEqual(config.kafkaBrokers, ['redpanda-1:9092', 'redpanda-2:9092']);
  assert.equal(config.sweepIntervalMs, 60_000);
  assert.equal(loadWorkerConfig({ ...ENV, REPRACER_RELAY_PG_URL_FILE: '/run/secrets/relay_pg_url' }, read).relayPgUrl, 'postgres://svc_relay@db/repracer');
  assert.throws(() => loadWorkerConfig({ ...ENV, REPRACER_KAFKA_BROKERS: '' }, read), /CONFIG_MISSING: REPRACER_KAFKA_BROKERS/);
  assert.throws(() => loadWorkerConfig({ ...ENV, REPRACER_APP_PG_URL_FILE: '/run/secrets/nope' }, read), /CONFIG_SECRET_UNREADABLE/);
  assert.throws(() => loadWorkerConfig({ ...ENV, REPRACER_WORKER_SWEEP_MS: 'soon' }, read), ConfigError);
  const { REPRACER_KAUFLAND_FALLBACK_EMAIL: _omitted, ...withoutEmail } = ENV;
  assert.throws(() => loadWorkerConfig(withoutEmail, read), /CONFIG_MISSING: REPRACER_KAUFLAND_FALLBACK_EMAIL/);
});

test('OQ-190: the adapter is chosen by the channel of the account from the directory; a channel without an adapter is refused [Р-112]', async () => {
  const config = loadWorkerConfig(ENV, read);
  const deps = {
    accounts: { async verify() { return { ok: false as const, reason: 'NOT_FOUND' as const }; } },
    credentials: { async get() { return {}; } },
    alerts: { async raise() {} },
    logger: { log() {} },
    now: () => '2026-09-18T10:00:00.000Z',
  } as unknown as AdapterDependencies;
  const channels: Record<string, string> = { 'acc-kaufland': 'KAUFLAND', 'acc-amazon': 'AMAZON', 'acc-ebay': 'EBAY' };
  let lookups = 0;
  const directory = {
    async verify(_tenantId: TenantId, channelAccountId: ChannelAccountId) {
      lookups += 1;
      const channel = channels[String(channelAccountId)];
      return channel ? { ok: true as const, account: { channel } } : { ok: false as const, reason: 'NOT_FOUND' };
    },
  };
  const adapterFor = channelAdapters(deps, config, directory);
  assert.equal((await adapterFor('t-1', 'acc-kaufland')).descriptor.channel, 'KAUFLAND');
  assert.equal((await adapterFor('t-1', 'acc-amazon')).descriptor.channel, 'AMAZON');
  assert.equal(lookups, 2);
  await adapterFor('t-1', 'acc-kaufland');
  assert.equal(lookups, 2, 'the channel of an account is asked once: an account does not change its channel');
  // Р-112: адаптера eBay нет до снимка спецификации — сообщение по такому аккаунту не притворяется обработанным
  await assert.rejects(adapterFor('t-1', 'acc-ebay'), /NO_ADAPTER: EBAY/);
  await assert.rejects(adapterFor('t-1', 'acc-unknown'), /ACCOUNT_UNUSABLE: NOT_FOUND/);
});

test('OQ-190: the deployment starts the entry point of this service and mounts the secrets read-only', () => {
  const compose = readFileSync(fileURLToPath(new URL('../../../deploy/worker/compose.yaml', import.meta.url)), 'utf8');
  assert.match(compose, /services\/pricing-worker\/src\/main\.ts/);
  assert.match(compose, /\/run\/secrets:ro/);
  assert.match(compose, /REPRACER_APP_PG_URL_FILE/);
  assert.match(compose, /restart: unless-stopped/);
  // Секреты — файлами: значения адресов баз в переменных окружения развёртывание не передаёт
  assert.equal(/^\s+REPRACER_APP_PG_URL:/m.test(compose), false);
  assert.equal(/^\s+REPRACER_DISPATCHER_PG_URL:/m.test(compose), false);
});

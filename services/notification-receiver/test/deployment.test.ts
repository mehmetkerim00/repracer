import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '@repracer/service-runtime';
import { loadReceiverConfig } from '../src/config.ts';

/**
 * OQ-190 (шаг 27): развёртывание приёмника уведомлений — часть репозитория. Живой очереди нет (OQ-167), поэтому проверяется то, что
 * можно проверить без неё: конфигурация читает секреты файлами, регион и адрес очереди не домысливаются, compose запускает точку входа
 * этого сервиса и монтирует секреты только на чтение.
 */

const FILES: Record<string, string> = {
  '/run/secrets/app_pg_url': 'postgres://svc_app@db/repracer',
  '/run/secrets/inbound_pg_url': 'postgres://svc_inbound@db/repracer',
  '/run/secrets/sqs_queue_url': 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-notifications\n',
  '/run/secrets/aws_access_key_id': 'AKIASYNTHETIC0000001',
  '/run/secrets/aws_secret_access_key': 'syn-aws-secret-access-key-0001',
  '/run/secrets/receiver_heartbeat_url': 'https://hc.example.invalid/ping/00000000-0000-4000-8000-000000000002',
};
const read = (p: string) => {
  const v = FILES[p];
  if (v === undefined) throw new Error('no file');
  return v;
};
const ENV = {
  REPRACER_AMAZON_REGION: 'EU',
  REPRACER_AMAZON_APPLICATION_ID: 'amzn1.sellerapps.app.00000000-0000-0000-0000-000000000000',
  REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application',
  REPRACER_CHANNEL_SECRETS_DIR: '/run/secrets/channels',
  REPRACER_APP_PG_URL_FILE: '/run/secrets/app_pg_url',
  REPRACER_INBOUND_PG_URL_FILE: '/run/secrets/inbound_pg_url',
  REPRACER_SQS_QUEUE_URL_FILE: '/run/secrets/sqs_queue_url',
  REPRACER_AWS_ACCESS_KEY_ID_FILE: '/run/secrets/aws_access_key_id',
  REPRACER_AWS_SECRET_ACCESS_KEY_FILE: '/run/secrets/aws_secret_access_key',
  REPRACER_RECEIVER_HEARTBEAT_URL_FILE: '/run/secrets/receiver_heartbeat_url',
} as const;

test('OQ-190: the receiver configuration reads the queue and the AWS keys from files; the region and the queue URL are not guessed', () => {
  const config = loadReceiverConfig(ENV, read);
  assert.equal(config.queueUrl, 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-notifications');
  assert.equal(config.region, 'EU');
  assert.equal(config.aws.sessionToken, null, 'without AssumeRole the permanent keys are used');
  assert.equal(config.silenceAlertAfterMs, null, 'empty value means the policy of the receiver decides');
  assert.throws(() => loadReceiverConfig({ ...ENV, REPRACER_AMAZON_REGION: 'eu' }, read), /CONFIG_INVALID: REPRACER_AMAZON_REGION/);
  // Шаг 28, E: адрес очереди значением переменной не принимается — только файлом, кроме режима стенда
  assert.throws(() => loadReceiverConfig({ ...ENV, REPRACER_SQS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/0/q', REPRACER_SQS_QUEUE_URL_FILE: '' }, read),
    /CONFIG_SECRET_IN_ENV: REPRACER_SQS_QUEUE_URL/);
  assert.match(
    loadReceiverConfig({ ...ENV, REPRACER_MODE: 'stand', REPRACER_SQS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/000000000000/stand', REPRACER_SQS_QUEUE_URL_FILE: '' }, read).queueUrl,
    /stand$/);
  // OQ-194: без адреса отметки процесс не стартует, пока её явно не выключили
  const { REPRACER_RECEIVER_HEARTBEAT_URL_FILE: _hb, ...withoutHeartbeat } = ENV;
  assert.throws(() => loadReceiverConfig(withoutHeartbeat, read), /CONFIG_MISSING: REPRACER_RECEIVER_HEARTBEAT_URL/);
  assert.equal(loadReceiverConfig({ ...withoutHeartbeat, REPRACER_RECEIVER_HEARTBEAT: 'off' }, read).heartbeatUrl, null);
  assert.throws(() => loadReceiverConfig({ ...ENV, REPRACER_AWS_SECRET_ACCESS_KEY_FILE: '/run/secrets/nope' }, read), /CONFIG_SECRET_UNREADABLE/);
  const { REPRACER_AMAZON_APPLICATION_ID: _omitted, ...withoutApp } = ENV;
  assert.throws(() => loadReceiverConfig(withoutApp, read), /CONFIG_MISSING: REPRACER_AMAZON_APPLICATION_ID/);
  assert.throws(() => loadReceiverConfig({ ...ENV, REPRACER_RECEIVER_SILENCE_MS: '1000' }, read), ConfigError);
});

test('OQ-190: the deployment starts the entry point of this service, keeps one instance and mounts the secrets read-only', () => {
  const compose = readFileSync(fileURLToPath(new URL('../../../deploy/notification-receiver/compose.yaml', import.meta.url)), 'utf8');
  assert.match(compose, /services\/notification-receiver\/src\/main\.ts/);
  assert.match(compose, /replicas: 1/);
  assert.match(compose, /\/run\/secrets:ro/);
  assert.match(compose, /REPRACER_SQS_QUEUE_URL_FILE/);
  assert.match(compose, /REPRACER_RECEIVER_HEARTBEAT_URL_FILE/);
  // Адрес очереди и ключи AWS значениями переменных не передаются
  assert.equal(/^\s+REPRACER_SQS_QUEUE_URL:/m.test(compose), false);
  assert.equal(/^\s+REPRACER_AWS_SECRET_ACCESS_KEY:/m.test(compose), false);
});

import { fileURLToPath } from 'node:url';
import { createDryMailSender, createHeartbeat, createMailSender, ProcessHealth, serveHealth, type Env } from '@repracer/service-runtime';
import { remoteJwks, staticJwks } from '@repracer/identity';
import { createLocalIssuer } from '@repracer/identity/test-issuer';
import { createPool } from '@repracer/pricing-store-pg';
import type { MailSender } from '@repracer/alert-delivery';
import { createPanel } from './panel.ts';
import { loadOperatorConfig } from './config.ts';

/**
 * Р-165 (шаг 40): процесс панели оператора платформы. Отдельный от консоли и НЕ публичный: в промышленном профиле он
 * не стоит за общим прокси, а слушает адрес, до которого добираются по SSH-туннелю или из названного списка адресов.
 *
 * Что он поднимает: HTTP панели на своём порту, `/healthz` и метрики на другом, отметку во внешнем сервисе [Р-127] и
 * ОДИН пул подключений ролью `repracer_operator`. Одна роль здесь — не упрощение: у панели ровно один набор прав, и
 * второго ей не нужно [Р-90].
 */

export interface RunningPanel {
  port: number;
  metricsPort: number;
  close(): Promise<void>;
}

/**
 * Подстановки прогона. Единственная — отправитель почты: живой прогон обязан ПРОЧИТАТЬ письмо, которое ушло владельцу
 * пилота, иначе «приглашение отправлено» проверяется словом отправителя о самом себе [Р-94]. Всё остальное процесс
 * строит из конфигурации сам, и подставить это нечем.
 */
export interface PanelOverrides {
  mail?: MailSender;
}

export async function startOperatorPanel(env: Env = process.env, overrides: PanelOverrides = {}): Promise<RunningPanel> {
  const config = loadOperatorConfig(env);
  const health = new ProcessHealth();
  const pool = createPool(config.pgUrl, { max: 4, applicationName: 'repracer-operator-panel' });
  const mail = overrides.mail ?? (config.mail ? createMailSender(config.mail) : createDryMailSender());

  /**
   * Ключи, которыми проверяется токен: у поставщика по адресу JWKS, а в режиме стенда — свои, из ключа прогона.
   * Выбор делает КОНФИГУРАЦИЯ, а не код маршрута: в работе значения `REPRACER_OPERATOR_STAND_KEY` не принимается вовсе.
   */
  const jwks = config.standIssuerKeyPem
    ? staticJwks(createLocalIssuer({ issuer: config.oidc.issuer, audience: config.oidc.audience, privateKeyPem: config.standIssuerKeyPem }).jwks)
    : remoteJwks(config.oidc.jwksUrl);

  const server = createPanel({
    pool,
    oidc: { issuer: config.oidc.issuer, audience: config.oidc.audience, jwks },
    mail,
    invitationBaseUrl: config.invitationBaseUrl,
    invitationTtlHours: config.invitationTtlHours,
    count: (name) => health.count(name),
  });

  const healthServer = await serveHealth(health, { port: config.metricsPort, prefix: 'repracer_operator', staleAfterMs: 120_000, host: '0.0.0.0' });
  health.alive();
  await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'INFO', code: 'OPERATOR_PANEL_STARTED', message: `operator panel on :${config.port}`, details: { mailDry: !config.mail } }));
    resolve();
  }));

  const alive = setInterval(() => health.alive(), 30_000);
  alive.unref();
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  const beat = async (): Promise<void> => {
    if (!heartbeat) return;
    try {
      await heartbeat.beat(health.healthy(120_000));
    } catch {
      health.count('heartbeat_failed');
    }
  };
  const heartbeatTimer = setInterval(() => { void beat(); }, 60_000);
  heartbeatTimer.unref();
  void beat();

  return {
    port: (server.address() as { port: number }).port,
    metricsPort: healthServer.port,
    async close() {
      clearInterval(alive);
      clearInterval(heartbeatTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await healthServer.close();
      await pool.end();
    },
  };
}

export async function main(): Promise<void> {
  await startOperatorPanel();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

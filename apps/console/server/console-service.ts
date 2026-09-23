import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHeartbeat, ProcessHealth, serveHealth, type Env } from '@repracer/service-runtime';
import { createAuthenticator, remoteJwks, staticJwks, type Authenticator, type Principal } from '@repracer/identity';
import { createLocalIssuer } from '@repracer/identity/test-issuer';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { pgStandJoinMember, pgStandUsers, STAND_EMAILS } from '@repracer/contract-tests/stand';
import { createStandApi, createStandServer, type StandIdentity } from './stand-server.ts';
import { createStaticHandler } from './static.ts';
import { loadConsoleConfig, CONSOLE_ROLES, type ConsoleConfig, type ConsoleRole } from './config.ts';
import { startDemoWorld, type RunningDemoWorld } from './demo-world.ts';

/**
 * Р-159 (шаг 37, OQ-221): консоль продавца как РАЗВОРАЧИВАЕМЫЙ процесс. До этого шага в репозитории был только сервер
 * стенда, который запускают руками, и промышленный профиль честно отвечал 503 вместо консоли.
 *
 * Что этот процесс делает: отдаёт собранный интерфейс и то же API, что стенд, держит `/healthz` и метрики на отдельном
 * порту и живёт за обратным прокси, который терминирует TLS [Р-158].
 *
 * Чего он НЕ делает и что названо прямо: тенанта продавца в нём завести нельзя — регистрации и подключения канала из
 * консоли ещё нет (OQ-213). Поэтому сегодня он поднимает ДЕМО-тенанта [Р-151] и пускает в него гостя [Р-160], а
 * продавец входит туда, где у него уже есть членство.
 */

/**
 * Издатель гостевых токенов. Это НЕ поставщик identity [Р-78]: у гостя нет учётной записи, и заводить её у поставщика
 * ради «посмотреть демо» значит просить человека зарегистрироваться, чтобы посмотреть демо без регистрации.
 *
 * Ключ приходит файлом секретов и одинаков у всех реплик; перезапуск сессии не рвёт. Временный ключ в памяти
 * разрешён только явно и означает «экземпляр один».
 *
 * Адрес издателя обязан быть https — этого требует проверка значения у привязки входа (0048). От настоящего поставщика
 * его отличает НЕ схема (он тоже https), а то, что эта строка закреплена в базе функцией `security.guest_issuer()`:
 * гостевое членство с чужим издателем база не создаёт.
 */
export const GUEST_ISSUER = 'https://guest.repracer.invalid';
const GUEST_AUDIENCE = 'repracer-console';
const GUEST_TOKEN_SECONDS = 3600;
/**
 * Сколько гостей демо выдаёт в минуту. Ограничение продукта, а не защита от злоумышленника: маршрут публичный, и без
 * предела он позволяет кому угодно писать строки в платформенные таблицы (находка 5 ревью шага 37). Шестьдесят в
 * минуту — это больше, чем бывает у демо, и меньше, чем нужно, чтобы его залить.
 */
const GUEST_SESSIONS_PER_MINUTE = 60;

function poolsFor(config: ConsoleConfig): Record<ConsoleRole, PgPool> {
  const out = {} as Record<ConsoleRole, PgPool>;
  // У каждой роли свой пул и своё имя в журнале базы: `pg_stat_activity` показывает, кто именно занял соединения
  const sizes: Partial<Record<ConsoleRole, number>> = { app: 8, admin: 4, authenticator: 2 };
  for (const role of CONSOLE_ROLES) out[role] = createPool(config.pgUrls[role], { max: sizes[role] ?? 2, applicationName: `repracer-console-${role}` });
  return out;
}

/**
 * Вход двумя путями сразу: продавец приходит с токеном поставщика, гость — с нашим. Оба проверяются ПОЛНОСТЬЮ (подпись,
 * издатель, получатель, сроки), и членства в обоих случаях читаются из базы при каждом запросе [Р-78].
 *
 * Издатель в токене читается БЕЗ проверки подписи — только чтобы выбрать проверяющего (находка 9 ревью шага 37).
 * Довериться ему нельзя и не нужно: выбранный проверяющий всё равно сверяет издателя сам, и подделать свой `iss` значит
 * лишь выбрать себе более строгую проверку. Зато публичное демо перестаёт зависеть от поставщика продавцов: пока
 * гостевые токены проверялись после провайдерских, недоступный JWKS ронял и гостя тоже.
 */
function issuerOf(authorization: string | undefined): string | null {
  const jwt = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization ?? '')?.[1];
  if (!jwt) return null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof payload.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

function bothIssuers(seller: Authenticator | null, guest: Authenticator, onSellerFailure: (error: unknown) => void): Authenticator {
  return {
    async authenticate(authorization: string | undefined): Promise<Principal | null> {
      if (issuerOf(authorization) === GUEST_ISSUER) return guest.authenticate(authorization);
      if (!seller) return guest.authenticate(authorization);
      try {
        return await seller.authenticate(authorization);
      } catch (error) {
        // Недоступный поставщик — не повод отвечать 500 гостю: его токен проверяется нашим ключом в памяти
        onSellerFailure(error);
        return guest.authenticate(authorization);
      }
    },
  };
}

/**
 * Запуск процесса. Окружение — параметр, а не только `process.env`: живой прогон поднимает ТОТ ЖЕ процесс на своей базе и
 * ходит по нему как браузер [Р-136, Р-142]. Прогон, зовущий обработчик мимо HTTP-слоя, не видит ни отдачи файлов, ни
 * предела тела, ни кодов ответа.
 */
export interface RunningConsole {
  port: number;
  metricsPort: number;
  demoTenantId: string | null;
  close(): Promise<void>;
}

export async function startConsole(env: Env = process.env): Promise<RunningConsole> {
  const config = loadConsoleConfig(env);
  const health = new ProcessHealth();
  const pools = poolsFor(config);
  const directory = new PgIdentityDirectory(pools.authenticator as never);

  /**
   * Ключ гостевого издателя приходит ИЗВНЕ (шаг 38): пока он рождался в памяти, две реплики за прокси подписывали
   * разными ключами, и гость получал случайные 401. Временный ключ остаётся, но только по явному требованию.
   */
  const guestIssuer = createLocalIssuer({ issuer: GUEST_ISSUER, audience: GUEST_AUDIENCE, ...(config.guestKeyPem ? { privateKeyPem: config.guestKeyPem } : {}) });
  if (config.publicDemo && !config.guestKeyPem) {
    console.log(JSON.stringify({ level: 'WARN', code: 'GUEST_KEY_EPHEMERAL', message: 'ключ гостевого издателя временный: экземпляр консоли должен быть ОДИН, иначе гость получит 401 от соседней реплики' }));
  }
  const guestAuth = createAuthenticator({ issuer: GUEST_ISSUER, audience: GUEST_AUDIENCE, jwks: staticJwks(guestIssuer.jwks), directory });
  const sellerAuth = config.oidc
    ? createAuthenticator({ issuer: config.oidc.issuer, audience: config.oidc.audience, jwks: remoteJwks(config.oidc.jwksUrl), directory })
    : null;

  // Держатель, а не переменная: пересев меняет мир, а замыкания (гость, остановка) смотрят на ТЕКУЩИЙ
  const state: { demo: RunningDemoWorld | null } = { demo: null };
  let tag = 3700;
  // Список миров у процесса ОДИН и тот же объект: пересев заменяет его содержимое, а обработчик держит ту же ссылку
  const worlds: unknown[] = [];
  const memberUsers = await pgStandUsers(directory as never, pools.onboarding as never);
  // Окно выдачи гостей: минута и счётчик в ней (находка 5 ревью шага 37)
  const guestWindow = { minute: 0, issued: 0 };

  const reseed = async (): Promise<void> => {
    const previous = state.demo;
    tag += 1;
    const started = await startDemoWorld({
      pools: { app: pools.app, admin: pools.admin, provisioning: pools.provisioning, dispatcher: pools.dispatcher, scheduler: pools.scheduler, exporter: pools.exporter, stock: pools.stock, bulkWorker: pools.bulk_worker },
      pgUrl: config.pgUrls.app,
      // Роли исполнителя заданий — ЯВНО: в работе строка подключения несёт пароль, и подстановка роли молча не сработала бы
      pgUrlsByRole: { admin: config.pgUrls.admin, bulk_worker: config.pgUrls.bulk_worker, stock: config.pgUrls.stock },
      tag, memberUsers, memberEmails: STAND_EMAILS,
      joinMember: pgStandJoinMember(pools.admin as never, directory as never),
      log: (m) => console.log(JSON.stringify({ level: 'INFO', code: 'CONSOLE_DEMO', message: m })),
    });
    state.demo = started;
    worlds.length = 0;
    worlds.push(started.world);
    health.count('demo_seeded');
    /**
     * Старый мир останавливается ПОСЛЕ того, как новый встал: иначе между пересевом и готовностью нового демо гость
     * видел бы пустой список миров и решил бы, что консоль сломалась. Данные старого тенанта остаются в базе —
     * удаляет их удаление по сроку, которому демо-тенант не исключение.
     */
    previous?.stop();
  };

  if (config.publicDemo) await reseed();

  const identity: StandIdentity = {
    authenticator: bothIssuers(sellerAuth, guestAuth, (error) => {
      health.count('seller_identity_unavailable');
      console.error(JSON.stringify({ level: 'ERROR', code: 'IDENTITY_PROVIDER_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }));
    }),
    ...(config.publicDemo
      ? {
        guest: {
          async issue() {
            const tenantId = state.demo?.tenantId;
            if (!tenantId) throw new Error('DEMO_NOT_READY');
            const minute = Math.floor(Date.now() / 60_000);
            if (minute !== guestWindow.minute) { guestWindow.minute = minute; guestWindow.issued = 0; }
            if (guestWindow.issued >= GUEST_SESSIONS_PER_MINUTE) {
              health.count('guest_rate_limited');
              throw new Error('GUEST_RATE_LIMIT');
            }
            guestWindow.issued += 1;
            const subject = `guest-${randomUUID()}`;
            // Членство гостя заводит БАЗА: здесь нет ни роли, ни прав — только адрес входа и тенант демо [Р-160]
            await pools.onboarding.query('SELECT security.create_demo_guest($1, $2, $3, $4)',
              [tenantId, GUEST_ISSUER, subject, `${subject}@demo.invalid`]);
            health.count('guest_session');
            // Второго фактора у гостя нет и быть не может: операций, которым он нужен, гостю не дано [Р-143, Р-160]
            return { accessToken: guestIssuer.token(subject, { email: `${subject}@demo.invalid`, amr: [], expiresInSeconds: GUEST_TOKEN_SECONDS }), expiresIn: GUEST_TOKEN_SECONDS };
          },
        },
      }
      : {}),
  };

  const api = createStandApi(worlds as never, identity);
  const server = createStandServer(api, config.locale, createStaticHandler(config.distDir));
  const healthServer = await serveHealth(health, { port: config.metricsPort, prefix: 'repracer_console', staleAfterMs: 120_000, host: '0.0.0.0' });
  health.alive();
  // Консоль слушает ВСЕ адреса контейнера: снаружи её выставляет только прокси, у самого процесса TLS нет [Р-158]
  await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'INFO', code: 'CONSOLE_STARTED', message: `console on :${config.port}`, details: { publicDemo: config.publicDemo, seller: Boolean(config.oidc) } }));
    resolve();
  }));

  // Пересев по расписанию [Р-160]: демо, в котором кто-то «выключил репрайсинг всему каталогу», показывать следующему гостю нельзя
  if (config.publicDemo) {
    const timer = setInterval(() => {
      health.alive();
      void reseed().catch((error: unknown) => console.error(JSON.stringify({ level: 'ERROR', code: 'CONSOLE_DEMO_RESEED_FAILED', message: error instanceof Error ? error.message : String(error) })));
    }, config.demoReseedHours * 3_600_000);
    timer.unref();
  }
  // Процесс жив, пока жив сервер: отдельного цикла у консоли нет, поэтому отметка обновляется по времени
  const alive = setInterval(() => health.alive(), 30_000);
  alive.unref();

  /**
   * Р-127: остановившуюся консоль не заметит никто — посетитель просто уйдёт, а продавец решит, что «опять упало».
   * Поэтому процесс отмечается во внешнем сервисе, как планировщик, диспетчер и приёмник.
   */
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  const beat = async (): Promise<void> => {
    if (!heartbeat) return;
    try {
      await heartbeat.beat(health.healthy(120_000));
    } catch {
      // Сорванная отметка — не повод ронять консоль: внешний сервис заметит её отсутствие сам
      health.count('heartbeat_failed');
    }
  };
  const heartbeatTimer = setInterval(() => { void beat(); }, 60_000);
  heartbeatTimer.unref();
  void beat();

  return {
    port: (server.address() as { port: number }).port,
    metricsPort: healthServer.port,
    demoTenantId: state.demo?.tenantId ?? null,
    async close() {
      clearInterval(alive);
      clearInterval(heartbeatTimer);
      state.demo?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await healthServer.close();
      await Promise.all(CONSOLE_ROLES.map((r) => pools[r].end()));
    },
  };
}

export async function main(): Promise<void> {
  await startConsole();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

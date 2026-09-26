import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { invitationMessage, type MailSender } from '@repracer/alert-delivery';
import { LOCALES, messagesFor, type Locale } from '@repracer/console-model';
import { hasSecondFactor, TokenError, verifyToken, type JwksSource } from '@repracer/identity';
import type { PgPool } from '@repracer/pricing-store-pg';
import { PANEL_PAGE } from './page.ts';

/**
 * Р-165…Р-168 (шаг 40): HTTP-слой панели оператора.
 *
 * Семь экранов чтения и ЧЕТЫРЕ действия — весь список здесь, и он закрытый: маршрута, который делает что-то ещё,
 * в панели нет, а если бы появился, у роли `repracer_operator` всё равно нет прав ни на одну таблицу (0126).
 *
 * Вход — только у поставщика identity, и панель не решает, кто оператор: пару (издатель, субъект) из проверенного
 * токена она отдаёт базе, а та отвечает действующей учётной записью или ничем [Р-165]. Второй фактор панель тоже не
 * проверяет сама [Р-104]: она объявляет его базе из утверждения `amr`, а отказывает — база, своей причиной.
 */

export interface PanelDeps {
  pool: PgPool;
  oidc: { issuer: string; audience: string; jwks: JwksSource };
  mail: MailSender;
  invitationBaseUrl: string;
  invitationTtlHours: number;
  /** Счётчики процесса: панель считает вызовы так же, как остальные процессы */
  count?: (name: string) => void;
  now?: () => Date;
}

interface Acting {
  operatorId: string;
  displayName: string;
  mfa: boolean;
}

/** Тело запроса панели маленькое: имя тенанта и заметка. Всё, что больше, — не запрос оператора */
const MAX_BODY = 64 * 1024;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Предел тела проверяется ДО разбора и после проверки входа: иначе панель разбирает чужие мегабайты
    if (size > MAX_BODY) throw new PanelError(413, 'BODY_TOO_LARGE', `тело запроса больше ${MAX_BODY} байт`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new PanelError(400, 'BODY_NOT_JSON', 'тело запроса — не объект JSON');
  }
}

export class PanelError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new PanelError(400, 'FIELD_MISSING', `поле ${key} обязательно`);
  return value.trim();
};

/**
 * Ошибка базы становится кодом ответа по её SQLSTATE, а не по тексту: причина отказа приходит от защиты, которая
 * отказала, и панель её не переписывает [Р-94]. Своих проверок у панели нет — значит и своих причин тоже.
 */
function fromDatabase(error: unknown): PanelError {
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? 'database error';
  if (code === '42501') return new PanelError(403, 'FORBIDDEN', message);
  if (code === '22023') return new PanelError(400, 'INVALID_PARAMETER', message);
  if (code === '23000' || code === '23505' || code === '23514') return new PanelError(409, 'CONFLICT', message);
  throw error;
}

export function createPanel(deps: PanelDeps): Server {
  const count = deps.count ?? (() => undefined);
  const now = deps.now ?? (() => new Date());

  /** Кто пришёл: проверенный токен → действующая учётная запись оператора. Чужому токену панель отвечает 401 */
  async function acting(req: IncomingMessage): Promise<Acting> {
    const header = req.headers.authorization;
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? '');
    if (!m) throw new PanelError(401, 'NO_TOKEN', 'вход у поставщика identity обязателен [Р-165]');
    let token;
    try {
      token = await verifyToken(m[1]!, deps.oidc);
    } catch (error) {
      if (error instanceof TokenError) throw new PanelError(401, 'TOKEN_REJECTED', 'токен не принят');
      throw error;
    }
    const { rows } = await deps.pool.query<{ operator_id: string; display_name: string }>(
      'SELECT operator_id, display_name FROM security.resolve_platform_operator($1, $2)', [token.issuer, token.subject]);
    const row = rows[0];
    if (!row) {
      count('operator_unknown');
      // Человек с настоящим входом, но без учётной записи оператора, — не оператор: панель не список сотрудников
      throw new PanelError(403, 'NOT_AN_OPERATOR', 'учётной записи оператора платформы нет или она отозвана [Р-165]');
    }
    return { operatorId: row.operator_id, displayName: row.display_name, mfa: hasSecondFactor(token.amr) };
  }

  /** Чтение: одна функция базы — один экран. Ни цен, ни себестоимости в них нет, и прав на них у роли тоже нет */
  async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await deps.pool.query(sql, params);
    return rows as T[];
  }

  /**
   * Действие: транзакция, в которой второй фактор ОБЪЯВЛЕН базе из `amr` токена. Объявление не равно разрешению —
   * отказывает `security.operator_acting`, и его причину панель не переписывает [Р-94].
   */
  async function act<T>(who: Acting, run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T | null>): Promise<T | null> {
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.auth_mfa', $1, true)", [who.mfa ? 'on' : 'off']);
      const value = await run((sql, params) => client.query(sql, params) as Promise<{ rows: unknown[] }>);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw fromDatabase(error);
    } finally {
      client.release();
    }
  }

  const localeOf = (value: string | null | undefined): Locale => (LOCALES.includes(value as Locale) ? (value as Locale) : 'de');

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://panel.invalid');
    const path = url.pathname;

    // Страница панели: разметка без данных. Всё, что в ней показано, приходит теми же запросами, что ниже
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PANEL_PAGE);
      return;
    }
    if (!path.startsWith('/api/operator/')) {
      json(res, 404, { code: 'NOT_FOUND' });
      return;
    }

    const who = await acting(req);
    const limit = Number(url.searchParams.get('limit') ?? '200');
    const rest = path.slice('/api/operator/'.length);

    if (req.method === 'GET') {
      count('read');
      switch (rest) {
        case 'session': json(res, 200, { operatorId: who.operatorId, displayName: who.displayName, secondFactor: who.mfa }); return;
        case 'jobs': json(res, 200, { jobs: await read('SELECT * FROM platform.operator_jobs()') }); return;
        case 'alerts': json(res, 200, { alerts: await read('SELECT * FROM platform.operator_alerts($1)', [limit]) }); return;
        case 'write-queue': json(res, 200, { queue: await read('SELECT * FROM platform.operator_write_queue()') }); return;
        case 'notifications': json(res, 200, { notifications: await read('SELECT * FROM platform.operator_notifications()') }); return;
        case 'tenants': json(res, 200, { tenants: await read('SELECT * FROM platform.operator_tenants()') }); return;
        case 'snapshot-skips': json(res, 200, { skips: await read('SELECT * FROM platform.operator_snapshot_skips($1)', [limit]) }); return;
        case 'actions': json(res, 200, { actions: await read('SELECT * FROM platform.operator_actions_log($1, $2)', [url.searchParams.get('action'), limit]) }); return;
        default: json(res, 404, { code: 'NOT_FOUND' }); return;
      }
    }

    if (req.method !== 'POST') {
      json(res, 405, { code: 'METHOD_NOT_ALLOWED' });
      return;
    }

    const body = await readBody(req);
    // ---- Действие 1: тенант пилота [Р-167]
    if (rest === 'tenants') {
      const name = str(body, 'name');
      const region = str(body, 'region');
      const ownerEmail = str(body, 'ownerEmail').toLowerCase();
      // Язык, на котором продавец читает письма и экраны [Р-161]: список проверяет база, панель его не повторяет [Р-104]
      const locale = typeof body.locale === 'string' && body.locale.trim() !== '' ? body.locale.trim() : 'de';
      const tenantId = randomUUID();
      const ownerUserId = randomUUID();
      await act(who, async (query) => {
        await query('SELECT security.operator_create_tenant($1, $2, $3, $4, $5, $6, $7)',
          [who.operatorId, tenantId, name, region, ownerUserId, ownerEmail, locale]);
        return null;
      });
      count('tenant_created');
      json(res, 201, { tenantId, ownerEmail, locale });
      return;
    }

    // ---- Действие 2: приглашение владельца письмом [Р-166, Р-167]
    const invite = /^tenants\/([0-9a-f-]{36})\/invite$/.exec(rest);
    if (invite) {
      const tenantId = invite[1]!;
      const email = str(body, 'email').toLowerCase();
      /**
       * Токен приглашения рождается ЗДЕСЬ и уходит в письмо; база видит только его отпечаток (0053). В журнал он не
       * попадает ни разу — ни в тексте письма, ни в ответе: ответ панели называет приглашение идентификатором.
       */
      const token = randomBytes(32).toString('base64url');
      const sha = createHash('sha256').update(token).digest();
      const ttl = `${deps.invitationTtlHours} hours`;
      const invitationId = await act<string>(who, async (query) => {
        const { rows } = await query('SELECT security.operator_invite_owner($1, $2, $3, $4, $5::interval) AS id',
          [who.operatorId, tenantId, email, sha, ttl]);
        return (rows[0] as { id: string }).id;
      });
      const tenants = await read<{ tenant_id: string; name: string; locale: string }>('SELECT * FROM platform.operator_tenants()');
      const tenant = tenants.find((t) => t.tenant_id === tenantId);
      const expiresAt = new Date(now().getTime() + deps.invitationTtlHours * 3_600_000).toISOString();
      // Письмо читает ПРОДАВЕЦ, поэтому язык — тенанта [Р-161], а не оператора
      const letter = invitationMessage(email, tenant?.name ?? '', `${deps.invitationBaseUrl}#${token}`, expiresAt, messagesFor(localeOf(tenant?.locale)));
      const sent = await deps.mail.send(letter);
      count('owner_invited');
      json(res, 201, { invitationId, mailRef: sent.ref, dryRun: Boolean(deps.mail.dry), expiresAt });
      return;
    }

    // ---- Действие 3: пропуск снимков разобран [OQ-181]
    const resolve = /^snapshot-skips\/([0-9a-f-]{36})\/resolve$/.exec(rest);
    if (resolve) {
      const resolution = str(body, 'resolution');
      const note = str(body, 'note');
      await act(who, async (query) => {
        await query('SELECT security.operator_resolve_snapshot_skip($1, $2, $3, $4)', [who.operatorId, resolve[1], resolution, note]);
        return null;
      });
      count('snapshot_skip_resolved');
      json(res, 200, { resolved: resolve[1], resolution });
      return;
    }

    // ---- Действие 4: алерт увиден [Р-166]
    const ack = /^alerts\/([0-9a-f-]{36})\/acknowledge$/.exec(rest);
    if (ack) {
      const tenantId = str(body, 'tenantId');
      await act(who, async (query) => {
        await query('SELECT security.operator_acknowledge_alert($1, $2, $3)', [who.operatorId, tenantId, ack[1]]);
        return null;
      });
      count('alert_acknowledged');
      json(res, 200, { acknowledged: ack[1] });
      return;
    }

    json(res, 404, { code: 'NOT_FOUND' });
  }

  return createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (error instanceof PanelError) {
        json(res, error.status, { code: error.code, message: error.message });
        return;
      }
      count('error');
      // Текст внутренней ошибки наружу не идёт: в нём бывают строки подключения и параметры запросов
      console.error(JSON.stringify({ level: 'ERROR', code: 'OPERATOR_PANEL_ERROR', message: error instanceof Error ? error.message : String(error) }));
      json(res, 500, { code: 'INTERNAL' });
    });
  });
}

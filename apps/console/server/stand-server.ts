import { createHash } from 'node:crypto';
import { parseStockSheet } from '@repracer/stock-sync';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  boundsDiffView, boundsView, bulkJobsView, bulkJobView, can, canCancelBulkJob, channelNotes, onboardingView, complianceView, fingerprint, costImportView, currentStrategies, listQuery, MAX_SCOPES, OFFER_CHOICES, pageOf, parseListQuery, type ListQuery, discountCheckView, dangerousReport, decisionListView, decisionTrace, describe, expandBoundsEdit, importTargets, LOCALES, messagesFor, parseBoundsEditRequest, parseFeedQuery, scopeById, unitOf,
  parseStrategyDraft, planStop, priceFeed, productList, rejectedView, REPORT_PERIODS_DAYS, stopView, strategiesView,
  type Locale, type Messages, type StandWorld, type StopTarget, type Viewer,
  productPage, clampOffset, feedPageQuery, REJECTED_WINDOW_DAYS, stockView, stockDivergencesView, shadowView, SHADOW_PERIOD_DAYS,
} from '@repracer/console-model';
import { buildPreview, readTable, suggestMapping, TABLE_ENCODINGS } from '@repracer/cost-import';
import type { BulkJobInput, DiscountAnnouncementInput } from '@repracer/pricing-pipeline';
import {
  buildStandWorlds, memoryStandDirectory, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, type LiveWorld,
} from '@repracer/contract-tests/stand';
import { createAuthenticator, hasSecondFactor, remoteJwks, staticJwks, type Authenticator, type Principal } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import {
  NOTE_MAX, NOTE_MIN, type BoundsIndexItem, type BoundsIndexView, type EnableResult, type NoteRequest, type SessionView, type StopRequest, type StrategySaveResponse, type WorldSummary,
} from '../src/api-types.ts';

/**
 * Сервер стенда для интерфейса [Р-67]. Только 127.0.0.1, данные синтетические.
 * Вход [Р-78]: паролей и сессий у нас нет — запрос несёт токен поставщика identity (`Authorization: Bearer`), сервер проверяет
 * подпись, издателя, получателя и сроки, находит пользователя по (издатель, subject) и читает членства и роли при каждом запросе.
 * На стенде поставщика заменяет локальный имитатор (как имитаторы каналов); в работе — поставщик из ADR-0013.
 * Права действий проверяет хранилище пути решения (на PostgreSQL — БД), сервер дублирует проверку, чтобы ответить 403 до вызова.
 * Автор действия — пользователь токена: его членство сверяет хранилище (находка 4). Тексты — на языке запроса [Р-72].
 */

export interface ApiRequest {
  method: string;
  url: string;
  body: unknown;
  authorization?: string | undefined;
  cookie?: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  setCookies?: string[];
  /** Файл задания [OQ-202]: он не JSON — выгрузка в 28 МБ внутри JSON была бы тем же синхронным ответом, только длиннее */
  file?: { contentType: string; content: string; fileName: string };
}

export interface StandIdentity {
  authenticator: Authenticator;
  /** Имитатор поставщика — только стенд: выдаёт токен синтетического пользователя по роли */
  /**
   * Имитатор поставщика — только стенд: выдаёт токен синтетического пользователя по роли. Второй фактор — ПАРАМЕТР [OQ-209]:
   * пока имитатор выдавал всем `amr: ['pwd','otp']`, ни один живой прогон не отличал операцию, требующую второго фактора, от
   * не требующей, и регрессия «перестало просить» была невидима.
   */
  simulator?: { token(account: (typeof STAND_ACCOUNTS)[number], options?: { secondFactor?: boolean }): string; expiresInSeconds: number };
  /**
   * Р-160 (шаг 37): публичное демо. Гость приходит без регистрации и получает НАБЛЮДАТЕЛЯ в демо-тенанте: членство
   * заводит база (`security.create_demo_guest`), а токен подписываем мы — поставщик про гостя не знает и знать не
   * должен. Чего гость не может, держит база, а не этот маршрут: роль не повышается, заданий он не создаёт.
   */
  guest?: { issue(): Promise<{ accessToken: string; expiresIn: number }> };
}

export const LOCALE_COOKIE = 'repracer_locale';

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function note(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text.length >= NOTE_MIN && text.length <= NOTE_MAX ? text : null;
}

function parseTarget(live: LiveWorld, raw: unknown): StopTarget | null {
  const t = raw as Partial<{ kind: string; channelAccountId: string; marketplace: string }> | null;
  if (t?.kind === 'TENANT') return { kind: 'TENANT' };
  const account = live.accounts.find((a) => a.channelAccountId === t?.channelAccountId);
  if (!account) return null;
  if (t?.kind === 'CHANNEL_ACCOUNT') return { kind: 'CHANNEL_ACCOUNT', channelAccountId: account.channelAccountId };
  if (t?.kind === 'STOREFRONT' && typeof t.marketplace === 'string' && account.marketplaces.includes(t.marketplace)) {
    return { kind: 'STOREFRONT', channelAccountId: account.channelAccountId, marketplace: t.marketplace };
  }
  return null;
}

/**
 * Предложения запроса: список идентификаторов ИЛИ «все» [Р-136]. Список каталога — 381 КБ, он не проходит предел тела запроса
 * (413, ревью шага 29, находка 1), а экран со страницами может перечислить только страницу. «Все» раскрывает сервер.
 */
function scopeIds(raw: unknown, world: StandWorld, all: unknown): string[] | null {
  if (all === true) return world.state.scopes.map((s) => s.writeScopeId);
  return Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_SCOPES && raw.every((x) => typeof x === 'string') ? [...new Set(raw as string[])] : null;
}

function draftProblemsText(problems: ReadonlyArray<{ field: string; code: string }>, m: Messages): string {
  const t = m.ui.strategies;
  return problems.map((p) => `${(t.fields as Record<string, string>)[p.field] ?? (p.field === 'name' ? t.name : p.field === 'type' ? t.type : p.field)}: ${t.problems[p.code as keyof typeof t.problems]}`).join('; ');
}

/** Настоящая календарная дата YYYY-MM-DD: 2026-13-01 и 2026-02-30 — нет (находка 11 ревью шага 24) */
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** Р-123: выгрузка доказательной истории — не больше 18 месяцев за запрос */
export const EVIDENCE_MAX_DAYS = 550;
/** Р-154: экран остановок показывает последние события аудита, а не весь журнал тенанта */
const AUDIT_RECENT = 200;
/**
 * Inbound API: строк в одном вызове — не больше; склад шлёт партиями.
 *
 * Предел ИЗМЕРЕН (находка 10 ревью шага 36), а не объявлен: 5000 заказов в одном `POST /inbound/v1/orders` — 218 896
 * байт тела и 1,6–2,7 секунды (два прогона) при сроке ответа экрана в 10 секунд (`apps/console/test/stock-only-live.pg.test.ts`, живой
 * прогон через HTTP). Разбор идёт по одному номеру заказа, и до замера предел был недостижим: тело в 218 КБ отвергалось
 * с 413, потому что этот маршрут не был назван партией продавца в `bodyLimitFor`.
 */
const INBOUND_ROWS_MAX = 5000;
/**
 * Шаг 30 [OQ-202]: предела строк у выгрузки больше НЕТ. Шаг 29 ввёл его (100 000), потому что 300 000 строк — это 28 МБ в одном
 * ответе экрана и десять секунд ожидания. Задание готовит файл в базе, и предел исчез вместе со своей причиной: ждать нечего,
 * продавец скачивает готовое. Предел ПЕРИОДА остался — он не про объём ответа, а про смысл доказательства (≤ 18 месяцев).
 */

/** Р-123: объявление скидки из тела запроса; неверное — null (ответ 400) */
function parseDiscount(world: StandWorld, raw: unknown): DiscountAnnouncementInput | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const scope = typeof r.writeScopeId === 'string' ? scopeById(world, r.writeScopeId) : undefined;
  const amount = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
  const instant = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const reference = amount(r.referencePriceMinor);
  const sale = amount(r.salePriceMinor);
  const startsAt = instant(r.startsAt);
  const endsAt = r.endsAt === null || r.endsAt === undefined || r.endsAt === '' ? null : instant(r.endsAt);
  if (!scope || reference === null || sale === null || startsAt === null || (r.endsAt && endsAt === null)) return null;
  return { writeScopeId: scope.writeScopeId, referencePriceMinor: reference, salePriceMinor: sale, currency: scope.currency, startsAt, endsAt };
}

/**
 * Р-123, Р-124: экран комплаенса — объявленные скидки с повторной проверкой по текущей истории и глубина видимой истории каждого оффера
 * на сейчас
 */
async function compliance(live: LiveWorld, world: StandWorld, m: Messages, query?: ListQuery) {
  const announcements = await live.store.discountAnnouncements(world.tenantId);
  const rechecks = new Map(await Promise.all(announcements.map(async (a) => [a.announcementId, await live.store.omnibusCheck(world.tenantId, a.writeScopeId, a.startsAt)] as const)));
  const now = live.clock.iso();
  /**
   * Р-136: глубина истории считается только у ПОКАЗАННЫХ предложений. На каталоге целевого клиента этот экран спрашивал базу
   * десять тысяч раз подряд: 24,8 секунды и 8,7 МБ ответа (живой прогон через консоль, шаг 29).
   */
  const { items: shown } = pageOf(world.state.scopes, listQuery(query), m);
  const depth = new Map(await Promise.all(shown.map(async (sc) => [sc.writeScopeId, await live.store.omnibusCheck(world.tenantId, sc.writeScopeId, now)] as const)));
  return complianceView(world, announcements, rechecks, m, depth, listQuery(query));
}

/** Шаг 23: устаревший экран различий — какой оффер и какие границы у него сейчас */
function conflictText(world: StandWorld, conflict: { writeScopeId: string; actual: { minMinor: number | null; maxMinor: number | null } }, m: Messages): string {
  const scope = scopeById(world, conflict.writeScopeId);
  if (!scope) return m.ui.server.boundsConflict;
  return m.ui.server.boundsConflictAt(unitOf(world, scope, m).label, m.money(conflict.actual.minMinor, scope.currency), m.money(conflict.actual.maxMinor, scope.currency));
}

export function createStandApi(worlds: readonly LiveWorld[], identity: StandIdentity) {
  const localeCookie = (l: Locale) => `${LOCALE_COOKIE}=${l}; SameSite=Strict; Path=/; Max-Age=31536000`;

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    const url = new URL(req.url, 'http://stand');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const jar = cookies(req.cookie);
    const requested = url.searchParams.get('locale');
    const locale: Locale = isLocale(requested) ? requested : isLocale(jar[LOCALE_COOKIE]) ? jar[LOCALE_COOKIE] : 'de';
    const m = messagesFor(locale);
    const s = m.ui.server;
    const ok = (body: unknown, setCookies?: string[]): ApiResponse => ({ status: 200, body, ...(setCookies ? { setCookies } : {}) });
    const fail = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Токен поставщика проверяется при каждом запросе; недействительный токен — как его отсутствие
    const principal: Principal | null = await identity.authenticator.authenticate(req.authorization);
    const sessionView = (l: Locale): SessionView => ({
      user: principal ? { subject: principal.subject, email: principal.email } : null, locale: l,
      simulator: identity.simulator ? STAND_ACCOUNTS.map((a) => ({ role: a.role, label: m.values[a.role] })) : null,
      demoGuest: Boolean(identity.guest),
    });

    /**
     * Шаг 35 [Р-152]: Inbound API остатков — путь для склада продавца, а не для браузера. Свой ключ, не токен поставщика:
     * `Authorization: Bearer <ключ>`; ключ находится по префиксу и отпечатку ДО контекста тенанта. Неверный ключ — 401 без
     * подробностей. Устаревшее значение (asOf не новее известного) не применяется и называется в ответе.
     */
    /**
     * Ключ Inbound API находится по префиксу и отпечатку ДО контекста тенанта, а мир выбирается по ТЕНАНТУ ключа [Р-31]:
     * миры одной базы находят ключи друг друга, и первый в списке забирал бы чужой (находка 5 ревью шага 35).
     */
    const inboundKeyHolder = async () => {
      const raw = req.authorization?.startsWith('Bearer ') ? req.authorization.slice(7).trim() : '';
      if (!/^rpk_[0-9a-f]{12}\.[0-9a-f]{48}$/.test(raw)) return null;
      const prefix = raw.split('.')[0] ?? '';
      for (const w of worlds) {
        const r = await w.stock.resolveInboundKey(prefix, createHash('sha256').update(raw).digest('hex'));
        if (!r) continue;
        const own = worlds.find((x) => x.tenantId === r.tenantId);
        return own ? { ...r, world: own } : null;
      }
      return null;
    };

    /**
     * Р-157 (шаг 36, OQ-217): источник сообщает «заказ учтён» — резервации этого заказа закрываются сразу. Освобождение
     * по сроку [Р-25] остаётся страховкой: до шага 36 подтверждать резервацию Inbound API было НЕКОМУ, и единственным
     * путём был TTL — товар уже отгружен, а доступный остаток занижен сутки.
     */
    if (parts[0] === 'inbound' && parts[1] === 'v1' && parts[2] === 'orders') {
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      const resolved = await inboundKeyHolder();
      if (!resolved) return fail(401, 'UNAUTHORIZED', s.unauthenticated);
      const refs = Array.isArray(body.orders) ? (body.orders as unknown[]) : null;
      if (!refs || refs.length === 0 || refs.length > INBOUND_ROWS_MAX) return fail(400, 'BAD_ROWS', s.badRequest);
      const parsedRefs: string[] = [];
      for (const r of refs) {
        const x = r as Record<string, unknown>;
        const ref = typeof x.externalOrderRef === 'string' ? x.externalOrderRef.trim() : '';
        if (ref === '') return fail(400, 'BAD_ROWS', s.badRequest);
        parsedRefs.push(ref);
      }
      const outcome = await resolved.world.stock.confirmInboundOrders(resolved.tenantId, resolved.stockSourceId, parsedRefs);
      return ok(outcome);
    }

    if (parts[0] === 'inbound' && parts[1] === 'v1' && parts[2] === 'stock') {
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      const resolved = await inboundKeyHolder();
      if (!resolved) return fail(401, 'UNAUTHORIZED', s.unauthenticated);
      const rows = Array.isArray(body.rows) ? (body.rows as unknown[]) : null;
      if (!rows || rows.length === 0 || rows.length > INBOUND_ROWS_MAX) return fail(400, 'BAD_ROWS', s.badRequest);
      const parsed: Array<{ sku: string; quantity: number; asOf: string }> = [];
      for (const r of rows) {
        const x = r as Record<string, unknown>;
        if (typeof x.sku !== 'string' || x.sku.trim() === '' || !Number.isSafeInteger(x.quantity) || (x.quantity as number) < 0
          || typeof x.asOf !== 'string' || Number.isNaN(Date.parse(x.asOf))) return fail(400, 'BAD_ROWS', s.badRequest);
        parsed.push({ sku: x.sku.trim(), quantity: x.quantity as number, asOf: new Date(x.asOf).toISOString() });
      }
      /**
       * Р-31: тенант приходит с ключом и СВЕРЯЕТСЯ с миром, которому ключ принадлежит. Первая редакция писала в тенанта
       * мира, а найденный тенант не использовала: пока мир на базе один, это совпадало, а на двух первый же мир списка
       * поймал бы чужой ключ (ревью шага 35, находка 5).
       */
      if (resolved.tenantId !== resolved.world.tenantId) return fail(401, 'UNAUTHORIZED', s.unauthenticated);
      const outcome = await resolved.world.stock.inboundStock(resolved.tenantId, resolved.stockSourceId, parsed);
      const propagated = outcome.productIds.length > 0 && resolved.world.stockPipeline ? await resolved.world.stockPipeline.propagate(resolved.tenantId, outcome.productIds) : { writes: 0, unchanged: 0 };
      return ok({ applied: outcome.applied, stale: outcome.stale, unknownSkus: outcome.unknownSkus, writes: propagated.writes });
    }

    if (parts[0] !== 'api') return fail(404, 'NOT_FOUND', s.notFound);

    if (parts[1] === 'session') {
      if (req.method === 'GET' && parts.length === 2) return ok(sessionView(locale));
      if (req.method === 'POST' && parts[2] === 'locale') {
        if (!isLocale(body.locale)) return fail(400, 'BAD_LOCALE', s.notFound);
        return ok(sessionView(body.locale), [localeCookie(body.locale)]);
      }
      return fail(404, 'NOT_FOUND', s.notFound);
    }

    /**
     * Р-160: «посмотреть демо». Гостя заводит база и возвращает наблюдателя демо-тенанта; ответ — такой же токен, как у
     * продавца, потому что дальше гость ходит ТЕМ ЖЕ путём: те же экраны, те же проверки прав, та же роль из членства.
     */
    if (parts[1] === 'demo' && parts[2] === 'guest') {
      if (!identity.guest) return fail(404, 'NOT_FOUND', s.notFound);
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      /**
       * Находка 5 ревью шага 37: маршрут ПУБЛИЧНЫЙ, и каждый вызов — три строки в платформенных таблицах. Без предела
       * это способ писать в базу без учётной записи. Предел — свойство демо, и он назван продавцу словами, а не молча
       * отдаёт 500.
       */
      const issued = await identity.guest.issue().catch((error: unknown) => {
        if ((error as Error).message === 'GUEST_RATE_LIMIT') return null;
        throw error;
      });
      if (!issued) return fail(429, 'DEMO_BUSY', s.demoBusy);
      return ok({ accessToken: issued.accessToken, tokenType: 'Bearer', expiresIn: issued.expiresIn });
    }

    // Имитатор поставщика стенда: токен синтетического пользователя; в работе этого адреса нет
    if (parts[1] === 'stand-issuer' && parts[2] === 'token') {
      if (!identity.simulator) return fail(404, 'NOT_FOUND', s.notFound);
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      const account = STAND_ACCOUNTS.find((a) => a.role === body.role);
      if (!account) return fail(400, 'UNKNOWN_ACCOUNT', s.unknownAccount);
      // Вход без второго фактора — как у продавца, вошедшего одним паролем: так проверяется, что его действительно просят
      const secondFactor = body.secondFactor !== false;
      return ok({ accessToken: identity.simulator.token(account, { secondFactor }), tokenType: 'Bearer', expiresIn: identity.simulator.expiresInSeconds });
    }

    if (!principal) return fail(401, 'UNAUTHENTICATED', s.unauthenticated);
    if (parts[1] !== 'worlds') return fail(404, 'NOT_FOUND', s.notFound);

    // Роль — из членства при каждом запросе; мира без членства для пользователя нет
    const viewerIn = (live: LiveWorld): Viewer | null => {
      const membership = principal.memberships.find((x) => x.tenantId === live.identityTenantId);
      return membership ? { membershipId: live.membershipAlias(membership.membershipId), role: membership.role } : null;
    };

    if (parts.length === 2) {
      if (req.method !== 'GET') return fail(405, 'METHOD', s.method);
      const visible = worlds.flatMap((live) => {
        const viewer = viewerIn(live);
        return viewer ? [{ live, viewer }] : [];
      });
      // Р-154: список миров — счётчики агрегатом, без чтения состояния ни одного мира
      return ok(await Promise.all(visible.map(async ({ live, viewer }): Promise<WorldSummary> => {
        const [c, accounts] = await Promise.all([live.store.worldCounters(live.tenantId, live.clock.iso() as never), live.store.channelAccounts(live.tenantId)]);
        return {
          id: live.id, title: live.title, description: live.description, failures: live.failures, scopes: c.scopes, decisionsLastDay: c.decisionsLastDay,
          interventionsLastWeek: c.interventionsLastWeek, activeStops: c.activeStops, activeHalts: c.activeHalts, role: m.values[viewer.role],
          // Р-151: демо помечается уже в списке миров; Р-150: сколько каналов ждёт доступа — видно до входа в мир
          demo: c.demo,
          awaitingAccess: accounts.filter((a) => a.authStatus === 'AWAITING_ACCESS').length,
        };
      })));
    }

    const live = worlds.find((w) => w.id === parts[2]);
    const viewer = live ? viewerIn(live) : null;
    if (!live || !viewer) return fail(404, 'WORLD_NOT_FOUND', s.notFound);
    /**
     * Р-149: экран пути читает ТОЛЬКО то, что показывает, — счётчики шагов, аккаунты, сужение и признак демо, — и не ждёт
     * состояния консоли целиком (`live.view` читает все решения тенанта, OQ-214). На раннере CI первый запрос экрана пути
     * демо-тенанта занял 10,98 с при пределе 10: остальные восемь — 0,04–0,09 с. Экран, у которого шесть чисел, не должен
     * зависеть от размера ленты решений.
     */
    if (req.method === 'GET' && parts[3] === 'onboarding' && parts[4] === undefined) {
      const [progress, status, accounts, demo] = await Promise.all([
        live.store.onboardingProgress(live.tenantId), live.store.onboardingStatus(live.tenantId), live.store.channelAccounts(live.tenantId),
        live.store.tenantIsDemo(live.tenantId),
      ]);
      return ok(onboardingView({ id: live.id, demo, viewer }, progress, status, accounts, m));
    }
    const world = await live.view(viewer);
    /**
     * Р-151: признак демо — из БАЗЫ (`tenant.demo` в состоянии консоли), а не из настройки стенда. Первая редакция брала его
     * из поля, выставленного руками, и столбец базы не читал никто: забытая настройка сняла бы метку молча (ревью шага 34,
     * находка 4).
     */
    world.demo = world.state.demo;
    const screen = parts[3];
    const param = parts[4] ?? null;
    /**
     * Задача D шага 34: у тенанта без единого канала первого аккаунта нет. Раньше здесь стояло `live.accounts[0]!` — на пустом
     * тенанте это 500 вместо честного ответа «канал не подключён».
     */
    const noChannel = (): never => { throw Object.assign(new Error('no channel account'), { cause: 'NO_CHANNEL' }); };
    const ctx = (channelAccountId?: string | null) => live.callContext(channelAccountId ?? live.accounts[0]?.channelAccountId ?? noChannel());

    /**
     * Р-120: предложение, которое канал оценивает сам, стратегию не получает. Проверка осталась в запросе, а не ушла в задание:
     * продавцу это надо сказать сразу, а не через отказ задания. Последнее слово всё равно за базой (0082).
     */
    const channelPriced = (ids: readonly string[]) => {
      for (const id of ids) {
        const scope = scopeById(world, id);
        if (scope && channelNotes(world, scope, m).some((n) => n.code !== 'PRICING_HEALTH')) return unitOf(world, scope, m).label;
      }
      return null;
    };
    /**
     * Р-139: массовая операция — создание ЗАДАНИЯ. Запрос обязан быть дешёвым: всё, что растёт с размером каталога, делает
     * задание. Второй фактор предъявляется здесь, человеком; фоновый процесс предъявит базе само задание.
     */
    const createJob = async (kind: BulkJobInput['kind'], params: Record<string, unknown>, totalItems: number | null, message: string): Promise<ApiResponse> => {
      // Язык — тот, на котором человек создал задание [Р-72]: тексты его итога пишет процесс, у которого запроса уже нет
      const created = await live.store.createBulkJob(world.tenantId, { kind, params: { ...params, locale }, ...(totalItems === null ? {} : { totalItems }) },
        { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (created.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', kind === 'COST_IMPORT' ? m.ui.costImport.mfa : s.mfaRequiredBounds);
      if (created.status === 'QUEUE_FULL') return fail(409, 'QUEUE_FULL', m.ui.jobs.queueFull);
      if (created.status !== 'CREATED') return fail(403, 'FORBIDDEN', s.forbidden);
      const job = await live.store.bulkJob(world.tenantId, created.jobId);
      return ok({ jobId: created.jobId, message, ...(job ? { job: bulkJobView(job, m) } : {}) });
    };

    if (req.method === 'GET') {
      switch (screen) {
        /**
         * Шаг 41 [Р-169…Р-171]: теневой режим. Сводку считает база агрегатом [Р-154], список удержанных записей идёт
         * страницей. У мира сценария в памяти режима нет — честный 404 вместо выдуманных чисел.
         */
        case 'shadow': {
          if (param !== null) return fail(404, 'NOT_FOUND', s.notFound);
          if (!live.shadow) return fail(404, 'NOT_FOUND', s.notFound);
          const query = parseListQuery(url.searchParams);
          if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
          /**
           * Находка 3 ревью шага 41: окно отчёта выбирается из НАЗВАННЫХ вариантов, а не приходит свободным числом —
           * иначе «дней = 100000» прошло бы до запроса и прочитало всю историю тенанта [Р-154].
           */
          const daysParam = url.searchParams.get('days');
          const days = daysParam === null ? SHADOW_PERIOD_DAYS[0] : Number(daysParam);
          if (!(SHADOW_PERIOD_DAYS as readonly number[]).includes(days)) return fail(400, 'BAD_PAGE', s.badRequest);
          const probe = await live.shadow.shadowPage(world.tenantId, live.clock.iso(), { offset: 0, limit: 1, sinceDays: days });
          const clamped = { ...query, offset: clampOffset(query, probe.total) };
          const page = await live.shadow.shadowPage(world.tenantId, live.clock.iso(), { ...clamped, sinceDays: days });
          return ok(shadowView(world, page, clamped, m, days));
        }
        // Шаг 35 [Р-153]: остатки — страницей по товарам, сводка агрегатом, расхождения — отдельным списком
        case 'stock': {
          if (param === 'divergences') return ok(stockDivergencesView(world, await live.stock.stockDivergences(world.tenantId, 200), m));
          if (param !== null) return fail(404, 'NOT_FOUND', s.notFound);
          const query = parseListQuery(url.searchParams);
          if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
          // Смещение за концом подтягивается ДО выборки — иначе подпись «151–200 из 200» стоит над пустой таблицей
          const probe = await live.stock.stockPage(world.tenantId, { offset: 0, limit: 1 });
          const clamped = { ...query, offset: clampOffset(query, probe.total) };
          const [page, sources] = await Promise.all([live.stock.stockPage(world.tenantId, clamped), live.stock.stockSources(world.tenantId)]);
          return ok(stockView(world, page, clamped, sources, m));
        }
        case 'products': {
          const query = parseListQuery(url.searchParams);
          if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
          // Р-154: статистика решений — только для показанных строк, по индексу единицы
          const { shown } = productPage(world, m, query);
          return ok(productList(world, m, query, await live.store.scopeDecisionStats(world.tenantId, shown.map((x) => x.writeScopeId))));
        }
        case 'decisions': {
          if (param === null) {
            // Р-154: страницу и итог отдаёт база; смещение за концом подтягивается к последней странице теми же правилами
            const query = parseListQuery(url.searchParams);
            if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
            const scopeFilter = url.searchParams.get('writeScopeId');
            if (scopeFilter && !scopeById(world, scopeFilter)) return fail(400, 'BAD_PAGE', s.badRequest);
            const probe = await live.store.decisionPage(world.tenantId, { offset: 0, limit: 1, ...(scopeFilter ? { writeScopeId: scopeFilter } : {}) });
            const clamped = { ...query, offset: clampOffset(query, probe.total) };
            const page = await live.store.decisionPage(world.tenantId, { ...clamped, ...(scopeFilter ? { writeScopeId: scopeFilter } : {}) });
            return ok(decisionListView(world, page, clamped, m));
          }
          const detail = await live.store.decisionDetail(world.tenantId, param);
          return detail ? ok(decisionTrace(world, detail, m)) : fail(404, 'DECISION_NOT_FOUND', s.notFound);
        }
        case 'rejected': {
          // Р-154: отчёт — по вмешательствам окна (неделя), «без изменения» до экрана не доходят
          const to = world.now;
          const from = new Date(Date.parse(to) - REJECTED_WINDOW_DAYS * 86_400_000).toISOString();
          return ok(rejectedView(world, await live.store.interventions(world.tenantId, from as never, to as never), m));
        }
        case 'bounds': {
          if (param === null) {
            // Р-136: страница, а не весь каталог; список границ — тот же порядок, что у списка товаров
            const query = parseListQuery(url.searchParams);
            if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
            const list = productList(world, m, query);
            return ok({
              items: list.rows.map((r): BoundsIndexItem => ({ writeScopeId: r.unit.writeScopeId, label: r.unit.label, minPrice: r.minPrice, maxPrice: r.maxPrice })),
              page: list.page,
              canEdit: can(viewer.role, 'MANAGE_PRICING'),
            } satisfies BoundsIndexView);
          }
          const b = boundsView(world, param, m);
          return b ? ok(b) : fail(404, 'SCOPE_NOT_FOUND', s.notFound);
        }
        case 'stop': return ok(stopView(world, await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m));
        /**
         * Р-136 (ревью шага 29, находка 4): поиск предложения. Выпадающий список показывает первые OFFER_CHOICES, и без поиска
         * предложения 201…10 000 были недостижимы: по ним нельзя было ни объявить скидку, ни выгрузить доказательство [Р-123].
         */
        case 'offers': {
          const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (q.length > 100) return fail(400, 'BAD_QUERY', s.badRequest);
          const matches = world.state.scopes.filter((sc) => {
            if (q === '') return true;
            const unit = unitOf(world, sc, m);
            return [unit.label, sc.externalUnitId, sc.channelProductRef, sc.gtin ?? ''].some((v) => String(v).toLowerCase().includes(q));
          });
          return ok({ items: matches.slice(0, OFFER_CHOICES).map((sc) => unitOf(world, sc, m)), total: matches.length, shown: Math.min(matches.length, OFFER_CHOICES) });
        }
        // Шаг 21: стратегии, лента цен, отчёт об опасных изменениях [Р-73]
        case 'strategies': {
          const query = parseListQuery(url.searchParams);
          return query ? ok(strategiesView(world, m, can(viewer.role, 'MANAGE_PRICING'), query)) : fail(400, 'BAD_PAGE', s.badRequest);
        }
        case 'feed': {
          // Шаг 23: фильтры и страница — на сервере по всему окну ленты; неверный параметр — 400, а не молчаливое «все»
          const query = parseFeedQuery(url.searchParams);
          if (!query || (query.writeScopeId && !scopeById(world, query.writeScopeId))) return fail(400, 'BAD_FEED_QUERY', s.badRequest);
          /**
           * Р-154: страницу, итог и счётчики групп отдаёт база. Итог берётся из ПЕРВОГО запроса, и по нему подтягивается
           * смещение за концом: второй запрос идёт без подсчёта (`counts: false`) — иначе полный агрегат считался бы дважды
           * на каждый показ экрана (ревью шага 35, находка 8).
           */
          const first = await live.store.feedPage(world.tenantId, world.now as never, feedPageQuery(query));
          const pageQuery = feedPageQuery(query, first.total);
          const page = pageQuery.offset === feedPageQuery(query).offset
            ? first
            : { ...await live.store.feedPage(world.tenantId, world.now as never, { ...pageQuery, counts: false }), counts: first.counts, total: first.total };
          return ok(priceFeed(world, m, query, page, pageQuery));
        }
        case 'dangerous': {
          /**
           * Находка 14 ревью шага 29: строка запроса не превращается в число вручную — `Number` принимает `0x10`, `1e3` и
           * пробелы по краям. Период сверяется со списком допустимых КАК СТРОКА, и разбора числа здесь нет вовсе.
           */
          const raw = url.searchParams.get('days') ?? String(REPORT_PERIODS_DAYS[1]);
          const days = REPORT_PERIODS_DAYS.find((d) => String(d) === raw);
          if (days === undefined) return fail(400, 'BAD_PERIOD', s.badRequest);
          const from = new Date(Date.parse(world.now) - days * 86_400_000).toISOString();
          return ok(dangerousReport(world, await live.store.interventions(world.tenantId, from as never, world.now as never), days, m));
        }
        // Р-123: отчёт по объявленным скидкам — каждая проверяется заново по текущей истории цен (исправления свёртки, поздние цены)
        case 'compliance': {
          if (param === null) {
            const query = parseListQuery(url.searchParams);
            return query ? ok(await compliance(live, world, m, query)) : fail(400, 'BAD_PAGE', s.badRequest);
          }
          return fail(404, 'NOT_FOUND', s.notFound);
        }
        /**
         * Р-139: ход и история массовых операций. Состояние задания в базе, поэтому перезагрузка страницы ничего не теряет:
         * экран собирается тем же запросом и через секунду, и через час. Задания — только своего тенанта [Р-16]: список
         * приходит из хранилища под его `tenant_id`, чужой идентификатор не находится.
         */
        case 'jobs': {
          if (param === null) {
            // Список заданий называет готовые файлы: по ним продавец возвращается к заданию, с экрана которого ушёл
            const jobs = await live.store.listBulkJobs(world.tenantId);
            return ok(bulkJobsView(jobs, m, await live.store.bulkJobArtifactSummaries(world.tenantId, jobs.map((j) => j.jobId))));
          }
          const job = await live.store.bulkJob(world.tenantId, param);
          if (!job) return fail(404, 'JOB_NOT_FOUND', m.ui.jobs.notFound);
          if (parts[5] === 'artifact') {
            const file = await live.store.bulkJobArtifact(world.tenantId, param);
            if (!file) return fail(404, 'NO_FILE', m.ui.jobs.noFile);
            return { status: 200, body: null, file: { contentType: file.contentType, content: file.content, fileName: file.fileName } };
          }
          if (parts.length > 5) return fail(404, 'NOT_FOUND', s.notFound);
          const file = job.status === 'SUCCEEDED' ? await live.store.bulkJobArtifact(world.tenantId, param) : null;
          return ok(bulkJobView(job, m, file ? { fileName: file.fileName, rows: file.rows, sha256: file.sha256 } : null));
        }
        default: return fail(404, 'NOT_FOUND', s.notFound);
      }
    }

    // Находка 11 ревью шага 24: маршруты ниже — только POST
    if (req.method !== 'POST') return fail(405, 'METHOD', s.method);

    /**
     * Р-123, Р-139, OQ-202: выгрузка доказательной истории — фоновое задание. Предел в 100 000 строк, введённый шагом 29, снят
     * вместе с причиной: ответ экрана в 28 МБ был отказом, а файл, подготовленный заданием, продавец просто скачивает. Второго
     * фактора выгрузка не требует — она ничего не меняет.
     */
    if (screen === 'compliance' && param === 'evidence') {
      const from = typeof body.from === 'string' ? body.from : '';
      const to = typeof body.to === 'string' ? body.to : '';
      const ws = typeof body.writeScopeId === 'string' && body.writeScopeId !== '' ? body.writeScopeId : null;
      if (!isDay(from) || !isDay(to) || from > to || (ws && !scopeById(world, ws))) return fail(400, 'BAD_EVIDENCE_QUERY', s.badRequest);
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > EVIDENCE_MAX_DAYS) return fail(400, 'EVIDENCE_TOO_LONG', s.evidenceTooLong(EVIDENCE_MAX_DAYS));
      return createJob('PRICE_EVIDENCE', { from, to, ...(ws ? { writeScopeId: ws } : {}) },
        ws ? 1 : world.state.scopes.length, m.ui.jobs.createdEvidence);
    }

    /**
     * Р-142 (шаг 31): выгрузка ленты цен файлом. Фильтр — тот же, что на экране, и приходит он тем же разбором: файл обязан
     * совпадать с тем, что продавец видел. Второго фактора не требует — ничего не меняет.
     */
    if (screen === 'feed' && param === 'export') {
      const raw = (body.query ?? {}) as Record<string, unknown>;
      const asStrings = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      const query = parseFeedQuery(new URLSearchParams(asStrings));
      if (!query || (query.writeScopeId && !scopeById(world, query.writeScopeId))) return fail(400, 'BAD_FEED_QUERY', s.badRequest);
      const total = (await live.store.feedPage(world.tenantId, world.now as never, feedPageQuery({ ...query, offset: 0, limit: 1 }))).total;
      return createJob('PRICE_FEED_EXPORT', { query: asStrings }, total, m.ui.jobs.createdFeedExport);
    }

    /**
     * OQ-207: отмена ожидающего задания. Идущее применение не отменяется — оно целиком или никак [Р-134]; на экране кнопка
     * есть ровно у того задания, которое ещё ждёт своей очереди.
     */
    /**
     * Р-149: единственное, что путь ХРАНИТ, — сужение набора [Р-131]; место остановки выводится из данных. Права у двух
     * действий разные [Р-143] (ревью шага 34, находка 2): сужает тот, кто правит цены, а включает тот, кто вправе включать
     * движок, — оператор включает, хотя цен не правит. Первая редакция закрывала оба одним правом, и «своё право
     * включения» было недостижимо через консоль.
     */
    /**
     * Шаг 35 [Р-152, Р-153]: остатки. Источник, файл, включение — тот, кто ведёт каталог (MANAGE_CATALOG); выбор пути —
     * тот, кто ведёт каталог или цены. Файл остатков — задание [Р-139]; включение — один запрос: единицы и записи
     * создаются множественными операторами, а отправляет их диспетчер [Р-64].
     */
    /**
     * Шаг 41 [Р-170]: переключение режима записи. Консоль НЕ решает, кому это можно: она передаёт базе членство,
     * пользователя сессии, второй фактор и набранное подтверждение, а отказ показывает тот, что пришёл от базы [Р-94].
     */
    if (screen === 'shadow' && param === 'mode') {
      if (!live.shadow) return fail(404, 'NOT_FOUND', s.notFound);
      /**
       * Находка 5 ревью шага 41: маршрут был открыт любому, кто вошёл, — включая ПУБЛИЧНОГО гостя демо [Р-160], и отказ
       * базы приходил 500-м. Право на управление тенантом проверяется здесь, а роль владельца для перехода в бой —
       * по-прежнему в базе: консоль не решает, кому это можно, но и не пускает заведомо чужих.
       */
      if (!can(viewer.role, 'MANAGE_TENANT')) return fail(403, 'FORBIDDEN', m.ui.shadow.errors.notOwner);
      const toMode = body.toMode === 'LIVE' ? 'LIVE' : body.toMode === 'SHADOW' ? 'SHADOW' : null;
      if (typeof body.channelAccountId !== 'string' || toMode === null) return fail(400, 'BAD_REQUEST', s.badRequest);
      const outcome = await live.shadow.switchWriteMode(world.tenantId, {
        channelAccountId: body.channelAccountId, toMode,
        ...(typeof body.typedConfirmation === 'string' ? { typedConfirmation: body.typedConfirmation } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr),
      });
      const e = m.ui.shadow.errors;
      if (outcome.status === 'SWITCHED') return ok({ mode: outcome.mode, message: outcome.mode === 'LIVE' ? e.live : e.shadow });
      if (outcome.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', e.mfa);
      if (outcome.status === 'NOT_OWNER') return fail(403, 'FORBIDDEN', e.notOwner);
      if (outcome.status === 'CONFIRMATION_MISMATCH') return fail(400, 'CONFIRMATION_MISMATCH', e.confirmation);
      if (outcome.status === 'MODE_MISMATCH') return fail(409, 'MODE_MISMATCH', e.modeMismatch);
      /**
       * Р-172: бой закрыт неизвестным свойством витрины — отказ называет витрину и свойство ЧЕЛОВЕЧЕСКИМ языком [Р-72].
       * База отдаёт код свойства (`DAY_BOUNDARY`), и переводит его словарь: продавцу нужна «граница суток», а не имя столбца.
       */
      if (outcome.status === 'PROPERTY_UNKNOWN') {
        const names = m.ui.shadow.properties.names;
        const detail = Object.entries(names).reduce((text, [code, name]) => (name ? text.replaceAll(code, name) : text), outcome.detail);
        return fail(409, 'PROPERTY_UNKNOWN', e.propertyUnknown(detail));
      }
      return fail(403, 'FORBIDDEN', s.forbidden);
    }

    if (screen === 'stock' && param !== null) {
      if (!can(viewer.role, 'MANAGE_CATALOG')) return fail(403, 'FORBIDDEN', m.ui.stock.noRight);
      const actor = { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) };
      if (param === 'sources') {
        const mode = body.mode === 'INBOUND_API' ? 'INBOUND_API' : body.mode === 'INTERNAL_POOL' ? 'INTERNAL_POOL' : null;
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
        if (!mode || name === '') return fail(400, 'BAD_SOURCE', s.badRequest);
        const created = await live.stock.createStockSource(world.tenantId, { mode, name }, actor);
        if (created.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
        // Ключ уходит в ответ ОДИН раз и нигде не пишется — ни в журнал, ни в базу (там отпечаток)
        return ok({ stockSourceId: created.stockSourceId, apiKey: created.apiKey });
      }
      if (param === 'import') {
        if (typeof body.content !== 'string' || typeof body.fileName !== 'string' || typeof body.stockSourceId !== 'string') return fail(400, 'BAD_FILE', s.badRequest);
        const sources = await live.stock.stockSources(world.tenantId);
        const source = sources.find((x) => x.stockSourceId === body.stockSourceId);
        if (!source || source.mode !== 'INTERNAL_POOL') return fail(400, 'BAD_SOURCE', s.badRequest);
        let rows = 0;
        try {
          const parsed = parseStockSheet(readTable(Buffer.from(body.content, 'base64')).rows);
          if ('code' in parsed) return fail(400, parsed.code, s.badRequest);
          rows = parsed.rows.length;
        } catch { return fail(400, 'BAD_FILE', s.badRequest); }
        return createJob('STOCK_IMPORT', { fileName: body.fileName, content: body.content, stockSourceId: body.stockSourceId }, rows, m.ui.stock.importFile.created);
      }
      if (param === 'enable') {
        const account = live.accounts.find((a) => a.channelAccountId === body.channelAccountId);
        if (!account) return fail(400, 'BAD_ACCOUNT', s.badRequest);
        const int = (v: unknown, fallback: number) => (v === undefined || v === null || v === '' ? fallback : Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
        const bufferUnits = int(body.bufferUnits, 0); const minQuantityToList = int(body.minQuantityToList, 0);
        const maxQuantity = body.maxQuantity === undefined || body.maxQuantity === null || body.maxQuantity === '' ? null : int(body.maxQuantity, 0);
        if (bufferUnits === null || minQuantityToList === null || maxQuantity === null && body.maxQuantity !== undefined && body.maxQuantity !== null && body.maxQuantity !== '') return fail(400, 'BAD_ALLOCATION', s.badRequest);
        if (maxQuantity !== null && maxQuantity < 1) return fail(400, 'BAD_ALLOCATION', s.badRequest);
        // Р-139: включение — задание; сколько предложений оно затронет, известно заранее — это размер шага пути
        const status = (await live.store.onboardingStatus(world.tenantId)).find((x) => x.step === 'STOCK_SYNC');
        if (!status || status.totalCount === 0) return fail(409, 'NO_OFFERS', m.ui.stock.enable.noOffers);
        return createJob('STOCK_SYNC_ENABLE', { channelAccountId: account.channelAccountId, bufferUnits, maxQuantity, minQuantityToList, acknowledgeSideEffects: body.acknowledgeSideEffects === true },
          status.totalCount, m.ui.stock.importFile.enableCreated);
      }
      return fail(404, 'NOT_FOUND', s.notFound);
    }

    if (screen === 'onboarding' && param !== null) {
      const actor = { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) };
      // Р-152: выбор пути — намерение продавца; его выбирает тот, кто ведёт остатки или цены
      if (param === 'path') {
        if (!can(viewer.role, 'MANAGE_CATALOG') && !can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
        const path = body.path === 'STOCK' ? 'STOCK' : body.path === 'STOCK_AND_PRICING' ? 'STOCK_AND_PRICING' : null;
        if (!path) return fail(400, 'BAD_PATH', s.badRequest);
        const saved = await live.store.saveOnboardingProgress(world.tenantId, { path }, actor);
        if (saved === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
        return ok({ path });
      }
      if (param === 'narrow') {
        if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', m.ui.onboarding.noRight);
        // Сузить можно только до предложений с готовой себестоимостью — иного смысла у сужения нет [Р-131]; снять — тоже здесь.
        // Правда одна — база: тот же признак, по которому считается шаг, а не поле экрана
        const ids = body.widen === true ? null : await live.store.scopesWithCost(world.tenantId);
        if (ids !== null && ids.length === 0) return fail(400, 'NOTHING_TO_NARROW_TO', m.ui.onboarding.stepHints.COSTS);
        const saved = await live.store.saveOnboardingProgress(world.tenantId, { scopeWriteScopeIds: ids }, actor);
        if (saved === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
        return ok({ narrowedTo: ids === null ? null : ids.length });
      }
      if (param === 'enable') {
        // Последний шаг — включение движка у набора: массовая операция, значит задание [Р-139]; право у вида своё [Р-143]
        if (!can(viewer.role, 'ENABLE_REPRICING')) return fail(403, 'FORBIDDEN', m.ui.onboarding.noRightEnable);
        const progress = await live.store.onboardingProgress(world.tenantId);
        const chosen = progress?.scopeWriteScopeIds ?? null;
        const targets = world.state.scopes.filter((x) => x.pricingMode !== 'ENGINE' && (chosen === null || chosen.includes(x.writeScopeId)));
        if (targets.length === 0) return fail(409, 'NOTHING_TO_ENABLE', m.ui.onboarding.completed);
        return createJob('REPRICING_ENABLE', chosen === null ? { all: true } : { writeScopeIds: targets.map((x) => x.writeScopeId) }, targets.length,
          m.ui.onboarding.enable(targets.length));
      }
      return fail(404, 'NOT_FOUND', s.notFound);
    }

    if (screen === 'jobs' && param !== null && parts[5] === 'cancel') {
      /**
       * Отменяет СВОЁ задание любой участник, ЧУЖОЕ — тот, кто имеет право на САМУ ЭТУ ОПЕРАЦИЮ (находка 3 ревью шага 31,
       * задача D шага 32). Иначе оператор отменял бы подтверждённый вторым фактором импорт владельца, и тот видел бы
       * «отменено, в базе ничего не изменено», не понимая, кто это сделал. Какое право у какого вида — `CANCEL_ACTION`.
       */
      const target = await live.store.bulkJob(world.tenantId, param);
      if (!target) return fail(404, 'JOB_NOT_FOUND', m.ui.jobs.notFound);
      const ownJob = target.createdByMembershipId === viewer.membershipId;
      if (!canCancelBulkJob(viewer.role, target.kind, ownJob)) return fail(403, 'FORBIDDEN', s.forbidden);
      const outcome = await live.store.cancelBulkJob(world.tenantId, param, { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (outcome === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (outcome === 'NOT_WAITING') return fail(409, 'NOT_WAITING', m.ui.jobs.notWaiting);
      const job = await live.store.bulkJob(world.tenantId, param);
      return job ? ok(bulkJobView(job, m)) : fail(404, 'JOB_NOT_FOUND', m.ui.jobs.notFound);
    }

    // Р-123: предупреждение «эта скидка нарушит правило» до записи — только чтение, права на просмотр достаточно
    if (screen === 'compliance' && param === 'check') {
      const input = parseDiscount(world, body);
      if (!input) return fail(400, 'BAD_DISCOUNT', s.badDiscount);
      const check = await live.store.omnibusCheck(world.tenantId, input.writeScopeId, input.startsAt);
      return ok(discountCheckView(world, input.writeScopeId, input.referencePriceMinor, check, m));
    }

    // Р-123: объявление скидки — база проверяет правило сама и хранит проверку; нарушение — отказ, не предупреждение
    if (screen === 'compliance' && param === 'announce') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const input = parseDiscount(world, body);
      if (!input) return fail(400, 'BAD_DISCOUNT', s.badDiscount);
      const result = await live.store.announceDiscount(world.tenantId, input, { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status === 'VIOLATION') return fail(400, 'OMNIBUS_VIOLATION', discountCheckView(world, input.writeScopeId, input.referencePriceMinor, result.check, m)!.headline);
      if (result.status === 'INVALID') return fail(400, result.cause, s.badDiscount);
      return ok({ message: m.ui.compliance.announced, compliance: await compliance(live, await live.view(viewer), m) });
    }
    if (screen === 'stop' && param === 'plan') {
      const target = parseTarget(live, body.target);
      return target ? ok(planStop(world, target, m)) : fail(400, 'BAD_TARGET', s.badTarget);
    }

    // Kill switch человеком [Р-69, Р-70]; журнал аудита пишет хранилище [Р-76]
    if (screen === 'stop' && param === null) {
      const r = body as Partial<StopRequest>;
      const target = parseTarget(live, r.target);
      if (!target) return fail(400, 'BAD_TARGET', s.badTarget);
      if (!can(viewer.role, 'STOP_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (r.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const text = note(r.note);
      if (!text) return fail(400, 'NOTE_REQUIRED', s.noteRequired(NOTE_MIN, NOTE_MAX));
      const plan = planStop(world, target, m);
      const result = await live.pipeline.stopPricing(ctx(target.kind === 'TENANT' ? null : target.channelAccountId), {
        scope: target.kind, channelAccountId: target.kind === 'TENANT' ? null : target.channelAccountId,
        marketplace: target.kind === 'STOREFRONT' ? target.marketplace : null, stoppedAt: live.clock.iso(), stoppedByMembershipId: viewer.membershipId,
        stoppedByUserId: principal.userId, note: text,
      });
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status === 'ALREADY_ACTIVE') return fail(409, 'ALREADY_STOPPED', s.alreadyStopped);
      return ok({ message: s.stopped(plan.impact.text), stop: stopView(await live.view(viewer), await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m) });
    }

    if (screen === 'stops' && param !== null && parts[5] === 'resume') {
      const stop = world.state.stops.find((x) => x.stopId === param && x.releasedAt === null);
      if (!stop) return fail(404, 'NOT_ACTIVE', s.notActive);
      if (!can(viewer.role, stop.scope === 'TENANT' ? 'RESUME_TENANT_STOP' : 'RESUME_CHANNEL_STOP')) return fail(403, 'FORBIDDEN', s.forbidden);
      const r = body as Partial<NoteRequest>;
      if (r.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const text = note(r.note);
      if (!text) return fail(400, 'NOTE_REQUIRED', s.noteRequired(NOTE_MIN, NOTE_MAX));
      // Р-88: снятие остановки тенанта — только со вторым фактором; хранилище и БД проверяют то же
      const mfa = hasSecondFactor(principal.amr);
      if (stop.scope === 'TENANT' && !mfa) return fail(403, 'MFA_REQUIRED', s.mfaRequired);
      const result = await live.pipeline.resumePricing(ctx(stop.channelAccountId), stop.stopId, { membershipId: viewer.membershipId, userId: principal.userId, mfa, note: text, at: live.clock.iso() });
      if (result.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', s.mfaRequired);
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status !== 'RELEASED') return fail(404, 'NOT_ACTIVE', s.notActive);
      return ok({ message: s.resumed, stop: stopView(await live.view(viewer), await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m) });
    }

    // Системная остановка витрины [Р-51, Р-52]: ручное снятие — с заметкой
    if (screen === 'halts' && param !== null && parts[5] === 'release') {
      const halt = world.state.halts.find((h) => h.haltId === param && h.releasedAt === null);
      if (!halt) return fail(404, 'NOT_ACTIVE', s.notActive);
      if (!can(viewer.role, 'RELEASE_CHANNEL_HALT')) return fail(403, 'FORBIDDEN', s.forbidden);
      const r = body as Partial<NoteRequest>;
      if (r.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const text = note(r.note);
      if (!text) return fail(400, 'NOTE_REQUIRED', s.noteRequired(NOTE_MIN, NOTE_MAX));
      // Находка 12 ревью шага 15 [Р-88]: ручное снятие системной остановки — со вторым фактором; хранилище и БД проверяют то же
      const mfa = hasSecondFactor(principal.amr);
      if (!mfa) return fail(403, 'MFA_REQUIRED', s.mfaRequired);
      const result = await live.pipeline.releaseHaltManually(ctx(halt.channelAccountId), halt.haltId, { membershipId: viewer.membershipId, userId: principal.userId, mfa }, text);
      return result.released ? ok({ message: s.released, stop: stopView(await live.view(viewer), await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m) }) : fail(404, 'NOT_ACTIVE', s.notActive);
    }

    // Р-118: снятие недоверия каналу — только человек с правом, от своего имени, со вторым фактором и заметкой; хранилище и БД проверяют то же
    if (screen === 'distrusts' && param !== null && parts[5] === 'release') {
      const distrust = world.state.distrusts.find((d) => d.distrustId === param && d.releasedAt === null);
      if (!distrust) return fail(404, 'NOT_ACTIVE', s.notActive);
      if (!can(viewer.role, 'RELEASE_CHANNEL_DISTRUST')) return fail(403, 'FORBIDDEN', s.forbidden);
      const r = body as Partial<NoteRequest>;
      if (r.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const text = note(r.note);
      if (!text) return fail(400, 'NOTE_REQUIRED', s.noteRequired(NOTE_MIN, NOTE_MAX));
      const mfa = hasSecondFactor(principal.amr);
      if (!mfa) return fail(403, 'MFA_REQUIRED', s.mfaRequiredDistrust);
      try {
        const result = await live.pipeline.releaseDistrust(ctx(distrust.channelAccountId), distrust.distrustId, { membershipId: viewer.membershipId, userId: principal.userId, mfa }, text);
        return result.released ? ok({ message: s.distrustReleased, stop: stopView(await live.view(viewer), await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m) }) : fail(404, 'NOT_ACTIVE', s.notActive);
      } catch (error) {
        // Отказ хранилища или БД (роль, пользователь сессии, второй фактор): текст отказа наружу не отдаётся
        const code = (error as { code?: string }).code;
        if (code === '42501' || /may not|not the membership|permission/i.test(String((error as Error).message))) return fail(403, 'FORBIDDEN', s.forbidden);
        throw error;
      }
    }

    /**
     * Шаг 21, OQ-201: превью стратегии на реальных единицах записи — без фиксации; права на просмотр достаточно. Шаг 30 сделал
     * его ЗАДАНИЕМ: решение считается по каждому предложению каталога, а не по выборке 500 из 10 000. Выборка была ценой
     * синхронного ответа, а не свойством продукта, — и вместе с ответом она исчезла.
     */
    if (screen === 'strategies' && param === 'preview') {
      const parsed = parseStrategyDraft(body.draft);
      if (!parsed.ok) return fail(400, 'BAD_DRAFT', draftProblemsText(parsed.problems, m));
      const ids = scopeIds(body.writeScopeIds, world, body.all);
      if (!ids) return fail(400, 'BAD_SCOPES', s.tooManyScopes(Array.isArray(body.writeScopeIds) ? body.writeScopeIds.length : 0, MAX_SCOPES));
      return createJob('STRATEGY_PREVIEW', { draft: body.draft, ...(body.all === true ? { all: true } : { writeScopeIds: ids }) },
        ids.length, m.ui.jobs.createdPreview);
    }

    /**
     * Предпросмотр, который видел человек, — это ЗАДАНИЕ этого тенанта, лежащее в базе. Сохранение сверяется с ним, а не с
     * заново посчитанным превью: пересчёт по каталогу стоил бы столько же, сколько сам предпросмотр, и мог бы разойтись с
     * показанным по причинам, к человеку отношения не имеющим.
     */
    const confirmedPreview = async (draft: unknown): Promise<{ ok: true; offers: number } | { ok: false; response: ApiResponse }> => {
      const jobId = typeof body.previewJobId === 'string' ? body.previewJobId : null;
      if (!jobId || typeof body.previewToken !== 'string') return { ok: false, response: fail(409, 'PREVIEW_CHANGED', s.previewChanged) };
      const job = jobId ? await live.store.bulkJob(world.tenantId, jobId) : null;
      if (!job || job.kind !== 'STRATEGY_PREVIEW' || job.status !== 'SUCCEEDED') return { ok: false, response: fail(409, 'PREVIEW_CHANGED', s.previewChanged) };
      const result = (job.result ?? {}) as { previewToken?: string; offers?: number; view?: { saveBlocked: string | null }; expected?: unknown };
      if (result.previewToken !== body.previewToken) return { ok: false, response: fail(409, 'PREVIEW_CHANGED', s.previewChanged) };
      /**
       * Черновик и выбор предложений — те же: иначе сохранялось бы не то, что было посчитано. Сравниваются РАЗОБРАННЫЕ
       * черновики, а не тела запросов: параметры задания лежат в jsonb, а он переставляет ключи объекта — отпечаток
       * пришедшего и вернувшегося не совпал бы никогда, и сохранить не удалось бы вовсе.
       */
      const params = job.params as { draft?: unknown; writeScopeIds?: string[]; all?: boolean };
      const asked = parseStrategyDraft(draft);
      const computed = parseStrategyDraft(params.draft);
      // Выбор сравнивается НЕРАСКРЫТЫМ: «весь каталог» — это флаг, и раскрытый список сравнивался бы с пустым (живой прогон)
      const chosen = body.all === true ? [] : (Array.isArray(body.writeScopeIds) ? [...new Set(body.writeScopeIds as string[])] : []);
      if (!asked.ok || !computed.ok
        || fingerprint([computed.draft, params.all === true, params.writeScopeIds ?? []])
           !== fingerprint([asked.draft, body.all === true, chosen])) {
        return { ok: false, response: fail(409, 'PREVIEW_CHANGED', s.previewChanged) };
      }
      // Р-120: чужое ценообразование канала названо своей причиной, а не общим «сохранить нельзя»
      const priced = channelPriced(scopeIds(body.writeScopeIds, world, body.all) ?? []);
      if (priced) return { ok: false, response: fail(400, 'CHANNEL_PRICING_ACTIVE', s.channelPricingActive(priced)) };
      // Находка 3 ревью шага 21 [Р-39]: стратегия, для которой канал не даёт нужных данных конкурентов, не назначается
      if (result.view?.saveBlocked) return { ok: false, response: fail(400, 'STRATEGY_UNAVAILABLE', result.view.saveBlocked) };
      /**
       * Находка 4 ревью шага 21: предпросмотр старше стратегии предложения не сохраняется. Сравниваются стратегии на момент
       * предпросмотра и сейчас — в памяти, по уже прочитанному миру: заново считать предпросмотр по каталогу ради этого
       * незачем. Последнее слово всё равно за хранилищем: тот же набор уходит в задание как `expected` (CONFLICT).
       */
      const ids = scopeIds(body.writeScopeIds, world, body.all) ?? [];
      if (fingerprint(result.expected ?? null) !== fingerprint(currentStrategies(world, ids))) {
        return { ok: false, response: fail(409, 'PREVIEW_CHANGED', s.previewChanged) };
      }
      return { ok: true, offers: result.offers ?? 0 };
    };

    // Сохранение — только того превью, что видел человек: сервер пересчитывает превью и сравнивает токен
    if (screen === 'strategies' && param === null) {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const parsed = parseStrategyDraft(body.draft);
      if (!parsed.ok) return fail(400, 'BAD_DRAFT', draftProblemsText(parsed.problems, m));
      const ids = scopeIds(body.writeScopeIds, world, body.all);
      if (!ids) return fail(400, 'BAD_SCOPES', s.badRequest);
      const confirmed = await confirmedPreview(body.draft);
      if (!confirmed.ok) return confirmed.response;
      /**
       * Р-139: назначение — фоновое задание. Предпросмотр и его токен остаются здесь: это то, что видел человек, и проверять
       * его надо до создания задания. Растёт с каталогом только запись — она и ушла в задание.
       */
      const strategyId = typeof body.strategyId === 'string' ? body.strategyId : null;
      return createJob('STRATEGY_ASSIGN', { draft: body.draft, ...(body.all === true ? { all: true } : { writeScopeIds: ids }), strategyId, previewJobId: body.previewJobId },
        ids.length, m.ui.jobs.createdStrategy);
    }

    // OQ-169 (шаг 24): существующая версия — выбранным офферам без новой версии; то же превью и тот же токен, что при сохранении
    if (screen === 'strategies' && param === 'assign') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const item = strategiesView(world, m, true).strategies.find((x) => x.strategyId === body.strategyId && x.version === body.version);
      if (!item) return fail(404, 'STRATEGY_NOT_FOUND', s.notFound);
      if (!item.assignable) return fail(400, 'VERSION_NOT_ACTIVE', s.versionNotActive);
      const ids = scopeIds(body.writeScopeIds, world, body.all);
      if (!ids) return fail(400, 'BAD_SCOPES', s.badRequest);
      const confirmed = await confirmedPreview(body.draft ?? item.draft);
      if (!confirmed.ok) return confirmed.response;
      // Р-139: назначение существующей версии — то же фоновое задание: для продавца это одна операция над каталогом
      return createJob('STRATEGY_ASSIGN', { strategyId: item.strategyId, version: item.version, ...(body.all === true ? { all: true } : { writeScopeIds: ids }), previewJobId: body.previewJobId },
        ids.length, m.ui.jobs.createdStrategy);
    }

    // OQ-169: снять стратегию с офферов — только при выключенном репрайсинге
    if (screen === 'strategies' && param === 'unassign') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const ids = scopeIds(body.writeScopeIds, world, body.all);
      if (!ids) return fail(400, 'BAD_SCOPES', s.badRequest);
      const result = await live.store.unassignStrategy(world.tenantId, { writeScopeIds: ids, expected: currentStrategies(world, ids) },
        { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status === 'CONFLICT') return fail(409, 'PREVIEW_CHANGED', s.previewChanged);
      if (result.status === 'INVALID' && result.cause === 'REPRICING_ENABLED') {
        const scope = result.writeScopeId ? scopeById(world, result.writeScopeId) : undefined;
        return fail(400, 'REPRICING_ENABLED', s.repricingEnabledUnassign(scope ? unitOf(world, scope, m).label : m.ui.common.noValue));
      }
      if (result.status !== 'UNASSIGNED') return fail(400, result.cause, s.badRequest);
      return ok({ message: m.ui.strategies.unassigned, strategies: strategiesView(await live.view(viewer), m, true) } satisfies StrategySaveResponse);
    }

    /**
     * Р-139 (шаг 30): применение правки границ — фоновое задание. Запрос только создаёт его: и пересчёт различий, и сама
     * запись растут с размером каталога, поэтому оба остались внутри задания, а не в ожидании ответа.
     */
    if (screen === 'bounds' && param === 'apply') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      /**
       * Задача D шага 31: применение ссылается на ЗАДАНИЕ экрана различий, а не пересылает запрос заново. Набор правок уже
       * посчитан — применять его второй раз посчитанным значило бы делать работу по каталогу дважды (44 секунды вместо
       * двадцати), и при этом применять НЕ ТО, что показано, а пересчитанное.
       */
      const planJobId = typeof body.planJobId === 'string' ? body.planJobId : null;
      if (!planJobId || typeof body.planToken !== 'string') return fail(409, 'PLAN_CHANGED', s.planChanged);
      const plan = await live.store.bulkJob(world.tenantId, planJobId);
      const planResult = (plan?.result ?? {}) as { planToken?: string; offers?: number };
      if (!plan || plan.kind !== 'BOUNDS_PLAN' || plan.status !== 'SUCCEEDED' || planResult.planToken !== body.planToken) {
        return fail(409, 'PLAN_CHANGED', s.planChanged);
      }
      /**
       * Применяет тот, кто СМОТРЕЛ (находка 5 ревью шага 31). Обещание «применяется ровно то, что видел человек» держится
       * токеном экрана; но токен лежит в задании того же тенанта, и без этой проверки другой участник применил бы правку
       * каталога, ни разу не открыв экран различий.
       */
      if (plan.createdByMembershipId !== viewer.membershipId) return fail(409, 'PLAN_CHANGED', s.planChanged);
      const asked = planResult.offers ?? 0;
      /**
       * Р-88, Р-135, Р-144: правка границ БОЛЬШЕ ЧЕМ ОДНОГО предложения — со вторым фактором, правка одного — без него.
       * Объём виден здесь, из посчитанного экрана различий, поэтому здесь и проверяется: сказать об этом до создания задания
       * честнее, чем отказом задания через минуту. Последнее слово всё равно за базой — `bounds_mass_edit_requires_mfa`.
       */
      if (asked > 1 && !hasSecondFactor(principal.amr)) return fail(403, 'MFA_REQUIRED', s.mfaRequiredBounds);
      return createJob('BOUNDS_EDIT', { planJobId, planToken: body.planToken }, asked, m.ui.jobs.createdBounds);
    }

    /**
     * Шаг 21, задача D шага 31: экран различий массовой правки — тоже ЗАДАНИЕ. База вычисляет итог в откатываемой транзакции
     * по всему каталогу; держать это в запросе значило бы ждать ответа секунды, а потом повторять ту же работу при применении.
     */
    if (screen === 'bounds' && param === 'plan') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      const request = parseBoundsEditRequest(body.request);
      if (!request) {
        const asked = Array.isArray((body.request as { writeScopeIds?: unknown[] })?.writeScopeIds) ? ((body.request as { writeScopeIds: unknown[] }).writeScopeIds).length : 0;
        return asked > MAX_SCOPES ? fail(400, 'TOO_MANY_SCOPES', s.tooManyScopes(asked, MAX_SCOPES)) : fail(400, 'BAD_REQUEST', s.badRequest);
      }
      // Разбор запроса дёшев и остаётся в запросе: продавец узнаёт о неверной правке сразу, а не отказом задания
      const { problems } = expandBoundsEdit(world, request);
      if (problems.length > 0) {
        const texts = m.ui.boundsEdit.problems;
        // Первые несколько причин и число остальных: на каталоге склейка всех проблем давала мегабайтный ответ (находка 12)
        const shown = problems.slice(0, 10).map((p) => `${texts[p.code]}${p.writeScopeId ? ` (${p.writeScopeId}${p.bound ? `, ${p.bound}_price` : ''})` : ''}`);
        const rest = problems.length - shown.length;
        return fail(400, 'BAD_EDIT', rest > 0 ? `${shown.join('; ')} ${s.andMoreProblems(rest)}` : shown.join('; '));
      }
      const asked = request.all === true ? world.state.scopes.length : request.writeScopeIds.length;
      return createJob('BOUNDS_PLAN', { request: body.request }, asked, m.ui.jobs.createdPlan);
    }

    /**
     * Р-139 (находка 10 ревью шага 30): применение создаёт задание и БОЛЬШЕ НИЧЕГО. Читать файл и строить предпросмотр здесь
     * незачем: задание читает его заново и само сверяет отпечаток с тем, который видел человек. Пока разбор оставался в
     * запросе, «дешёвое нажатие» на файле в 200 000 строк стоило ровно столько же, сколько предпросмотр.
     */
    if (screen === 'cost-import' && param === 'apply') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', m.ui.costImport.noRight);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      if (typeof body.content !== 'string' || typeof body.fingerprint !== 'string') return fail(400, 'BAD_REQUEST', s.badRequest);
      const name = typeof body.fileName === 'string' && body.fileName.trim() !== '' ? body.fileName.trim().slice(0, 200) : 'import';
      return createJob('COST_IMPORT', {
        fileName: name, content: body.content, fingerprint: body.fingerprint, ...(body.mapping ? { mapping: body.mapping } : {}),
        ...(body.encoding ? { encoding: body.encoding } : {}),
      }, null, m.ui.jobs.createdCostImport);
    }

    if (screen === 'cost-import' && param === 'plan') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', m.ui.costImport.noRight);
      const name = typeof body.fileName === 'string' && body.fileName.trim() !== '' ? body.fileName.trim().slice(0, 200) : 'import';
      const content = typeof body.content === 'string' ? body.content : null;
      if (content === null) return fail(400, 'BAD_REQUEST', s.badRequest);
      // Файл приходит в base64: и таблица XLSX (двоичная), и CSV в любой кодировке проходят одним путём
      let sheet;
      try {
        // OQ-200: продавец может задать кодировку, если наша догадка не подошла — её показывает экран
        const chosen = TABLE_ENCODINGS.find((e) => e === body.encoding);
        sheet = readTable(Buffer.from(content, 'base64'), chosen);
      } catch (error) {
        return fail(400, (error as { code?: string }).code ?? 'UNSUPPORTED_FORMAT', String((error as Error).message).slice(0, 200));
      }
      const suggested = suggestMapping(sheet);
      // Продавец мог поправить сопоставление колонок: его выбор сильнее подсказки
      const chosen = body.mapping && typeof body.mapping === 'object' ? (body.mapping as Record<string, unknown>) : {};
      const mapping = { ...suggested.mapping };
      for (const [field, index] of Object.entries(chosen)) {
        // null — «этой колонки в файле нет»: продавец снимает подсказку так же явно, как ставит свою
        if (index === null) delete mapping[field as keyof typeof mapping];
        else if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) mapping[field as keyof typeof mapping] = index;
      }
      const offers = importTargets(world, m);
      const preview = buildPreview({ sheet, mapping, offers });
      return ok(costImportView(world, preview, { name, sheet, mapping }, suggested.suggestions, m));
    }

    // Шаг 12, G и Р-77: включение с предупреждениями по типу стратегии
    if (screen === 'scopes' && param !== null && parts[5] === 'enable') {
      const scope = world.state.scopes.find((x) => x.writeScopeId === param);
      if (!scope) return fail(404, 'SCOPE_NOT_FOUND', s.notFound);
      if (!can(viewer.role, 'ENABLE_REPRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      const result = await live.pipeline.enableRepricing(ctx(scope.channelAccountId), scope.writeScopeId, { acknowledgeWarnings: body.acknowledgeWarnings === true, userId: principal.userId });
      return ok({
        enabled: result.enabled, problems: result.problems.map((p) => describe(p, m)), warnings: result.warnings.map((w) => describe(w, m)),
      } satisfies EnableResult);
    }
    return fail(404, 'NOT_FOUND', s.notFound);
  };
}

export type StandIdentityMode = { kind: 'simulator' } | { kind: 'oidc'; issuer: string; audience: string; jwksUrl: string };

const OIDC_VARS = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'] as const;

/**
 * Режим входа стенда — только явно: STAND_IDENTITY=simulator (имитатор поставщика, синтетические пользователи) или
 * STAND_IDENTITY=oidc (настоящий поставщик, нужны все три OIDC_*). Опечатка или неполная конфигурация — отказ запуска,
 * а не молчаливый имитатор с открытой выдачей токенов; имитатор при заданных OIDC_* тоже не запускается.
 */
export function resolveStandIdentityMode(env: Readonly<Record<string, string | undefined>>): StandIdentityMode {
  const present = OIDC_VARS.filter((v) => env[v]);
  if (env.STAND_IDENTITY === 'oidc') {
    const missing = OIDC_VARS.filter((v) => !env[v]);
    if (missing.length > 0) throw new Error(`STAND_IDENTITY=oidc requires ${OIDC_VARS.join(', ')}; missing: ${missing.join(', ')}`);
    if (!/^https:\/\//.test(env.OIDC_ISSUER!) || !/^https:\/\//.test(env.OIDC_JWKS_URL!)) throw new Error('OIDC_ISSUER and OIDC_JWKS_URL must be https URLs');
    return { kind: 'oidc', issuer: env.OIDC_ISSUER!, audience: env.OIDC_AUDIENCE!, jwksUrl: env.OIDC_JWKS_URL! };
  }
  if (env.STAND_IDENTITY === 'simulator') {
    if (present.length > 0) throw new Error(`STAND_IDENTITY=simulator refuses ${present.join(', ')}: the simulator issues tokens for any stand role`);
    return { kind: 'simulator' };
  }
  throw new Error('STAND_IDENTITY must be "simulator" or "oidc": the stand does not choose the sign-in mode on its own');
}

const MAX_BODY_BYTES = 64 * 1024;
/**
 * Ревью шага 28, находка 6: массовый импорт — это файл продавца, и 64 КиБ хватало примерно на 2 180 строк при объявленном пределе
 * базы в 200 000 (`row_count <= 200000`). Выгрузка живого прогона (10 000 строк) — 229 КБ, в base64 — 305 КБ. Предел пути импорта
 * взят от предела базы: 200 000 строк типичной выгрузки — это ~24 МБ, в base64 — ~32 МБ.
 */
const MAX_IMPORT_BODY_BYTES = 48 * 1024 * 1024;
/**
 * Файлы продавца (себестоимость, остатки) и ЛЮБАЯ партия Inbound API: их предел выше, чем у обычного запроса экрана.
 *
 * Находка 10 ревью шага 36: `/inbound/v1/orders` в этот список не входил, и объявленный предел в 5000 заказов был
 * недостижим — 5000 номеров заказов весят ~200 КБ, то есть склад получал 413 вместо ответа. Нашлось замером: предел,
 * который никто не проверял по времени, не проверяли и по размеру.
 */
/**
 * Находка 6 ревью шага 37: предел выбирается ДО проверки токена — иначе тело пришлось бы читать, чтобы узнать, кто его
 * шлёт. Пока консоль не смотрела в интернет, это было безразлично; теперь смотрит [Р-159], и аноним, шлющий 48 МиБ на
 * адрес импорта, занимал бы память процесса до ответа 401. Большой предел даётся только тому, кто ПРЕДЪЯВИЛ вход:
 * токен или ключ Inbound API. Проверка предъявленного — дальше и в прежнем месте.
 */
const bodyLimitFor = (url: string, authorized: boolean) => (authorized && (url.includes('/cost-import/') || url.includes('/stock/import') || url.includes('/inbound/v1/')) ? MAX_IMPORT_BODY_BYTES : MAX_BODY_BYTES);

function send(res: ServerResponse, r: ApiResponse): void {
  if (r.file) {
    res.writeHead(r.status, {
      'content-type': `${r.file.contentType}; charset=utf-8`, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${r.file.fileName.replace(/[^\w.\-]/g, '_')}"`,
    });
    res.end(r.file.content);
    return;
  }
  res.writeHead(r.status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(r.setCookies ? { 'set-cookie': r.setCookies } : {}),
  });
  res.end(JSON.stringify(r.body));
}

/**
 * HTTP-слой стенда: предел тела запроса, разбор JSON и перехват ошибок. Р-136 (шаг 29, ревью, находка 1): он вынесен из точки
 * входа именно затем, чтобы живой прогон шёл ЧЕРЕЗ НЕГО. Прогон, зовущий `createStandApi` напрямую, не видит ни предела тела, ни
 * битого JSON — а это ровно тот класс дефекта, ради которого принято Р-136 (на шаге 28 импорт не проходил из-за предела в 64 КиБ).
 */
export function createStandServer(
  handle: ReturnType<typeof createStandApi>, locale: Locale = 'de',
  /**
   * Р-159 (шаг 37): тот же HTTP-слой отдаёт и СОБРАННЫЙ интерфейс — разворачиваемая консоль не поднимает второго сервера
   * рядом. Адреса API и файлы страницы не пересекаются: всё, что начинается с `/api/` и `/inbound/`, идёт обработчику,
   * остальное — файлам сборки. Стенд разработчика запускается без этого параметра: интерфейс ему даёт vite.
   */
  serveStatic?: (pathname: string) => { status: number; contentType: string; body: Buffer; cacheControl: string } | null,
) {
  const fallback = messagesFor(locale).ui.server;
  return createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://console').pathname;
    if (serveStatic && !pathname.startsWith('/api/') && !pathname.startsWith('/inbound/')) {
      const file = serveStatic(pathname);
      if (!file) return send(res, { status: 404, body: { error: { code: 'NOT_FOUND', message: fallback.notFound } } });
      res.writeHead(file.status, { 'content-type': file.contentType, 'cache-control': file.cacheControl });
      res.end(file.body);
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const limit = bodyLimitFor(req.url ?? '', Boolean(req.headers.authorization));
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) {
        /**
         * Отказ до конца загрузки. Соединение закрывается ПОСЛЕ того, как ответ ушёл: если оборвать сокет сразу, клиент видит
         * «сеть отвалилась» вместо понятного 413 — и продавец не узнает, что именно не так (ревью шага 29, находка 1).
         */
        res.setHeader('connection', 'close');
        send(res, { status: 413, body: { error: { code: 'TOO_LARGE', message: fallback.tooLarge } } });
        // Остаток тела дочитывается и выбрасывается, иначе клиент видит обрыв вместо ответа; поток без конца — обрываем
        let drained = 0;
        req.on('data', (chunk: Buffer) => { drained += chunk.length; if (drained > limit) req.destroy(); });
        req.resume();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      return send(res, { status: 400, body: { error: { code: 'BAD_JSON', message: fallback.badJson } } });
    }
    try {
      send(res, await handle({ method: req.method ?? 'GET', url: req.url ?? '/', body, authorization: req.headers.authorization, cookie: req.headers.cookie }));
    } catch (error) {
      // Задача D шага 34: тенант без единого канала — не поломка стенда, а честное состояние [Р-150]
      if ((error as { cause?: unknown }).cause === 'NO_CHANNEL') return send(res, { status: 409, body: { error: { code: 'NO_CHANNEL', message: fallback.noChannel } } });
      // Ни тело запроса, ни токен в журнал не пишутся — только метод, путь и сообщение ошибки
      console.error('stand request failed', req.method, new URL(req.url ?? '/', 'http://stand').pathname, error instanceof Error ? error.message : error);
      send(res, { status: 500, body: { error: { code: 'STAND_ERROR', message: fallback.standError } } });
    }
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.STAND_PORT ?? 4318);
  let handle: ReturnType<typeof createStandApi>;
  // Режим входа выбирает тот, кто запускает, явно (находка 6): стенд не включает имитатор молча при неполной конфигурации
  const mode = resolveStandIdentityMode(process.env);
  const external = mode.kind === 'oidc' ? { issuer: mode.issuer, audience: mode.audience, jwks: remoteJwks(mode.jwksUrl) } : null;
  const issuer = external ? null : createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const simulator = issuer
    ? {
      token: (a: (typeof STAND_ACCOUNTS)[number], options?: { secondFactor?: boolean }) =>
        issuer.token(a.subject, { email: a.email, amr: options?.secondFactor === false ? ['pwd'] : ['pwd', 'otp'] }),
      expiresInSeconds: 900,
    }
    : undefined;
  const verify = external ?? { issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer!.jwks) };
  if (process.env.REPRACER_PG_URL) {
    const { createPool } = await import('@repracer/pricing-store-pg');
    const { PgIdentityDirectory } = await import('@repracer/identity/pg');
    const { pgStoreFactory } = await import('@repracer/contract-tests/pg-store');
    const url = process.env.REPRACER_PG_URL;
    // Р-90: у каждой роли подключения — свой пул. Путь решения — svc_app; остановки и снятия консоли — svc_admin; тенанты стенда —
    // svc_provisioning; вход — svc_authenticator
    const role = (login: string, max: number) => createPool(url.replace('svc_app@', `${login}@`), { max, applicationName: `repracer-stand-${login}` });
    const pool = createPool(url, { max: 8, applicationName: 'repracer-stand' });
    const adminPool = role('svc_admin', 4);
    const directory = new PgIdentityDirectory(role('svc_authenticator', 2) as never);
    const memberUsers = await pgStandUsers(directory, role('svc_onboarding', 1));
    const worlds = await buildStandWorlds({
      filter: (sc) => !sc.tags.includes('memory-only'),
      storeFactory: pgStoreFactory(pool, role('svc_dispatcher', 2), role('svc_fx_loader', 1), {
        memberUsers, memberEmails: STAND_EMAILS, adminPool, provisioningPool: role('svc_provisioning', 1),
        joinMember: pgStandJoinMember(adminPool, directory),
      }),
    });
    /**
     * Р-151 (шаг 34): демо-тенант для показа продавцу — `REPRACER_DEMO=on`: уже настроенный мир (себестоимость, границы,
     * стратегия, движок включён), время в нём НАСТОЯЩЕЕ, секунда в секунду. Ускорять его нельзя (ревью шага 34, находка 9).
     *
     * Шаг 37 [Р-159]: тот же мир поднимает разворачиваемая консоль, поэтому он живёт одним модулем, а не двумя копиями.
     */
    if (process.env.REPRACER_DEMO === 'on') {
      const { startDemoWorld } = await import('./demo-world.ts');
      const started = await startDemoWorld({
        pools: {
          app: pool, admin: adminPool, provisioning: role('svc_provisioning', 1), dispatcher: role('svc_dispatcher', 2),
          scheduler: role('svc_scheduler', 3), exporter: role('svc_exporter', 2), stock: role('svc_stock', 2), bulkWorker: role('svc_bulk_worker', 2),
        },
        pgUrl: url, tag: 3400, memberUsers, memberEmails: STAND_EMAILS,
        joinMember: pgStandJoinMember(adminPool, directory),
      });
      worlds.push(started.world);
    }
    handle = createStandApi(worlds, { authenticator: createAuthenticator({ ...verify, directory }), ...(simulator ? { simulator } : {}) });
  } else {
    // Стенд не включает ничего молча и ничего молча не пропускает: демо живёт только на PostgreSQL (ревью шага 34, находка 9)
    if (process.env.REPRACER_DEMO === 'on') throw new Error('REPRACER_DEMO=on needs PostgreSQL: set REPRACER_PG_URL (the demo tenant runs the real decision path)');
    const worlds = await buildStandWorlds();
    handle = createStandApi(worlds, { authenticator: createAuthenticator({ ...verify, directory: memoryStandDirectory(worlds) }), ...(simulator ? { simulator } : {}) });
  }
  const server = createStandServer(handle);
  server.listen(port, '127.0.0.1', () => console.log(`stand on http://127.0.0.1:${port}/api/session (${process.env.REPRACER_PG_URL ? 'PostgreSQL' : 'memory'})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

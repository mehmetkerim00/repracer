import { createHash } from 'node:crypto';
import { systemClock } from '@repracer/channel-port';
import type { TenantWorldIndex } from './tenant-worlds.ts';
import { parseStockSheet } from '@repracer/stock-sync';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  boundsDiffView, boundsView, bulkJobsView, bulkJobView, can, canCancelBulkJob, catalogPageOf, catalogTotal, CHANNEL_PRICING_SHOWN, channelNotes, STRATEGY_SCOPE_EXAMPLES, onboardingView, complianceView, fingerprint, costImportView, currentStrategies, listQuery, MAX_SCOPES, OFFER_CHOICES, pageOf, parseListQuery, type ListQuery, discountCheckView, dangerousReport, decisionListView, decisionTrace, describe, expandBoundsEdit, importTargets, LOCALES, messagesFor, parseBoundsEditRequest, parseFeedQuery, scopeById, unitOf,
  parseStrategyDraft, planStop, priceFeed, productList, rejectedView, REPORT_PERIODS_DAYS, stopView, strategiesView,
  type Locale, type Messages, type StandWorld, type StopTarget, type Viewer,
  productPage, clampOffset, feedPageQuery, REJECTED_WINDOW_DAYS, stockView, stockDivergencesView, stockReturnsView, shadowView, liveRefusalText, SHADOW_PERIOD_DAYS,
} from '@repracer/console-model';
import { buildPreview, readTable, suggestMapping, TABLE_ENCODINGS } from '@repracer/cost-import';
import type { BulkJobInput, ConsoleCatalogFacts, ConsoleCatalogFactsQuery, ConsoleCatalogPage, DiscountAnnouncementInput, DiscountAnnouncementRow, InterventionSlice } from '@repracer/pricing-pipeline';
import {
  buildStandWorlds, memoryStandDirectory, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, type LiveWorld,
} from '@repracer/contract-tests/stand';
import { createAuthenticator, hasSecondFactor, remoteJwks, staticJwks, type Authenticator, type Principal } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { connectionsView, OTHER_TOOLS_ANSWERS } from '@repracer/console-model';
import type { ChannelConnectService } from './connect.ts';
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
  /** Шаг 45 [OQ-238]: ID-токен поставщика — методы входа (второй фактор) */
  idToken?: string | undefined;
  cookie?: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  setCookies?: string[];
  /** Шаг 59: ответ «повторите через N секунд» (503 очереди пересчётов остатков) */
  retryAfterSeconds?: number;
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
  /** Шаг 44 [Р-178]: настоящий вход у поставщика — страница уходит к нему сама (код с PKCE) */
  oidc?: { issuer: string; clientId: string; scope: string };
  /**
   * Шаг 44 [Р-179]: приём приглашения из письма. Новый владелец входит у поставщика впервые — пользователя у нас ещё нет,
   * поэтому токен проверяется без сопоставления, а связь (издатель, subject) ↔ пользователь создаёт база по приглашению.
   */
  acceptInvitation?(invitationToken: string, verified: { issuer: string; subject: string; email: string | null; emailVerified: boolean }): Promise<string>;
}

export const LOCALE_COOKIE = 'repracer_locale';

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Шаг 68 (K7): суток прожатой тени США — целое 0…7; другое значение — отказ подъёма, а не тихий ноль */
function pressDaysOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 7) throw new Error(`REPRACER_DEMO_PRESS_DAYS must be an integer 0..7, got ${raw}`);
  return n;
}

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
/** Шаг 59 (ревью шага 58, находка 3): сколько склад ждёт очередь пересчётов остатков тенанта, прежде чем получить 503 */
const INBOUND_RECALC_WAIT_MS = 5_000;
/** Шаг 59 [Р-199]: сколько строк возврата показывает экран остатков — ждущие решения идут первыми */
const RETURNS_LIST_LIMIT = 200;
/** Шаг 59 [Р-199]: идентификатор строки возврата — UUID; иное не доходит до базы (там 22P02 стал бы 500) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INBOUND_RECALC_RETRY_SECONDS = 10;
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
async function compliance(live: LiveWorld, world: StandWorld, m: Messages, query?: ListQuery, prefetched?: readonly DiscountAnnouncementRow[]) {
  const announcements = prefetched ? [...prefetched] : await live.store.discountAnnouncements(world.tenantId);
  const rechecks = new Map(await Promise.all(announcements.map(async (a) => [a.announcementId, await live.store.omnibusCheck(world.tenantId, a.writeScopeId, a.startsAt)] as const)));
  const now = live.clock.iso();
  /**
   * Р-136: глубина истории считается только у ПОКАЗАННЫХ предложений. На каталоге целевого клиента этот экран спрашивал базу
   * десять тысяч раз подряд: 24,8 секунды и 8,7 МБ ответа (живой прогон через консоль, шаг 29).
   */
  // Шаг 67 (OQ-248): страница — та, что выбрала база, у мира выбранных единиц
  const { items: shown } = catalogPageOf(world, listQuery(query), m);
  const depth = new Map(await Promise.all(shown.map(async (sc) => [sc.writeScopeId, await live.store.omnibusCheck(world.tenantId, sc.writeScopeId, now)] as const)));
  return complianceView(world, announcements, rechecks, m, depth, listQuery(query));
}

/** Шаг 23: устаревший экран различий — какой оффер и какие границы у него сейчас */
function conflictText(world: StandWorld, conflict: { writeScopeId: string; actual: { minMinor: number | null; maxMinor: number | null } }, m: Messages): string {
  const scope = scopeById(world, conflict.writeScopeId);
  if (!scope) return m.ui.server.boundsConflict;
  return m.ui.server.boundsConflictAt(unitOf(world, scope, m).label, m.money(conflict.actual.minMinor, scope.currency), m.money(conflict.actual.maxMinor, scope.currency));
}

/**
 * Шаг 43 [Р-175]: службы консоли, которых нет у мира стенда. Подключение канала — у мира, чей тенант подключает каналы
 * настоящим OAuth: процесс с кольцом ключей и приложениями каналов. Мира без службы экран честно показывает недоступным.
 */
export interface StandServices {
  connect?(worldId: string): ChannelConnectService | null;
  /**
   * Шаг 44 [Р-178]: миры тенантов пользователя — по его членствам, из базы (`security.console_tenant_worlds`). Демо сюда не
   * попадает никогда: гостевой путь — свои миры в списке `worlds`, и смешать их нечем.
   */
  tenantWorlds?(principal: Principal): Promise<TenantWorldIndex>;
  /** Шаг 44 (находка 4 ревью): ключ Inbound API → тенант → его мир, вне списка миров стенда */
  inbound?(prefix: string, sha256Hex: string): Promise<{ tenantId: string; stockSourceId: string; world: LiveWorld } | null>;
  /**
   * Шаг 64 (ревью, находка 1): язык по умолчанию — развёртывания (`REPRACER_CONSOLE_LOCALE`), а не жёсткое `de`. Без него продавец из США
   * в новом браузере (без куки) видел немецкий первый экран, а прогоны этого не видели: они шлют куку языка в каждом запросе
   */
  defaultLocale?: Locale;
  /**
   * Шаг 67 (OQ-248): ТОЛЬКО тест равенства — каждый экран строится из каталога целиком, без страниц и фактов базы. Ответы обоих путей
   * обязаны совпадать (`console-screens-targeted.pg.test.ts`)
   */
  fullCatalogScreens?: boolean;
}

export function createStandApi(worlds: readonly LiveWorld[], identity: StandIdentity, services: StandServices = {}) {
  const localeCookie = (l: Locale) => `${LOCALE_COOKIE}=${l}; SameSite=Strict; Path=/; Max-Age=31536000`;

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    const url = new URL(req.url, 'http://stand');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const jar = cookies(req.cookie);
    const requested = url.searchParams.get('locale');
    const locale: Locale = isLocale(requested) ? requested : isLocale(jar[LOCALE_COOKIE]) ? jar[LOCALE_COOKIE] : services.defaultLocale ?? 'de';
    // Шаг 69 (K1, K4): в мире тенанта сообщения пересобираются на его языке и в его поясе (ниже, когда мир найден)
    let m = messagesFor(locale);
    let s = m.ui.server;
    const ok = (body: unknown, setCookies?: string[]): ApiResponse => ({ status: 200, body, ...(setCookies ? { setCookies } : {}) });
    const fail = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Токен поставщика проверяется при каждом запросе; недействительный токен — как его отсутствие
    const principal: Principal | null = await identity.authenticator.authenticate(req.authorization, req.idToken);
    const sessionView = (l: Locale): SessionView => ({
      user: principal ? { subject: principal.subject, email: principal.email } : null, locale: l,
      simulator: identity.simulator ? STAND_ACCOUNTS.map((a) => ({ role: a.role, label: m.values[a.role] })) : null,
      demoGuest: Boolean(identity.guest),
      oidc: identity.oidc ?? null,
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
      return services.inbound ? services.inbound(prefix, createHash('sha256').update(raw).digest('hex')) : null;
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
      /**
       * Шаг 59 (ревью шага 58, находка 3): пересчёты тенанта идут по очереди; склад не ждёт очередь дольше INBOUND_RECALC_WAIT_MS — пул
       * остатков консоли общий для всех тенантов. Отказ — 503 с Retry-After; повтор той же присылки придёт устаревшим, поэтому пересчитываются
       * товары ВСЕХ узнанных строк, а не только применённых
       */
      const products = [...new Set(outcome.recognizedProductIds)];
      let propagated = { writes: 0, unchanged: 0 };
      if (products.length > 0 && resolved.world.stockPipeline) {
        try {
          propagated = await resolved.world.stockPipeline.propagate(resolved.tenantId, products, { lockTimeoutMs: INBOUND_RECALC_WAIT_MS });
        } catch (error) {
          if ((error as { code?: string }).code !== '55P03') throw error;
          return { ...fail(503, 'STOCK_RECALCULATION_BUSY', s.busy), retryAfterSeconds: INBOUND_RECALC_RETRY_SECONDS };
        }
      }
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

    /**
     * Шаг 44 [Р-179]: приём приглашения. Токен проверен поставщиком (подпись, издатель, аудитория, сроки), адрес подтверждён
     * им же и совпадает с адресом приглашения — это сверяет база. Повторный приём и чужое приглашение — отказ базы.
     */
    if (parts[1] === 'invitations' && parts[2] === 'accept') {
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      if (!identity.acceptInvitation) return fail(404, 'NOT_FOUND', s.notFound);
      let verified;
      try {
        verified = await identity.authenticator.identify(req.authorization);
      } catch (error) {
        // Находка 10 ревью шага 45: поставщик не ответил — это не «адрес не подтверждён» и не сбой консоли
        if ((error as { code?: string }).code === 'USERINFO_UNAVAILABLE') return fail(503, 'IDENTITY_PROVIDER_UNAVAILABLE', m.ui.app.invitation.providerUnavailable);
        throw error;
      }
      if (!verified) return fail(401, 'UNAUTHENTICATED', s.unauthenticated);
      const invitation = typeof body.token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(body.token) ? body.token : null;
      if (!invitation) return fail(400, 'BAD_INVITATION', m.ui.app.invitation.bad);
      try {
        await identity.acceptInvitation(invitation, { issuer: verified.issuer, subject: verified.subject, email: verified.email, emailVerified: verified.emailVerified });
      } catch (error) {
        /**
         * Находка 17 ревью шага 44: отказ — это отказ БАЗЫ (`insufficient_privilege`), а не любая ошибка: сбой базы раньше
         * тоже отвечал «истекло или использовано», и продавец просил новое приглашение, которое не помогло бы. Истёкшее,
         * чужое и уже принятое приглашение по-прежнему выглядят одинаково — кроме неподтверждённого адреса: его продавец
         * исправляет сам, у поставщика, и это надо сказать.
         */
        if ((error as { code?: string }).code !== '42501') throw error;
        const unverified = /has not verified the email/.test((error as Error).message);
        return fail(409, unverified ? 'INVITATION_EMAIL_UNVERIFIED' : 'INVITATION_REFUSED', unverified ? m.ui.app.invitation.unverified : m.ui.app.invitation.refused);
      }
      return ok({ accepted: true, message: m.ui.app.invitation.accepted });
    }

    if (!principal) return fail(401, 'UNAUTHENTICATED', s.unauthenticated);
    if (parts[1] !== 'worlds') return fail(404, 'NOT_FOUND', s.notFound);
    // Р-178: миры запроса — миры стенда и демо плюс миры тенантов пользователя из базы; Р-182: указатель, а не собранные миры
    const tenantIndex = services.tenantWorlds ? await services.tenantWorlds(principal) : null;

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
      /**
       * Р-182: миры тенантов — счётчики всех одним обращением к базе. Роль — из свежих членств, как у миров стенда:
       * запись указателя без членства в списке не появится.
       */
      const tenantSummaries = tenantIndex && tenantIndex.entries.length > 0 ? await tenantIndex.summaries() : new Map();
      const tenantRows = (tenantIndex?.entries ?? []).flatMap((e): WorldSummary[] => {
        const membership = principal.memberships.find((x) => x.tenantId === e.tenantId);
        const c = tenantSummaries.get(e.tenantId);
        if (!membership || !c) return [];
        return [{
          id: e.id, title: e.title, description: '', failures: [], scopes: c.scopes, decisionsLastDay: c.decisionsLastDay,
          interventionsLastWeek: c.interventionsLastWeek, activeStops: c.activeStops, activeHalts: c.activeHalts, role: m.values[membership.role],
          demo: c.demo, awaitingAccess: c.awaitingAccess, euStorefronts: c.euStorefronts, locale: c.locale, timeZone: c.timeZone,
        }];
      });
      // Р-154: список миров — счётчики агрегатом, без чтения состояния ни одного мира
      return ok([...await Promise.all(visible.map(async ({ live, viewer }): Promise<WorldSummary> => {
        const [c, accounts, display] = await Promise.all([live.store.worldCounters(live.tenantId, live.clock.iso() as never), live.store.channelAccounts(live.tenantId),
          live.display ? live.display() : Promise.resolve(null)]);
        return {
          // Шаг 64: демо-мир назван на языке интерфейса — клиент из США видел описание посева по-немецки
          id: live.id, title: c.demo ? m.ui.app.demoWorldTitle : live.title, description: c.demo ? m.ui.app.demoWorldDescription : live.description,
          failures: live.failures, scopes: c.scopes, decisionsLastDay: c.decisionsLastDay,
          interventionsLastWeek: c.interventionsLastWeek, activeStops: c.activeStops, activeHalts: c.activeHalts, role: m.values[viewer.role],
          // Р-151: демо помечается уже в списке миров; Р-150: сколько каналов ждёт доступа — видно до входа в мир
          demo: c.demo,
          awaitingAccess: accounts.filter((a) => a.authStatus === 'AWAITING_ACCESS').length,
          euStorefronts: c.euStorefronts,
          // Ревью шага 69, находка 5: язык демо — язык гостя, поэтому список его не называет; пояс — называет
          locale: display && !display.followsRequestLocale ? display.locale : null, timeZone: display?.timeZone ?? null,
        };
      })), ...tenantRows]);
    }

    const live = worlds.find((w) => w.id === parts[2]) ?? (await tenantIndex?.open(parts[2]!)) ?? undefined;
    const viewer = live ? viewerIn(live) : null;
    if (!live || !viewer) return fail(404, 'WORLD_NOT_FOUND', s.notFound);
    /**
     * Шаг 69 (K1, K4): мир тенанта говорит на языке ТЕНАНТА, а время показывает в его поясе — агентство с тенантами DE и US видит
     * каждый на его языке. Язык запроса (кука, развёртывание) остаётся у экранов вне мира и у миров сценариев стенда
     */
    const display = live.display ? await live.display() : null;
    if (display) {
      // Ревью шага 69, находка 5: у публичного демо язык — гостя (запроса), пояс — демо
      m = messagesFor(display.followsRequestLocale ? m.locale : display.locale, { timeZone: display.timeZone });
      s = m.ui.server;
    }
    /**
     * Р-149: экран пути читает ТОЛЬКО то, что показывает, — счётчики шагов, аккаунты, сужение и признак демо, — и не ждёт
     * состояния консоли целиком (`live.view` читает все решения тенанта, OQ-214). На раннере CI первый запрос экрана пути
     * демо-тенанта занял 10,98 с при пределе 10: остальные восемь — 0,04–0,09 с. Экран, у которого шесть чисел, не должен
     * зависеть от размера ленты решений.
     */
    /**
     * Шаг 69 (K1, K4): язык и пояс показа тенанта. Читает любой участник, меняет администратор тенанта (MANAGE_TENANT) —
     * административной записью с автором и аудитом. У мира сценария стенда настроек нет — 404
     */
    if (parts[3] === 'settings' && parts[4] === undefined) {
      const store = live.store as unknown as { setTenantDisplay?: (t: string, c: { locale?: Locale; timeZone?: string | null }, a: { userId: string; mfa: boolean }) => Promise<{ status: string }> };
      if (!display || !store.setTenantDisplay) return fail(404, 'NOT_FOUND', s.notFound);
      // Ревью шага 69, находка 13: экран различает «пояс задан» и «пояс по умолчанию» — иначе правка языка делала умолчание явным
      const view = (d: { locale: Locale; timeZone: string; timeZoneSet?: boolean }) =>
        ({ locale: d.locale, timeZone: d.timeZone, timeZoneSet: d.timeZoneSet ?? true, canChange: can(viewer.role, 'MANAGE_TENANT') });
      if (req.method === 'GET') return ok(view(display));
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', s.notFound);
      if (!can(viewer.role, 'MANAGE_TENANT')) return fail(403, 'FORBIDDEN', s.forbidden);
      const nextLocale = body.locale === undefined ? undefined : isLocale(body.locale) ? body.locale : null;
      const nextZone = body.timeZone === undefined ? undefined : body.timeZone === null || body.timeZone === '' ? null
        : typeof body.timeZone === 'string' && body.timeZone.length <= 64 ? body.timeZone.trim() : false;
      if (nextLocale === null || nextZone === false) return fail(400, 'BAD_SETTINGS', m.ui.settings.invalid);
      const saved = await store.setTenantDisplay(live.tenantId, { ...(nextLocale ? { locale: nextLocale } : {}), ...(nextZone !== undefined ? { timeZone: nextZone } : {}) },
        { userId: principal!.userId, mfa: hasSecondFactor(principal!.amr) });
      if (saved.status === 'TIME_ZONE_UNKNOWN') return fail(400, 'TIME_ZONE_UNKNOWN', m.ui.settings.timeZoneUnknown);
      if (saved.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (saved.status !== 'SAVED') return fail(400, 'BAD_SETTINGS', m.ui.settings.invalid);
      return ok(view(await live.display!()));
    }
    if (req.method === 'GET' && parts[3] === 'onboarding' && parts[4] === undefined) {
      const [progress, status, accounts, demo] = await Promise.all([
        live.store.onboardingProgress(live.tenantId), live.store.onboardingStatus(live.tenantId), live.store.channelAccounts(live.tenantId),
        live.store.tenantIsDemo(live.tenantId),
      ]);
      return ok(onboardingView({ id: live.id, demo, viewer }, progress, status, accounts, m));
    }
    /**
     * Шаг 43 [Р-175…Р-177]: подключение каналов. Экран читает только аккаунты и запросы согласия — состояние консоли
     * целиком ему не нужно [Р-154]. Начинает и завершает подключение тот, кто управляет тенантом; гость демо [Р-160] и
     * наблюдатель получают 403 здесь, а запись без права всё равно отклонит база (страж административной записи).
     */
    if (parts[3] === 'connections') {
      const connect = services.connect?.(live.id) ?? null;
      const param4 = parts[4] ?? null;
      const t = m.ui.connections;
      if (req.method === 'GET' && param4 === null) {
        const rows = connect ? await connect.connections(live.tenantId) : { accounts: [], pending: [] };
        return ok(connectionsView({ worldId: live.id, role: viewer.role, now: systemClock.now() }, rows, connect ? connect.connectable() : [], m));
      }
      if (req.method !== 'POST' || (param4 !== 'start' && param4 !== 'callback' && param4 !== 'cancel' && param4 !== 'other-tools' && param4 !== 'quantity-writes' && param4 !== 'quantity-writes-revoke')) return fail(404, 'NOT_FOUND', s.notFound);
      if (!can(viewer.role, 'MANAGE_TENANT')) return fail(403, 'FORBIDDEN', t.noRight);
      const actor = { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) };
      /**
       * Шаг 60 [Р-202]: внешние писатели канала. Ответ «обновляет ли другой инструмент остатки или цены» и подтверждение записи
       * количества — через хранилище остатков, а не через службу подключения: у мира без OAuth (стенд, файл развёртывания)
       * вопрос тот же. Кто подтверждает (только владелец), что набрано и не противоречит ли ответу — проверяет база; консоль
       * лишь переводит её исход в код HTTP, не переписывая причину [Р-94]. Второй фактор не нужен [Р-202]
       */
      if (param4 === 'other-tools' || param4 === 'quantity-writes' || param4 === 'quantity-writes-revoke') {
        const e = t.errors;
        const accountId = typeof body.channelAccountId === 'string' ? body.channelAccountId : null;
        if (!accountId || !live.accounts.some((a) => a.channelAccountId === accountId)) return fail(404, 'ACCOUNT_NOT_FOUND', e.accountNotFound);
        if (param4 === 'other-tools') {
          if (!live.stock.answerOtherTools) return fail(404, 'NOT_FOUND', s.notFound);
          const answer = OTHER_TOOLS_ANSWERS.find((x) => x === body.answer) ?? null;
          if (!answer) return fail(400, 'BAD_ANSWER', e.badAnswer);
          const answered = await live.stock.answerOtherTools(live.tenantId, accountId, answer, actor);
          if (answered.status === 'ANSWERED') return ok({ answer, message: t.otherTools.answered, warning: answer === 'PRICES' || answer === 'STOCK_AND_PRICES' ? t.otherTools.twoRepricers : null });
          if (answered.status === 'NOT_FOUND') return fail(404, 'ACCOUNT_NOT_FOUND', e.accountNotFound);
          if (answered.status === 'CONFLICT') return fail(409, 'QUANTITY_WRITES_CONFIRMED', e.answerConflictConfirmed);
          return fail(403, 'FORBIDDEN', t.noRight);
        }
        /**
         * Шаг 61 [Р-202]: отзыв — тем же порядком, что выдача: владелец, набранный идентификатор аккаунта, журнал, аудит. Запись количества
         * выключается сразу, неотправленные версии снимаются; ответ называет, сколько выключено и снято
         */
        if (param4 === 'quantity-writes-revoke') {
          if (!live.stock.revokeQuantityWrites) return fail(404, 'NOT_FOUND', s.notFound);
          if (typeof body.typedConfirmation !== 'string' || body.typedConfirmation.length > 256) return fail(400, 'CONFIRMATION_MISMATCH', e.confirmationMismatch);
          const revoked = await live.stock.revokeQuantityWrites(live.tenantId, accountId, body.typedConfirmation, actor);
          switch (revoked.status) {
            case 'REVOKED': return ok({ revoked: true, disabledScopes: revoked.disabledScopes, discardedWrites: revoked.discardedWrites, inFlightWrites: revoked.inFlightWrites,
              message: t.quantityWrites.revoked(revoked.disabledScopes, revoked.discardedWrites, revoked.inFlightWrites) });
            case 'NOT_OWNER': return fail(403, 'NOT_OWNER', e.notOwner);
            case 'FORBIDDEN': return fail(403, 'FORBIDDEN', t.noRight);
            case 'NOT_FOUND': return fail(404, 'ACCOUNT_NOT_FOUND', e.accountNotFound);
            case 'NOT_CONFIRMED': return fail(409, 'NOT_CONFIRMED', e.notConfirmedToRevoke);
            case 'CONFIRMATION_MISMATCH': return fail(400, 'CONFIRMATION_MISMATCH', e.confirmationMismatch);
          }
        }
        if (!live.stock.confirmQuantityWrites) return fail(404, 'NOT_FOUND', s.notFound);
        if (typeof body.typedConfirmation !== 'string' || body.typedConfirmation.length > 256) return fail(400, 'CONFIRMATION_MISMATCH', e.confirmationMismatch);
        const confirmed = await live.stock.confirmQuantityWrites(live.tenantId, accountId, body.typedConfirmation, actor);
        switch (confirmed.status) {
          case 'CONFIRMED': return ok({ confirmed: true, message: t.quantityWrites.confirmed });
          case 'NOT_OWNER': return fail(403, 'NOT_OWNER', e.notOwner);
          case 'FORBIDDEN': return fail(403, 'FORBIDDEN', t.noRight);
          case 'NOT_FOUND': return fail(404, 'ACCOUNT_NOT_FOUND', e.accountNotFound);
          case 'ALREADY_CONFIRMED': return fail(409, 'ALREADY_CONFIRMED', e.alreadyConfirmed);
          case 'CONFIRMATION_MISMATCH': return fail(400, 'CONFIRMATION_MISMATCH', e.confirmationMismatch);
          case 'ANSWER_FIRST': return fail(409, 'ANSWER_FIRST', e.answerFirst);
          case 'OTHER_TOOL_MANAGES_STOCK': return fail(409, 'OTHER_TOOL_MANAGES_STOCK', e.otherToolManagesStock);
        }
      }
      if (!connect) return fail(409, 'CHANNEL_UNAVAILABLE', t.errors.unavailable);
      if (param4 === 'cancel') {
        const id = typeof body.authorizationRequestId === 'string' && /^[0-9a-f-]{36}$/.test(body.authorizationRequestId) ? body.authorizationRequestId : null;
        if (!id) return fail(400, 'BAD_REQUEST', s.badRequest);
        return (await connect.cancel(live.tenantId, id, actor)) ? ok({ cancelled: true }) : fail(409, 'ALREADY_DONE', t.errors.alreadyDone);
      }
      if (param4 === 'start') {
        const marketplaces = Array.isArray(body.marketplaces) && body.marketplaces.every((x) => typeof x === 'string') ? body.marketplaces as string[] : null;
        if (typeof body.channel !== 'string' || !marketplaces) return fail(400, 'BAD_REQUEST', s.badRequest);
        const started = await connect.start(live.tenantId, { channel: body.channel, marketplaces }, actor);
        if (started.status === 'UNAVAILABLE') return fail(409, 'CHANNEL_UNAVAILABLE', t.errors.unavailable);
        if (started.status === 'BAD_MARKETPLACES') return fail(400, 'BAD_MARKETPLACES', t.errors.badMarketplaces);
        if (started.status === 'IDENTITY_UNKNOWN') return fail(409, 'IDENTITY_UNKNOWN', t.errors.identityUnknown);
        return ok({ consentUrl: started.consentUrl, expiresAt: started.expiresAt });
      }
      // Параметры возврата — строками и не больше десятка: SPA пересылает их из адреса, по которому канал вернул браузер
      const raw = (body.params ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw).slice(0, 10)) if (typeof v === 'string' && v.length <= 2048) params[k] = v;
      const outcome = await connect.callback(live.tenantId, params, actor);
      const e = t.errors;
      if (outcome.status === 'CONNECTED') return ok({ channelAccountId: outcome.channelAccountId, reconnected: outcome.reconnected, message: e.connected(outcome.reconnected) });
      if (outcome.status === 'DENIED') return fail(409, 'DENIED', e.denied);
      if (outcome.status === 'EXPIRED') return fail(409, 'EXPIRED', e.expired);
      if (outcome.status === 'ALREADY_DONE') return fail(409, 'ALREADY_DONE', e.alreadyDone);
      if (outcome.status === 'EXCHANGE_FAILED') return fail(502, `EXCHANGE_${outcome.failure}`, e.exchange);
      if (outcome.status === 'SELLER_TAKEN') return fail(409, 'SELLER_TAKEN', e.sellerTaken);
      if (outcome.status === 'IDENTITY_UNKNOWN') return fail(409, 'IDENTITY_UNKNOWN', t.errors.identityUnknown);
      if (outcome.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', e.mfa);
      return fail(400, outcome.status, e.unknownState);
    }

    /**
     * Шаги 66–67 (OQ-248): экран не грузит каталог целиком. На 50 000 предложений состояние каталога — 41,5 МБ памяти сервера и 4,4–6,4 с
     * на КАЖДЫЙ запрос экрана, хотя экран показывает 50 строк. Каждый экран называет единицы, которые покажет (страницу, найденные,
     * примеры, единицы отчёта), и спрашивает базу о каталоге целиком только то, что ему нужно (`consoleCatalogFacts`): число и первые
     * предложения, поиск, использование стратегий, влияние остановки, ценообразование канала. Хранилищу в памяти (миры сценариев) это не
     * нужно — его каталог мал. Тест равенства (`fullCatalogScreens`) строит те же экраны из каталога целиком и сравнивает ответы
     */
    const targeted = !services.fullCatalogScreens && live.store.consoleCatalogFacts && live.store.consoleCatalogPage ? live.store : null;
    /**
     * Мир из названных единиц. Номер из запроса может быть любой строкой: единицу неверной формы хранилище не находит (а не роняет
     * приведением типа), и экран отвечает тем же «не найдено», что и с каталогом целиком
     */
    const load = async (scopeIds: ReadonlyArray<unknown> | null, extra: { catalogPage?: ConsoleCatalogPage | null; facts?: ConsoleCatalogFacts | null } = {}): Promise<StandWorld> => {
      const ids = targeted && scopeIds ? [...new Set(scopeIds.filter((x): x is string => typeof x === 'string' && x !== ''))] : null;
      const w = await live.view(viewer, ids ? { scopeIds: ids } : undefined);
      /**
       * Р-151: признак демо — из БАЗЫ (`tenant.demo` в состоянии консоли), а не из настройки стенда. Первая редакция брала его
       * из поля, выставленного руками, и столбец базы не читал никто: забытая настройка сняла бы метку молча (ревью шага 34,
       * находка 4).
       */
      w.demo = w.state.demo;
      if (targeted && extra.catalogPage) w.catalogPage = extra.catalogPage;
      if (targeted && extra.facts) w.catalogFacts = extra.facts;
      return w;
    };
    const facts = (query: ConsoleCatalogFactsQuery): Promise<ConsoleCatalogFacts | null> => targeted ? targeted.consoleCatalogFacts!(live.tenantId, query) : Promise.resolve(null);
    const catalogPageFor = (query: ListQuery): Promise<ConsoleCatalogPage | null> =>
      targeted ? targeted.consoleCatalogPage!(live.tenantId, live.clock.iso() as never, query) : Promise.resolve(null);
    /** Единицы среза вмешательств: решения, намерения, снятые записи — отчёты отклонённых и опасных изменений */
    const sliceScopeIds = (slice: InterventionSlice) => [...slice.decisions, ...slice.intents, ...slice.endedWrites].map((x) => x.writeScopeId);
    const screen = parts[3];
    const param = parts[4] ?? null;
    /** Экраны, которые отдают и маршруты записи (ответ после действия) — одним построителем */
    const strategiesScreen = async (canEdit: boolean, query?: ListQuery) => {
      const [page, f] = await Promise.all([
        catalogPageFor(listQuery(query)),
        facts({ first: 1, strategyUsage: { examples: STRATEGY_SCOPE_EXAMPLES }, channelPricing: { limit: CHANNEL_PRICING_SHOWN } }),
      ]);
      const world = await load(page && f ? [...page.scopeIds, ...f.firstIds, ...(f.strategyUsage ?? []).flatMap((u) => u.exampleIds)] : null, { catalogPage: page, facts: f });
      return strategiesView(world, m, canEdit, query);
    };
    const stopScreen = async () => {
      const world = await load([], { facts: await facts({ stopImpact: true }) });
      return stopView(world, await live.store.auditRecent(world.tenantId, AUDIT_RECENT), m);
    };
    const complianceScreen = async (query?: ListQuery) => {
      const [announcements, page, f] = await Promise.all([live.store.discountAnnouncements(live.tenantId), catalogPageFor(listQuery(query)), facts({ first: OFFER_CHOICES })]);
      const world = await load(page && f ? [...announcements.map((x) => x.writeScopeId), ...page.scopeIds, ...f.firstIds] : null, { catalogPage: page, facts: f });
      return compliance(live, world, m, query, announcements);
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
          const world = await load([]);
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
          const world = await load([]);
          if (param === 'divergences') return ok(stockDivergencesView(world, await live.stock.stockDivergences(world.tenantId, 200), m));
          // Шаг 59 [Р-199]: возвраты — ждущие решения человека первыми; у хранилища без возвратов маршрута нет
          if (param === 'returns') {
            if (!live.stock.listReturns) return fail(404, 'NOT_FOUND', s.notFound);
            return ok(stockReturnsView(world, await live.stock.listReturns(world.tenantId, RETURNS_LIST_LIMIT), m));
          }
          if (param !== null) return fail(404, 'NOT_FOUND', s.notFound);
          const query = parseListQuery(url.searchParams);
          if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
          // Шаг 69 (K8): поиск по названию или SKU и фильтр «с резервациями»; неверный параметр — отказ, а не молчаливое «всё»
          const search = (url.searchParams.get('q') ?? '').trim();
          const reservedParam = url.searchParams.get('reserved');
          if (search.length > 100 || (reservedParam !== null && reservedParam !== '1')) return fail(400, 'BAD_PAGE', s.badRequest);
          const filter = { search: search === '' ? null : search, withReservations: reservedParam === '1' };
          // Смещение за концом подтягивается ДО выборки — иначе подпись «151–200 из 200» стоит над пустой таблицей
          const probe = await live.stock.stockPage(world.tenantId, { offset: 0, limit: 1, ...filter });
          const clamped = { ...query, offset: clampOffset(query, probe.total) };
          const [page, sources] = await Promise.all([live.stock.stockPage(world.tenantId, { ...clamped, ...filter }), live.stock.stockSources(world.tenantId)]);
          return ok(stockView(world, page, clamped, sources, m, filter));
        }
        case 'products': {
          const query = parseListQuery(url.searchParams);
          if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
          const catalog = await catalogPageFor(query);
          const world = await load(catalog ? catalog.scopeIds : null, { catalogPage: catalog });
          // Р-154: статистика решений — только для показанных строк, по индексу единицы
          const shown = catalog ? catalog.scopeIds : productPage(world, m, query).shown.map((x) => x.writeScopeId);
          return ok(productList(world, m, query, await live.store.scopeDecisionStats(world.tenantId, shown), catalog ?? undefined));
        }
        case 'decisions': {
          if (param === null) {
            // Р-154: страницу и итог отдаёт база; смещение за концом подтягивается к последней странице теми же правилами
            const query = parseListQuery(url.searchParams);
            if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
            const scopeFilter = url.searchParams.get('writeScopeId');
            // Предложение фильтра есть в каталоге — до запроса страницы, как и раньше; шаг 67: по миру одной его единицы
            if (scopeFilter && !scopeById(await load([scopeFilter]), scopeFilter)) return fail(400, 'BAD_PAGE', s.badRequest);
            const probe = await live.store.decisionPage(live.tenantId, { offset: 0, limit: 1, ...(scopeFilter ? { writeScopeId: scopeFilter } : {}) });
            const clamped = { ...query, offset: clampOffset(query, probe.total) };
            const page = await live.store.decisionPage(live.tenantId, { ...clamped, ...(scopeFilter ? { writeScopeId: scopeFilter } : {}) });
            return ok(decisionListView(await load([scopeFilter, ...page.items.map((d) => d.writeScopeId)]), page, clamped, m));
          }
          const detail = await live.store.decisionDetail(live.tenantId, param);
          return detail ? ok(decisionTrace(await load([detail.decision.writeScopeId]), detail, m)) : fail(404, 'DECISION_NOT_FOUND', s.notFound);
        }
        case 'rejected': {
          // Р-154: отчёт — по вмешательствам окна (неделя), «без изменения» до экрана не доходят
          const to = live.clock.iso();
          const from = new Date(Date.parse(to) - REJECTED_WINDOW_DAYS * 86_400_000).toISOString();
          const slice = await live.store.interventions(live.tenantId, from as never, to as never);
          // Отклонённый снимок называет предложение ключом канала: первую единицу каталога с этим ключом называет база
          const f = await facts({ keys: slice.rejectedSnapshots.map((x) => ({ marketplace: x.key.marketplace, channelProductRef: x.key.channelProductRef, condition: x.key.condition })) });
          return ok(rejectedView(await load([...sliceScopeIds(slice), ...(f?.keyed ?? []).map((k) => k.writeScopeId)], { facts: f }), slice, m));
        }
        case 'bounds': {
          if (param === null) {
            // Р-136: страница, а не весь каталог; список границ — тот же порядок, что у списка товаров
            const query = parseListQuery(url.searchParams);
            if (!query) return fail(400, 'BAD_PAGE', s.badRequest);
            const catalog = await catalogPageFor(query);
            const list = productList(await load(catalog ? catalog.scopeIds : null, { catalogPage: catalog }), m, query, undefined, catalog ?? undefined);
            return ok({
              items: list.rows.map((r): BoundsIndexItem => ({ writeScopeId: r.unit.writeScopeId, label: r.unit.label, minPrice: r.minPrice, maxPrice: r.maxPrice })),
              page: list.page,
              canEdit: can(viewer.role, 'MANAGE_PRICING'),
            } satisfies BoundsIndexView);
          }
          const b = boundsView(await load([param]), param, m);
          return b ? ok(b) : fail(404, 'SCOPE_NOT_FOUND', s.notFound);
        }
        case 'stop': return ok(await stopScreen());
        /**
         * Р-136 (ревью шага 29, находка 4): поиск предложения. Выпадающий список показывает первые OFFER_CHOICES, и без поиска
         * предложения 201…10 000 были недостижимы: по ним нельзя было ни объявить скидку, ни выгрузить доказательство [Р-123].
         */
        case 'offers': {
          const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (q.length > 100) return fail(400, 'BAD_QUERY', s.badRequest);
          /**
           * Шаг 67 (OQ-248): поиск — в базе, по тем же полям и той же подписи экрана (`unitLabel` шаблоном, имя канала аккаунта); мир —
           * только найденных, первые OFFER_CHOICES в порядке каталога
           */
          if (targeted) {
            const channelNames = Object.fromEntries(live.accounts.map((a) => [a.channel, m.values[a.channel as keyof typeof m.values] ?? a.channel]));
            const unknownChannel = m.values['UNKNOWN_CHANNEL' as keyof typeof m.values] ?? 'UNKNOWN_CHANNEL';
            // Шаг 68 (K10): витрина словами — правило подписи экрана (`storefrontName`) повторяет база, словарь витрин — целиком (ревью, находка 6)
            const found = (await facts({ search: { q, limit: OFFER_CHOICES, labelTemplate: m.ui.common.unitLabel('{p}', '{s}'), marketplaceWords: m.ui.connections.marketplaces, channelNames, unknownChannel } }))!.search!;
            const world = await load(found.ids);
            const items = found.ids.flatMap((id) => { const sc = scopeById(world, id); return sc ? [unitOf(world, sc, m)] : []; });
            return ok({ items, total: found.total, shown: Math.min(found.total, OFFER_CHOICES) });
          }
          const world = await load(null);
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
          return query ? ok(await strategiesScreen(can(viewer.role, 'MANAGE_PRICING'), query)) : fail(400, 'BAD_PAGE', s.badRequest);
        }
        case 'feed': {
          // Шаг 23: фильтры и страница — на сервере по всему окну ленты; неверный параметр — 400, а не молчаливое «все»
          const query = parseFeedQuery(url.searchParams);
          if (!query || (query.writeScopeId && !scopeById(await load([query.writeScopeId]), query.writeScopeId))) return fail(400, 'BAD_FEED_QUERY', s.badRequest);
          const now = live.clock.iso();
          /**
           * Р-154: страницу, итог и счётчики групп отдаёт база. Итог берётся из ПЕРВОГО запроса, и по нему подтягивается
           * смещение за концом: второй запрос идёт без подсчёта (`counts: false`) — иначе полный агрегат считался бы дважды
           * на каждый показ экрана (ревью шага 35, находка 8).
           */
          const first = await live.store.feedPage(live.tenantId, now as never, feedPageQuery(query));
          const pageQuery = feedPageQuery(query, first.total);
          const page = pageQuery.offset === feedPageQuery(query).offset
            ? first
            : { ...await live.store.feedPage(live.tenantId, now as never, { ...pageQuery, counts: false }), counts: first.counts, total: first.total };
          const f = await facts({ first: OFFER_CHOICES });
          return ok(priceFeed(await load([query.writeScopeId, ...page.items.map((i) => i.write.writeScopeId), ...(f?.firstIds ?? [])], { facts: f }), m, query, page, pageQuery));
        }
        case 'dangerous': {
          /**
           * Находка 14 ревью шага 29: строка запроса не превращается в число вручную — `Number` принимает `0x10`, `1e3` и
           * пробелы по краям. Период сверяется со списком допустимых КАК СТРОКА, и разбора числа здесь нет вовсе.
           */
          const raw = url.searchParams.get('days') ?? String(REPORT_PERIODS_DAYS[1]);
          const days = REPORT_PERIODS_DAYS.find((d) => String(d) === raw);
          if (days === undefined) return fail(400, 'BAD_PERIOD', s.badRequest);
          const now = live.clock.iso();
          const from = new Date(Date.parse(now) - days * 86_400_000).toISOString();
          const slice = await live.store.interventions(live.tenantId, from as never, now as never);
          return ok(dangerousReport(await load(sliceScopeIds(slice)), slice, days, m));
        }
        // Р-123: отчёт по объявленным скидкам — каждая проверяется заново по текущей истории цен (исправления свёртки, поздние цены)
        case 'compliance': {
          if (param === null) {
            const query = parseListQuery(url.searchParams);
            return query ? ok(await complianceScreen(query)) : fail(400, 'BAD_PAGE', s.badRequest);
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
            const jobs = await live.store.listBulkJobs(live.tenantId);
            return ok(bulkJobsView(jobs, m, await live.store.bulkJobArtifactSummaries(live.tenantId, jobs.map((j) => j.jobId))));
          }
          const job = await live.store.bulkJob(live.tenantId, param);
          if (!job) return fail(404, 'JOB_NOT_FOUND', m.ui.jobs.notFound);
          if (parts[5] === 'artifact') {
            const file = await live.store.bulkJobArtifact(live.tenantId, param);
            if (!file) return fail(404, 'NO_FILE', m.ui.jobs.noFile);
            return { status: 200, body: null, file: { contentType: file.contentType, content: file.content, fileName: file.fileName } };
          }
          if (parts.length > 5) return fail(404, 'NOT_FOUND', s.notFound);
          const file = job.status === 'SUCCEEDED' ? await live.store.bulkJobArtifact(live.tenantId, param) : null;
          return ok(bulkJobView(job, m, file ? { fileName: file.fileName, rows: file.rows, sha256: file.sha256 } : null));
        }
        default: return fail(404, 'NOT_FOUND', s.notFound);
      }
    }

    // Находка 11 ревью шага 24: маршруты ниже — только POST
    if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
    /**
     * Шаг 67 (OQ-248): мир маршрутов записи — то, что маршрут на деле читает. Остановка и снятия (план, остановка, возобновление, снятие
     * системной остановки и недоверия) — остановки тенанта и влияние по аккаунту и витрине. Маршруты, которым нужен только тенант
     * (режим записи, остатки, путь и сужение онбординга, отмена задания, применение плана границ и импорта), — без каталога (ревью шага 67,
     * находка 4: решение по возврату или включение одного предложения на 50 000 начинались с 5–8 с сборки каталога). Одно предложение —
     * его единица: включение, проверка и объявление скидки, выгрузки (и число предложений каталога фактом). Каталог целиком строят только
     * массовые операции, которым он нужен по смыслу («весь каталог», стратегии, план границ, план импорта, включение набора) — остаток OQ-248
     */
    const stopRoute = (screen === 'stop' && (param === 'plan' || param === null))
      || ((screen === 'stops' && parts[5] === 'resume') || ((screen === 'halts' || screen === 'distrusts') && parts[5] === 'release')) && param !== null;
    const tenantOnlyRoute = (screen === 'shadow' && param === 'mode') || (screen === 'stock' && param !== null)
      || (screen === 'onboarding' && (param === 'path' || param === 'narrow')) || (screen === 'jobs' && param !== null && parts[5] === 'cancel')
      || (screen === 'bounds' && param === 'apply') || (screen === 'cost-import' && param === 'apply');
    const oneUnit = screen === 'scopes' && param !== null && parts[5] === 'enable' ? [param]
      : screen === 'compliance' && (param === 'check' || param === 'announce' || param === 'evidence') ? [body.writeScopeId]
        : screen === 'feed' && param === 'export' ? [((body.query ?? {}) as Record<string, unknown>).writeScopeId] : null;
    const world = stopRoute ? await load([], { facts: await facts({ stopImpact: true }) })
      : tenantOnlyRoute ? await load([])
        : oneUnit ? await load(oneUnit, { facts: screen === 'compliance' && param === 'evidence' ? await facts({}) : null })
          : await load(null);
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
      /**
       * Язык — тот, на котором говорит мир задания [Р-72]: тексты его итога пишет процесс, у которого запроса уже нет. Ревью шага 69,
       * находка 8: у мира тенанта это язык тенанта (K1), и пояс тоже его (K4) — итог задания и файлы не должны говорить языком куки и UTC
       */
      const created = await live.store.createBulkJob(world.tenantId, {
        kind, params: { ...params, locale: m.locale, ...(display ? { timeZone: display.timeZone } : {}) }, ...(totalItems === null ? {} : { totalItems }),
      },
        { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (created.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', kind === 'COST_IMPORT' ? m.ui.costImport.mfa : s.mfaRequiredBounds);
      if (created.status === 'QUEUE_FULL') return fail(409, 'QUEUE_FULL', m.ui.jobs.queueFull);
      if (created.status !== 'CREATED') return fail(403, 'FORBIDDEN', s.forbidden);
      const job = await live.store.bulkJob(world.tenantId, created.jobId);
      return ok({ jobId: created.jobId, message, ...(job ? { job: bulkJobView(job, m) } : {}) });
    };


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
        ws ? 1 : catalogTotal(world), m.ui.jobs.createdEvidence);
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
        /**
         * Шаг 68 (K2): база называет «витрина / СВОЙСТВО (вопрос)»; продавцу — витрина словами, что не подтверждено и кто подтверждает
         * (способ закрытия из ревизии витрин тенанта), без идентификатора витрины и кода нашего вопроса
         */
        const properties = (await live.shadow!.shadowPage(live.tenantId, live.clock.iso(), { offset: 0, limit: 1 })).properties;
        const channel = live.accounts.find((a) => a.channelAccountId === body.channelAccountId)?.channel ?? '';
        return fail(409, 'PROPERTY_UNKNOWN', liveRefusalText(channel, outcome.detail, properties, m));
      }
      // Р-172: витрины аккаунта не видны вовсе — это другой отказ, и подставлять в него имя свойства нечего
      if (outcome.status === 'PROPERTY_INVISIBLE') return fail(409, 'PROPERTY_UNKNOWN', e.marketplacesInvisible(outcome.detail));
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
      /**
       * Шаг 59 [Р-199]: решение человека о возврате внутреннего пула. Автоматического возврата в пул нет: «принять на склад» —
       * движение RETURN с автором (права, человека и аудит проверяет база), «не принимать» — только решение. После принятия
       * товар пересчитывается и уходит в каналы тем же конвейером, что после Inbound API
       */
      if (param === 'returns') {
        if (!live.stock.decideReturn) return fail(404, 'NOT_FOUND', s.notFound);
        if (typeof body.orderReturnId !== 'string' || !UUID_RE.test(body.orderReturnId) || typeof body.accept !== 'boolean'
          || (body.note !== undefined && body.note !== null && typeof body.note !== 'string')) return fail(400, 'BAD_RETURN', s.badRequest);
        const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : null;
        const decided = await live.stock.decideReturn(world.tenantId, body.orderReturnId, { accept: body.accept, note }, actor);
        if (decided.status === 'NOT_FOUND') return fail(404, 'RETURN_NOT_FOUND', m.ui.stock.returns.notFound);
        if (decided.status === 'NOT_PENDING') return fail(409, 'RETURN_NOT_PENDING', m.ui.stock.returns.notPending);
        if (decided.status !== 'DECIDED') return fail(403, 'FORBIDDEN', m.ui.stock.noRight);
        let writes = 0;
        let recalculationPending = false;
        if (decided.accepted && live.stockPipeline) {
          try {
            writes = (await live.stockPipeline.propagate(world.tenantId, [decided.productId], { lockTimeoutMs: INBOUND_RECALC_WAIT_MS })).writes;
          } catch (error) {
            // Решение уже записано; пересчёт занят очередью тенанта — количество уйдёт со следующим пересчётом, а не отказом человеку
            if ((error as { code?: string }).code !== '55P03') throw error;
            recalculationPending = true;
          }
        }
        return ok({ status: 'DECIDED', accepted: decided.accepted, productId: decided.productId, writes, recalculationPending, message: m.ui.stock.returns.decided(decided.accepted) });
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
        /**
         * Шаг 60 [Р-202]: запись количества выключена, пока владелец не подтвердил на экране подключений, что количество в
         * этом канале не ведут другие инструменты. Проверяется ДО создания задания — иначе продавец увидел бы провал задания
         * вместо объяснения; само задание и база откажут так же (NOT_CONFIRMED, страж write_scope)
         */
        const writes = live.stock.quantityWritesState ? await live.stock.quantityWritesState(world.tenantId, account.channelAccountId) : null;
        if (writes && !writes.confirmed) {
          return fail(409, 'QUANTITY_WRITES_NOT_CONFIRMED', m.ui.stock.enable.notConfirmed(writes.otherTools === 'STOCK' || writes.otherTools === 'STOCK_AND_PRICES'));
        }
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
      return ok({ message: m.ui.compliance.announced, compliance: await complianceScreen() });
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
      return ok({ message: s.stopped(plan.impact.text), stop: await stopScreen() });
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
      return ok({ message: s.resumed, stop: await stopScreen() });
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
      return result.released ? ok({ message: s.released, stop: await stopScreen() }) : fail(404, 'NOT_ACTIVE', s.notActive);
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
        return result.released ? ok({ message: s.distrustReleased, stop: await stopScreen() }) : fail(404, 'NOT_ACTIVE', s.notActive);
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
      return ok({ message: m.ui.strategies.unassigned, strategies: await strategiesScreen(true) } satisfies StrategySaveResponse);
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

/**
 * Шаг 52 (OWASP A05, самопроверка — docs/evidence/step52-owasp.md): заголовки безопасности каждого ответа консоли, страницы и API.
 * Консоль не встраивается в чужие страницы (frame-ancestors, X-Frame-Options), тип содержимого не угадывается, адрес страницы не уходит
 * третьим сторонам в Referer (ссылка приглашения несёт токен во фрагменте — фрагмент браузер и так не шлёт). Полная политика
 * источников скриптов и соединений — отдельной строкой плана: ей нужен адрес поставщика identity из конфигурации
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Шаг 53 (OWASP A05): полная политика содержимого консоли. Страница — только свои скрипты, стили и картинки, без встроенного кода;
 * соединения — свой адрес и поставщик входа (страница читает его настройки и меняет код на токен, PKCE). Конечная точка токена должна
 * жить на адресе поставщика — у ZITADEL так и есть; иначе её адрес добавляется сюда
 */
export function consoleContentSecurityPolicy(identityOrigins: readonly string[]): string {
  const origins = [...new Set(identityOrigins.flatMap((u) => { try { return [new URL(u).origin]; } catch { return []; } }))];
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    `connect-src ${["'self'", ...origins].join(' ')}`,
    "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'",
  ].join('; ');
}

/**
 * Шаг 66 (OQ-248): предел ответа экрана. Экран отдаёт страницу, а не каталог: самый большой ответ экрана на 10 000 предложений —
 * 98 КБ (шаг 57), на 50 000 — страница товаров 50 КБ. Ответ больше предела — признак экрана, забывшего страницу: он не уходит
 * вовсе (500 со своим кодом), а журнал называет маршрут и размер. Файлы выгрузок идут своим путём [Р-145] и под предел не попадают
 */
export const SCREEN_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/** Тело JSON-ответа экрана с пределом: больше предела — 500 RESPONSE_TOO_LARGE и строка журнала с маршрутом и размером, без содержимого */
export function screenBody(r: Pick<ApiResponse, 'status' | 'body'>, route = ''): { status: number; body: string } {
  const body = JSON.stringify(r.body);
  const bytes = Buffer.byteLength(body);
  if (bytes <= SCREEN_RESPONSE_MAX_BYTES) return { status: r.status, body };
  console.log(JSON.stringify({ level: 'ERROR', code: 'SCREEN_RESPONSE_TOO_LARGE', route, bytes, limit: SCREEN_RESPONSE_MAX_BYTES }));
  return { status: 500, body: JSON.stringify({ error: { code: 'RESPONSE_TOO_LARGE', message: 'response exceeds the screen limit' } }) };
}

function send(res: ServerResponse, r: ApiResponse, route = '', method = 'GET'): void {
  if (r.file) {
    res.writeHead(r.status, {
      'content-type': `${r.file.contentType}; charset=utf-8`, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${r.file.fileName.replace(/[^\w.\-]/g, '_')}"`,
    });
    res.end(r.file.content);
    return;
  }
  /**
   * Предел — у ЭКРАНОВ (чтение мира). Ответ записи или Inbound API приходит после фиксации: подменить его отказом значило бы сказать
   * «не применено» о применённом (ревью шага 66, находка 7)
   */
  const screen = method === 'GET' && route.startsWith('/api/worlds/') ? screenBody(r, route) : { status: r.status, body: JSON.stringify(r.body) };
  if (screen.status !== r.status) {
    res.writeHead(screen.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(screen.body);
    return;
  }
  const body = screen.body;
  res.writeHead(r.status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(r.setCookies ? { 'set-cookie': r.setCookies } : {}),
    ...(r.retryAfterSeconds !== undefined ? { 'retry-after': String(r.retryAfterSeconds) } : {}),
  });
  res.end(body);
}

/**
 * HTTP-слой стенда: предел тела запроса, разбор JSON и перехват ошибок. Р-136 (шаг 29, ревью, находка 1): он вынесен из точки
 * входа именно затем, чтобы живой прогон шёл ЧЕРЕЗ НЕГО. Прогон, зовущий `createStandApi` напрямую, не видит ни предела тела, ни
 * битого JSON — а это ровно тот класс дефекта, ради которого принято Р-136 (на шаге 28 импорт не проходил из-за предела в 64 КиБ).
 */
/**
 * Шаг 53 (OWASP A04, самопроверка шага 52): ограничение частоты запросов консоли — страница, API и Inbound API идут через этот слой.
 * Скользящее окно в минуту на АДРЕС клиента. За прокси адрес — первый в `X-Forwarded-For`, только если это разрешено (`trustProxy`):
 * иначе все анонимы делили бы адрес прокси, а доверять заголовку без прокси — значит дать анониму выбирать себе адрес.
 *
 * Шаг 54 (ревью шага 53, находки 1–2): ключ — только адрес, а не отпечаток заголовка Authorization. Заголовок до проверки входа
 * ничего не доказывает: выдуманный токен на каждый запрос давал новый счётчик, и предел не действовал вовсе. Запрос с заголовком
 * получает БОЛЬШИЙ предел того же счётчика адреса — выдуманные токены одного адреса делят один бюджет. Ключей не больше `maxClients`
 * (вытесняется давно молчавший), просроченные убирает таймер, а не запрос — у атакующего нет способа сделать запрос дорогим.
 * Процессный счётчик: у нескольких реплик свой у каждой — поэтому реплика одна, и это держит страж конфигурации (шаг 54, п. 3)
 */
export interface RateLimitConfig {
  /** Запросов в минуту на адрес, если запрос предъявляет вход (токен или ключ Inbound API) */
  authorizedPerMinute: number;
  /** Запросов в минуту на адрес без входа (страница, гость демо до входа) */
  anonymousPerMinute: number;
  trustProxy: boolean;
  now?: () => number;
  /** Предел числа адресов в памяти; по умолчанию 20 000 */
  maxClients?: number;
}

/**
 * Шаг 55 (ревью шага 54, находка 5): ключ адреса. IPv6 — префикс /64: у любого VPS их тысячи, и адрес на запрос обходил бы предел и
 * вытеснял счётчики законных клиентов; IPv4 и IPv4 в IPv6 (::ffff:a.b.c.d) — адрес целиком
 */
export function clientKeyOf(address: string): string {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (!a.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return a.replace(/^::ffff:/, '');
  const [head, tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function createRateLimiter(config: RateLimitConfig) {
  const now = config.now ?? systemClock.nowMs;
  const maxClients = config.maxClients ?? 20_000;
  // Порядок вставки Map — порядок последнего обращения: адрес переставляется в конец при каждом запросе
  const hits = new Map<string, number[]>();
  const sweep = () => { const edge = now() - 60_000; for (const [k, v] of hits) if (v[v.length - 1]! <= edge) hits.delete(k); };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const check = (headers: Record<string, string | string[] | undefined>, remoteAddress: string | undefined): { ok: true } | { ok: false; retryAfterSeconds: number } => {
    const auth = typeof headers.authorization === 'string' && headers.authorization.length > 0;
    const forwarded = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'].split(',')[0]!.trim() : '';
    const address = clientKeyOf(config.trustProxy && forwarded ? forwarded : (remoteAddress ?? 'unknown'));
    /**
     * Шаг 55 (ревью шага 54, находка 4): у адреса ДВА счётчика — без входа и с заголовком входа. Общий счётчик ломал офис за одним NAT:
     * вкладка экрана заданий выбирала анонимный предел адреса, и перезагрузка страницы любым сотрудником получала 429. Выдуманные токены
     * одного адреса по-прежнему делят один бюджет «с заголовком» (находка 1 ревью шага 53)
     */
    const key = `${auth ? 'auth' : 'anon'}|${address}`;
    const limit = auth ? config.authorizedPerMinute : config.anonymousPerMinute;
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => x > t - 60_000);
    hits.delete(key);
    if (list.length >= limit) {
      hits.set(key, list);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((list[list.length - limit]! + 60_000 - t) / 1000)) };
    }
    list.push(t);
    hits.set(key, list);
    // Жёсткий потолок памяти: вытесняется адрес, молчавший дольше всех (первый в порядке обращения)
    while (hits.size > maxClients) hits.delete(hits.keys().next().value!);
    return { ok: true };
  };
  return Object.assign(check, { size: () => hits.size, close: () => clearInterval(timer) });
}

export function createStandServer(
  handle: ReturnType<typeof createStandApi>, locale: Locale = 'de',
  /**
   * Р-159 (шаг 37): тот же HTTP-слой отдаёт и СОБРАННЫЙ интерфейс — разворачиваемая консоль не поднимает второго сервера
   * рядом. Адреса API и файлы страницы не пересекаются: всё, что начинается с `/api/` и `/inbound/`, идёт обработчику,
   * остальное — файлам сборки. Стенд разработчика запускается без этого параметра: интерфейс ему даёт vite.
   */
  serveStatic?: (pathname: string) => { status: number; contentType: string; body: Buffer; cacheControl: string } | null,
  options: { rateLimit?: RateLimitConfig; contentSecurityPolicy?: string } = {},
) {
  const fallback = messagesFor(locale).ui.server;
  const limited = options.rateLimit ? createRateLimiter(options.rateLimit) : null;
  const server = createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (options.contentSecurityPolicy) res.setHeader('content-security-policy', options.contentSecurityPolicy);
    // Шаг 55 (ревью шага 54, находка 4): предел — у API и Inbound API; страница и файлы сборки дешёвы (из памяти) и грузятся без входа
    // пачкой — считать их значило бы отдавать бюджет адреса перезагрузкам страницы
    const limitedPath = /^\/(api|inbound)\//.test(new URL(req.url ?? '/', 'http://console').pathname);
    if (limited && limitedPath) {
      const verdict = limited(req.headers, req.socket.remoteAddress);
      if (!verdict.ok) {
        res.setHeader('retry-after', String(verdict.retryAfterSeconds));
        req.resume();
        return send(res, { status: 429, body: { error: { code: 'RATE_LIMITED', message: fallback.rateLimited } } });
      }
    }
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
      send(res, await handle({ method: req.method ?? 'GET', url: req.url ?? '/', body, authorization: req.headers.authorization,
        idToken: typeof req.headers['x-repracer-id-token'] === 'string' ? req.headers['x-repracer-id-token'] : undefined, cookie: req.headers.cookie }),
        (req.url ?? '/').split('?')[0], req.method ?? 'GET');
    } catch (error) {
      // Задача D шага 34: тенант без единого канала — не поломка стенда, а честное состояние [Р-150]
      if ((error as { cause?: unknown }).cause === 'NO_CHANNEL') return send(res, { status: 409, body: { error: { code: 'NO_CHANNEL', message: fallback.noChannel } } });
      // Ни тело запроса, ни токен в журнал не пишутся — только метод, путь и сообщение ошибки
      console.error('stand request failed', req.method, new URL(req.url ?? '/', 'http://stand').pathname, error instanceof Error ? error.message : error);
      send(res, { status: 500, body: { error: { code: 'STAND_ERROR', message: fallback.standError } } });
    }
  });
  if (limited) server.on('close', () => limited.close());
  return server;
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
    let demoWorldId: string | null = null;
    if (process.env.REPRACER_DEMO === 'on') {
      const { startDemoWorld } = await import('./demo-world.ts');
      const started = await startDemoWorld({
        pools: {
          app: pool, admin: adminPool, provisioning: role('svc_provisioning', 1), dispatcher: role('svc_dispatcher', 2),
          scheduler: role('svc_scheduler', 3), exporter: role('svc_exporter', 2), stock: role('svc_stock', 2), bulkWorker: role('svc_bulk_worker', 2),
        },
        pgUrl: url, tag: 3400, memberUsers, memberEmails: STAND_EMAILS,
        joinMember: pgStandJoinMember(adminPool, directory),
        // Шаг 64: `REPRACER_DEMO_US=on` — профиль США в демо: аккаунты eBay US и Amazon US в тени (docs/demo-script.md)
        usAccounts: process.env.REPRACER_DEMO_US === 'on',
        // Шаг 68 (K7): `REPRACER_DEMO_PRESS_DAYS=7` — неделя тени США прожата при подъёме: недельный отчёт показуем сразу (0…7)
        usPressDays: process.env.REPRACER_DEMO_US === 'on' ? pressDaysOf(process.env.REPRACER_DEMO_PRESS_DAYS) : 0,
        // Шаг 69 (K1, K4): язык и пояс демо-тенанта (команда подготовки демо для клиента из США ставит en и его пояс)
        ...(process.env.REPRACER_DEMO_LOCALE === 'en' || process.env.REPRACER_DEMO_LOCALE === 'de' ? { locale: process.env.REPRACER_DEMO_LOCALE } : {}),
        ...(process.env.REPRACER_DEMO_TIME_ZONE ? { timeZone: process.env.REPRACER_DEMO_TIME_ZONE } : {}),
        // Шаг 64: `REPRACER_DEMO_SHADOW=on` — демо в тени [Р-169]: сценарий показа «система физически не может трогать цены»
        ...(process.env.REPRACER_DEMO_SHADOW === 'on' ? { writeMode: 'SHADOW' as const } : {}),
      });
      worlds.push(started.world);
      demoWorldId = started.world.id;
    }
    // Шаг 64: у демо — подключения только для чтения (аккаунты и вопрос о других инструментах [Р-202]), подключать нечем
    const { readOnlyConnections } = await import('./connect.ts');
    const { PgChannelConnectStore } = await import('@repracer/pricing-store-pg');
    const demoConnect = readOnlyConnections(new PgChannelConnectStore(adminPool));
    handle = createStandApi(worlds, { authenticator: createAuthenticator({ ...verify, directory }), ...(simulator ? { simulator } : {}) },
      { connect: (worldId) => (worldId === demoWorldId ? demoConnect : null) });
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

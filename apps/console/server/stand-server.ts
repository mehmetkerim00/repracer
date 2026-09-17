import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  boundsDiffView, boundsView, can, complianceView, currentStrategies, discountCheckView, dangerousReport, decisionList, decisionTrace, describe, expandBoundsEdit, LOCALES, messagesFor, parseBoundsEditRequest, parseFeedQuery, priceEvidenceCsv, scopeById, unitOf,
  parseStrategyDraft, planStop, previewToken, priceFeed, productList, rejectedView, REPORT_PERIODS_DAYS, stopView, strategiesView, strategyPreviewView,
  type Locale, type Messages, type StandWorld, type StopTarget, type StrategyDraft, type Viewer,
} from '@repracer/console-model';
import type { DiscountAnnouncementInput, StrategyPreview } from '@repracer/pricing-pipeline';
import {
  buildStandWorlds, memoryStandDirectory, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, type LiveWorld,
} from '@repracer/contract-tests/stand';
import { createAuthenticator, hasSecondFactor, remoteJwks, staticJwks, type Authenticator, type Principal } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import {
  NOTE_MAX, NOTE_MIN, type BoundsApplyResult, type BoundsIndexItem, type BoundsIndexView, type EnableResult, type NoteRequest, type SessionView, type StopRequest, type StrategySaveResponse, type WorldSummary,
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
}

export interface StandIdentity {
  authenticator: Authenticator;
  /** Имитатор поставщика — только стенд: выдаёт токен синтетического пользователя по роли */
  simulator?: { token(account: (typeof STAND_ACCOUNTS)[number]): string; expiresInSeconds: number };
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

const MAX_PREVIEW_SCOPES = 200;

/** Превью стратегии на выбранных единицах записи: каждая — стратегия и Gate на последнем принятом снимке, без фиксации */
async function previewsFor(live: LiveWorld, world: StandWorld, draft: StrategyDraft, writeScopeIds: readonly string[]): Promise<StrategyPreview[] | null> {
  const out: StrategyPreview[] = [];
  for (const id of writeScopeIds) {
    const scope = world.state.scopes.find((x) => x.writeScopeId === id);
    if (!scope) return null;
    const preview = await live.pipeline.previewStrategy(live.callContext(scope.channelAccountId), id, { strategyId: 'draft', version: 1, ...draft });
    if (!preview) return null;
    out.push(preview);
  }
  return out;
}

function scopeIds(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_PREVIEW_SCOPES && raw.every((x) => typeof x === 'string') ? [...new Set(raw as string[])] : null;
}

function draftProblemsText(problems: ReadonlyArray<{ field: string; code: string }>, m: Messages): string {
  const t = m.ui.strategies;
  return problems.map((p) => `${(t.fields as Record<string, string>)[p.field] ?? (p.field === 'name' ? t.name : p.field === 'type' ? t.type : p.field)}: ${t.problems[p.code as keyof typeof t.problems]}`).join('; ');
}

/** Настоящая календарная дата YYYY-MM-DD: 2026-13-01 и 2026-02-30 — нет (находка 11 ревью шага 24) */
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** Р-123: выгрузка доказательной истории — не больше 18 месяцев за запрос */
export const EVIDENCE_MAX_DAYS = 550;

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
    });

    if (parts[0] !== 'api') return fail(404, 'NOT_FOUND', s.notFound);

    if (parts[1] === 'session') {
      if (req.method === 'GET' && parts.length === 2) return ok(sessionView(locale));
      if (req.method === 'POST' && parts[2] === 'locale') {
        if (!isLocale(body.locale)) return fail(400, 'BAD_LOCALE', s.notFound);
        return ok(sessionView(body.locale), [localeCookie(body.locale)]);
      }
      return fail(404, 'NOT_FOUND', s.notFound);
    }

    // Имитатор поставщика стенда: токен синтетического пользователя; в работе этого адреса нет
    if (parts[1] === 'stand-issuer' && parts[2] === 'token') {
      if (!identity.simulator) return fail(404, 'NOT_FOUND', s.notFound);
      if (req.method !== 'POST') return fail(405, 'METHOD', s.method);
      const account = STAND_ACCOUNTS.find((a) => a.role === body.role);
      if (!account) return fail(400, 'UNKNOWN_ACCOUNT', s.unknownAccount);
      return ok({ accessToken: identity.simulator.token(account), tokenType: 'Bearer', expiresIn: identity.simulator.expiresInSeconds });
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
      return ok(await Promise.all(visible.map(async ({ live, viewer }): Promise<WorldSummary> => {
        const w = await live.view(viewer);
        return {
          id: w.id, title: w.title, description: w.description, failures: live.failures, scopes: w.state.scopes.length, decisions: w.state.decisions.length,
          rejected: rejectedView(w, m).items.length, activeStops: w.state.stops.filter((x) => x.releasedAt === null).length,
          activeHalts: w.state.halts.filter((h) => h.releasedAt === null).length, role: m.values[viewer.role],
        };
      })));
    }

    const live = worlds.find((w) => w.id === parts[2]);
    const viewer = live ? viewerIn(live) : null;
    if (!live || !viewer) return fail(404, 'WORLD_NOT_FOUND', s.notFound);
    const world = await live.view(viewer);
    const screen = parts[3];
    const param = parts[4] ?? null;
    const ctx = (channelAccountId?: string | null) => live.callContext(channelAccountId ?? live.accounts[0]!.channelAccountId);

    if (req.method === 'GET') {
      switch (screen) {
        case 'products': return ok(productList(world, m));
        case 'decisions': {
          if (param === null) return ok(decisionList(world, m));
          const trace = decisionTrace(world, param, m);
          return trace ? ok(trace) : fail(404, 'DECISION_NOT_FOUND', s.notFound);
        }
        case 'rejected': return ok(rejectedView(world, m));
        case 'bounds': {
          if (param === null) {
            return ok({
              items: productList(world, m).rows.map((r): BoundsIndexItem => ({ writeScopeId: r.unit.writeScopeId, label: r.unit.label, minPrice: r.minPrice, maxPrice: r.maxPrice })),
              canEdit: can(viewer.role, 'MANAGE_PRICING'),
            } satisfies BoundsIndexView);
          }
          const b = boundsView(world, param, m);
          return b ? ok(b) : fail(404, 'SCOPE_NOT_FOUND', s.notFound);
        }
        case 'stop': return ok(stopView(world, m));
        // Шаг 21: стратегии, лента цен, отчёт об опасных изменениях [Р-73]
        case 'strategies': return ok(strategiesView(world, m, can(viewer.role, 'MANAGE_PRICING')));
        case 'feed': {
          // Шаг 23: фильтры и страница — на сервере по всему окну ленты; неверный параметр — 400, а не молчаливое «все»
          const query = parseFeedQuery(url.searchParams);
          if (!query || (query.writeScopeId && !scopeById(world, query.writeScopeId))) return fail(400, 'BAD_FEED_QUERY', s.badRequest);
          return ok(priceFeed(world, m, query));
        }
        case 'dangerous': {
          const days = Number(url.searchParams.get('days') ?? 7);
          if (!(REPORT_PERIODS_DAYS as readonly number[]).includes(days)) return fail(400, 'BAD_PERIOD', s.badRequest);
          return ok(dangerousReport(world, days, m));
        }
        // Р-123: отчёт по объявленным скидкам — каждая проверяется заново по текущей истории цен (исправления свёртки, поздние цены)
        case 'compliance': {
          if (param === null) {
            const announcements = await live.store.discountAnnouncements(world.tenantId);
            const rechecks = new Map(await Promise.all(announcements.map(async (a) => [a.announcementId, await live.store.omnibusCheck(world.tenantId, a.writeScopeId, a.startsAt)] as const)));
            return ok(complianceView(world, announcements, rechecks, m));
          }
          if (param === 'evidence') {
            const from = url.searchParams.get('from') ?? '';
            const to = url.searchParams.get('to') ?? '';
            const ws = url.searchParams.get('writeScopeId');
            if (!isDay(from) || !isDay(to) || from > to || (ws && !scopeById(world, ws))) return fail(400, 'BAD_EVIDENCE_QUERY', s.badRequest);
            if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > EVIDENCE_MAX_DAYS) return fail(400, 'EVIDENCE_TOO_LONG', s.evidenceTooLong(EVIDENCE_MAX_DAYS));
            const days = await live.store.priceEvidence(world.tenantId, { from, to, ...(ws ? { writeScopeIds: [ws] } : {}) });
            const csv = priceEvidenceCsv(world, days);
            return ok({ filename: `price-evidence_${from}_${to}.csv`, csv, sha256: createHash('sha256').update(csv).digest('hex'), days: days.length });
          }
          return fail(404, 'NOT_FOUND', s.notFound);
        }
        default: return fail(404, 'NOT_FOUND', s.notFound);
      }
    }

    // Находка 11 ревью шага 24: маршруты ниже — только POST
    if (req.method !== 'POST') return fail(405, 'METHOD', s.method);

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
      const announcements = await live.store.discountAnnouncements(world.tenantId);
      const rechecks = new Map(await Promise.all(announcements.map(async (a) => [a.announcementId, await live.store.omnibusCheck(world.tenantId, a.writeScopeId, a.startsAt)] as const)));
      return ok({ message: m.ui.compliance.announced, compliance: complianceView(await live.view(viewer), announcements, rechecks, m) });
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
      return ok({ message: s.stopped(plan.impact.text), stop: stopView(await live.view(viewer), m) });
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
      return ok({ message: s.resumed, stop: stopView(await live.view(viewer), m) });
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
      return result.released ? ok({ message: s.released, stop: stopView(await live.view(viewer), m) }) : fail(404, 'NOT_ACTIVE', s.notActive);
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
        return result.released ? ok({ message: s.distrustReleased, stop: stopView(await live.view(viewer), m) }) : fail(404, 'NOT_ACTIVE', s.notActive);
      } catch (error) {
        // Отказ хранилища или БД (роль, пользователь сессии, второй фактор): текст отказа наружу не отдаётся
        const code = (error as { code?: string }).code;
        if (code === '42501' || /may not|not the membership|permission/i.test(String((error as Error).message))) return fail(403, 'FORBIDDEN', s.forbidden);
        throw error;
      }
    }

    // Шаг 21: превью стратегии на реальных единицах записи — без фиксации; права на просмотр достаточно
    if (screen === 'strategies' && param === 'preview') {
      const parsed = parseStrategyDraft(body.draft);
      if (!parsed.ok) return fail(400, 'BAD_DRAFT', draftProblemsText(parsed.problems, m));
      const ids = scopeIds(body.writeScopeIds);
      const previews = ids ? await previewsFor(live, world, parsed.draft, ids) : null;
      return previews ? ok(strategyPreviewView(world, parsed.draft, previews, m)) : fail(400, 'BAD_SCOPES', s.badRequest);
    }

    // Сохранение — только того превью, что видел человек: сервер пересчитывает превью и сравнивает токен
    if (screen === 'strategies' && param === null) {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const parsed = parseStrategyDraft(body.draft);
      if (!parsed.ok) return fail(400, 'BAD_DRAFT', draftProblemsText(parsed.problems, m));
      const ids = scopeIds(body.writeScopeIds);
      const previews = ids ? await previewsFor(live, world, parsed.draft, ids) : null;
      if (!previews) return fail(400, 'BAD_SCOPES', s.badRequest);
      if (typeof body.previewToken !== 'string' || body.previewToken !== previewToken(parsed.draft, previews, world)) return fail(409, 'PREVIEW_CHANGED', s.previewChanged);
      // Находка 3 ревью шага 21 [Р-39]: стратегия, для которой канал не даёт нужных данных конкурентов, не назначается
      if (previews.some((p) => !p.availability.available)) return fail(400, 'STRATEGY_UNAVAILABLE', s.strategyUnavailable);
      const strategyId = typeof body.strategyId === 'string' ? body.strategyId : null;
      const result = await live.store.saveStrategy(world.tenantId, {
        strategyId, name: parsed.draft.name, params: parsed.draft.params, deadbandMinor: parsed.draft.deadbandMinor, assignTo: ids!, expected: currentStrategies(world, ids!),
      }, { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status === 'CONFLICT') return fail(409, 'PREVIEW_CHANGED', s.previewChanged);
      // Шаг 23: отказ базы по доступности стратегии [Р-39, OQ-166] и по ценообразованию канала у оффера [Р-120] — с понятным текстом
      if (result.status === 'INVALID' && result.cause === 'STRATEGY_UNAVAILABLE') return fail(400, 'STRATEGY_UNAVAILABLE', s.strategyUnavailable);
      if (result.status === 'INVALID' && result.cause === 'CHANNEL_PRICING_ACTIVE') {
        const scope = result.writeScopeId ? scopeById(world, result.writeScopeId) : undefined;
        return fail(400, 'CHANNEL_PRICING_ACTIVE', s.channelPricingActive(scope ? unitOf(world, scope, m).label : m.ui.common.noValue));
      }
      if (result.status !== 'SAVED') return fail(400, result.cause, s.badRequest);
      return ok({ message: m.ui.strategies.saved(result.strategy.version, result.assigned.length), strategies: strategiesView(await live.view(viewer), m, true) } satisfies StrategySaveResponse);
    }

    // OQ-169 (шаг 24): существующая версия — выбранным офферам без новой версии; то же превью и тот же токен, что при сохранении
    if (screen === 'strategies' && param === 'assign') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const item = strategiesView(world, m, true).strategies.find((x) => x.strategyId === body.strategyId && x.version === body.version);
      if (!item) return fail(404, 'STRATEGY_NOT_FOUND', s.notFound);
      if (!item.assignable) return fail(400, 'VERSION_NOT_ACTIVE', s.versionNotActive);
      const ids = scopeIds(body.writeScopeIds);
      const previews = ids ? await previewsFor(live, world, item.draft, ids) : null;
      if (!previews) return fail(400, 'BAD_SCOPES', s.badRequest);
      if (typeof body.previewToken !== 'string' || body.previewToken !== previewToken(item.draft, previews, world)) return fail(409, 'PREVIEW_CHANGED', s.previewChanged);
      if (previews.some((p) => !p.availability.available)) return fail(400, 'STRATEGY_UNAVAILABLE', s.strategyUnavailable);
      const result = await live.store.assignStrategyVersion(world.tenantId, { strategyId: item.strategyId, version: item.version, assignTo: ids!, expected: currentStrategies(world, ids!) },
        { membershipId: viewer.membershipId, userId: principal.userId, mfa: hasSecondFactor(principal.amr) });
      if (result.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (result.status === 'CONFLICT') return fail(409, 'PREVIEW_CHANGED', s.previewChanged);
      if (result.status === 'INVALID' && result.cause === 'STRATEGY_UNAVAILABLE') return fail(400, 'STRATEGY_UNAVAILABLE', s.strategyUnavailable);
      if (result.status === 'INVALID' && result.cause === 'VERSION_NOT_ACTIVE') return fail(400, 'VERSION_NOT_ACTIVE', s.versionNotActive);
      if (result.status === 'INVALID' && result.cause === 'CHANNEL_PRICING_ACTIVE') {
        const scope = result.writeScopeId ? scopeById(world, result.writeScopeId) : undefined;
        return fail(400, 'CHANNEL_PRICING_ACTIVE', s.channelPricingActive(scope ? unitOf(world, scope, m).label : m.ui.common.noValue));
      }
      if (result.status !== 'SAVED') return fail(400, result.cause, s.badRequest);
      return ok({ message: m.ui.strategies.assigned(result.strategy.version, result.assigned.length), strategies: strategiesView(await live.view(viewer), m, true) } satisfies StrategySaveResponse);
    }

    // OQ-169: снять стратегию с офферов — только при выключенном репрайсинге
    if (screen === 'strategies' && param === 'unassign') {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      const ids = scopeIds(body.writeScopeIds);
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

    // Шаг 21: массовая правка границ — экран различий (база вычисляет итог в откатываемой транзакции), затем применение с токеном
    if (screen === 'bounds' && (param === 'plan' || param === 'apply')) {
      if (!can(viewer.role, 'MANAGE_PRICING')) return fail(403, 'FORBIDDEN', s.forbidden);
      const request = parseBoundsEditRequest(body.request);
      if (!request) return fail(400, 'BAD_REQUEST', s.badRequest);
      const { edits, problems } = expandBoundsEdit(world, request);
      if (problems.length > 0) {
        const texts = m.ui.boundsEdit.problems;
        return fail(400, 'BAD_EDIT', problems.map((p) => `${texts[p.code]}${p.writeScopeId ? ` (${p.writeScopeId}${p.bound ? `, ${p.bound}_price` : ''})` : ''}`).join('; '));
      }
      const mfa = hasSecondFactor(principal.amr);
      const actor = { membershipId: viewer.membershipId, userId: principal.userId, mfa };
      // Экран различий второго фактора не требует — он нужен для применения [Р-88]
      const preview = await live.store.editBounds(world.tenantId, edits, actor, 'PREVIEW');
      if (preview.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (preview.status === 'CONFLICT') return fail(409, 'BOUNDS_CONFLICT', conflictText(world, preview, m));
      if (preview.status !== 'PREVIEWED') return fail(400, preview.status === 'INVALID' ? preview.cause : preview.status, s.badRequest);
      const diff = boundsDiffView(world, edits, preview.rows, m);
      if (param === 'plan') return ok(diff);
      if (body.confirmed !== true) return fail(400, 'NOT_CONFIRMED', s.notConfirmed);
      if (typeof body.planToken !== 'string' || body.planToken !== diff.planToken) return fail(409, 'PLAN_CHANGED', s.planChanged);
      const applied = await live.store.editBounds(world.tenantId, edits, actor, 'APPLY');
      if (applied.status === 'MFA_REQUIRED') return fail(403, 'MFA_REQUIRED', s.mfaRequiredBounds);
      if (applied.status === 'FORBIDDEN') return fail(403, 'FORBIDDEN', s.forbidden);
      if (applied.status === 'CONFLICT') return fail(409, 'BOUNDS_CONFLICT', conflictText(world, applied, m));
      if (applied.status !== 'APPLIED') return fail(400, applied.status === 'INVALID' ? applied.cause : applied.status, s.badRequest);
      return ok({ message: m.ui.boundsEdit.applied(applied.rows.length), rows: applied.rows.length } satisfies BoundsApplyResult);
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

function send(res: ServerResponse, r: ApiResponse): void {
  res.writeHead(r.status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(r.setCookies ? { 'set-cookie': r.setCookies } : {}),
  });
  res.end(JSON.stringify(r.body));
}

async function main(): Promise<void> {
  const port = Number(process.env.STAND_PORT ?? 4318);
  let handle: ReturnType<typeof createStandApi>;
  // Режим входа выбирает тот, кто запускает, явно (находка 6): стенд не включает имитатор молча при неполной конфигурации
  const mode = resolveStandIdentityMode(process.env);
  const external = mode.kind === 'oidc' ? { issuer: mode.issuer, audience: mode.audience, jwks: remoteJwks(mode.jwksUrl) } : null;
  const issuer = external ? null : createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const simulator = issuer ? { token: (a: (typeof STAND_ACCOUNTS)[number]) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 } : undefined;
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
    handle = createStandApi(worlds, { authenticator: createAuthenticator({ ...verify, directory }), ...(simulator ? { simulator } : {}) });
  } else {
    const worlds = await buildStandWorlds();
    handle = createStandApi(worlds, { authenticator: createAuthenticator({ ...verify, directory: memoryStandDirectory(worlds) }), ...(simulator ? { simulator } : {}) });
  }
  const fallback = messagesFor('de').ui.server;
  const server = createServer(async (req, res) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return send(res, { status: 413, body: { error: { code: 'TOO_LARGE', message: fallback.tooLarge } } });
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
      // Ни тело запроса, ни токен в журнал не пишутся — только метод, путь и сообщение ошибки
      console.error('stand request failed', req.method, new URL(req.url ?? '/', 'http://stand').pathname, error instanceof Error ? error.message : error);
      send(res, { status: 500, body: { error: { code: 'STAND_ERROR', message: fallback.standError } } });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`stand on http://127.0.0.1:${port}/api/session (${process.env.REPRACER_PG_URL ? 'PostgreSQL' : 'memory'})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

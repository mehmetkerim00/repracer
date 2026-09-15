import { can, type StopScope } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import { channelOf, gap, type ConsoleHalt, type ConsoleScope, type ConsoleStop, type Gap, type StandWorld } from './world.ts';

/**
 * Экран E: два разных действия [Р-69].
 *  - Остановка человеком (kill switch) — все изменения цен без исключений; тенант — самостоятельный объект [Р-70].
 *  - Системная остановка витрины по испорченным данным — только цены из данных конкурентов [Р-51]; снимается выборкой
 *    или вручную [Р-52].
 * Права — по роли зрителя: остановить — владелец и оператор; возобновить тенант — владелец.
 */

export type StopTarget =
  | { kind: 'TENANT' }
  | { kind: 'CHANNEL_ACCOUNT'; channelAccountId: string }
  | { kind: 'STOREFRONT'; channelAccountId: string; marketplace: string };

export interface StopImpact {
  /** Предложений с автоматической ценой, все цены которых остановятся */
  prices: number;
  /** Ждущих записей, которые не будут отправлены */
  pendingWritesDropped: number;
  text: string;
}

export interface StopCard {
  stopId: string;
  scope: StopScope;
  scopeLabel: string;
  since: string;
  by: string;
  note: string;
  released: string | null;
  canResume: boolean;
}

export interface HaltCard {
  haltId: string;
  scopeLabel: string;
  reason: string;
  since: string;
  review: string;
  released: string | null;
  canRelease: boolean;
}

export interface TargetCard {
  target: StopTarget;
  label: string;
  /** Действующая остановка, которая покрывает цель (может быть шире — остановка тенанта) */
  coveredBy: StopCard | null;
  impact: StopImpact;
  canStop: boolean;
}

/** Запись журнала аудита остановок [Р-76]: кто (роль в момент действия), что, где, с какой заметкой */
export interface AuditCard {
  at: string;
  action: string;
  actor: string;
  scope: string;
  note: string | null;
}

export interface StopView {
  worldId: string;
  permissions: { canStop: boolean; canResumeTenant: boolean; canResumeChannel: boolean; canReleaseHalt: boolean };
  tenant: TargetCard;
  accounts: TargetCard[];
  storefronts: TargetCard[];
  stops: { active: StopCard[]; history: StopCard[] };
  halts: { active: HaltCard[]; history: HaltCard[] };
  audit: AuditCard[];
  notStopped: string[];
  gaps: Gap[];
}

export interface StopPlan {
  target: StopTarget;
  alreadyActive: boolean;
  impact: StopImpact;
  confirmTitle: string;
  confirmText: string;
}

function scopesOf(world: StandWorld, target: StopTarget): ConsoleScope[] {
  return world.state.scopes.filter((s) => target.kind === 'TENANT'
    || (s.channelAccountId === target.channelAccountId && (target.kind === 'CHANNEL_ACCOUNT' || s.marketplace === target.marketplace)));
}

function impactOf(world: StandWorld, scopes: readonly ConsoleScope[], m: Messages): StopImpact {
  const ids = new Set(scopes.filter((s) => s.pricingMode === 'ENGINE').map((s) => s.writeScopeId));
  const pending = world.state.writes.filter((w) => ids.has(w.writeScopeId) && (w.status === 'PENDING' || (w.status === 'FAILED' && w.nextAttemptAt))).length;
  return { prices: ids.size, pendingWritesDropped: pending, text: m.ui.stop.impact(ids.size, pending) };
}

function sameTarget(stop: ConsoleStop, target: StopTarget): boolean {
  if (stop.scope !== target.kind) return false;
  if (target.kind === 'TENANT') return true;
  return stop.channelAccountId === target.channelAccountId && (target.kind === 'CHANNEL_ACCOUNT' || stop.marketplace === target.marketplace);
}

function covers(stop: ConsoleStop, target: StopTarget): boolean {
  if (stop.releasedAt !== null) return false;
  if (stop.scope === 'TENANT') return true;
  if (target.kind === 'TENANT') return false;
  if (stop.channelAccountId !== target.channelAccountId) return false;
  return stop.scope === 'CHANNEL_ACCOUNT' || (target.kind === 'STOREFRONT' && stop.marketplace === target.marketplace);
}

function memberLabel(world: StandWorld, membershipId: string | null, m: Messages): string {
  if (!membershipId) return m.ui.stop.unknownMember;
  const member = world.state.members.find((x) => x.membershipId === membershipId);
  const role = member ? m.values[member.role] : m.ui.stop.unknownMember;
  return membershipId === world.viewer.membershipId ? m.ui.stop.you(role) : role;
}

function targetLabel(world: StandWorld, target: StopTarget | ConsoleStop, m: Messages): string {
  const kind = 'kind' in target ? target.kind : target.scope;
  if (kind === 'TENANT') return m.ui.stop.wholeTenant;
  const accountId = 'kind' in target ? (target as { channelAccountId: string }).channelAccountId : (target as ConsoleStop).channelAccountId!;
  const channel = m.values[channelOf(world, accountId) as keyof typeof m.values] ?? channelOf(world, accountId);
  if (kind === 'CHANNEL_ACCOUNT') return m.ui.stop.account(channel);
  const marketplace = 'kind' in target ? (target as { marketplace: string }).marketplace : (target as ConsoleStop).marketplace!;
  return m.ui.stop.storefront(channel, marketplace);
}

function stopCard(world: StandWorld, s: ConsoleStop, m: Messages): StopCard {
  const role = world.viewer.role;
  return {
    stopId: s.stopId, scope: s.scope, scopeLabel: targetLabel(world, s, m), since: m.when(s.stoppedAt), by: memberLabel(world, s.stoppedByMembershipId, m), note: s.note,
    released: s.releasedAt ? m.ui.stop.releasedBy(m.when(s.releasedAt), memberLabel(world, s.releasedByMembershipId, m), s.releaseNote ?? '') : null,
    canResume: s.releasedAt === null && can(role, s.scope === 'TENANT' ? 'RESUME_TENANT_STOP' : 'RESUME_CHANNEL_STOP'),
  };
}

function haltCard(world: StandWorld, h: ConsoleHalt, m: Messages): HaltCard {
  const review = [...world.state.haltReviews].reverse().find((r) => r.haltId === h.haltId && r.outcome === 'RELEASED');
  const channel = m.values[channelOf(world, h.channelAccountId) as keyof typeof m.values] ?? channelOf(world, h.channelAccountId);
  return {
    haltId: h.haltId,
    scopeLabel: h.marketplace === null ? m.ui.stop.account(channel) : m.ui.stop.storefront(channel, h.marketplace),
    reason: m.values[h.reasonCode], since: m.when(h.haltedAt),
    review: h.releasedAt ? '' : m.ui.stop.haltReview(m.when(h.nextReviewAt)),
    released: h.releasedAt
      ? h.releasedKind === 'AUTO' ? m.ui.stop.haltReleasedAuto(m.when(h.releasedAt)) : m.ui.stop.releasedBy(m.when(h.releasedAt), memberLabel(world, review?.membershipId ?? null, m), review?.note ?? '')
      : null,
    canRelease: h.releasedAt === null && can(world.viewer.role, 'RELEASE_CHANNEL_HALT'),
  };
}

function targetCard(world: StandWorld, target: StopTarget, m: Messages): TargetCard {
  const covering = world.state.stops.filter((s) => covers(s, target))
    .sort((a, b) => ({ TENANT: 0, CHANNEL_ACCOUNT: 1, STOREFRONT: 2 }[a.scope] - { TENANT: 0, CHANNEL_ACCOUNT: 1, STOREFRONT: 2 }[b.scope]))[0];
  return {
    target, label: targetLabel(world, target, m), coveredBy: covering ? stopCard(world, covering, m) : null,
    impact: impactOf(world, scopesOf(world, target), m), canStop: !covering && can(world.viewer.role, 'STOP_PRICING'),
  };
}

export function stopView(world: StandWorld, m: Messages): StopView {
  const role = world.viewer.role;
  return {
    worldId: world.id,
    permissions: {
      canStop: can(role, 'STOP_PRICING'), canResumeTenant: can(role, 'RESUME_TENANT_STOP'),
      canResumeChannel: can(role, 'RESUME_CHANNEL_STOP'), canReleaseHalt: can(role, 'RELEASE_CHANNEL_HALT'),
    },
    tenant: targetCard(world, { kind: 'TENANT' }, m),
    accounts: world.accounts.map((a) => targetCard(world, { kind: 'CHANNEL_ACCOUNT', channelAccountId: a.channelAccountId }, m)),
    storefronts: world.accounts.flatMap((a) => a.marketplaces.map((mk) => targetCard(world, { kind: 'STOREFRONT', channelAccountId: a.channelAccountId, marketplace: mk }, m))),
    stops: {
      active: world.state.stops.filter((s) => s.releasedAt === null).map((s) => stopCard(world, s, m)),
      history: world.state.stops.filter((s) => s.releasedAt !== null).map((s) => stopCard(world, s, m)),
    },
    halts: {
      active: world.state.halts.filter((h) => h.releasedAt === null).map((h) => haltCard(world, h, m)),
      history: world.state.halts.filter((h) => h.releasedAt !== null).map((h) => haltCard(world, h, m)),
    },
    audit: [...world.state.audit].reverse().map((a): AuditCard => ({
      at: m.when(a.at),
      action: m.ui.stop.auditActions[a.action],
      actor: a.actorType === 'SYSTEM' || !a.role ? m.ui.stop.system
        : a.membershipId === world.viewer.membershipId ? m.ui.stop.you(m.values[a.role]) : m.values[a.role],
      scope: a.scope === null ? m.ui.stop.wholeTenant
        : targetLabel(world, { scope: a.scope, channelAccountId: a.channelAccountId, marketplace: a.marketplace } as ConsoleStop, m),
      note: a.note,
    })),
    notStopped: m.ui.stop.notStopped,
    gaps: [gap(m, 'MFA_AT_PROVIDER')],
  };
}

export function planStop(world: StandWorld, target: StopTarget, m: Messages): StopPlan {
  const impact = impactOf(world, scopesOf(world, target), m);
  const label = targetLabel(world, target, m);
  return {
    target, impact,
    alreadyActive: world.state.stops.some((s) => s.releasedAt === null && sameTarget(s, target)),
    confirmTitle: m.ui.stop.confirmTitle(label),
    confirmText: target.kind === 'TENANT' ? m.ui.stop.confirmTenant(impact.text) : m.ui.stop.confirmChannel(impact.text),
  };
}

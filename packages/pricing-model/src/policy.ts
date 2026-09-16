/**
 * Правила продукта, общие для ядра, интерфейса и БД (БД дублирует их ограничениями и триггерами 0042).
 */

// ---------------------------------------------------------------------------
// Остановки [Р-69, Р-70]
// ---------------------------------------------------------------------------

/**
 * Остановка человеком (kill switch) — все изменения цен без исключений, на тенант, аккаунт или витрину.
 * Остановка тенанта — самостоятельный объект: действует и на аккаунты, подключённые после неё.
 * Системная остановка канала по испорченным данным — pricing_halt, только цены из данных конкурентов [Р-51].
 */
export type StopScope = 'TENANT' | 'CHANNEL_ACCOUNT' | 'STOREFRONT';

export interface StopRef {
  stopId: string;
  scope: StopScope;
  channelAccountId: string | null;
  marketplace: string | null;
  stoppedAt: string;
  stoppedByMembershipId: string;
}

/** Системная остановка канала [Р-42, Р-51] */
export interface HaltRef {
  haltId: string;
  reasonCode: 'CHANNEL_MASS_SHIFT';
  marketplace: string | null;
  haltedAt: string;
}

export function stopCovers(stop: Pick<StopRef, 'scope' | 'channelAccountId' | 'marketplace'>, channelAccountId: string, marketplace: string): boolean {
  if (stop.scope === 'TENANT') return true;
  if (stop.channelAccountId !== channelAccountId) return false;
  return stop.scope === 'CHANNEL_ACCOUNT' || stop.marketplace === marketplace;
}

// ---------------------------------------------------------------------------
// Роли [OQ-125, шаг 12; OQ-129, шаг 13]
// ---------------------------------------------------------------------------

export const MEMBER_ROLES = ['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export type PricingAction = 'VIEW_PRICING' | 'STOP_PRICING' | 'RESUME_TENANT_STOP' | 'RESUME_CHANNEL_STOP' | 'RELEASE_CHANNEL_HALT' | 'ENABLE_REPRICING'
  | 'MANAGE_PRICING' | 'MANAGE_CATALOG' | 'MANAGE_TENANT' | 'GIVE_MIGRATION_CONSENT';

/**
 * Права на цены (шаг 13, OQ-129). Стоп-кран — у каждого, кто отвечает за цены: владелец, администратор, оператор,
 * менеджер цен. Возобновить весь тенант — владелец и администратор тенанта (агентство управляет клиентом без владельца);
 * витрину или аккаунт — все, кто может остановить. Менеджер остатков и наблюдатель только смотрят.
 * Матрица дублирована в БД (`security.pricing_permission`, 0045) — совпадение проверяет тест.
 */
export const PRICING_PERMISSIONS: Readonly<Record<PricingAction, readonly MemberRole[]>> = {
  VIEW_PRICING: MEMBER_ROLES,
  STOP_PRICING: ['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  RESUME_TENANT_STOP: ['OWNER', 'ADMIN'],
  RESUME_CHANNEL_STOP: ['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  RELEASE_CHANNEL_HALT: ['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  ENABLE_REPRICING: ['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  // Шаг 18 [Р-100]: административная запись проверяет роль, а не только членство (security.admin_write_action, 0068)
  MANAGE_PRICING: ['OWNER', 'ADMIN', 'PRICING_MANAGER'],
  MANAGE_CATALOG: ['OWNER', 'ADMIN', 'INVENTORY_MANAGER'],
  MANAGE_TENANT: ['OWNER', 'ADMIN'],
  // Р-101: согласие на необратимую миграцию eBay — только владелец (и только от своего имени, со вторым фактором — в БД)
  GIVE_MIGRATION_CONSENT: ['OWNER'],
};

export const PRICING_ACTIONS: readonly PricingAction[] = ['VIEW_PRICING', 'STOP_PRICING', 'RESUME_TENANT_STOP', 'RESUME_CHANNEL_STOP', 'RELEASE_CHANNEL_HALT', 'ENABLE_REPRICING',
  'MANAGE_PRICING', 'MANAGE_CATALOG', 'MANAGE_TENANT', 'GIVE_MIGRATION_CONSENT'];

export function can(role: MemberRole, action: PricingAction): boolean {
  return PRICING_PERMISSIONS[action].includes(role);
}

export function resumeActionFor(scope: StopScope): PricingAction {
  return scope === 'TENANT' ? 'RESUME_TENANT_STOP' : 'RESUME_CHANNEL_STOP';
}

// ---------------------------------------------------------------------------
// «Опасное изменение» [Р-73]
// ---------------------------------------------------------------------------

/** Отклонённое Gate решение опасно, если предложенная цена дальше этого от нарушенной границы */
export const DANGEROUS_DEVIATION_BP = 1000;

/** Отклонение от границы: |предложено − граница| / граница, базисные пункты с округлением вверх */
export function boundDeviationBp(proposedMinor: number, boundMinor: number): number {
  if (!Number.isSafeInteger(proposedMinor) || !Number.isSafeInteger(boundMinor) || boundMinor <= 0) return 0;
  return Math.ceil((Math.abs(proposedMinor - boundMinor) * 10_000) / boundMinor);
}

export type BoundIntervention = 'DANGEROUS' | 'CORRECTED';

/** Р-73: опасно — отклонено Gate с отклонением больше 10 %; остальное — скорректировано */
export function classifyBoundIntervention(deviationBp: number): BoundIntervention {
  return deviationBp > DANGEROUS_DEVIATION_BP ? 'DANGEROUS' : 'CORRECTED';
}

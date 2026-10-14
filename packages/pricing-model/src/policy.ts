import type { DistrustReasonCode, HaltReasonCode } from './reasons.ts';
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
  reasonCode: HaltReasonCode;
  marketplace: string | null;
  haltedAt: string;
}

/**
 * Остановка по недоверию каналу [Р-118]: сломана трансляция цены в канал (например, неверная база цены, Р-116). Третий вид остановки —
 * не расширение системной остановки Р-51 и не kill switch Р-69: держит все цены, включая фиксированные, ставит её система,
 * снимает только человек со вторым фактором.
 */
export interface DistrustRef {
  distrustId: string;
  reasonCode: DistrustReasonCode;
  marketplace: string | null;
  detectedAt: string;
}

export function stopCovers(stop: Pick<StopRef, 'scope' | 'channelAccountId' | 'marketplace'>, channelAccountId: string, marketplace: string): boolean {
  if (stop.scope === 'TENANT') return true;
  if (stop.channelAccountId !== channelAccountId) return false;
  return stop.scope === 'CHANNEL_ACCOUNT' || stop.marketplace === marketplace;
}

// ---------------------------------------------------------------------------
// Роли [OQ-125, шаг 12; OQ-129, шаг 13]
// ---------------------------------------------------------------------------

export const MEMBER_ROLES = ['OWNER', 'MANAGER', 'VIEWER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Шаг 88 [Р-213]: у человека в рабочем пространстве ровно одна роль (одно членство на тенант и пользователя — база, 0002, 0185).
 * Видимых ролей три: владелец — всё, менеджер — ежедневная работа, наблюдатель — только чтение. Прежние роли не удалены: их
 * назначения работают, а консоль показывает администратора и оператора только с флагом развёртывания «расширенные роли»
 * (`REPRACER_EXTENDED_ROLES=on`); менеджер цен и менеджер остатков — роли прежних назначений, новых им не предлагается.
 */
export const VISIBLE_ROLES: readonly MemberRole[] = ['OWNER', 'MANAGER', 'VIEWER'];
export const EXTENDED_ROLES: readonly MemberRole[] = [...VISIBLE_ROLES, 'ADMIN', 'OPERATOR'];

/** Роли, которые консоль предлагает (вход стенда, описания ролей): три видимые или пять с флагом расширенных ролей */
export function offeredRoles(extended: boolean): readonly MemberRole[] {
  return extended ? EXTENDED_ROLES : VISIBLE_ROLES;
}

export type PricingAction = 'VIEW_PRICING' | 'STOP_PRICING' | 'RESUME_TENANT_STOP' | 'RESUME_CHANNEL_STOP' | 'RELEASE_CHANNEL_HALT' | 'RELEASE_CHANNEL_DISTRUST' | 'ENABLE_REPRICING'
  | 'RETURN_TO_SHADOW' | 'MANAGE_PRICING' | 'MANAGE_CATALOG' | 'MANAGE_TENANT' | 'GIVE_MIGRATION_CONSENT';

/**
 * Права на цены (шаг 13, OQ-129; шаг 88, Р-213). Стоп-кран — у каждого, кто отвечает за цены. Менеджер (MANAGER) — ежедневная
 * работа: цены, границы, стратегии, остатки, импорт себестоимости, массовые операции, стоп-кран и перевод аккаунта обратно в тень
 * (снятие недоверия каналу — владельцу, шаг 89); управление людьми и
 * аккаунтами каналов (MANAGE_TENANT) — у владельца (и прежнего администратора). Только владельцу база отдаёт и то, чего в матрице
 * нет отдельной строкой: перевод в бой [Р-170], подтверждение и отзыв записи количества [Р-202]. Менеджер остатков и наблюдатель
 * только смотрят на цены. Матрица дублирована в БД (`security.pricing_permission`, 0185) — совпадение проверяет тест.
 */
export const PRICING_PERMISSIONS: Readonly<Record<PricingAction, readonly MemberRole[]>> = {
  VIEW_PRICING: MEMBER_ROLES,
  STOP_PRICING: ['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  RESUME_TENANT_STOP: ['OWNER', 'MANAGER', 'ADMIN'],
  RESUME_CHANNEL_STOP: ['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  RELEASE_CHANNEL_HALT: ['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  // Р-118: канал искажает наши цены — снять недоверие значит снова поверить каналу. Шаг 89 (ADR-0054, решение владельца): только
  // владелец (и прежний администратор), не менеджер
  RELEASE_CHANNEL_DISTRUST: ['OWNER', 'ADMIN'],
  ENABLE_REPRICING: ['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER'],
  // Шаг 89 (ADR-0054, решение владельца): обратно в тень — безопасная сторона, и у менеджера; в бой — только владелец, свой страж базы [Р-170]
  RETURN_TO_SHADOW: ['OWNER', 'MANAGER', 'ADMIN'],
  // Шаг 18 [Р-100]: административная запись проверяет роль, а не только членство (security.admin_write_action, 0068)
  MANAGE_PRICING: ['OWNER', 'MANAGER', 'ADMIN', 'PRICING_MANAGER'],
  MANAGE_CATALOG: ['OWNER', 'MANAGER', 'ADMIN', 'INVENTORY_MANAGER'],
  MANAGE_TENANT: ['OWNER', 'ADMIN'],
  // Р-101: согласие на необратимую миграцию eBay — только владелец (и только от своего имени, со вторым фактором — в БД)
  GIVE_MIGRATION_CONSENT: ['OWNER'],
};

export const PRICING_ACTIONS: readonly PricingAction[] = ['VIEW_PRICING', 'STOP_PRICING', 'RESUME_TENANT_STOP', 'RESUME_CHANNEL_STOP', 'RELEASE_CHANNEL_HALT', 'RELEASE_CHANNEL_DISTRUST', 'ENABLE_REPRICING',
  'RETURN_TO_SHADOW', 'MANAGE_PRICING', 'MANAGE_CATALOG', 'MANAGE_TENANT', 'GIVE_MIGRATION_CONSENT'];

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

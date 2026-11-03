import type {
  DefaultStrategyRow,
  ConsoleCatalogFacts, ConsoleCatalogPage, ConsoleDecisionRow, ConsoleHaltRow, ConsoleIntentRow, ConsoleScopeRow, ConsoleState, ConsoleStopRow, ConsoleWriteRow,
} from '@repracer/pricing-pipeline';
import type { MemberRole } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import { swatchOf, type Swatch } from './color.ts';

/**
 * Мир для экранов [Р-67]: состояние хранилища через порт PricingStore.readConsoleState — одинаково в памяти и на PostgreSQL.
 * Объяснения решений — из неизменяемых слепков [Р-68], отчёты прогона экранам не нужны.
 */

export interface StandAccount {
  channelAccountId: string;
  channel: string;
  marketplaces: string[];
  /** Р-119: системная остановка снимается свежей выборкой (SAMPLE) или только человеком (MANUAL_ONLY) — свойство канала */
  haltRelease?: 'SAMPLE' | 'MANUAL_ONLY';
}

/** Кто смотрит: от его роли зависят действия [OQ-125] */
export interface Viewer {
  membershipId: string;
  role: MemberRole;
}

export interface StandWorld {
  id: string;
  title: string;
  description: string;
  tenantId: string;
  /** Время мира */
  now: string;
  accounts: StandAccount[];
  viewer: Viewer;
  state: ConsoleState;
  /** Р-151: мир на симуляторе — данные синтетические, путь настоящий; помечается везде, где показываются деньги */
  demo?: boolean;
  /** Шаг 91: демо-тенант со своим именем — лёгкий продавец вида преп-центра; имя мира — его, а не общее имя демо */
  ownName?: boolean;
  /**
   * Шаг 93: справочник показа «адрес → имя человека» — у стенда из посева; имя из базы (`display_name`) важнее. Нет имени — адрес.
   * Журнал и права его не читают: только то, как человек назван на экране
   */
  people?: Readonly<Record<string, string>>;
  /**
   * Шаг 67 (OQ-248): мир собран не из каталога целиком, а из единиц, которые назвал экран. Тогда то, что экран знает о каталоге
   * целиком, — из базы: страница каталога (`catalogPage`) и факты (`catalogFacts`). Без них — каталог целиком в `state.scopes`
   * (хранилище в памяти, тест равенства)
   */
  catalogPage?: ConsoleCatalogPage;
  catalogFacts?: ConsoleCatalogFacts;
  /** Шаг 103 [Р-228]: стратегии по умолчанию аккаунтов — карточка стратегии называет, для каких аккаунтов она умолчание */
  defaultStrategies?: readonly DefaultStrategyRow[];
}

export type ConsoleScope = ConsoleScopeRow;
export type ConsoleDecision = ConsoleDecisionRow;
export type ConsoleIntent = ConsoleIntentRow;
export type ConsoleWrite = ConsoleWriteRow;
export type ConsoleHalt = ConsoleHaltRow;
export type ConsoleStop = ConsoleStopRow;

/** Пробелы в данных, которые остаются после шага 12: экран говорит «нет данных», а не придумывает значение */
export const GAP_CODES = [
  // Шаг 69 (K5): пробелы — то, что клиенту полезно знать об экране; заметки разработчика (уровень опроса, источник подтверждения, отказы
  // базы при фиксации, тариф комиссии, второй фактор на стенде, пояс показа — сделан K4, названия — OQ-249) убраны вместе с кодами
  'NO_EXPLANATION', 'SNAPSHOT_CONTENT', 'SNAPSHOT_REF_EXPIRED', 'CHANNEL_VALUES_WITHHELD', 'COST_COMPONENTS',
  'NO_OP_NOT_EXPLAINED', 'EXPLANATION_DICTIONARY_MISSING',
  // Шаг 21: экраны стратегий, правки границ, ленты цен и отчёта об опасных изменениях
  'PREVIEW_LAST_SNAPSHOT', 'PREVIEW_CURRENT_BOUNDS', 'BOUND_LEVELS', 'MASS_EDIT_MFA_PER_TRANSACTION', 'IMPORT_NO_FX', 'IMPORT_OFFER_KEYS', 'FEED_WINDOW',
  'DANGEROUS_REPORT_WINDOW', 'DANGEROUS_THRESHOLD', 'FLOOR_HOLD_TARGET_WINDOW',
  // Шаг 35 [Р-153]: экран остатков; [Р-154]: срез вмешательств ограничен
  'STOCK_CHANNEL_NOT_READ', 'INTERVENTIONS_TRUNCATED',
  // Шаг 23: три вида остановки, ценообразование канала, стратегии и лента
  'DISTRUST_DETAILS', 'CHANNEL_PRICING_OFFERS_WITHOUT_SCOPE', 'PRICING_HEALTH_ISSUES', 'POSITION_STRATEGY',
  // Шаг 24: Omnibus
  'OMNIBUS_OUTSIDE_PRICES', 'OMNIBUS_TIME_ZONE_TO_VERIFY',
] as const;
export type GapCode = (typeof GAP_CODES)[number];

export interface Gap {
  code: GapCode;
  what: string;
  why: string;
}

export function gap(m: Messages, code: GapCode): Gap {
  return { code, ...m.gaps[code] };
}

export function uniqueGaps(gaps: readonly Gap[]): Gap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => (seen.has(g.code) ? false : (seen.add(g.code), true)));
}

export type Tone = 'ok' | 'progress' | 'warn' | 'stop' | 'off' | 'unknown';

export interface StatusCell {
  tone: Tone;
  label: string;
  detail: string;
  /** Шаг 89: короткая строка для тесной ячейки таблицы; полный `detail` — подсказкой */
  short?: string;
}

export interface UnitRef {
  writeScopeId: string;
  channel: string;
  marketplace: string;
  externalUnitId: string;
  channelProductRef: string;
  condition: string;
  gtin: string | null;
  /** Подпись целиком — «Plant pot, green · amazon.com»: поиск, подсказки, заголовки страниц, выгрузки и письма */
  label: string;
  /** Шаг 111 [Р-237]: имя продукта без витрины — в таблицах и списках рядом с чипом витрины */
  name: string;
  storefront: StorefrontChip;
  /**
   * Шаг 112 [Р-238]: цвет товара словом продавца (импорт «Product details») — второй строкой под названием; кружок-образец — только у
   * известного слова (`swatch`), незнакомое — только текстом. В подписи `label` цвета нет: выгрузки несут его своей колонкой
   */
  color: string | null;
  swatch: Swatch | null;
}

/**
 * Шаг 111 [Р-237]: витрина в таблицах и списках — чип площадки: кружок её цвета (палитра Primer) с буквой — a amazon, w walmart, e ebay,
 * k kaufland. Короткое имя витрины рядом — только когда у пространства больше одной витрины этой площадки (amazon.de и amazon.com); полное
 * имя — подсказкой и доступным именем. Выгрузки, журналы в файлах и письма называют витрину полностью, как прежде
 */
export interface StorefrontChip {
  channel: string;
  letter: string;
  /** Полное имя витрины — «amazon.com» */
  full: string;
  /** Короткое имя — «.de»; null, когда без него однозначно */
  short: string | null;
}

const CHIP_LETTERS: Readonly<Record<string, string>> = { AMAZON: 'a', WALMART: 'w', EBAY: 'e', KAUFLAND: 'k' };

export function storefrontChip(world: Pick<StandWorld, 'accounts'> | null, channel: string, marketplace: string, m: Messages): StorefrontChip {
  const full = storefrontName(channel, marketplace, m);
  const names = new Set([full, ...(world?.accounts ?? []).filter((a) => a.channel === channel).flatMap((a) => a.marketplaces.map((mk) => storefrontName(channel, mk, m)))]);
  return { channel, letter: CHIP_LETTERS[channel] ?? channel.slice(0, 1).toLowerCase(), full, short: names.size > 1 ? /^[a-z]+(\.[a-z.]+)$/.exec(full)?.[1] ?? full : null };
}

export function channelOf(world: StandWorld, channelAccountId: string): string {
  return world.accounts.find((a) => a.channelAccountId === channelAccountId)?.channel ?? 'UNKNOWN_CHANNEL';
}

export function unitOf(world: StandWorld, scope: ConsoleScope, m: Messages): UnitRef {
  const channel = channelOf(world, scope.channelAccountId);
  const name = scope.title ?? scope.sku ?? m.ui.common.unitRef(scope.externalUnitId);
  const storefront = storefrontChip(world, channel, scope.marketplace, m);
  return {
    writeScopeId: scope.writeScopeId, channel, marketplace: scope.marketplace, externalUnitId: scope.externalUnitId,
    channelProductRef: scope.channelProductRef, condition: scope.condition, gtin: scope.gtin,
    label: m.ui.common.unitLabel(name, storefront.full), name, storefront,
    color: scope.color ?? null, swatch: swatchOf(scope.color),
  };
}

/**
 * Шаг 68 (K10): витрина словами — «amazon.com», «ebay.com», «kaufland.de», а не «Amazon ATVPDKIKX0DER». Kaufland называет витрины
 * кодом страны, и код страны без канала другого канала не опознаёт, поэтому правило — по паре канал и витрина. Неизвестная витрина —
 * имя канала и её код, а не пустота
 */
// Правило повторяет поиск в базе (`consoleCatalogFacts`, ключ `marketplaceWords`): изменение здесь — изменение там; равенство держит тест шага 67
export function storefrontName(channel: string, marketplace: string, m: Messages): string {
  if (channel === 'KAUFLAND' && /^[a-z]{2}$/.test(marketplace)) return `kaufland.${marketplace}`;
  // Шаг 79: аккаунт Amazon, записанный кодом страны (демо, ожидание доступа), — тоже витриной, а не «Amazon de»
  if (channel === 'AMAZON' && (marketplace === 'de' || marketplace === 'us')) return marketplace === 'de' ? 'amazon.de' : 'amazon.com';
  return m.ui.connections.marketplaces[marketplace] ?? `${m.values[channel as keyof typeof m.values] ?? channel} ${marketplace}`;
}

export function scopeById(world: StandWorld, writeScopeId: string): ConsoleScope | undefined {
  return world.state.scopes.find((s) => s.writeScopeId === writeScopeId);
}

/** Шаг 67 (OQ-248): предложений в каталоге — из фактов базы у мира выбранных единиц, иначе по каталогу мира */
export function catalogTotal(world: StandWorld): number {
  return world.catalogFacts ? world.catalogFacts.total : world.state.scopes.length;
}

/** Шаг 67 (OQ-248): первые `n` предложений каталога в его порядке */
export function catalogFirst(world: StandWorld, n: number): ConsoleScope[] {
  const f = world.catalogFacts;
  if (!f) return world.state.scopes.slice(0, n);
  const byId = new Map(world.state.scopes.map((sc) => [sc.writeScopeId, sc]));
  return f.firstIds.slice(0, n).flatMap((id) => { const sc = byId.get(id); return sc ? [sc] : []; });
}

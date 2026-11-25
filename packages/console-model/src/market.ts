import type { Locale } from './i18n/types.ts';

/**
 * Шаг 87 [Р-214]: профиль рынка развёртывания — какие каналы, витрины, языки и правила консоль ПРЕДЛАГАЕТ и называет. Продукт выходит
 * сначала на рынок США; всё европейское спрятано за профиль, но не удалено: код, словари, тесты и интеграции живые, и Европа
 * открывается одним значением (`REPRACER_MARKET_PROFILE=eu` или `global`).
 *
 * Профиль — свойство РАЗВЁРТЫВАНИЯ, а не данных: он решает, что предлагать (подключение, язык, вкладка Omnibus), и ничего не меняет в
 * базе. Данные тенанта профиль не прячет и не трогает — цены, которые уже меняются, не исчезают с экрана из-за настройки показа.
 */
export const MARKET_PROFILES = ['us', 'eu', 'global'] as const;
export type MarketProfile = (typeof MARKET_PROFILES)[number];

/** Профиль по умолчанию — первый рынок продукта [Р-214] */
export const DEFAULT_MARKET_PROFILE: MarketProfile = 'us';

/** Витрины США: amazon.com, ebay.com и (шаг 89) walmart.com. Остальные наши витрины — Европа (amazon.de, ebay.de, kaufland.de и .at) */
export const US_STOREFRONTS: Readonly<Record<string, readonly string[]>> = { AMAZON: ['ATVPDKIKX0DER'], EBAY: ['EBAY_US'], WALMART: ['WALMART_US'] };

export interface MarketScope {
  profile: MarketProfile;
  /** Каналы, которые консоль предлагает подключить и называет */
  channels: readonly string[];
  /** Языки интерфейса; первый — язык по умолчанию. Один язык — переключателя языка нет */
  locales: readonly Locale[];
  /** Правило ЕС о прежней цене скидки (Omnibus): вкладка и проверка */
  omnibus: boolean;
  /** Валюты витрин профиля (посев демо и подсказки; в коде и модели EUR и USD остаются наравне [Р-57]) */
  currencies: readonly string[];
  /**
   * Шаг 176 [Р-256]: витрины, которые консоль предлагает и называет клиентскому тенанту, — сужение профиля каталогом каналов тенанта.
   * Нет поля — витрины профиля целиком
   */
  storefronts?: Readonly<Record<string, readonly string[]>>;
}

const SCOPES: Readonly<Record<MarketProfile, MarketScope>> = {
  // Шаг 89: Walmart — канал рынка США; в профиле eu его нет (витрина одна — walmart.com)
  us: { profile: 'us', channels: ['AMAZON', 'EBAY', 'WALMART'], locales: ['en', 'es', 'fr'], omnibus: false, currencies: ['USD'] },
  eu: { profile: 'eu', channels: ['KAUFLAND', 'AMAZON', 'EBAY'], locales: ['de', 'en', 'es', 'fr'], omnibus: true, currencies: ['EUR'] },
  global: { profile: 'global', channels: ['KAUFLAND', 'AMAZON', 'EBAY', 'WALMART'], locales: ['de', 'en', 'es', 'fr'], omnibus: true, currencies: ['EUR', 'USD'] },
};

export function isMarketProfile(value: unknown): value is MarketProfile {
  return typeof value === 'string' && (MARKET_PROFILES as readonly string[]).includes(value);
}

export function marketScope(profile: MarketProfile): MarketScope {
  return SCOPES[profile];
}

/** Значение развёртывания: не задано — профиль по умолчанию; задано неверно — отказ, а не молчаливое умолчание */
export function marketProfileOf(raw: string | undefined): MarketProfile {
  if (raw === undefined || raw === '') return DEFAULT_MARKET_PROFILE;
  if (!isMarketProfile(raw)) throw new Error(`REPRACER_MARKET_PROFILE must be one of ${MARKET_PROFILES.join(', ')}, got ${raw}`);
  return raw;
}

const isUsStorefront = (channel: string, marketplace: string): boolean => (US_STOREFRONTS[channel] ?? []).includes(marketplace);

/** Витрина входит в профиль: канал профиля и витрина его рынка (у global — любая) */
export function storefrontInMarket(scope: MarketScope, channel: string, marketplace: string): boolean {
  if (!scope.channels.includes(channel)) return false;
  if (scope.storefronts && !(scope.storefronts[channel] ?? []).includes(marketplace)) return false;
  if (scope.profile === 'global') return true;
  return scope.profile === 'us' ? isUsStorefront(channel, marketplace) : !isUsStorefront(channel, marketplace);
}

/**
 * Мир стенда (рабочее пространство сценария или демо) входит в профиль, если в нём нет аккаунтов или хотя бы одна его витрина — витрина
 * профиля. Миры тенантов продавцов этим не фильтруются: данные профиль не прячет
 */
export function worldInMarket(scope: MarketScope, accounts: ReadonlyArray<{ channel: string; marketplaces: readonly string[] }>): boolean {
  return accounts.length === 0 || accounts.some((a) => a.marketplaces.some((mp) => storefrontInMarket(scope, a.channel, mp)));
}

/** Язык запроса в профиле: язык профиля остаётся, чужой — язык профиля по умолчанию */
export function localeInMarket(scope: MarketScope, locale: Locale): Locale {
  return scope.locales.includes(locale) ? locale : scope.locales[0]!;
}

/** Каналы, которые можно подключить, — только каналы и витрины профиля; канал без витрин профиля не предлагается */
export function connectableInMarket<T extends { channel: string; marketplaces: readonly string[] }>(scope: MarketScope, channels: readonly T[]): T[] {
  return channels.flatMap((c) => {
    const marketplaces = c.marketplaces.filter((mp) => storefrontInMarket(scope, c.channel, mp));
    return marketplaces.length === 0 ? [] : [{ ...c, marketplaces }];
  });
}

/**
 * Шаг 176 [Р-256] (этап 3 отчёта «QA-A Testing 2.0», продолжение Р-251): каталог каналов клиентского тенанта — свойство развёртывания
 * `REPRACER_CLIENT_CHANNELS`: `amazon_us` — клиентские и пилотные тенанты видят и подключают только amazon.com; `all` — все витрины
 * профиля. Демо — исключение всегда: симуляторная витрина держит три канала, на ней держатся перепроверки QA. Код и интеграции других
 * каналов живут и проходят CI; данные тенанта каталог не прячет — их и не бывает: подключить другой канал нельзя, а база откажет и
 * прямой записи (0239)
 */
export const CLIENT_CHANNELS = ['ALL', 'AMAZON_US'] as const;
export type ClientChannels = (typeof CLIENT_CHANNELS)[number];

/** Витрина MVP [Р-251]: amazon.com */
export const AMAZON_US_ONLY: Readonly<Record<string, readonly string[]>> = { AMAZON: ['ATVPDKIKX0DER'] };

/** Значение развёртывания: не задано — умолчание процесса; задано неверно — отказ, а не молчаливое умолчание */
export function clientChannelsOf(raw: string | undefined, fallback: ClientChannels): ClientChannels {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'amazon_us') return 'AMAZON_US';
  if (raw === 'all') return 'ALL';
  throw new Error(`REPRACER_CLIENT_CHANNELS must be amazon_us or all, got ${raw}`);
}

/** Каталог каналов тенанта: демо и развёртывание «all» — профиль целиком; клиент при «amazon_us» — только amazon.com профиля */
export function tenantMarketScope(scope: MarketScope, tenant: { demo: boolean }, clientChannels: ClientChannels): MarketScope {
  if (tenant.demo || clientChannels === 'ALL') return scope;
  return { ...scope, channels: scope.channels.filter((c) => c in AMAZON_US_ONLY), storefronts: AMAZON_US_ONLY };
}

/**
 * Шаг 88 [Р-213]: флаг развёртывания «расширенные роли» (`REPRACER_EXTENDED_ROLES`: on или off, по умолчанию off) — по образцу
 * профиля рынка. Выключен: консоль предлагает три видимые роли (владелец, менеджер, наблюдатель); включён — ещё администратора и
 * оператора. Назначенные роли флаг не трогает: человек с прежней ролью работает в любом положении флага
 */
export function extendedRolesOf(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`REPRACER_EXTENDED_ROLES must be on or off, got ${raw}`);
}

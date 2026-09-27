import { readFileSync } from 'node:fs';
import { amazonLwa, AMAZON_SELLER_CENTRAL, ebayOAuth, loadKeyring, type Keyring, type OAuthProvider } from '@repracer/channel-oauth';
import { ConfigError, requiredValue, secretFromEnv, type Env } from './env.ts';

/**
 * Р-175…Р-177 (шаг 43): приложения каналов платформы и кольцо ключей токенов — одна конфигурация для консоли (подключение)
 * и планировщика (проверка авторизаций). Секреты — только файлами [шаг 28, E].
 *
 * Приложение канала настраивается ЦЕЛИКОМ или не настраивается вовсе: половина ключей — это не «почти подключено», а
 * отказ на первом же возврате продавца. Ненастроенный канал не ошибка процесса: экран покажет его «ожидает доступа
 * платформы» с названной причиной [Р-150]. Кольцо ключей обязательно, как только настроен хотя бы один канал: токен без
 * ключа шифрования не записать, а временный ключ в памяти сделал бы все токены нечитаемыми после перезапуска.
 */

export interface ChannelAppsConfig {
  keyring: Keyring | null;
  /** Адрес возврата консоли (`https://…/connect/callback`); у eBay вместо адреса — RuName приложения */
  redirectUrl: string | null;
  amazon: { applicationId: string; clientId: string; clientSecret: string; draft: boolean; tokenUrl?: string } | null;
  ebay: {
    environment: 'SANDBOX' | 'PRODUCTION'; clientId: string; clientSecret: string; ruName: string; scopes: string[];
    /** Шаг 47: конечные точки МОДЕЛИ поставщика eBay (согласие, токены, Commerce Identity) — только в режиме стенда */
    endpoints?: { authorize: string; token: string; identity: string };
  } | null;
}

const onOff = (v: string | undefined, name: string): boolean => {
  if (v === 'on') return true;
  if (v === 'off') return false;
  throw new ConfigError(`CONFIG_MISSING: ${name}=on|off (приложение настроено — его состояние называется явно)`);
};
const ebayEnvironment = (v: string | undefined): 'SANDBOX' | 'PRODUCTION' => {
  if (v === 'SANDBOX' || v === 'PRODUCTION') return v;
  throw new ConfigError('CONFIG_MISSING: REPRACER_EBAY_ENVIRONMENT=SANDBOX|PRODUCTION (приложение настроено — окружение называется явно)');
};

const AMAZON_VARS = ['REPRACER_AMAZON_APP_ID', 'REPRACER_AMAZON_LWA_CLIENT_ID'] as const;
const EBAY_VARS = ['REPRACER_EBAY_CLIENT_ID', 'REPRACER_EBAY_RUNAME', 'REPRACER_EBAY_SCOPES'] as const;
export const EBAY_IDENTITY_SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly';
/** Шаг 47: ссылка на ключи приложения eBay внутри процесса — их отдаёт провайдер учётных данных из конфигурации, не из файла */
export const EBAY_APPLICATION_REF = 'platform:ebay-application';

/**
 * Шаг 47: модель поставщика eBay в прогоне пилота отвечает на петле — согласие, обмен кода и Commerce Identity (E-11) по одному
 * базовому адресу. Подмена — ТОЛЬКО в режиме стенда: в работе адрес токенов, подменённый переменной окружения, увёл бы коды
 * согласия и ключи приложения (Basic) на чужой хост.
 */
function modelEndpoints(env: Env): { authorize: string; token: string; identity: string } {
  if (env.REPRACER_MODE !== 'stand') throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_OAUTH_BASE is accepted only with REPRACER_MODE=stand (модель поставщика eBay)');
  let base: URL;
  try { base = new URL(env.REPRACER_EBAY_OAUTH_BASE!); } catch { throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_OAUTH_BASE must be an absolute URL'); }
  const origin = base.origin;
  return { authorize: `${origin}/oauth2/authorize`, token: `${origin}/identity/v1/oauth2/token`, identity: `${origin}/commerce/identity/v1/user/` };
}

export function loadChannelAppsConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ChannelAppsConfig {
  const all = (vars: readonly string[], secretName: string, what: string): boolean => {
    const present = vars.filter((v) => env[v]);
    const secretSet = Boolean(env[`${secretName}_FILE`] || env[secretName]);
    if (present.length === 0 && !secretSet) return false;
    const missing = [...vars.filter((v) => !env[v]), ...(secretSet ? [] : [`${secretName}_FILE`])];
    if (missing.length > 0) throw new ConfigError(`CONFIG_MISSING: ${missing.join(', ')} (${what} настраивается целиком или не настраивается вовсе)`);
    return true;
  };
  const amazon = all(AMAZON_VARS, 'REPRACER_AMAZON_LWA_CLIENT_SECRET', 'приложение Amazon')
    ? {
      applicationId: env.REPRACER_AMAZON_APP_ID!, clientId: env.REPRACER_AMAZON_LWA_CLIENT_ID!,
      clientSecret: requiredValue(secretFromEnv(env, 'REPRACER_AMAZON_LWA_CLIENT_SECRET', read), 'REPRACER_AMAZON_LWA_CLIENT_SECRET_FILE'),
      // Приложение в состоянии Draft согласуется только с version=beta (website-authorization-workflow). Умолчания нет
      // (находка 14 ревью шага 43): «черновик» по умолчанию у опубликованного приложения — ловушка на первом согласии
      draft: onOff(env.REPRACER_AMAZON_APP_DRAFT, 'REPRACER_AMAZON_APP_DRAFT'),
      // Шаг 45 [Р-181]: модель поставщика LWA прогона отвечает на петле — адрес токенов подменяется ТОЛЬКО в режиме стенда
      ...(env.REPRACER_MODE === 'stand' && env.REPRACER_AMAZON_LWA_TOKEN_URL ? { tokenUrl: env.REPRACER_AMAZON_LWA_TOKEN_URL } : {}),
    }
    : null;
  const ebay = all(EBAY_VARS, 'REPRACER_EBAY_CLIENT_SECRET', 'приложение eBay')
    ? {
      // Песочница или бой — называется явно: умолчание «песочница» у боевого приложения молча не подключало бы никого
      environment: ebayEnvironment(env.REPRACER_EBAY_ENVIRONMENT),
      clientId: env.REPRACER_EBAY_CLIENT_ID!, ruName: env.REPRACER_EBAY_RUNAME!,
      clientSecret: requiredValue(secretFromEnv(env, 'REPRACER_EBAY_CLIENT_SECRET', read), 'REPRACER_EBAY_CLIENT_SECRET_FILE'),
      // Scope называет конфигурация (E-08; набор, с которым работает песочница, — шаг 39)
      scopes: env.REPRACER_EBAY_SCOPES!.split(/\s+/).filter(Boolean),
      ...(env.REPRACER_EBAY_OAUTH_BASE ? { endpoints: modelEndpoints(env) } : {}),
    }
    : null;
  if (env.REPRACER_EBAY_OAUTH_BASE && !ebay) throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_OAUTH_BASE без приложения eBay — подменять нечего');
  /**
   * Находка 2 ревью шага 39: без scope `commerce.identity.readonly` продавца после обмена кода не назвать (E-11), и каждое
   * повторное подключение упиралось бы в отказ «продавец неизвестен». Отказ — при старте процесса, а не у продавца.
   */
  if (ebay && !ebay.scopes.includes(EBAY_IDENTITY_SCOPE)) {
    throw new ConfigError(`CONFIG_INVALID: REPRACER_EBAY_SCOPES must include ${EBAY_IDENTITY_SCOPE} (продавец eBay называется по нему, E-11)`);
  }
  const keyringText = secretFromEnv(env, 'REPRACER_CHANNEL_KEYRING', read);
  if ((amazon || ebay) && !keyringText) throw new ConfigError('CONFIG_MISSING: REPRACER_CHANNEL_KEYRING_FILE (приложение канала настроено, а ключа шифрования токенов нет)');
  const redirectUrl = env.REPRACER_CONNECT_REDIRECT_URL ?? null;
  if (amazon && !redirectUrl) throw new ConfigError('CONFIG_MISSING: REPRACER_CONNECT_REDIRECT_URL');
  // Код согласия по открытому каналу — это раздача чужих авторизаций
  if (redirectUrl && !/^https:\/\/[^/]+\/connect\/callback$/.test(redirectUrl) && env.REPRACER_MODE !== 'stand') {
    throw new ConfigError('CONFIG_INVALID: REPRACER_CONNECT_REDIRECT_URL must be https://<host>/connect/callback');
  }
  return { keyring: keyringText ? loadKeyring(keyringText) : null, redirectUrl, amazon, ebay };
}

/** Витрины приложений платформы: регион — свойство витрины, у eBay регион в согласии не участвует */
const AMAZON_MARKETPLACES = Object.keys(AMAZON_SELLER_CENTRAL).map((id) => ({ id, region: id === 'ATVPDKIKX0DER' ? 'NA' as const : 'EU' as const }));
const EBAY_MARKETPLACES = [{ id: 'EBAY_DE', region: null }, { id: 'EBAY_US', region: null }];

export interface ChannelApp {
  channel: 'AMAZON' | 'EBAY';
  marketplaces: Array<{ id: string; region: 'EU' | 'NA' | null }>;
  platformMissing: string[];
  provider: OAuthProvider | null;
}

/** Поставщики OAuth процесса; ненастроенный канал — с причиной, по которой его нельзя подключить [Р-150] */
export function channelApps(c: ChannelAppsConfig): ChannelApp[] {
  return [
    c.amazon && c.redirectUrl
      ? { channel: 'AMAZON', marketplaces: AMAZON_MARKETPLACES, platformMissing: [], provider: amazonLwa({ ...c.amazon, redirectUri: c.redirectUrl }) }
      : { channel: 'AMAZON', marketplaces: AMAZON_MARKETPLACES, platformMissing: ['AMAZON_APPLICATION'], provider: null },
    c.ebay
      ? { channel: 'EBAY', marketplaces: EBAY_MARKETPLACES, platformMissing: [], provider: ebayOAuth({ environment: c.ebay.environment, clientId: c.ebay.clientId, clientSecret: c.ebay.clientSecret, redirectUri: c.ebay.ruName, scopes: c.ebay.scopes, ...(c.ebay.endpoints ? { endpoints: c.ebay.endpoints } : {}) }) }
      : { channel: 'EBAY', marketplaces: EBAY_MARKETPLACES, platformMissing: ['EBAY_DEVELOPER_KEYS'], provider: null },
  ];
}

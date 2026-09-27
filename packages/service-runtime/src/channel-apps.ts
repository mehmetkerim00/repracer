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
  amazon: { applicationId: string; clientId: string; clientSecret: string; draft: boolean } | null;
  ebay: { environment: 'SANDBOX' | 'PRODUCTION'; clientId: string; clientSecret: string; ruName: string; scopes: string[] } | null;
}

const AMAZON_VARS = ['REPRACER_AMAZON_APP_ID', 'REPRACER_AMAZON_LWA_CLIENT_ID'] as const;
const EBAY_VARS = ['REPRACER_EBAY_CLIENT_ID', 'REPRACER_EBAY_RUNAME', 'REPRACER_EBAY_SCOPES'] as const;

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
      // Приложение в состоянии Draft согласуется только с version=beta (website-authorization-workflow)
      draft: (env.REPRACER_AMAZON_APP_DRAFT ?? 'on') !== 'off',
    }
    : null;
  const ebay = all(EBAY_VARS, 'REPRACER_EBAY_CLIENT_SECRET', 'приложение eBay')
    ? {
      environment: env.REPRACER_EBAY_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' as const : 'SANDBOX' as const,
      clientId: env.REPRACER_EBAY_CLIENT_ID!, ruName: env.REPRACER_EBAY_RUNAME!,
      clientSecret: requiredValue(secretFromEnv(env, 'REPRACER_EBAY_CLIENT_SECRET', read), 'REPRACER_EBAY_CLIENT_SECRET_FILE'),
      // Scope Inventory API не подтверждён снимком (E-08): его называет конфигурация, а не код
      scopes: env.REPRACER_EBAY_SCOPES!.split(/\s+/).filter(Boolean),
    }
    : null;
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
      ? { channel: 'EBAY', marketplaces: EBAY_MARKETPLACES, platformMissing: [], provider: ebayOAuth({ environment: c.ebay.environment, clientId: c.ebay.clientId, clientSecret: c.ebay.clientSecret, redirectUri: c.ebay.ruName, scopes: c.ebay.scopes }) }
      : { channel: 'EBAY', marketplaces: EBAY_MARKETPLACES, platformMissing: ['EBAY_DEVELOPER_KEYS'], provider: null },
  ];
}

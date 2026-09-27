import { refreshAccess, type TokenFailure } from './flow.ts';
import type { Fetch, OAuthProvider } from './providers.ts';
import { openToken, type Keyring, type SealedToken } from './vault.ts';

/**
 * Р-177 (шаг 43): фоновая проверка авторизаций. Каждый действующий токен время от времени обменивается на access-токен —
 * это и есть единственный способ узнать, что продавец отозвал доступ в кабинете канала: уведомления об отзыве в снимках
 * спецификаций нет (A-18, E-09). Итог записывает БАЗА (`security.channel_authorization_checked`): отзыв переводит аккаунт в
 * `REVOKED` с CRITICAL-алертом, который доставка отправляет владельцу письмом [Р-156]; сеть и сбой канала — счётчик.
 *
 * Сломанные ключи НАШЕГО приложения (PLATFORM) — не новость для продавца: итог уходит в базу счётчиком, а наверх —
 * алертом платформы для оператора. Токен не покидает эту функцию: ни в журнал, ни в итог, ни в ошибку.
 */

export interface CheckableCredential {
  tenantId: string;
  channelAccountId: string;
  channel: string;
  region: string | null;
  credentialId: string;
  sealed: SealedToken;
}

export interface CredentialVaultPort {
  due(olderThanSeconds: number, limit: number): Promise<CheckableCredential[]>;
  recordCheck(tenantId: string, credentialId: string, outcome: 'OK' | TokenFailure, code: string | null): Promise<string>;
  /** Шаг 45 (хвост шага 43): вытесненные версии старше 30 суток удаляет база функцией хранителя; ответ — сколько */
  purgeSuperseded(): Promise<number>;
}

export interface AuthorizationCheckOutcome {
  checked: number;
  ok: number;
  revoked: number;
  transient: number;
  platform: number;
  /** Канала нет в реестре поставщиков процесса — проверить нечем; не отзыв и не ошибка продавца */
  noProvider: number;
  /** Каналы, у которых отказали НАШИ ключи приложения — для алерта оператору */
  platformChannels: string[];
  /**
   * Находка 7 ревью шага 43: отзывов за проход подозрительно много (не меньше трёх и больше половины проверенных) — это
   * скорее наша поломка (перерегистрация приложения, порча токенов), чем одновременное решение продавцов. Такие отказы
   * записаны как временные с кодом `SUSPICIOUS_MASS_INVALID_GRANT`, аккаунты не тронуты, писем продавцам нет.
   */
  suspiciousRevocations: number;
  /** Находка 15 ревью шага 43: токен не открывается нашим кольцом ключей — поломка хранения, а не ключей приложения */
  keyringFailures: number;
  /** Вытесненных версий токенов удалено по сроку за проход */
  purged: number;
}

/** Порог предохранителя: отзывов за проход не меньше этого числа И больше половины проверенных */
export const MASS_REVOCATION_MIN = 3;

export interface AuthorizationCheckerOptions {
  vault: CredentialVaultPort;
  keyring: Keyring;
  provider: (c: { channel: string; region: string | null }) => OAuthProvider | null;
  http: Fetch;
  /** Как давно проверенный токен проверять снова */
  olderThanSeconds: number;
  limit: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createAuthorizationChecker(o: AuthorizationCheckerOptions) {
  return {
    async check(): Promise<AuthorizationCheckOutcome> {
      const out: AuthorizationCheckOutcome = { checked: 0, ok: 0, revoked: 0, transient: 0, platform: 0, noProvider: 0, platformChannels: [], suspiciousRevocations: 0, keyringFailures: 0, purged: 0 };
      // Срок вытесненных токенов — каждым проходом: шифротекст, который больше не нужен, не живёт дольше срока
      // Находка 6 ревью шага 45: уборка — вспомогательная; её сбой не должен останавливать обнаружение отзывов
      try {
        out.purged = await o.vault.purgeSuperseded();
      } catch (error) {
        o.log?.('CHANNEL_CREDENTIALS_PURGE_FAILED', { message: error instanceof Error ? error.message : String(error) });
      }
      const revoked: Array<{ c: CheckableCredential; code: string }> = [];
      const platform = (channel: string) => { out.platform += 1; if (!out.platformChannels.includes(channel)) out.platformChannels.push(channel); };
      for (const c of await o.vault.due(o.olderThanSeconds, o.limit)) {
        const provider = o.provider(c);
        if (!provider) {
          out.noProvider += 1;
          continue;
        }
        out.checked += 1;
        let token: string;
        try {
          token = openToken(o.keyring, c.sealed, c);
        } catch {
          // Не открывается нашим кольцом ключей — это наша поломка (ключ удалён или подменён), а не отзыв продавцом
          await o.vault.recordCheck(c.tenantId, c.credentialId, 'PLATFORM', 'KEYRING');
          out.keyringFailures += 1;
          continue;
        }
        const r = await refreshAccess(provider, token, o.http);
        if (r.ok) {
          await o.vault.recordCheck(c.tenantId, c.credentialId, 'OK', null);
          out.ok += 1;
          continue;
        }
        // Отзыв записывается ПОСЛЕ прохода: сперва видно, не отказывают ли каналы всем сразу
        if (r.failure === 'REVOKED') { revoked.push({ c, code: r.code }); continue; }
        const result = await o.vault.recordCheck(c.tenantId, c.credentialId, r.failure, r.code);
        if (r.failure === 'TRANSIENT') out.transient += 1;
        else platform(c.channel);
        o.log?.('channel_authorization_check_failed', { tenantId: c.tenantId, channelAccountId: c.channelAccountId, failure: r.failure, code: r.code, result });
      }
      const suspicious = revoked.length >= MASS_REVOCATION_MIN && revoked.length * 2 > out.checked;
      for (const { c, code } of revoked) {
        const result = await o.vault.recordCheck(c.tenantId, c.credentialId, suspicious ? 'TRANSIENT' : 'REVOKED', suspicious ? 'SUSPICIOUS_MASS_INVALID_GRANT' : code);
        if (suspicious) out.suspiciousRevocations += 1;
        else out.revoked += 1;
        o.log?.('channel_authorization_check_failed', { tenantId: c.tenantId, channelAccountId: c.channelAccountId, failure: suspicious ? 'SUSPICIOUS' : 'REVOKED', code, result });
      }
      return out;
    },
  };
}

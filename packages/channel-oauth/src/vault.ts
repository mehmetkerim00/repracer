import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Р-177 (шаг 43): refresh-токен канала хранится ТОЛЬКО зашифрованным. AES-256-GCM: шифротекст, 12 байт вектора и 16
 * байт метки подлинности; ключ — в ФАЙЛЕ секретов на машине, в базе и в репозитории его нет. Копия базы токенов не
 * раскрывает, а подменённый шифротекст не расшифровывается (метка GCM).
 *
 * Связанные данные (AAD) — тенант и аккаунт: шифротекст одного аккаунта, переложенный в строку другого, не откроется.
 * Иначе строка с правом записи в таблицу могла бы «переселить» чужой токен себе.
 */

export interface Keyring {
  /** Ключ, которым шифруются НОВЫЕ токены; старые открываются своим `key_id` — так ключ меняется без перешифровки */
  current: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface SealedToken {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Файл ключей: `{"current":"k1","keys":{"k1":"<32 байта base64>"}}`. Ошибка разбора называет ЧТО не так, но не
 * содержимое файла: ключ в сообщение об ошибке не попадает никогда.
 */
export function loadKeyring(text: string): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('CREDENTIALS_KEYRING_UNREADABLE');
  }
  const obj = parsed as { current?: unknown; keys?: unknown };
  if (typeof obj.current !== 'string' || !obj.keys || typeof obj.keys !== 'object') throw new Error('CREDENTIALS_KEYRING_SHAPE');
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(obj.keys as Record<string, unknown>)) {
    if (!KEY_ID.test(id) || typeof value !== 'string') throw new Error('CREDENTIALS_KEYRING_SHAPE');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_KEYRING_KEY_LENGTH');
    keys.set(id, key);
  }
  if (!keys.has(obj.current)) throw new Error('CREDENTIALS_KEYRING_NO_CURRENT');
  return { current: obj.current, keys };
}

/** Кольцо ключей для прогонов и тестов: ключ случайный, живёт в памяти процесса и нигде не сохраняется */
export function ephemeralKeyring(id = 'test'): Keyring {
  return { current: id, keys: new Map([[id, randomBytes(32)]]) };
}

const aad = (tenantId: string, channelAccountId: string) => Buffer.from(`repracer/channel-credential/v1/${tenantId}/${channelAccountId}`, 'utf8');

export function sealToken(keyring: Keyring, token: string, owner: { tenantId: string; channelAccountId: string }): SealedToken {
  const key = keyring.keys.get(keyring.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(owner.tenantId, owner.channelAccountId));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { keyId: keyring.current, iv, authTag: cipher.getAuthTag(), ciphertext };
}

export function openToken(keyring: Keyring, sealed: SealedToken, owner: { tenantId: string; channelAccountId: string }): string {
  const key = keyring.keys.get(sealed.keyId);
  if (!key) throw new Error('CREDENTIALS_KEY_UNKNOWN');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
    decipher.setAAD(aad(owner.tenantId, owner.channelAccountId));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Ни шифротекст, ни ключ в ошибку не попадают: сообщение говорит только, ЧТО случилось
    throw new Error('CREDENTIALS_TAMPERED_OR_WRONG_ACCOUNT');
  }
}

/** Параметр `state`: 32 случайных байта; в базу уходит только SHA-256 [Р-177] */
export function newState(): { state: string; stateSha256: Buffer } {
  const state = randomBytes(32).toString('base64url');
  return { state, stateSha256: stateDigest(state) };
}

export const stateDigest = (state: string): Buffer => createHash('sha256').update(state, 'utf8').digest();

/**
 * Р-177 (шаг 43): вторая линия против утечки токена в журнал. Первая — код не передаёт токены в журнал вовсе; эта
 * ловит то, что всё-таки туда попало: формы токенов, известные из снимков (`Atzr|`, `Atza|` — пример документации
 * Amazon; `v^1.…#` — форма токенов eBay), параметры кода согласия и refresh-токена в строке запроса или теле.
 *
 * Список форм явный: маскировать «всё похожее на секрет» значит испортить журнал и всё равно пропустить новое. Новая
 * форма — строка здесь И строка в правиле репозитория, которое ищет эти формы в доказательствах.
 */
export const TOKEN_PATTERNS: readonly RegExp[] = [
  /Atz[ar]\|[A-Za-z0-9_\-+/=.]+/g,
  /v\^1\.[0-9]+#[^\s"'&]+/g,
  /(spapi_oauth_code|refresh_token|access_token|client_secret|code)=([^&\s"']+)/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(TOKEN_PATTERNS[0]!, (m) => `${m.slice(0, 5)}[скрыто]`);
  out = out.replace(TOKEN_PATTERNS[1]!, 'v^1.[скрыто]');
  out = out.replace(TOKEN_PATTERNS[2]!, (_m, k: string) => `${k}=[скрыто]`);
  return out;
}

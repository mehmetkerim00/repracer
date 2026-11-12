import { ConfigError, type Env } from './env.ts';

/**
 * Шаг 121 (QA-A, видимая версия сборки): какой код работает. Задаёт развёртывание (`REPRACER_BUILD_SHA` — коммит, `REPRACER_BUILD_AT` —
 * время сборки), процесс называет её в `/healthz`, а консоль — человеку в подвале страницы: в отчёте об ошибке видно, на какой версии она.
 * Не задана — сборка неизвестна (запуск разработчика), а не выдуманная; задана криво — отказ при старте
 */
export interface BuildInfo {
  /** Коммит: 7–40 шестнадцатеричных знаков; `-dirty` — дерево с правками, версия не выдаёт себя за чистую */
  sha: string;
  /** Время сборки, ISO; null — развёртывание его не назвало */
  builtAt: string | null;
}

const SHA = /^[0-9a-f]{7,40}(-dirty)?$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function buildInfoFromEnv(env: Env): BuildInfo | null {
  const sha = env.REPRACER_BUILD_SHA?.trim() ?? '';
  const at = env.REPRACER_BUILD_AT?.trim() ?? '';
  if (sha === '') {
    if (at !== '') throw new ConfigError('CONFIG_INVALID: REPRACER_BUILD_AT is set without REPRACER_BUILD_SHA');
    return null;
  }
  if (!SHA.test(sha)) throw new ConfigError('CONFIG_INVALID: REPRACER_BUILD_SHA must be a git commit (7–40 hex digits, optionally -dirty)');
  if (at !== '' && (!AT.test(at) || Number.isNaN(Date.parse(at)))) throw new ConfigError('CONFIG_INVALID: REPRACER_BUILD_AT must be an ISO time');
  return { sha, builtAt: at === '' ? null : new Date(Date.parse(at)).toISOString() };
}

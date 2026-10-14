/**
 * Шаг 79: галерея экранов для проверки дизайна — стенд в памяти со всеми мирами сценариев и ПУСТЫМ рабочим пространством (без
 * предложений и каналов), плюс Vite с прокси на него. Демо-стенд показывает один настроенный мир; пустые состояния, «не найдено»
 * и экраны миров сценариев видны только здесь. Не тест и не часть сборки: запускается руками, держит порты, пока не прерван.
 *
 * Использование: node --experimental-strip-types apps/console/test/gallery-stand.ts [порт стенда] [порт интерфейса]
 * (по умолчанию 4329 и 5183, только 127.0.0.1)
 */
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildStandWorlds, memoryStandDirectory, STAND_AUDIENCE, STAND_ISSUER } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import { EMPTY_WORLD_ID, emptyWorld, emptyWorldConnect } from './empty-world.ts';

const standPort = Number(process.argv[2] ?? 4329);
const uiPort = Number(process.argv[3] ?? 5183);
const root = fileURLToPath(new URL('..', import.meta.url));

const worlds = await buildStandWorlds();
// Пустое рабочее пространство: ни предложений, ни аккаунтов канала — экраны отвечают пустыми состояниями с объяснением (шаг 87 — общий модуль)
const empty = emptyWorld(worlds[0]!.clock);
const all = [empty, ...worlds];
const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
const handle = createStandApi(all, {
  authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(all) }),
  simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 8 * 3600 },
}, {
  defaultLocale: 'en',
  // Как у сервера с настроенными приложениями каналов: пустое рабочее пространство видит кнопки подключения Amazon и eBay
  connect: (worldId) => (worldId !== EMPTY_WORLD_ID ? null : emptyWorldConnect),
  // Шаг 87: галерея показывает всё предложение — профиль задаётся тем же значением, что у стенда (по умолчанию global)
  ...(process.env.REPRACER_MARKET_PROFILE ? { market: process.env.REPRACER_MARKET_PROFILE as 'us' | 'eu' | 'global' } : {}),
});
const stand = createStandServer(handle);
await new Promise<void>((resolve) => stand.listen(standPort, '127.0.0.1', resolve));
const vite = await createServer({
  root, configFile: `${root}vite.config.ts`, logLevel: 'silent',
  server: { host: '127.0.0.1', port: uiPort, strictPort: true, hmr: false, proxy: { '/api': `http://127.0.0.1:${standPort}` } },
});
await vite.listen();
console.log(`gallery: ${all.length} workspaces (one empty) — http://127.0.0.1:${uiPort}/`);

import { useCallback, useEffect, useState } from 'react';
import { LOCALES, messagesFor, type Locale } from '@repracer/console-model';
import type { SessionView, StandToken, WorldSummary } from './api-types.ts';
import { requestJson, setAccessToken, useResource, type Resource } from './api.ts';
import { Badge, ErrorBox, errorText, href, Load, MessagesContext, useMessages } from './components.tsx';
import { BoundsScreen } from './screens/Bounds.tsx';
import { ComplianceScreen } from './screens/Compliance.tsx';
import { JobHistory } from './screens/Jobs.tsx';
import { OnboardingScreen } from './screens/Onboarding.tsx';
import { StockScreen } from './screens/Stock.tsx';
import { DangerousScreen } from './screens/Dangerous.tsx';
import { FeedScreen } from './screens/Feed.tsx';
import { StrategiesScreen } from './screens/Strategies.tsx';
import { DecisionsScreen, TraceScreen } from './screens/Decisions.tsx';
import { CostImportScreen } from './screens/CostImport.tsx';
import { ProductsScreen } from './screens/Products.tsx';
import { RejectedScreen } from './screens/Rejected.tsx';
import { StopScreen } from './screens/Stop.tsx';

export interface Route {
  worldId: string | null;
  screen: string;
  param: string | null;
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'w' || !parts[1]) return { worldId: null, screen: 'worlds', param: null };
  return { worldId: parts[1], screen: parts[2] ?? 'products', param: parts[3] ?? null };
}

/**
 * Р-142 (шаг 31): у массовых операций есть СВОЙ экран. Без него готовый файл и кнопка отмены жили только в состоянии того
 * экрана, с которого задание запустили: продавец уходил на другую страницу — и файл, лежащий в базе, становился недостижим
 * (находка 8 ревью шага 31).
 */
/** Р-149 (шаг 34): путь онбординга — первый экран: с него продавец начинает и к нему возвращается, пока путь не пройден */
const SCREENS = ['onboarding', 'stock', 'products', 'decisions', 'strategies', 'feed', 'rejected', 'dangerous', 'bounds', 'cost-import', 'compliance', 'jobs', 'stop'] as const;

/** Вход [Р-78]: у поставщика identity; на стенде — имитатор с синтетическими пользователями. Паролей у нас нет */
export function LoginView({ simulator, error, busy, onSignIn }: {
  simulator: SessionView['simulator'];
  error: string | null;
  busy: boolean;
  onSignIn: (role: string) => void;
}) {
  const m = useMessages();
  const l = m.ui.app.login;
  return (
    <section className="card login">
      <h2>{l.title}</h2>
      <p className="muted">{l.hint}</p>
      {simulator ? (
        <>
          <p className="notice">{l.simulator}</p>
          <div className="buttons">
            {simulator.map((a) => <button key={a.role} type="button" disabled={busy} onClick={() => onSignIn(a.role)}>{l.asAccount(a.label)}</button>)}
          </div>
        </>
      ) : <p className="notice">{l.noSimulator}</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

export function WorldList({ worlds }: { worlds: readonly WorldSummary[] }) {
  const m = useMessages();
  if (worlds.length === 0) return <p className="notice">{m.ui.app.login.noWorlds}</p>;
  return (
    <section>
      <h2>{m.ui.app.worlds}</h2>
      <p className="muted">{m.ui.app.worldsHint}</p>
      <ul className="worlds">
        {worlds.map((w) => (
          <li key={w.id} className="card">
            <h3><a href={href(w.id, 'products')}>{w.title}</a></h3>
            <p className="small muted">{w.description}</p>
            <p className="small">
              {w.demo ? <><Badge tone="warn">{m.ui.app.demoBadge}</Badge> · </> : null}
              {w.awaitingAccess > 0 ? <><Badge tone="warn">{m.ui.onboarding.channels.status.AWAITING_ACCESS}: {w.awaitingAccess}</Badge> · </> : null}
              {w.role} · {m.ui.app.counts(w.scopes, w.decisionsLastDay, w.interventionsLastWeek)}
              {w.activeStops > 0 ? <> · <Badge tone="stop">{m.ui.app.activeStops(w.activeStops)}</Badge></> : null}
              {w.activeHalts > 0 ? <> · <Badge tone="warn">{m.ui.app.activeHalts(w.activeHalts)}</Badge></> : null}
              {w.failures.length > 0 ? <> · <Badge tone="warn">{m.ui.app.diverged(w.failures.length)}</Badge></> : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorldScreen({ route, worlds }: { route: Route & { worldId: string }; worlds: readonly WorldSummary[] }) {
  const m = useMessages();
  const world = worlds.find((w) => w.id === route.worldId);
  if (!world) return <p className="error">{m.ui.app.worldNotFound(route.worldId)} <a href="#/">{m.ui.app.backToWorlds}</a></p>;
  return (
    <>
      {/* Р-151: демо помечается на КАЖДОМ экране мира — деньги показываются на большинстве из них */}
      {world.demo ? <p className="notice demo-banner" role="note"><Badge tone="warn">{m.ui.app.demoBadge}</Badge> {m.ui.app.demoBanner}</p> : null}
      <nav className="tabs">
        <a href="#/">{m.ui.app.backToWorlds}</a>
        <strong>{world.title}</strong>
        {SCREENS.map((key) => (
          <a key={key} href={href(world.id, key)} className={route.screen === key ? 'active' : ''}>{m.ui.app.screens[key]}</a>
        ))}
      </nav>
      {route.screen === 'onboarding' ? <OnboardingScreen worldId={world.id} />
        : route.screen === 'stock' ? <StockScreen worldId={world.id} />
        : route.screen === 'products' ? <ProductsScreen worldId={world.id} />
        : route.screen === 'decisions' ? (route.param ? <TraceScreen worldId={world.id} decisionId={route.param} /> : <DecisionsScreen worldId={world.id} />)
          : route.screen === 'rejected' ? <RejectedScreen worldId={world.id} />
            : route.screen === 'bounds' ? <BoundsScreen worldId={world.id} writeScopeId={route.param} />
              : route.screen === 'cost-import' ? <CostImportScreen worldId={world.id} />
              : route.screen === 'stop' ? <StopScreen worldId={world.id} />
                : route.screen === 'strategies' ? <StrategiesScreen worldId={world.id} />
                  : route.screen === 'feed' ? <FeedScreen worldId={world.id} />
                    : route.screen === 'dangerous' ? <DangerousScreen worldId={world.id} days={[1, 7, 30].includes(Number(route.param)) ? Number(route.param) : 7} />
                      : route.screen === 'compliance' ? <ComplianceScreen worldId={world.id} />
                        : route.screen === 'jobs' ? <JobHistory worldId={world.id} />
                : <p className="error">{m.ui.app.screenNotFound}</p>}
    </>
  );
}

function SignedIn({ route }: { route: Route }) {
  const m = useMessages();
  const [worlds, retry] = useResource<WorldSummary[]>('/api/worlds', m.locale);
  return (
    <Load resource={worlds} retry={retry}>
      {(list) => (route.worldId === null ? <WorldList worlds={list} /> : <WorldScreen route={{ ...route, worldId: route.worldId }} worlds={list} />)}
    </Load>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [locale, setLocale] = useState<Locale>('de');
  const [session, setSession] = useState<Resource<SessionView>>(() => ({ state: 'loading', startedAt: Date.now() }));
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const m = messagesFor(locale);

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const apply = useCallback((p: Promise<SessionView>) => {
    p.then((s) => { setSession({ state: 'ready', data: s }); setLocale(s.locale); }, (error: unknown) => setSession({ state: 'error', error }));
  }, []);
  const loadSession = useCallback(() => apply(requestJson<SessionView>('/api/session')), [apply]);
  useEffect(loadSession, [loadSession]);

  const signIn = async (role: string) => {
    setBusy(true);
    setLoginError(null);
    try {
      const { accessToken } = await requestJson<StandToken>('/api/stand-issuer/token', { method: 'POST', body: { role }, locale });
      setAccessToken(accessToken);
      setSession({ state: 'ready', data: await requestJson<SessionView>('/api/session', { locale }) });
    } catch (error) {
      setLoginError(errorText(error, m));
    } finally {
      setBusy(false);
    }
  };

  const changeLocale = (next: Locale) => {
    setLocale(next);
    apply(requestJson<SessionView>('/api/session/locale', { method: 'POST', body: { locale: next } }));
  };

  const user = session.state === 'ready' ? session.data.user : null;
  return (
    <MessagesContext.Provider value={m}>
      <div className="app" lang={locale}>
        <header>
          <h1>{m.ui.app.title}</h1>
          <span className="muted small">{m.ui.app.stand}</span>
          <span className="spacer" />
          {LOCALES.map((l) => (
            <button key={l} type="button" className={l === locale ? 'active' : ''} aria-pressed={l === locale} onClick={() => changeLocale(l)}>{m.ui.app.languages[l]}</button>
          ))}
          {user ? (
            <>
              <span className="small">{m.ui.app.login.signedIn(user.email ?? user.subject)}</span>
              <button type="button" onClick={() => { setAccessToken(null); loadSession(); }}>{m.ui.app.login.logout}</button>
            </>
          ) : null}
        </header>
        <main>
          {session.state === 'loading' ? <p className="loading" role="status">{m.ui.app.loading(8)}</p>
            : session.state === 'error' ? <ErrorBox message={errorText(session.error, m)} onRetry={loadSession} />
              : user
                ? <SignedIn key={user.subject} route={route} />
                : <LoginView simulator={session.data.simulator} error={loginError} busy={busy} onSignIn={(role) => void signIn(role)} />}
        </main>
      </div>
    </MessagesContext.Provider>
  );
}

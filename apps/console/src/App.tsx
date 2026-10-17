import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { LOCALES, messagesFor, type Locale } from '@repracer/console-model';
import type { SessionView, StandToken, WorldSummary } from './api-types.ts';
import { requestJson, setAccessToken, useResource, type Resource } from './api.ts';
import { Badge, ErrorBox, errorText, href, Intro, Load, MarketContext, MessagesContext, NotFound, useMessages } from './components.tsx';
import { BrandMark, Icon, Octicon } from './icons.tsx';
import { applyTheme, storedTheme, systemDark, type ThemeChoice } from './theme.ts';
import { ZoneContext } from './date-range.tsx';
import { BoundsScreen } from './screens/Bounds.tsx';
import { CompetitionScreen } from './screens/Competition.tsx';
import { ChannelsScreen } from './screens/Channels.tsx';
import { ComplianceScreen } from './screens/Compliance.tsx';
import { CostsScreen } from './screens/Costs.tsx';
import { JobHistory } from './screens/Jobs.tsx';
import { ProtectionsScreen } from './screens/Protections.tsx';
import { ShadowScreen } from './screens/Shadow.tsx';
import { captureLoginReturns, completeLogin, forgetInvitation, pendingInvitation, startLogin } from './login.ts';
import { captureConnectCallback, ConnectCallback, pendingConnectCallback } from './screens/Connections.tsx';

// Р-175: возврат от канала запоминается ДО входа — адрес стирается сразу, код согласия в истории браузера не живёт
captureConnectCallback();
// Шаг 44 [Р-178]: возврат от поставщика входа и ссылка приглашения — тоже до входа
captureLoginReturns();
import { StockScreen } from './screens/Stock.tsx';
import { FeedScreen } from './screens/Feed.tsx';
import { StrategiesScreen } from './screens/Strategies.tsx';
import { TraceScreen } from './screens/Decisions.tsx';
import { ProductsScreen } from './screens/Products.tsx';
import { StopScreen } from './screens/Stop.tsx';

export interface Route {
  worldId: string | null;
  screen: string;
  param: string | null;
  /** Шаг 95: второй параметр — период вкладки «Prevented by rules» (`protections/rules/30`) */
  param2?: string | null;
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'w' || !parts[1]) return { worldId: null, screen: 'worlds', param: null };
  return { worldId: parts[1], screen: parts[2] ?? 'products', param: parts[3] ?? null, param2: parts[4] ?? null };
}

/**
 * Шаг 95 [Р-217]: меню из 9 пунктов. Прежние адреса не ломаются — закладки, ссылки из писем и старые вкладки ведут на новые места,
 * к нужному разделу. Квитанция решения (`decisions/<id>`, «Why this price») и страница предложения (`bounds/<id>`, «Bounds and price
 * floor») остаются своими адресами
 */
export function redirectOf(route: Pick<Route, 'screen' | 'param'>): string[] | null {
  switch (route.screen) {
    case 'decisions': return route.param === null ? ['feed', 'decisions'] : null;
    case 'rejected': return ['protections', 'rules'];
    case 'dangerous': return ['protections', 'rules', ...(route.param ? [route.param] : [])];
    case 'bounds': return route.param === null ? ['costs'] : null;
    case 'cost-import': return ['costs', 'import'];
    case 'connections': return ['channels', 'accounts'];
    case 'onboarding': return ['channels'];
    case 'jobs': return ['products', 'bulk'];
    // Шаг 96 (В19): страница остатков — Inventory
    case 'stock': return ['inventory'];
    default: return null;
  }
}

/** Пункт меню экрана, у которого своего пункта нет: квитанция решения — журнал цен, страница предложения — Costs & floors */
// Шаг 97: страница Competition предложения — из строки Offers, своего пункта меню у неё нет (меню остаётся из 9 пунктов)
const MENU_OF: Readonly<Record<string, string>> = { decisions: 'feed', bounds: 'costs', competition: 'products' };

/**
 * Р-142 (шаг 31): у массовых операций есть СВОЙ экран. Без него готовый файл и кнопка отмены жили только в состоянии того
 * экрана, с которого задание запустили: продавец уходил на другую страницу — и файл, лежащий в базе, становился недостижим
 * (находка 8 ревью шага 31).
 */
/** Р-149 (шаг 34): путь онбординга — первый экран: с него продавец начинает и к нему возвращается, пока путь не пройден */
/** Шаг 77: экраны мира — группами боковой панели (порядок групп и экранов — порядок показа продукта) */
/** Шаг 95 [Р-217]: 9 пунктов вместо 14 — функции те же, лишних дверей нет; Omnibus — только где действует правило ЕС */
// Шаг 96 (аудит В19): Offers — в разделе Pricing; раздел и страница остатков — Inventory
const NAV_GROUPS = [
  ['overview', ['shadow']],
  ['pricing', ['feed', 'strategies', 'costs', 'protections', 'products']],
  ['stock', ['inventory']],
  ['account', ['channels', 'compliance', 'stop']],
] as const;

/**
 * Шаг 85: на узких экранах (< 1012px, брейкпоинт large Primer) навигация — выдвижной панелью. Состояние — у приложения: кнопка меню живёт
 * в шапке, панель — у рабочего пространства; туда же на узких экранах переезжают переключатель языка, адрес и «Sign out» (`extras`)
 */
interface NavState { open: boolean; setOpen: (open: boolean) => void; extras: ReactNode }
const NavContext = createContext<NavState>({ open: false, setOpen: () => undefined, extras: null });

/** Шаг 81: знак у каждого пункта боковой панели — подпись та же, иконка только помогает глазу найти пункт */
/**
 * Шаг 96 (аудит, I): у каждого пункта своя иконка Octicons, смысл читается без подписи — таблица «пункт → иконка → почему» в
 * docs/evidence/step96-ux.md; смоук утверждает, что иконки не повторяются
 */
export const NAV_ICONS: Readonly<Record<string, string>> = {
  shadow: 'eye', feed: 'history', strategies: 'goal', costs: 'tag', protections: 'shield-check',
  products: 'list-unordered', inventory: 'package', channels: 'plug', compliance: 'law', stop: 'stop',
};

/** Вход [Р-78]: у поставщика identity; на стенде — имитатор с синтетическими пользователями. Паролей у нас нет */
/** Знак роли на карточке входа — две буквы, у каждой роли свой */

export function LoginView({ simulator, demoGuest, oidc, error, busy, onSignIn, onDemo }: {
  /** Шаг 44 [Р-178]: настоящий вход у поставщика identity */
  oidc?: SessionView['oidc'];
  simulator: SessionView['simulator'];
  /** Р-160: публичное демо включено — кнопка «посмотреть демо» ведёт внутрь без регистрации */
  demoGuest: boolean;
  error: string | null;
  busy: boolean;
  onSignIn: (role: string) => void;
  onDemo: () => void;
}) {
  const m = useMessages();
  const l = m.ui.app.login;
  return (
    <div className="login-wrap">
    {/* Шаг 83: без бренд-панели и градиентов — знак, имя и строка о продукте над карточкой входа, как у входа Primer */}
    <header className="login-head">
      <div className="login-brand"><BrandMark size={32} />{m.ui.app.brand}</div>
      <p className="login-tagline">{l.tagline}</p>
    </header>
    <section className="card login">
      <h2>{l.title}</h2>
      {/* Шаг 79 (ревью): вступление входа — одно предложение и «Learn more», как подзаголовки экранов */}
      <Intro text={l.hint} />
      {oidc ? (
        <div className="buttons">
          <button type="button" className="primary" disabled={busy} onClick={() => void startLogin(oidc)}>{m.ui.app.signIn}</button>
          {pendingInvitation() ? <p className="notice">{m.ui.app.invitation.signInFirst}</p> : null}
        </div>
      ) : null}
      {demoGuest ? (
        <>
          <p className="muted">{l.demoGuestHint}</p>
          <div className="buttons">
            <button type="button" className="primary" disabled={busy} onClick={onDemo}>{l.demoGuest}</button>
          </div>
        </>
      ) : null}
      {simulator ? (
        <>
          <p className="test-line">{l.simulator}</p>
          {/* Шаг 77: роли — сеткой карточек; знак роли рисуется стилями (data-initial). Шаг 78: у каждой роли свой знак (Owner и
              Operator оба были «O»), подпись — словарём на языке экрана (роли стенда по-немецки были английскими). Шаг 84: роли — одной
              колонкой: цветной кружок (шкала Primer Label, у роли свой цвет), имя роли и одной строкой, что роль может; «Sign in as …» —
              доступное имя кнопки */}
          <ul className="role-list">
            {simulator.map((a) => {
              const label = (m.values as Record<string, string | undefined>)[a.role] ?? a.label;
              return (
                <li key={a.role}>
                  <button type="button" className={`role-row role-${a.role}`} aria-label={l.asAccount(label)} disabled={busy} onClick={() => onSignIn(a.role)}>
                    <span className="role-dot" aria-hidden="true">{(l.roleMarks as Record<string, string | undefined>)[a.role] ?? label.slice(0, 2)}</span>
                    <span className="role-name">{label}</span>
                    <span className="role-can">{(l.roleCan as Record<string, string | undefined>)[a.role] ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : <p className="notice">{l.noSimulator}</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
    </div>
  );
}

/** Шаг 79: страница не найдена — карточка с заголовком, объяснением и путём обратно */
export function WorldList({ worlds }: { worlds: readonly WorldSummary[] }) {
  const m = useMessages();
  if (worlds.length === 0) return <p className="notice">{m.ui.app.login.noWorlds}</p>;
  const nf = new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US');
  return (
    // Шаг 84.1: заголовок и сетка карточек — по центру страницы: одна карточка не висит у левого края
    <section className="worlds-page">
      <h2>{m.ui.app.worlds}</h2>
      <p className="subtitle">{m.ui.app.worldsHint}</p>
      <ul className="worlds">
        {worlds.map((w) => (
          <li key={w.id} className="card">
            {/* Шаг 76 (предполётный прогон демо): демо в тени открывается экраном тени — с него начинается показ; экран входа выбирает
                сервер (демо в бою и миры продавцов — товары) */}
            <h3><a href={href(w.id, w.landing)}>{w.title}</a></h3>
            <p className="small muted">{w.description}</p>
            {/* Шаг 77: пилюли — своей строкой, роль и счётчики — строкой под ними, без перемешивания с «·» */}
            <div className="world-pills">
              {w.demo ? <Badge tone="warn">{m.ui.app.demoBadge}</Badge> : null}
              {w.awaitingAccess > 0 ? <Badge tone="warn">{m.ui.onboarding.channels.status.AWAITING_ACCESS}: {w.awaitingAccess}</Badge> : null}
              {w.activeStops > 0 ? <Badge tone="stop">{m.ui.app.activeStops(w.activeStops)}</Badge> : null}
              {w.activeHalts > 0 ? <Badge tone="warn">{m.ui.app.activeHalts(w.activeHalts)}</Badge> : null}
              {w.failures.length > 0 ? <Badge tone="warn">{m.ui.app.diverged(w.failures.length)}</Badge> : null}
            </div>
            {/* Шаг 84: показатели — подпись мелко над числом, вместо строки через точки; роль — подписью под ними */}
            <dl className="world-metrics">
              <div><dt>{m.ui.app.metrics.offers}</dt><dd>{nf.format(w.scopes)}</dd></div>
              <div><dt>{m.ui.app.metrics.decisions}</dt><dd>{nf.format(w.decisionsLastDay)}</dd></div>
              <div><dt>{m.ui.app.metrics.interventions}</dt><dd>{nf.format(w.interventionsLastWeek)}</dd></div>
            </dl>
            {w.role ? <p className="small muted world-meta">{w.role}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorldScreen({ route, worlds }: { route: Route & { worldId: string }; worlds: readonly WorldSummary[] }) {
  const outer = useMessages();
  const nav = useContext(NavContext);
  const market = useContext(MarketContext);
  const { setOpen } = nav;
  // Панель закрывается переходом на другой экран (выбор пункта) и клавишей Esc
  useEffect(() => { setOpen(false); }, [route.worldId, route.screen, route.param, setOpen]);
  useEffect(() => {
    if (!nav.open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav.open, setOpen]);
  // Шаг 95 [Р-217]: прежний адрес — замена адреса, а не новая запись истории: «назад» не возвращает на перенаправление
  const redirect = redirectOf(route);
  const redirectTo = redirect ? href(route.worldId, ...redirect) : null;
  useEffect(() => { if (redirectTo) window.location.replace(redirectTo); }, [redirectTo]);
  const world = worlds.find((w) => w.id === route.worldId);
  // Шаг 79: «не найдено» — карточкой с заголовком и путём обратно, а не строкой ошибки на фоне страницы
  if (!world) return <NotFound title={outer.ui.app.worldNotFoundTitle} text={outer.ui.app.worldNotFound(route.worldId)} back={outer.ui.app.backToWorlds} />;
  /**
   * Шаг 69 (K1, K4): мир тенанта — на языке тенанта и со временем в его поясе: агентство с тенантами DE и US видит каждый на его
   * языке. Переключатель языка в шапке остаётся для экранов вне мира; язык мира меняет администратор тенанта (экран подключений)
   */
  // Ревью шага 69, находка 5: у публичного демо язык не назван — он гостя (переключатель в шапке), а пояс — демо
  const m = world.locale || world.timeZone ? messagesFor(world.locale ?? outer.locale, { timeZone: world.timeZone }) : outer;
  const active = MENU_OF[route.screen] ?? route.screen;
  return (
    <MessagesContext.Provider value={m}>
      {/* Шаг 96.1: календарь периода считает дни в поясе пространства — в том же, что сервер */}
      <ZoneContext.Provider value={world.timeZone}>
      {/* Р-151: демо помечается на КАЖДОМ экране мира — деньги показываются на большинстве из них; шаг 77 — тонкой полосой под шапкой */}
      {world.demo ? <p className="demo-strip demo-banner" role="note"><Badge tone="warn">{m.ui.app.demoBadge}</Badge> {m.ui.app.demoBanner}</p> : null}
      <div className={`world-layout${nav.open ? ' nav-open' : ''}`}>
      <aside className="sidebar" id="world-nav">
        <div className="sidebar-inner">
        {/* Шаг 85: крестик — только у выдвижной панели узкого экрана */}
        <button type="button" className="nav-close ghost" aria-label={m.ui.app.closeMenu} onClick={() => setOpen(false)}><Icon name="x" size={20} /></button>
        <div className="workspace">
          <div className="name">{world.title}</div>
          {/* Шаг 100 (A): «All workspaces» — только когда есть из чего выбирать */}
          {worlds.length > 1 ? <a href="#/">{m.ui.app.backToWorlds}</a> : null}
        </div>
        <nav className="tabs-nav" aria-label={world.title}>
          {NAV_GROUPS.map(([group, keys]) => {
            // Шаг 68 (K3): Omnibus — правило ЕС; продавцу только с витринами США пункта нет [Р-123]
            // Шаг 87 [Р-214]: Omnibus — правило ЕС; в профиле без правила ЕС пункта меню нет вовсе
            const shown = keys.filter((key) => key !== 'compliance' || (world.euStorefronts && market.omnibus));
            // Шаг 96.1 (решение владельца): у раздела из одного пункта заголовка нет — пункт стоит своим блоком за разделителем
            const solo = shown.length === 1;
            return (
              <div key={group} className={`nav-group${solo ? ' solo' : ''}`}>
                {solo ? null : <div className="group-title">{m.ui.app.navGroups[group]}</div>}
                {shown.map((key) => (
                  <a key={key} href={href(world.id, key)} className={active === key ? 'active' : ''} aria-current={active === key ? 'page' : undefined} onClick={() => setOpen(false)}><Octicon name={NAV_ICONS[key] ?? ''} size={20} />{m.ui.app.screens[key]}</a>
                ))}
              </div>
            );
          })}
        </nav>
        {nav.extras ? <div className="sidebar-extras">{nav.extras}</div> : null}
        </div>
      </aside>
      {/* клик мимо выдвинутой панели её закрывает */}
      {nav.open ? <div className="nav-backdrop" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      <div className="world-content">
      {redirectTo ? null
        : route.screen === 'shadow' ? <ShadowScreen worldId={world.id} />
        : route.screen === 'feed' ? <FeedScreen worldId={world.id} kind={route.param === 'decisions' ? 'decisions' : 'writes'} />
        : route.screen === 'decisions' && route.param ? <TraceScreen worldId={world.id} decisionId={route.param} />
        : route.screen === 'strategies' ? <StrategiesScreen worldId={world.id} />
        : route.screen === 'costs' ? <CostsScreen worldId={world.id} section={route.param} target={route.param2 ?? null} />
        : route.screen === 'bounds' && route.param ? <BoundsScreen worldId={world.id} writeScopeId={route.param} />
        : route.screen === 'competition' && route.param ? <CompetitionScreen worldId={world.id} writeScopeId={route.param} />
        : route.screen === 'protections' ? <ProtectionsScreen worldId={world.id} tab={route.param === 'people' ? 'people' : 'rules'} days={[1, 7, 30].includes(Number(route.param2)) ? Number(route.param2) : 7} />
        : route.screen === 'products' && route.param === 'bulk'
          ? <><p className="back"><a href={href(world.id, 'products')}>{m.ui.jobs.back}</a></p><h2>{m.ui.jobs.pageTitle}</h2><p className="subtitle">{m.ui.app.subtitles.jobs}</p>
            {/* Шаг 96 (решение по варианту шага 95): кнопка с Offers — «Bulk operations»; отсюда — к трём массовым правкам */}
            <section className="card bulk-links">
              <h3>{m.ui.jobs.links.title}</h3>
              <ul className="index link-list">
                <li><a className="row-link" href={href(world.id, 'costs', 'edit')}>{m.ui.jobs.links.bounds}</a></li>
                <li><a className="row-link" href={href(world.id, 'strategies')}>{m.ui.jobs.links.strategies}</a></li>
                <li><a className="row-link" href={href(world.id, 'costs', 'import')}>{m.ui.jobs.links.costs}</a></li>
              </ul>
            </section>
            <JobHistory worldId={world.id} /></>
        : route.screen === 'products' ? <ProductsScreen worldId={world.id} />
        : route.screen === 'inventory' ? <StockScreen worldId={world.id} />
        : route.screen === 'channels' ? <ChannelsScreen worldId={world.id} section={route.param} />
        : route.screen === 'compliance' ? (world.euStorefronts && market.omnibus ? <ComplianceScreen worldId={world.id} /> : <><h2>{m.ui.app.screens.compliance}</h2><p className="subtitle">{m.ui.app.subtitles.compliance}</p><p className="notice">{m.ui.compliance.notApplicable}</p></>)
        : route.screen === 'stop' ? <StopScreen worldId={world.id} />
        : <NotFound title={m.ui.app.notFoundTitle} text={m.ui.app.screenNotFound} back={m.ui.app.screens.channels} href={href(world.id, 'channels')} />}
      </div>
      </div>
      </ZoneContext.Provider>
    </MessagesContext.Provider>
  );
}

/**
 * Шаг 100 (A): одно рабочее пространство — выбирать не из чего: после входа сразу в него, заменой адреса (кнопка «назад» не возвращает
 * на пустой выбор). Список — только при двух и больше
 */
function OnlyWorld({ world }: { world: WorldSummary }) {
  const m = useMessages();
  useEffect(() => { window.location.replace(href(world.id, world.landing)); }, [world.id, world.landing]);
  return <p className="loading" role="status">{m.ui.app.loading(8)}</p>;
}

function SignedIn({ route }: { route: Route }) {
  const m = useMessages();
  const [worlds, retry] = useResource<WorldSummary[]>('/api/worlds', m.locale);
  const [callback, setCallback] = useState(pendingConnectCallback);
  if (callback) return <ConnectCallback onDone={() => setCallback(false)} />;
  return (
    <Load resource={worlds} retry={retry}>
      {(list) => (route.worldId === null ? (list.length === 1 ? <OnlyWorld world={list[0]!} /> : <WorldList worlds={list} />)
        : <WorldScreen route={{ ...route, worldId: route.worldId }} worlds={list} />)}
    </Load>
  );
}

/**
 * Шаг 100 (C): язык — одно меню вместо трёх ссылок: глобус и код текущего («EN ▾»); по нажатию — языки на их родных именах и галочка
 * у текущего. То же в шапке, на входе и на телефоне (прежде «EN · ES · FR»). Клавиатура и aria — шаблон WAI-ARIA «кнопка меню»:
 * Enter, пробел и стрелка вниз открывают меню на текущем языке, стрелка вверх — на последнем, стрелки ходят по пунктам по кругу,
 * Home и End — к краям, Esc закрывает и возвращает фокус на кнопку, Tab и нажатие мимо закрывают
 */
function LanguageMenu({ locales, current, onChange }: { locales: readonly Locale[]; current: Locale; onChange: (locale: Locale) => void }) {
  const m = useMessages();
  const t = m.ui.app;
  const menuId = `${useId()}-languages`;
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setFocusIndex(null); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { if (open && focusIndex !== null) itemsRef.current[focusIndex]?.focus(); }, [open, focusIndex]);
  const currentIndex = Math.max(0, locales.indexOf(current));
  const openAt = (index: number) => { setOpen(true); setFocusIndex(index); };
  const close = (restore: boolean) => { setOpen(false); setFocusIndex(null); if (restore) buttonRef.current?.focus(); };
  const label = `${t.languageMenu}${m.colon}${t.languages[current]}`;
  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt(currentIndex); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openAt(locales.length - 1); }
  };
  const onItemKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = locales.length - 1;
    const to: Record<string, number> = { ArrowDown: i === last ? 0 : i + 1, ArrowUp: i === 0 ? last : i - 1, Home: 0, End: last };
    if (e.key in to) { e.preventDefault(); setFocusIndex(to[e.key]!); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
  };
  return (
    <div className="lang" ref={rootRef}>
      <button ref={buttonRef} type="button" className="lang-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={label} title={label} onClick={() => (open ? close(false) : openAt(currentIndex))} onKeyDown={onButtonKey}>
        <Octicon name="globe" size={16} /><span className="lang-current" aria-hidden="true">{current.toUpperCase()}</span><Octicon name="triangle-down" size={16} />
      </button>
      {open ? (
        <ul className="lang-menu" role="menu" id={menuId} aria-label={t.languageMenu}>
          {locales.map((l, i) => (
            <li key={l} role="none">
              <button type="button" role="menuitemradio" aria-checked={l === current} lang={l} tabIndex={-1} ref={(el) => { itemsRef.current[i] = el; }}
                onClick={() => { close(true); if (l !== current) onChange(l); }} onKeyDown={(e) => onItemKey(e, i)}>
                <span className="lang-check" aria-hidden="true">{l === current ? <Octicon name="check" size={16} /> : null}</span>{t.languages[l]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  // Шаг 87: до ответа сессии — английский: первый рынок продукта — США [Р-214]
  const [locale, setLocale] = useState<Locale>('en');
  const [session, setSession] = useState<Resource<SessionView>>(() => ({ state: 'loading', startedAt: Date.now() }));
  const [loginError, setLoginError] = useState<string | null>(null);
  // Находка 17 ревью шага 44: принятое приглашение называется словами — раньше продавец не видел ничего
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const m = messagesFor(locale);

  // Шаг 76 (ревью предполётного прогона, находка 2): заголовок вкладки и язык документа — на языке экрана; в index.html они были
  // русскими («консоль продавца (стенд)», lang="ru"), и зритель из США видел кириллицу на вкладке
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.ui.app.documentTitle;
  }, [locale]);

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

  /**
   * Шаг 44 [Р-178, Р-179]: возврат от поставщика → токен в памяти вкладки; если продавец пришёл по ссылке приглашения —
   * приглашение принимается сразу после входа, и список миров показывает его тенанта.
   */
  const finished = useRef(false);
  useEffect(() => {
    if (session.state !== 'ready' || finished.current) return;
    finished.current = true;
    void (async () => {
      try {
        const login = await completeLogin(session.data.oidc);
        const token = login?.accessToken ?? null;
        if (login) setAccessToken(login.accessToken, login.idToken);
        const invite = pendingInvitation();
        if (invite && (token || session.data.user)) {
          /**
           * Находка 9 ревью шага 44: отказ приглашения (уже принято, чужой адрес, истекло) не запирает вход — приглашение
           * забывается, сессия перечитывается, и продавец видит свои миры и текст отказа, а не страницу входа по кругу.
           */
          forgetInvitation();
          await requestJson<{ accepted: boolean; message?: string }>('/api/invitations/accept', { method: 'POST', body: { token: invite }, locale })
            .then((r) => setLoginNotice(r.message ?? m.ui.app.invitation.accepted))
            .catch((error: unknown) => setLoginError(errorText(error, m)));
        }
        if (token) loadSession();
      } catch (error) {
        setLoginError(errorText(error, m));
      }
    })();
  }, [session]);

  /**
   * Р-160: «посмотреть демо». Гость получает НАБЛЮДАТЕЛЯ в демо-тенанте; дальше он ходит тем же кодом, что продавец, —
   * своего пути у него нет, и поэтому экран не может случайно показать ему кнопку, которой база не даст сработать.
   */
  const enterDemo = async () => {
    setBusy(true);
    setLoginError(null);
    try {
      const { accessToken } = await requestJson<StandToken>('/api/demo/guest', { method: 'POST', body: {}, locale });
      setAccessToken(accessToken);
      setSession({ state: 'ready', data: await requestJson<SessionView>('/api/session', { locale }) });
    } catch (error) {
      setLoginError(errorText(error, m));
    } finally {
      setBusy(false);
    }
  };

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
  const [navOpen, setNavOpen] = useState(false);
  /**
   * Шаг 87 [Р-214]: языки — профиля рынка развёртывания. В профиле us язык один, и переключателя нет вовсе (немецкий словарь остаётся
   * и гоняется на профиле eu); до ответа сессии переключателя тоже нет — иначе мелькал бы «Deutsch»
   */
  const marketLocales: readonly Locale[] = session.state === 'ready' ? session.data.market.locales : [];
  const market = { locales: session.state === 'ready' ? session.data.market.locales : LOCALES, omnibus: session.state === 'ready' ? session.data.market.omnibus : false };
  // Шаг 100 (C): одно меню языков вместо ссылок — в шапке, на входе и в выдвижной панели телефона
  const langSwitch = marketLocales.length > 1 ? <LanguageMenu locales={marketLocales} current={locale} onChange={changeLocale} /> : null;
  // Шаг 93: тема — свойство устройства: системная, светлая или тёмная; выбор хранится в браузере
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  /**
   * Шаг 96.1 (решение владельца): кнопка — солнце или луна, то есть тема, которую человек видит сейчас; нажатие переключает светлую ↔
   * тёмную и запоминает выбор. Пока выбора нет, тема — системная, и иконка следует системе на лету. Подпись для экранного диктора и
   * подсказка называют, куда кнопка переключит
   */
  const [dark, setDark] = useState<boolean>(systemDark);
  useEffect(() => {
    let query: MediaQueryList;
    try { query = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return undefined; }
    const follow = () => setDark(query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  const seen: 'light' | 'dark' = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
  const target: 'light' | 'dark' = seen === 'dark' ? 'light' : 'dark';
  const themeLabel = target === 'dark' ? m.ui.app.theme.toDark : m.ui.app.theme.toLight;
  const themeSwitch = (
    <button type="button" className="ghost theme-button" aria-label={themeLabel} title={themeLabel} data-theme-choice={theme} data-theme-seen={seen}
      onClick={() => { setTheme(target); applyTheme(target); }}>
      <Octicon name={seen === 'dark' ? 'moon' : 'sun'} size={20} />
    </button>
  );
  // Шаг 85: на узких экранах внутри рабочего пространства язык, адрес и выход — в выдвижной панели; разметка та же, что в шапке
  // Шаг 93: человек — по имени от поставщика identity, если оно есть, иначе по адресу; адрес — подсказкой
  const who = user ? user.name ?? user.email ?? user.subject : '';
  const whoHint = user ? m.ui.app.login.signedIn(user.email ?? user.subject) : '';
  const extras = user ? (
    <>
      {langSwitch}
      {themeSwitch}
      <span className="user" title={whoHint}>{who}</span>
      <button type="button" onClick={() => { setAccessToken(null); loadSession(); }}>{m.ui.app.login.logout}</button>
    </>
  ) : null;
  return (
    <NavContext.Provider value={{ open: navOpen, setOpen: setNavOpen, extras }}>
    <MarketContext.Provider value={market}>
    <MessagesContext.Provider value={m}>
      <div className="app" lang={locale}>
        <header className={`topbar${user && route.worldId !== null ? ' in-world' : ''}`}>
          {/* Шаг 85: кнопка меню — только внутри рабочего пространства и только на узких экранах (стили) */}
          {user && route.worldId !== null ? (
            <button type="button" className="menu-button ghost" aria-label={m.ui.app.menu} aria-expanded={navOpen} aria-controls="world-nav" onClick={() => setNavOpen(!navOpen)}>
              <Icon name="menu" size={20} />
            </button>
          ) : null}
          <h1 className="brand"><BrandMark size={28} /><span className="brand-title">{m.ui.app.title}</span></h1>
          {/* Шаг 64 (проход консоли глазами клиента): «стенд, синтетические данные» — только у стенда с имитатором входа, не у продавца */}
          {/* Шаг 84: внутри рабочего пространства демо говорят жёлтая полоса и пилюля у заголовка — третья пометка в шапке лишняя */}
          {session.state === 'ready' && session.data.simulator && route.worldId === null ? <span className="env">{m.ui.app.stand}</span> : null}
          <span className="spacer" />
          {langSwitch}
          {themeSwitch}
          {user ? (
            <>
              {/* Шаг 78: в шапке — один человек; шаг 93 — имя, а «Signed in: адрес» подсказкой */}
              <span className="user" title={whoHint}>{who}</span>
              <button type="button" className="ghost" onClick={() => { setAccessToken(null); loadSession(); }}>{m.ui.app.login.logout}</button>
            </>
          ) : null}
        </header>
        <main className={`page${user && route.worldId !== null ? ' world' : ''}`}>
          {session.state === 'loading' ? <p className="loading" role="status">{m.ui.app.loading(8)}</p>
            : session.state === 'error' ? <ErrorBox message={errorText(session.error, m)} onRetry={loadSession} />
              : user
                ? <>{loginError ? <p className="error" role="alert">{loginError}</p> : null}{loginNotice ? <p className="notice" role="status">{loginNotice}</p> : null}<SignedIn key={user.subject} route={route} /></>
                : (
                  <LoginView
                    simulator={session.data.simulator} demoGuest={session.data.demoGuest} oidc={session.data.oidc} error={loginError} busy={busy}
                    onSignIn={(role) => void signIn(role)} onDemo={() => void enterDemo()}
                  />
                )}
        </main>
      </div>
    </MessagesContext.Provider>
    </MarketContext.Provider>
    </NavContext.Provider>
  );
}

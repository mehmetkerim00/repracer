import { useContext, useEffect, useRef, useState } from 'react';
import { zoneName, type ConnectionAccountView, type ConnectionsView, type Locale } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, href, Load, MarketContext, useMessages, Intro } from '../components.tsx';
import { CheckField, Field, FieldGrid, FormActions } from '../forms.tsx';

/**
 * Р-175…Р-177 (шаг 43): экран «Подключение каналов». Кнопка открывает страницу согласия КАНАЛА в этой же вкладке — как
 * переход по ссылке [Р-142]; канал возвращает браузер на `/connect/callback`, и этот адрес пересылает параметры возврата
 * серверу консоли. Мир, из которого начали, помнит вкладка (sessionStorage): адрес возврата у канала один на приложение.
 *
 * Токена экран не видит никогда — ни в ответе, ни в состоянии: только «доступ есть, получен тогда-то, проверен тогда-то».
 */

const PENDING_WORLD = 'repracer.connect.world';

const tone = (state: string): 'ok' | 'warn' | 'stop' => (state === 'LIVE' ? 'ok' : state === 'REVOKED' ? 'stop' : 'warn');

/** Шаг 95 [Р-217]: аккаунты — разделом Channels (`embedded`): заголовок раздела, страница называется пунктом меню */
export function ConnectionsScreen({ worldId, embedded = false }: { worldId: string; embedded?: boolean }) {
  const m = useMessages();
  const [view, retry] = useResource<ConnectionsView>(worldPath(worldId, 'connections'), m.locale);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const start = (channel: string, marketplaces: string[]) =>
    void requestJson<{ consentUrl: string }>(worldPath(worldId, 'connections', 'start'), { method: 'POST', locale: m.locale, body: { channel, marketplaces } })
      .then((r) => {
        try { sessionStorage.setItem(PENDING_WORLD, worldId); } catch { /* вкладка без хранилища: возврат спросит мир заново */ }
        window.location.assign(r.consentUrl);
      })
      .catch((e: unknown) => setError(errorText(e, m)));
  return (
    <Load shape="cards" resource={view} retry={retry}>
      {(v) => (
        <>
          {/* Заголовок страницы — над карточками, как на остальных экранах */}
          {embedded ? <h3>{v.title}</h3> : <h2>{v.title}</h2>}
          <Intro text={v.intro} />
          {/* Шаг 78: вступление вынесено в подзаголовок — карточка подключения только там, где есть что показать */}
          {v.noRightText || error || v.channels.length > 0 ? <section className="card">
            {v.noRightText ? <p className="notice">{v.noRightText}</p> : null}
            {error ? <ErrorBox message={error} /> : null}
            {v.channels.map((c) => {
              const picked = chosen[c.channel] ?? (c.marketplaces[0] ? [c.marketplaces[0].id] : []);
              return (
                <div key={c.channel} className="card">
                  <h3>{c.name} <Badge tone={tone(c.state)}>{c.stateText}</Badge></h3>
                  {c.missingText ? <p className="note">{c.missingText}</p> : null}
                  {c.channelLimitText ? <p className="notice">{c.channelLimitText}</p> : null}
                  {c.pendingText ? <p className="note">{c.pendingText}</p> : null}
                  {c.pendingRequestId ? (
                    <button type="button" onClick={() => void requestJson(worldPath(worldId, 'connections', 'cancel'), { method: 'POST', locale: m.locale, body: { authorizationRequestId: c.pendingRequestId } })
                      .then(() => retry()).catch((e: unknown) => setError(errorText(e, m)))}>{c.cancelLabel}</button>
                  ) : null}
                  {c.canConnect ? (
                    // Шаг 94: витрины — галочками стандарта в ряд, кнопка подключения — в конце, недоступная говорит почему
                    <div className="connect-row">
                      <div className="check-row">
                        {c.marketplaces.map((mk) => (
                          <CheckField key={mk.id} label={mk.label} checked={picked.includes(mk.id)}
                            onChange={(on) => setChosen({ ...chosen, [c.channel]: on ? [...picked, mk.id] : picked.filter((x) => x !== mk.id) })} />
                        ))}
                      </div>
                      <FormActions hint={picked.length === 0 ? m.ui.forms.why.storefront : null}>
                        <button type="button" className="primary" disabled={picked.length === 0} title={picked.length === 0 ? m.ui.forms.why.storefront : undefined} onClick={() => start(c.channel, picked)}>{c.connectLabel}</button>
                      </FormActions>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section> : null}
          {/* Шаг 77: аккаунт — карточкой: слева аккаунт, состояние и доступ, справа другие инструменты, запись остатков, внешние правки */}
          <div className="accounts">
            {v.accounts.map((a) => (
              <article key={a.channelAccountId} className="card account">
                <div className="account-main">
                  <div className="account-title">{a.label}</div>
                  <p><Badge tone={tone(a.state)}>{a.stateText}</Badge></p>
                  {a.progressText ? <p className="note">{a.progressText}</p> : null}
                  {a.channelLimitText ? <p className="note">{a.channelLimitText}</p> : null}
                  <p className="note">{a.authorizationText}</p>
                  {a.discoveryText ? <p className="note">{a.discoveryText}</p> : null}
                  {a.canReconnect ? <button type="button" onClick={() => start(a.channel, a.marketplaces)}>{a.reconnectLabel}</button> : null}
                </div>
                <div className="account-writers"><ExternalWriters worldId={worldId} account={a} onChanged={retry} /></div>
                {a.defaultStrategy ? <div className="account-default"><DefaultStrategy worldId={worldId} account={a} onChanged={retry} /></div> : null}
              </article>
            ))}
          </div>
          {/* Шаг 79: пустое рабочее пространство — не пустая страница: подключить нечем, только если сервер не настроил каналы */}
          {v.channels.length === 0 && v.accounts.length === 0 ? <section className="card"><p className="muted empty">{m.ui.connections.noChannels}</p></section> : null}
          {/* Как мы храним доступ — пояснением в рамке, а не строкой на фоне страницы */}
          {v.accounts.length > 0 ? <p className="notice">{v.tokenNote}</p> : null}
          <AccountSettings worldId={worldId} />
        </>
      )}
    </Load>
  );
}

/** Шаг 79: пояса витрин Release 1.0 и США — по одному на смещение, чтобы подписи не повторялись; заданный иной пояс добавляется в список */
const ZONE_CHOICES: readonly string[] = ['Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'UTC'];

/**
 * Шаг 69 (K1, K4): язык и пояс показа тенанта. Форма видна там, где у мира есть настройки тенанта (миры тенантов и демо); у мира
 * сценария стенда маршрут отвечает 404, и блока нет. Меняет администратор тенанта — отказ в праве приходит от сервера и базы
 */
function AccountSettings({ worldId }: { worldId: string }) {
  const m = useMessages();
  const market = useContext(MarketContext);
  const t = m.ui.settings;
  type SettingsView = { locale: 'de' | 'en' | 'es' | 'fr'; timeZone: string; timeZoneSet: boolean; canChange: boolean };
  const [view, setView] = useState<SettingsView | null>(null);
  const [zone, setZone] = useState('');
  const [language, setLanguage] = useState<Locale>('en');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void requestJson<SettingsView>(worldPath(worldId, 'settings'), { locale: m.locale })
      // Ревью шага 69, находка 13: пояс по умолчанию поле не заполняет — иначе сохранение языка сделало бы умолчание явным
      .then((v) => { setView(v); setZone(v.timeZoneSet ? v.timeZone : ''); setLanguage(v.locale); })
      .catch(() => setView(null));
  }, [worldId, m.locale]);
  if (!view) return null;
  // Смещение — на сейчас: летнее и зимнее время различаются; часы браузера здесь — только для подписи
  const nowIso = new Date().toISOString();
  const zones = view.timeZoneSet && !ZONE_CHOICES.includes(view.timeZone) ? [view.timeZone, ...ZONE_CHOICES] : ZONE_CHOICES;
  const initialZone = view.timeZoneSet ? view.timeZone : '';
  const save = () => void requestJson<SettingsView>(worldPath(worldId, 'settings'), {
    method: 'POST', locale: m.locale,
    // Пояс уходит, только если его правили: неизменённое поле не превращает умолчание витрины в заданный пояс
    body: { locale: language, ...(zone.trim() === initialZone ? {} : { timeZone: zone.trim() === '' ? null : zone.trim() }) },
  })
    // Язык и пояс применяются ко всем экранам мира — список миров и экраны перечитываются заново
    .then(() => { setNote(t.saved); window.location.reload(); })
    .catch((e: unknown) => setNote(errorText(e, m)));
  return (
    <section className="card">
      <h3>{t.title}</h3>
      <p className="note">{t.intro}</p>
      {view.canChange ? (
        <>
          {/* Шаг 94: язык и пояс — поля стандарта сеткой, пояснение — под выбором пояса, кнопка — в конце */}
          <FieldGrid cols={2}>
            {/* Шаг 87 [Р-214]: язык рабочего пространства — из языков профиля; при одном языке выбора нет */}
            {market.locales.length > 1 ? (
              <Field label={t.language}>
                <select value={language} onChange={(e) => setLanguage(e.currentTarget.value as Locale)}>
                  {market.locales.map((l) => <option key={l} value={l}>{m.ui.app.languages[l]}</option>)}
                </select>
              </Field>
            ) : null}
            {/* Шаг 79: пояс — выбором из списка с человеческими названиями, а не полем для кода IANA; значение наружу — тот же код */}
            <Field label={t.timeZone} caption={t.timeZoneHint}>
              <select value={zone} onChange={(e) => setZone(e.currentTarget.value)}>
                <option value="">{t.timeZoneFromStorefront(zoneName(m.locale, view.timeZone, nowIso))}</option>
                {zones.map((z) => <option key={z} value={z}>{zoneName(m.locale, z, nowIso)}</option>)}
              </select>
            </Field>
          </FieldGrid>
          <FormActions><button type="button" className="primary" onClick={save}>{t.save}</button></FormActions>
        </>
      ) : <p>{market.locales.length > 1 ? `${m.ui.app.languages[view.locale]} · ` : ''}{zoneName(m.locale, view.timeZone, nowIso)}</p>}
      {view.timeZoneSet ? null : <p className="note">{t.timeZoneDefault(zoneName(m.locale, view.timeZone, nowIso))}</p>}
      {view.canChange ? null : <p className="note">{t.readOnly}</p>}
      {note ? <p className="notice">{note}</p> : null}
    </section>
  );
}

/**
 * Шаг 60 [Р-202]: внешние писатели канала — у каждого аккаунта. Вопрос «обновляет ли другой инструмент остатки или цены»,
 * предупреждение о двух репрайсерах, запись количества (выключена, пока владелец не подтвердит набранным идентификатором
 * аккаунта) и счётчик внешних правок за сутки. Кто может подтвердить и не противоречит ли подтверждение ответу, решает база.
 */
function ExternalWriters({ worldId, account: a, onChanged }: { worldId: string; account: ConnectionAccountView; onChanged: () => void }) {
  const m = useMessages();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [typedRevoke, setTypedRevoke] = useState('');
  const post = (path: 'other-tools' | 'quantity-writes' | 'quantity-writes-revoke', body: Record<string, unknown>) =>
    void requestJson<{ message: string }>(worldPath(worldId, 'connections', path), { method: 'POST', locale: m.locale, body: { channelAccountId: a.channelAccountId, ...body } })
      .then((r) => { setError(null); setMessage(r.message); onChanged(); })
      .catch((e: unknown) => { setMessage(null); setError(errorText(e, m)); });
  const q = a.quantityWrites;
  return (
    <div>
      {/* Шаг 94: вопрос — подписью над сегментами, ответ словами — пояснением под ними */}
      {a.otherTools.options.length > 0 ? (
        // Шаг 96 (аудит Б15): неотвеченный вопрос держит путь подключения — пилюля говорит это у самого вопроса
        <Field group label={<>{a.otherTools.question}{a.otherTools.answer === null ? <> <Badge tone="warn">{m.ui.connections.otherTools.answerToFinish}</Badge></> : null}</>} caption={a.otherTools.text}>
          <div className="segmented">
            {a.otherTools.options.map((o) => (
              <button key={o.answer} type="button" disabled={o.answer === a.otherTools.answer} aria-pressed={o.answer === a.otherTools.answer} onClick={() => post('other-tools', { answer: o.answer })}>{o.label}</button>
            ))}
          </div>
        </Field>
      ) : <p><strong>{a.otherTools.question}</strong> {a.otherTools.text}</p>}
      {a.otherTools.warning ? <p className="notice" role="alert">{a.otherTools.warning}</p> : null}
      {/* Шаг 77: это фраза, а не короткий статус — блоком своего тона, а не пилюлей в две строки */}
      <p className={`status-line tone-${q.confirmed ? 'ok' : 'warn'}`}>{q.text}</p>
      {q.blockedText ? <p className="note">{q.blockedText}</p> : null}
      {q.canConfirm ? (
        <div className="typed-confirm">
          <Field label={q.confirmationHint}><input value={typed} onChange={(e) => setTyped(e.currentTarget.value)} /></Field>
          <FormActions hint={typed.trim() === '' ? m.ui.forms.why.typeName : null}>
            <button type="button" disabled={typed.trim() === ''} title={typed.trim() === '' ? m.ui.forms.why.typeName : undefined} onClick={() => post('quantity-writes', { typedConfirmation: typed })}>{q.confirmLabel}</button>
          </FormActions>
        </div>
      ) : null}
      {q.canRevoke ? (
        <div className="typed-confirm">
          <Field label={q.revokeHint} caption={q.revokeCaption}><input value={typedRevoke} onChange={(e) => setTypedRevoke(e.currentTarget.value)} /></Field>
          <FormActions hint={typedRevoke.trim() === '' ? m.ui.forms.why.typeName : null}>
            <button type="button" disabled={typedRevoke.trim() === ''} title={typedRevoke.trim() === '' ? m.ui.forms.why.typeName : undefined} onClick={() => post('quantity-writes-revoke', { typedConfirmation: typedRevoke })}>{q.revokeLabel}</button>
          </FormActions>
        </div>
      ) : null}
      <p>{a.externalEditsText}</p>
      <p className="note">{a.externalEditsNote}</p>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

/**
 * Шаг 103 [Р-228]: стратегия по умолчанию для новых предложений аккаунта — одной строкой, что сейчас и кто задал; что правило уже сделало;
 * выбор — «None» и активные стратегии, недоступная на канале — с причиной и не выбирается. Умолчание назначает, но не включает
 */
function DefaultStrategy({ worldId, account: a, onChanged }: { worldId: string; account: ConnectionAccountView; onChanged: () => void }) {
  const m = useMessages();
  const d = a.defaultStrategy!;
  const [choice, setChoice] = useState<string>(d.current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setChoice(d.current ?? ''); }, [d.current]);
  const same = choice === (d.current ?? '');
  const save = () => void requestJson<{ message: string }>(worldPath(worldId, 'connections', 'default-strategy'), {
    method: 'POST', locale: m.locale, body: { channelAccountId: a.channelAccountId, strategyId: choice === '' ? null : choice },
  }).then((r) => { setError(null); setMessage(r.message); onChanged(); }).catch((e: unknown) => { setMessage(null); setError(errorText(e, m)); });
  return (
    <div>
      <p className="default-line"><strong>{d.line}</strong></p>
      {d.results ? <p className="note">{d.results}</p> : null}
      {d.canEdit ? (
        <>
          {/* Строка выше уже называет умолчание — у поля своя подпись действия, а не повтор заголовка */}
          <Field label={m.ui.connections.defaultStrategy.choose} caption={d.hint}>
            <select value={choice} onChange={(e) => setChoice(e.currentTarget.value)}>
              {d.options.map((o) => <option key={o.strategyId ?? ''} value={o.strategyId ?? ''} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </Field>
          <FormActions hint={same ? m.ui.forms.why.chooseOther : null}>
            <button type="button" className="primary" disabled={same} title={same ? m.ui.forms.why.chooseOther : undefined} onClick={save}>{d.saveLabel}</button>
          </FormActions>
        </>
      ) : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

const PENDING_CALLBACK = 'repracer.connect.callback';

/**
 * Возврат от канала: адрес `/connect/callback?state=…&code=…`. Токен входа консоли живёт в памяти вкладки и после ухода
 * на страницу канала потерян, поэтому параметры сохраняются ДО входа (sessionStorage той же вкладки), а адрес сразу
 * стирается (history.replaceState): код согласия одноразовый, и в истории браузера ему делать нечего. Код живёт пять
 * минут — вход у поставщика identity укладывается.
 */
export function captureConnectCallback(): void {
  // Отрисовка на сервере (тесты экранов) окна не имеет
  if (typeof window === 'undefined' || window.location.pathname !== '/connect/callback') return;
  try { sessionStorage.setItem(PENDING_CALLBACK, JSON.stringify(Object.fromEntries(new URLSearchParams(window.location.search)))); } catch { /* без хранилища возврат не доедет, и экран скажет начать заново */ }
  window.history.replaceState(null, '', '/');
}

export function pendingConnectCallback(): boolean {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(PENDING_CALLBACK) !== null; } catch { return false; }
}

export function ConnectCallback({ onDone }: { onDone: () => void }) {
  const m = useMessages();
  const [message, setMessage] = useState<string | null>(null);
  // Находка 9 ревью шага 43: строгий режим React запускает эффект дважды — возврат уходит серверу ОДИН раз
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    let params: Record<string, string> = {};
    let worldId: string | null = null;
    try {
      params = JSON.parse(sessionStorage.getItem(PENDING_CALLBACK) ?? '{}') as Record<string, string>;
      worldId = sessionStorage.getItem(PENDING_WORLD);
      sessionStorage.removeItem(PENDING_CALLBACK);
    } catch { worldId = null; }
    if (!worldId) { setMessage(m.ui.connections.errors.unknownState); return; }
    void requestJson<{ message: string }>(worldPath(worldId, 'connections', 'callback'), { method: 'POST', locale: m.locale, body: { params } })
      // Шаг 95: прежний адрес `#/worlds/…/connections` разбор не знал (`w`, а не `worlds`) — возврат вёл на список пространств
      .then(() => { window.location.hash = href(worldId!, 'channels', 'accounts'); onDone(); })
      .catch((e: unknown) => setMessage(errorText(e, m)));
  }, []);
  return <section className="card"><p>{message ?? '…'}</p></section>;
}

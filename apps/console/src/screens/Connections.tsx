import { useEffect, useRef, useState } from 'react';
import type { ConnectionAccountView, ConnectionsView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Load, useMessages } from '../components.tsx';

/**
 * Р-175…Р-177 (шаг 43): экран «Подключение каналов». Кнопка открывает страницу согласия КАНАЛА в этой же вкладке — как
 * переход по ссылке [Р-142]; канал возвращает браузер на `/connect/callback`, и этот адрес пересылает параметры возврата
 * серверу консоли. Мир, из которого начали, помнит вкладка (sessionStorage): адрес возврата у канала один на приложение.
 *
 * Токена экран не видит никогда — ни в ответе, ни в состоянии: только «доступ есть, получен тогда-то, проверен тогда-то».
 */

const PENDING_WORLD = 'repracer.connect.world';

const tone = (state: string): 'ok' | 'warn' | 'stop' => (state === 'LIVE' ? 'ok' : state === 'REVOKED' ? 'stop' : 'warn');

export function ConnectionsScreen({ worldId }: { worldId: string }) {
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
    <Load resource={view} retry={retry}>
      {(v) => (
        <>
          <section className="card">
            <h2>{v.title}</h2>
            <p>{v.intro}</p>
            {v.noRightText ? <p className="notice">{v.noRightText}</p> : null}
            {error ? <ErrorBox message={error} /> : null}
            {v.channels.map((c) => {
              const picked = chosen[c.channel] ?? (c.marketplaces[0] ? [c.marketplaces[0].id] : []);
              return (
                <div key={c.channel} className="card">
                  <h3>{c.channel} <Badge tone={tone(c.state)}>{c.stateText}</Badge></h3>
                  {c.missingText ? <p className="note">{c.missingText}</p> : null}
                  {c.channelLimitText ? <p className="notice">{c.channelLimitText}</p> : null}
                  {c.pendingText ? <p className="note">{c.pendingText}</p> : null}
                  {c.pendingRequestId ? (
                    <button type="button" onClick={() => void requestJson(worldPath(worldId, 'connections', 'cancel'), { method: 'POST', locale: m.locale, body: { authorizationRequestId: c.pendingRequestId } })
                      .then(() => retry()).catch((e: unknown) => setError(errorText(e, m)))}>{c.cancelLabel}</button>
                  ) : null}
                  {c.canConnect ? (
                    <p>
                      {c.marketplaces.map((mk) => (
                        <label key={mk.id}>
                          <input type="checkbox" checked={picked.includes(mk.id)}
                            onChange={(e) => setChosen({ ...chosen, [c.channel]: e.currentTarget.checked ? [...picked, mk.id] : picked.filter((x) => x !== mk.id) })} />
                          {mk.label}
                        </label>
                      ))}
                      <button type="button" disabled={picked.length === 0} onClick={() => start(c.channel, picked)}>{c.connectLabel}</button>
                    </p>
                  ) : null}
                </div>
              );
            })}
          </section>
          <section className="card">
            <table>
              <tbody>
                {v.accounts.map((a) => (
                  <tr key={a.channelAccountId}>
                    <td>{a.label}</td>
                    <td>
                      <Badge tone={tone(a.state)}>{a.stateText}</Badge>{a.progressText ? <div className="note">{a.progressText}</div> : null}
                      {a.channelLimitText ? <div className="note">{a.channelLimitText}</div> : null}
                    </td>
                    <td className="note">{a.authorizationText}{a.discoveryText ? <><br />{a.discoveryText}</> : null}</td>
                    <td>{a.canReconnect ? <button type="button" onClick={() => start(a.channel, a.marketplaces)}>{a.reconnectLabel}</button> : null}</td>
                    <td><ExternalWriters worldId={worldId} account={a} onChanged={retry} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">{v.tokenNote}</p>
          </section>
        </>
      )}
    </Load>
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
      <p><strong>{a.otherTools.question}</strong> {a.otherTools.text}</p>
      {a.otherTools.options.length > 0 ? (
        <p>
          {a.otherTools.options.map((o) => (
            <button key={o.answer} type="button" disabled={o.answer === a.otherTools.answer} onClick={() => post('other-tools', { answer: o.answer })}>{o.label}</button>
          ))}
        </p>
      ) : null}
      {a.otherTools.warning ? <p className="notice" role="alert">{a.otherTools.warning}</p> : null}
      <p><Badge tone={q.confirmed ? 'ok' : 'warn'}>{q.text}</Badge></p>
      {q.blockedText ? <p className="note">{q.blockedText}</p> : null}
      {q.canConfirm ? (
        <p>
          <label>{q.confirmationHint} <input value={typed} onChange={(e) => setTyped(e.currentTarget.value)} /></label>
          <button type="button" disabled={typed.trim() === ''} onClick={() => post('quantity-writes', { typedConfirmation: typed })}>{q.confirmLabel}</button>
        </p>
      ) : null}
      {q.canRevoke ? (
        <p>
          <label>{q.revokeHint} <input value={typedRevoke} onChange={(e) => setTypedRevoke(e.currentTarget.value)} /></label>
          <button type="button" disabled={typedRevoke.trim() === ''} onClick={() => post('quantity-writes-revoke', { typedConfirmation: typedRevoke })}>{q.revokeLabel}</button>
        </p>
      ) : null}
      <p>{a.externalEditsText}</p>
      <p className="note">{a.externalEditsNote}</p>
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
      .then(() => { window.location.hash = `#/worlds/${encodeURIComponent(worldId!)}/connections`; onDone(); })
      .catch((e: unknown) => setMessage(errorText(e, m)));
  }, []);
  return <section className="card"><p>{message ?? '…'}</p></section>;
}

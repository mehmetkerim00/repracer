import { useState } from 'react';
import type { ListQuery, ShadowView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, href, Load, Pager, useMessages } from '../components.tsx';

/**
 * Р-169…Р-171 (шаг 41): экран «Теневой режим». Канал подключён, движок работает целиком, в канал не уходит ничего.
 * Здесь продавец видит would-be изменения со ссылкой на «почему эта цена», сводку за период и кнопку «включить бой».
 *
 * Включение боя требует второго фактора и НАБРАННОГО имени аккаунта [Р-170]; возврат в тень — одно нажатие. Асимметрия
 * намеренная: тень безопасна, и церемония на безопасном направлении учит продавца бояться кнопки, которая его защищает.
 */
export function ShadowScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: 50 });
  const [days, setDays] = useState(7);
  const [view, retry] = useResource<ShadowView>(`${worldPath(worldId, 'shadow')}?offset=${query.offset}&limit=${query.limit}&days=${days}`, m.locale);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const switchMode = (channelAccountId: string, toMode: 'SHADOW' | 'LIVE') =>
    void requestJson<{ mode: string }>(worldPath(worldId, 'shadow', 'mode'), {
      method: 'POST', locale: m.locale,
      body: { channelAccountId, toMode, ...(toMode === 'LIVE' ? { typedConfirmation: typed[channelAccountId] ?? '' } : {}) },
    }).then(() => { setError(null); retry(); }).catch((e: unknown) => setError(errorText(e, m)));

  const c = m.ui.shadow.columns;
  return (
    <Load resource={view} retry={retry}>
      {(v) => (
        <>
          <section className="card">
            <h2>{m.ui.shadow.title}{v.demo ? <Badge tone="warn">DEMO</Badge> : null}</h2>
            <p>{v.intro}</p>
            <p>{v.periods.map((p) => (
              <button key={p.days} type="button" disabled={p.active}
                onClick={() => { setDays(p.days); setQuery({ ...query, offset: 0 }); }}>{p.label}</button>
            ))}</p>
            {v.anyShadow ? <ul>{v.summaryLines.map((line) => <li key={line}>{line}</li>)}</ul> : <p>{v.none}</p>}
            <p className="note">{v.cannot}</p>
          </section>

          <section className="card">
            <table>
              <thead><tr><th>{c.account}</th><th>{c.mode}</th><th>{c.action}</th></tr></thead>
              <tbody>
                {v.accounts.map((a) => (
                  <tr key={a.channelAccountId}>
                    <td>{a.label}</td>
                    <td>
                      <Badge tone={a.writeMode === 'SHADOW' ? 'warn' : 'ok'}>{a.modeText}</Badge>
                      {a.changedText === null ? null : <div className="note">{a.changedText}</div>}
                      <div className="note">{m.ui.shadow.volume(a.offers, a.engineScopes)}</div>
                    </td>
                    <td>
                      {a.canGoLive ? (
                        <>
                          <div className="note">{a.confirmationHint}</div>
                          <input value={typed[a.channelAccountId] ?? ''} placeholder={a.externalAccountId}
                            onChange={(e) => setTyped({ ...typed, [a.channelAccountId]: e.currentTarget.value })} />
                          <button type="button" onClick={() => switchMode(a.channelAccountId, 'LIVE')}>{v.liveButton}</button>
                          <div className="note">{v.mfaHint}</div>
                        </>
                      ) : null}
                      {a.canGoShadow ? (
                        <button type="button" onClick={() => switchMode(a.channelAccountId, 'SHADOW')}>{v.shadowButton}</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {v.liveBlockedText === null ? null : <p className="note">{v.liveBlockedText}</p>}
            {error === null ? null : <ErrorBox message={error} />}
          </section>

          {/* Р-172: что мы про эти витрины НЕ знаем — рядом с кнопкой, которую это знание держит */}
          {v.properties.length === 0 ? null : (
            <section className="card">
              <h3>{v.propertiesTitle}</h3>
              <table>
                <tbody>
                  {v.properties.map((p) => (
                    <tr key={`${p.marketplace}/${p.propertyText}`}>
                      <td>{p.marketplace}</td>
                      <td>{p.propertyText}<div className="note">{p.valueText}</div></td>
                      <td>
                        <Badge tone={p.blocksLive ? 'warn' : 'ok'}>{p.statusText}</Badge>
                        <div className="note">{p.closesByText}{p.question === null ? null : ` · ${p.question}`}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Р-174: отчёт, который никто не получил, — не отчёт */}
          {v.digests.length === 0 ? null : (
            <section className="card">
              <h3>{v.digestsTitle}</h3>
              <table>
                <tbody>
                  {v.digests.map((d) => (
                    <tr key={d.periodText}>
                      <td>{d.periodText}</td>
                      <td>{d.decisions} / {d.heldWrites}{d.savingsText === null ? null : <div className="note">{d.savingsText}</div>}</td>
                      <td><Badge tone={d.delivered ? 'ok' : 'warn'}>{d.deliveryText}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            {v.rows.length === 0 ? <p>{v.none}</p> : (
              <table>
                <thead><tr><th>{c.offer}</th><th>{c.value}</th><th>{c.when}</th><th /></tr></thead>
                <tbody>
                  {v.rows.map((r) => (
                    <tr key={r.channelWriteId}>
                      <td>{r.label}</td>
                      <td>{r.valueText}{r.budgetText === null ? null : <div className="note">{r.budgetText}</div>}</td>
                      <td>{r.whenText}</td>
                      <td>{r.priceDecisionId === null ? null : <a href={href(worldId, 'decisions', r.priceDecisionId)}>{c.why}</a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Pager page={v.page} query={query} onQuery={setQuery} />
            <Gaps gaps={v.gaps} />
          </section>
        </>
      )}
    </Load>
  );
}

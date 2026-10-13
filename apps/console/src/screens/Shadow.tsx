import { useState } from 'react';
import type { ListQuery, ShadowView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, href, Intro, Load, Pager, useMessages, When } from '../components.tsx';
import { ShadowHero } from './ShadowHero.tsx';

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
    <Load shape="stats" resource={view} retry={retry}>
      {(v) => (
        <>
          {/* Заголовок страницы — над карточками, как на остальных экранах */}
          <h2>{m.ui.shadow.title}{v.demo ? <Badge tone="warn">{m.ui.app.demoBadge}</Badge> : null}</h2>
          {/* Вступление говорит «канал подключён» — без аккаунта оно было бы неправдой; пустое состояние ниже объясняет экран само */}
          {v.accounts.length === 0 ? <p className="subtitle">{m.ui.app.subtitles.shadow}</p> : <Intro text={v.intro} />}
          {/* Шаг 79: без аккаунта канала тени нечего показать — пустое состояние с путём, а не таблица без строк */}
          {v.accounts.length === 0 ? (
            <section className="card"><p className="muted empty">{m.ui.shadow.noAccounts} <a href={href(worldId, 'connections')}>{m.ui.app.connectChannel}</a></p></section>
          ) : <>
          {/* Шаг 82: окно отчёта — переключатель над сводкой; шаг 83: сводка — белые плитки и график, строки сводки — карточкой под ними */}
          {(() => {
            const periods = (
              <div className="periods">{v.periods.map((p) => (
                <button key={p.days} type="button" disabled={p.active}
                  onClick={() => { setDays(p.days); setQuery({ ...query, offset: 0 }); }}>{p.label}</button>
              ))}</div>
            );
            // Шаг 79 (ревью): строку «решений столько-то» уже сказали метрики — под ними её не повторяем
            const lines = v.summaryLines.filter((line) => line !== m.ui.shadow.summary.decisions(v.summary.decisions, v.summary.changes));
            return v.anyShadow ? (
              <>
                <ShadowHero view={v} periods={periods} />
                <section className="card ledger-lines">
                  <ul className="explain">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
                  {/* «Не прогноз выручки» уже сказано строкой о деньгах — второй раз под ней не повторяем */}
                  {v.summary.floorSavings.length > 0 ? null : <p className="note">{v.cannot}</p>}
                </section>
              </>
            ) : (
              <section className="card">
                {periods}
                <p>{v.none}</p>
                {v.summary.floorSavings.length > 0 ? null : <p className="note">{v.cannot}</p>}
              </section>
            );
          })()}

          {/* Шаг 81: аккаунты — карточками; подписи бывших колонок («Channel account», «Write mode», «Live writes») — у полей карточки */}
          <section className="account-modes">
                {v.accounts.map((a) => (
                  <article key={a.channelAccountId} className="account-mode">
                    <div className="am-account">
                      <div className="am-label">{c.account}</div>
                      <div className="am-name">{a.label}</div>
                      <div className="note">{m.ui.shadow.volume(a.offers, a.engineScopes)}</div>
                      {a.channelLimitText === null ? null : <div className="note">{a.channelLimitText}</div>}
                    </div>
                    <div className="am-mode">
                      <div className="am-label">{c.mode}</div>
                      <Badge tone={a.writeMode === 'SHADOW' ? 'warn' : 'ok'}>{a.modeText}</Badge>
                      {a.changedText === null ? null : <div className="note">{a.changedText}</div>}
                    </div>
                    <div className="am-action">
                      <div className="am-label">{c.action}</div>
                      {a.accessText === null ? null : (
                        <>
                          <Badge tone={a.authStatus === 'REVOKED' ? 'stop' : 'warn'}>{a.accessText}</Badge>
                          <div className="note">{a.accessHint}</div>
                        </>
                      )}
                      {a.canGoLive ? (
                        <div className="live-card">
                          <div className="note">{a.confirmationHint}</div>
                          <div className="live-row">
                            <input value={typed[a.channelAccountId] ?? ''} placeholder={a.externalAccountId}
                              onChange={(e) => setTyped({ ...typed, [a.channelAccountId]: e.currentTarget.value })} />
                            {/* Яркая кнопка — только когда имя набрано верно: до этого глаз не ведут к самому опасному действию экрана */}
                            <button type="button" className={(typed[a.channelAccountId] ?? '') === a.externalAccountId ? 'primary' : ''}
                              onClick={() => switchMode(a.channelAccountId, 'LIVE')}>{v.liveButton}</button>
                          </div>
                          <div className="note">{v.mfaHint}</div>
                        </div>
                      ) : null}
                      {a.canGoShadow ? (
                        <button type="button" onClick={() => switchMode(a.channelAccountId, 'SHADOW')}>{v.shadowButton}</button>
                      ) : null}
                    </div>
                  </article>
                ))}
            {v.liveBlockedText === null ? null : <p className="notice live-blocked">{v.liveBlockedText}</p>}
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
                      <td>{p.storefrontText}</td>
                      <td>{p.propertyText}<div className="note">{p.valueText}</div></td>
                      <td>
                        <Badge tone={p.blocksLive ? 'warn' : 'ok'}>{p.statusText}</Badge>
                        <div className="note">{p.closesByText}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Шаг 68 (K7): у демо — то самое недельное письмо, собранное за последние семь суток, с честной пометкой синтетики */}
          {v.digestPreview === null ? null : (
            <section className="card">
              <h3>{v.digestPreview.title} <Badge tone="warn">{m.ui.app.demoBadge}</Badge></h3>
              <p className="note">{v.digestPreview.synthetic}</p>
              <p><strong>{v.digestPreview.subject}</strong></p>
              <pre className="letter">{v.digestPreview.text}</pre>
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
                <thead><tr><th>{c.offer}</th><th className="num">{c.value}</th><th>{c.when}</th><th /></tr></thead>
                <tbody>
                  {v.rows.map((r) => (
                    <tr key={r.channelWriteId}>
                      <td>{r.label}</td>
                      <td className={r.field === 'QUANTITY' ? 'money' : 'money cur'}>{r.valueText}{r.budgetText === null ? null : <div className="note">{r.budgetText}</div>}</td>
                      <td><When value={r.whenText} /></td>
                      <td className="num">{r.priceDecisionId === null ? null : <a className="row-link" href={href(worldId, 'decisions', r.priceDecisionId)}>{c.why}</a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Pager page={v.page} query={query} onQuery={setQuery} />
            <Gaps gaps={v.gaps} />
          </section>
          </>}
        </>
      )}
    </Load>
  );
}

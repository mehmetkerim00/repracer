import { useState } from 'react';
import { periodSearch, type ListQuery, type Period, type ShadowView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, commonZone, ErrorBox, errorText, Gaps, href, Intro, Load, Pager, useMessages, When, WhenHead } from '../components.tsx';
import { PeriodPicker } from '../date-range.tsx';
import { Field, FormActions } from '../forms.tsx';
import { NextStepCard } from './Onboarding.tsx';
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
  // Шаг 96 (II): период — пресет или свой диапазон дат в поясе пространства
  const [period, setPeriod] = useState<Period>({ preset: '7d' });
  const [view, retry] = useResource<ShadowView>(`${worldPath(worldId, 'shadow')}?offset=${query.offset}&limit=${query.limit}&${periodSearch(period)}`, m.locale);
  // Шаг 96 (Б13): имя аккаунта копируется кнопкой, а не перепечатывается
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (id: string) => void navigator.clipboard?.writeText(id).then(() => setCopied(id)).catch(() => setCopied(null));
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
          {/* Шаг 96 (В22): следующий шаг — из того же вида пути, что Channels */}
          <NextStepCard worldId={worldId} />
          {/* Шаг 79: без аккаунта канала тени нечего показать — пустое состояние с путём, а не таблица без строк */}
          {v.accounts.length === 0 ? (
            <section className="card"><p className="muted empty">{m.ui.shadow.noAccounts} <a href={href(worldId, 'channels', 'accounts')}>{m.ui.app.connectChannel}</a></p></section>
          ) : <>
          {/* Шаг 82: окно отчёта — переключатель над сводкой; шаг 83: сводка — белые плитки и график, строки сводки — карточкой под ними */}
          {(() => {
            const periods = (
              <div className="toolbar field-toolbar period-bar">
                <PeriodPicker value={period} onChange={(p) => { setPeriod(p); setQuery({ ...query, offset: 0 }); }} />
                {v.clipped ? <span className="filters-count">{m.ui.period.clipped(30)}</span> : null}
              </div>
            );
            // Шаг 96 (В21): на виду — плитки, график и карточки каналов с действием; остальное — сворачиваемыми блоками ниже
            return v.anyShadow ? <ShadowHero view={v} periods={periods} /> : (
              <section className="card">
                {periods}
                <p>{v.none}</p>
                {v.summary.floorSavings.length > 0 ? null : <p className="note">{v.cannot}</p>}
              </section>
            );
          })()}

          {/* Шаг 81: аккаунты — карточками; подписи бывших колонок — у полей карточки (шаг 96: «Channel account», «Mode», «Sending prices») */}
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
                          {/* Шаг 94: подсказка — подписью над полем, второй фактор — пояснением под ним; поле не уже имени (шаг 86) */}
                          <Field label={a.confirmationHint} caption={v.mfaHint}>
                            <input value={typed[a.channelAccountId] ?? ''} placeholder={a.externalAccountId} size={a.externalAccountId.length + 2}
                              onChange={(e) => setTyped({ ...typed, [a.channelAccountId]: e.currentTarget.value })} />
                          </Field>
                          <FormActions>
                            {/* Яркая кнопка — только когда имя набрано верно: до этого глаз не ведут к самому опасному действию экрана */}
                            <button type="button" className={(typed[a.channelAccountId] ?? '') === a.externalAccountId ? 'primary' : ''}
                              onClick={() => switchMode(a.channelAccountId, 'LIVE')}>{v.liveButton}</button>
                            {/* Шаг 96 (Б13): имя копируется кнопкой; подтверждение и журнал прежние [Р-170] — имя по-прежнему вставляет человек */}
                            <button type="button" title={m.ui.shadow.copyHint} onClick={() => copy(a.externalAccountId)}>{copied === a.externalAccountId ? m.ui.shadow.copied : m.ui.shadow.copy}</button>
                          </FormActions>
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

          {/* Шаг 96 (В21): «полезно знать» — сводка чисел, что мы ещё проверяем о магазинах и оговорки экрана; данные те же, блок свёрнут */}
          <details className="card more-block">
            <summary>{m.ui.shadow.moreTitle}</summary>
            {v.anyShadow ? (
              <div className="summary-list-card">
                <dl className="summary-list">
                  {v.summaryList.map((row) => (
                    <div key={row.label} className="summary-row">
                      <dt>{row.label}{row.hint ? <span className="hint">{row.hint}</span> : null}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                {v.summaryNotes.length > 0 ? <div className="summary-notes">{v.summaryNotes.map((note) => <p key={note}>{note}</p>)}</div> : null}
                {v.summary.floorSavings.length > 0 ? null : <p className="summary-notes">{v.cannot}</p>}
              </div>
            ) : null}
            {/* Р-172, шаг 96 (А4): что мы про магазины ещё проверяем — людскими словами; первой строкой — что от продавца ничего не нужно */}
            {v.properties.length === 0 ? null : (
              <div className="store-checks">
                <h3>{v.propertiesTitle}</h3>
                {v.nothingNeeded ? <p><strong>{v.nothingNeeded}</strong></p> : null}
                <ul className="plain-list">
                  {v.properties.map((p) => (
                    <li key={`${p.marketplace}/${p.propertyText}`}><strong>{p.storefrontText}</strong> — {p.humanText}</li>
                  ))}
                </ul>
              </div>
            )}
            <Gaps gaps={v.gaps} />
          </details>

          {/* Шаг 68 (K7): у демо — то самое недельное письмо, собранное за последние семь суток, с честной пометкой синтетики */}
          {v.digestPreview === null ? null : (
            <details className="card more-block">
              <summary>{v.digestPreview.title} <Badge tone="warn">{m.ui.app.demoBadge}</Badge></summary>
              <p className="note">{v.digestPreview.synthetic}</p>
              <p><strong>{v.digestPreview.subject}</strong></p>
              <pre className="letter">{v.digestPreview.text}</pre>
            </details>
          )}

          {/* Р-174: отчёт, который никто не получил, — не отчёт */}
          {v.digests.length === 0 ? null : (
            <details className="card more-block">
              <summary>{v.digestsTitle}</summary>
              <table className="cardify">
                <tbody>
                  {v.digests.map((d) => (
                    <tr key={d.periodText}>
                      <td className="card-title">{d.periodText}</td>
                      <td>{d.decisions} / {d.heldWrites}{d.savingsText === null ? null : <div className="note">{d.savingsText}</div>}</td>
                      <td className="card-status"><Badge tone={d.delivered ? 'ok' : 'warn'}>{d.deliveryText}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {/* Шаг 96 (В21, Б16): удержанное — свёрнутым блоком; у строки — пилюля «цена» или «остаток» */}
          <details className="card more-block held-block">
            <summary>{m.ui.shadow.heldTableTitle(v.page.total)}</summary>
            {v.rows.length === 0 ? <p>{v.none}</p> : (
              <table className="cardify">
                <thead><tr><th>{c.offer}</th><th className="num">{c.value}</th><th><WhenHead label={c.when} zone={commonZone(v.rows.map((r) => r.whenText))} /></th><th /></tr></thead>
                <tbody>
                  {v.rows.map((r) => (
                    <tr key={r.channelWriteId}>
                      <td className="card-title">{r.label} <Badge tone="off">{m.ui.shadow.kinds[r.field === 'QUANTITY' ? 'QUANTITY' : 'PRICE']}</Badge></td>
                      <td className={r.field === 'QUANTITY' ? 'money' : 'money cur'} data-label={c.value}>{r.valueText}{r.budgetText === null ? null : <div className="note">{r.budgetText}</div>}</td>
                      <td data-label={`${c.when}${commonZone(v.rows.map((x) => x.whenText)) ? ` · ${commonZone(v.rows.map((x) => x.whenText))}` : ''}`}><When value={r.whenText} zone={!commonZone(v.rows.map((x) => x.whenText))} /></td>
                      <td className="num card-action">{r.priceDecisionId === null ? null : <a className="row-link" href={href(worldId, 'decisions', r.priceDecisionId)}>{c.why}</a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Pager page={v.page} query={query} onQuery={setQuery} />
          </details>
          </>}
        </>
      )}
    </Load>
  );
}

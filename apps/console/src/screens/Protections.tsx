import { useState } from 'react';
import { periodSearch, type Period } from '@repracer/console-model';
import { href, PeriodPicker, useMessages } from '../components.tsx';
import { DangerousScreen } from './Dangerous.tsx';
import { RejectedScreen } from './Rejected.tsx';

export type ProtectionsTab = 'people' | 'rules';

/**
 * Шаг 95 [Р-217]: Protections — прежние Stopped changes и Dangerous changes одной страницей с переключателем.
 * «Stopped by people» — изменения, которые остановил человек (стоп-кран, Stop pricing); «Prevented by rules» — сверху витрина
 * «пол удержал цену N раз — без него дешевле на X» и отчёт за период (удержания пола, отказы Price Gate), ниже — остальное, что за
 * неделю остановили или поправили правила (границы, проверка входов, перепроверка при отправке, остановка витрины). Прежний список
 * «Stopped changes» делил одно и другое только пилюлей «Stopped by»; ничего не пропало — разошлось по вкладкам
 */
export function ProtectionsScreen({ worldId, tab, days }: { worldId: string; tab: ProtectionsTab; days: number }) {
  const m = useMessages();
  const p = m.ui.protections;
  // Шаг 96 (II): период — общий на обе вкладки; прежний адрес `protections/rules/<1|7|30>` задаёт начальный пресет
  const [period, setPeriod] = useState<Period>({ preset: days === 1 ? '24h' : days === 30 ? '30d' : '7d' });
  return (
    <section className="protections">
      <h2>{m.ui.app.screens.protections}</h2>
      <p className="subtitle">{m.ui.app.subtitles.protections}</p>
      <nav className="tabs" aria-label={m.ui.app.screens.protections}>
        <a href={href(worldId, 'protections', 'people')} className={tab === 'people' ? 'active' : ''} aria-current={tab === 'people' ? 'page' : undefined}>{p.people}</a>
        <a href={href(worldId, 'protections', 'rules')} className={tab === 'rules' ? 'active' : ''} aria-current={tab === 'rules' ? 'page' : undefined}>{p.rules}</a>
      </nav>
      <div className="toolbar field-toolbar period-bar"><PeriodPicker value={period} onChange={setPeriod} /></div>
      {/* ключ — период: смена периода начинает списки с первой страницы */}
      {tab === 'people' ? <RejectedScreen key={periodSearch(period)} worldId={worldId} only="STOP" period={period} /> : (
        <>
          <DangerousScreen key={`d-${periodSearch(period)}`} worldId={worldId} period={period} />
          <RejectedScreen key={`r-${periodSearch(period)}`} worldId={worldId} only="RULES" period={period} />
        </>
      )}
    </section>
  );
}

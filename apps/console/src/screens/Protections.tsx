import { href, useMessages } from '../components.tsx';
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
  return (
    <section className="protections">
      <h2>{m.ui.app.screens.protections}</h2>
      <p className="subtitle">{m.ui.app.subtitles.protections}</p>
      <nav className="tabs" aria-label={m.ui.app.screens.protections}>
        <a href={href(worldId, 'protections', 'people')} className={tab === 'people' ? 'active' : ''} aria-current={tab === 'people' ? 'page' : undefined}>{p.people}</a>
        <a href={href(worldId, 'protections', 'rules')} className={tab === 'rules' ? 'active' : ''} aria-current={tab === 'rules' ? 'page' : undefined}>{p.rules}</a>
      </nav>
      {tab === 'people' ? <RejectedScreen worldId={worldId} only="STOP" /> : (
        <>
          <DangerousScreen worldId={worldId} days={days} />
          <RejectedScreen worldId={worldId} only="RULES" />
        </>
      )}
    </section>
  );
}

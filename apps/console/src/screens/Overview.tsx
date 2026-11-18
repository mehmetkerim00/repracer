import type { OverviewLine, OverviewView as OverviewModel } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, href, Load, useMessages } from '../components.tsx';

/**
 * Шаг 171 (#34, ярус 2; Р-254): Daily Overview — первый пункт меню. Четыре карточки-вопроса; каждая строка — ссылка в свою выборку с тем же
 * числом. Окно — последние 24 часа, и почему — сказано (отметка визита — шаг 172). В тени «что изменилось» говорит, что в магазин не ушло ничего
 */
function Lines({ worldId, lines }: { worldId: string; lines: readonly OverviewLine[] }) {
  return (
    <ul className="overview-lines">
      {lines.map((l) => (
        <li key={`${l.text}|${l.target.join('/')}`}>
          <span className={`status-dot dot-${l.tone}`} aria-hidden="true" />
          <a href={href(worldId, ...l.target)}>{l.text}</a>
        </li>
      ))}
    </ul>
  );
}

export function OverviewView({ view }: { view: OverviewModel }) {
  const m = useMessages();
  const t = m.ui.overview;
  return (
    <section className="overview">
      <h2>{m.ui.app.screens.overview}</h2>
      <p className="subtitle">{m.ui.app.subtitles.overview}</p>
      <p className="overview-window"><Badge tone="off">{view.windowText}</Badge> <span className="muted small">{view.windowNote}</span></p>
      {view.liveNote ? <p className="notice">{view.liveNote}</p> : null}
      <div className="overview-grid">
        <section className="card overview-card" data-question="working">
          <h3>{t.questions.working}</h3>
          <Lines worldId={view.worldId} lines={view.working} />
        </section>
        <section className="card overview-card" data-question="changed">
          <h3>{t.questions.changed}</h3>
          <p className="muted small">{view.changed.lead}</p>
          {view.changed.empty ? <p className="muted empty">{view.changed.empty}</p> : (
            <ul className="overview-lines overview-causes">
              {view.changed.groups.map((g) => (
                <li key={g.cause} data-cause={g.cause}>
                  <span className={`status-dot dot-${g.tone}`} aria-hidden="true" />
                  <a href={href(view.worldId, ...g.target)}><strong>{g.title}</strong> · {g.text}</a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card overview-card" data-question="risk">
          <h3>{t.questions.risk}</h3>
          {view.risk.empty ? <p className="muted empty">{view.risk.empty}</p> : <Lines worldId={view.worldId} lines={view.risk.items} />}
        </section>
        <section className="card overview-card" data-question="action">
          <h3>{t.questions.action}</h3>
          {view.action.empty ? <p className="muted empty">{view.action.empty}</p> : <Lines worldId={view.worldId} lines={view.action.items} />}
        </section>
      </div>
    </section>
  );
}

export function OverviewScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<OverviewModel>(worldPath(worldId, 'overview'), m.locale);
  return <Load shape="cards" resource={resource} retry={retry}>{(view) => <OverviewView view={view} />}</Load>;
}

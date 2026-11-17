import type { StatusLineView } from '@repracer/console-model';
import { useResource, worldPath } from './api.ts';
import { Badge, href, useMessages } from './components.tsx';

/**
 * Шаг 146 (#34, ярус 1): строка состояния продавца — первая на каждом экране рабочего пространства. Своим запросом, параллельно экрану:
 * экран её не ждёт. При переходе между экранами запрос повторяется (часть адреса `screen`), прежние числа видны до нового ответа.
 * Каждое число — ссылка ровно на ту выборку, из которой посчитано; ошибка — одной строкой, экран работает
 */
export function StatusLine({ worldId, screen }: { worldId: string; screen: string }) {
  const m = useMessages();
  const t = m.ui.statusLine;
  const [res] = useResource<StatusLineView>(`${worldPath(worldId, 'status')}?screen=${encodeURIComponent(screen)}`, m.locale, { keepPrevious: true });
  if (res.state === 'loading') return <nav className="status-line loading-line" aria-label={t.label} aria-busy="true" />;
  if (res.state === 'error') return <nav className="status-line" aria-label={t.label}><span className="muted">{t.unavailable}</span></nav>;
  const v = res.data;
  const dot = (tone: string) => <span className={`status-dot dot-${tone}`} aria-hidden="true" />;
  return (
    <nav className="status-line" aria-label={t.label}>
      <a className="status-item" data-part="mode" href={href(worldId, ...v.mode.target)}>{dot(v.mode.tone)}{v.mode.text}</a>
      <a className="status-item" data-part="stops" href={href(worldId, ...v.stops.target)}>{dot(v.stops.tone)}{v.stops.text}</a>
      {v.freshness.map((f) => (
        <a key={f.channelAccountId} className="status-item" data-part="freshness" href={href(worldId, ...f.target)}>{dot(f.tone)}{f.text} <Badge tone={f.tone}>{f.levelText}</Badge></a>
      ))}
      <span className="status-item status-attention" data-part="attention">
        {/* «Ничего не требует внимания» — не ссылка: пустой список вести некуда */}
        {v.attention.count > 0 ? <a href={href(worldId, ...v.attention.target)}>{dot(v.attention.tone)}{v.attention.text}</a> : <span className="status-quiet">{dot(v.attention.tone)}{v.attention.text}</span>}
        {v.attention.reasons.length > 0 ? (
          <span className="status-reasons">
            {v.attention.reasons.map((r) => <a key={r.code} data-reason={r.code} href={href(worldId, ...r.target)}>{r.text}</a>)}
          </span>
        ) : null}
      </span>
    </nav>
  );
}

import type { BoundsIndexView } from '../api-types.ts';
import { useResource, worldPath } from '../api.ts';
import { Load, SectionAnchor, useMessages } from '../components.tsx';
import { BoundsIndex } from './Bounds.tsx';
import { ImportPanel } from './Imports.tsx';

/**
 * Шаг 95 [Р-217]: Costs & floors — прежние Bounds и Unit cost import одним экраном: сверху границы всех предложений (с массовой
 * правкой), ниже — импорты разделами. Страница предложения «Bounds and price floor» остаётся своим адресом (`bounds/<id>`).
 * `section="import"` — прежний адрес `cost-import` и шаг онбординга ведут сразу к разделу импорта себестоимости.
 * Шаг 99 [Р-224, Р-225]: импортов здесь два — себестоимость и границы с минимальной маржой; меню не растёт
 */
export function CostsScreen({ worldId, section, target = null }: { worldId: string; section: string | null; target?: string | null }) {
  const m = useMessages();
  const [rights, retry] = useResource<BoundsIndexView>(`${worldPath(worldId, 'bounds')}?offset=0&limit=1`, m.locale);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  return (
    <section className="costs">
      <h2>{m.ui.app.screens.costs}</h2>
      <p className="subtitle">{m.ui.app.subtitles.costs}</p>
      <p className="page-actions">
        <button type="button" onClick={() => go('cost-import')}>{m.ui.costs.importAction}</button>
        <button type="button" onClick={() => go('bounds-import')}>{m.ui.costs.importBoundsAction}</button>
      </p>
      {/* Шаг 96 (В20): `costs/edit/<предложение>` — правка границ с этим предложением выбранным, прокручена к ней */}
      <BoundsIndex worldId={worldId} preselect={section === 'edit' ? target : null} focusEdit={section === 'edit'} />
      <SectionAnchor id="cost-import" focus={section === 'import'} />
      <Load shape="cards" resource={rights} retry={retry}>{(view) => <ImportPanel worldId={worldId} kind="COSTS" canEdit={view.canEdit} />}</Load>
      <SectionAnchor id="bounds-import" focus={section === 'bounds-import'} />
      <Load shape="cards" resource={rights} retry={retry}>{(view) => <ImportPanel worldId={worldId} kind="BOUNDS" canEdit={view.canEdit} />}</Load>
    </section>
  );
}

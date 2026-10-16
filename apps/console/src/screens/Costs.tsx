import type { BoundsIndexView } from '../api-types.ts';
import { useResource, worldPath } from '../api.ts';
import { Load, SectionAnchor, useMessages } from '../components.tsx';
import { BoundsIndex } from './Bounds.tsx';
import { CostImportPanel } from './CostImport.tsx';

/**
 * Шаг 95 [Р-217]: Costs & floors — прежние Bounds и Unit cost import одним экраном: сверху границы всех предложений (с массовой
 * правкой), ниже — импорт себестоимости разделом. Страница предложения «Bounds and price floor» остаётся своим адресом (`bounds/<id>`).
 * `section="import"` — прежний адрес `cost-import` и шаг онбординга ведут сразу к разделу импорта
 */
export function CostsScreen({ worldId, section, target = null }: { worldId: string; section: string | null; target?: string | null }) {
  const m = useMessages();
  const [rights, retry] = useResource<BoundsIndexView>(`${worldPath(worldId, 'bounds')}?offset=0&limit=1`, m.locale);
  return (
    <section className="costs">
      <h2>{m.ui.app.screens.costs}</h2>
      <p className="subtitle">{m.ui.app.subtitles.costs}</p>
      <p className="page-actions">
        <button type="button" onClick={() => document.getElementById('cost-import')?.scrollIntoView({ block: 'start' })}>{m.ui.costs.importAction}</button>
      </p>
      {/* Шаг 96 (В20): `costs/edit/<предложение>` — правка границ с этим предложением выбранным, прокручена к ней */}
      <BoundsIndex worldId={worldId} preselect={section === 'edit' ? target : null} focusEdit={section === 'edit'} />
      <SectionAnchor id="cost-import" focus={section === 'import'} />
      <Load shape="cards" resource={rights} retry={retry}>{(view) => <CostImportPanel worldId={worldId} canEdit={view.canEdit} />}</Load>
    </section>
  );
}

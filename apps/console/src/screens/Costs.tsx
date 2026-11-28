import { useState } from 'react';
import type { ImportKind } from '@repracer/console-model';
import type { BoundsIndexView } from '../api-types.ts';
import { useResource, worldPath } from '../api.ts';
import { Load, SectionAnchor, useMessages, useOpenBlocks } from '../components.tsx';
import { BoundsIndex } from './Bounds.tsx';
import { ImportPanel } from './Imports.tsx';

/**
 * Шаг 95 [Р-217]: Costs & floors — прежние Bounds и Unit cost import одним экраном: сверху границы всех предложений (с массовой
 * правкой), ниже — импорты разделами. Страница предложения «Bounds and price floor» остаётся своим адресом (`bounds/<id>`).
 * `section="import"` — прежний адрес `cost-import` и шаг онбординга ведут сразу к разделу импорта себестоимости.
 * Шаг 99 [Р-224, Р-225]: импортов здесь два — себестоимость и границы с минимальной маржой; меню не растёт.
 * Шаг 188 (письмо Мердана 28.11, §3; Р-254): массовая правка границ — главной кнопкой страницы; импорты (с их журналами) — раскрываемыми
 * разделами, свёрнутыми по умолчанию: раскрытие помнит браузер, адрес раздела и кнопка импорта раскрывают свой раздел
 */
export function CostsScreen({ worldId, section, target = null }: { worldId: string; section: string | null; target?: string | null }) {
  const m = useMessages();
  const [rights, retry] = useResource<BoundsIndexView>(`${worldPath(worldId, 'bounds')}?offset=0&limit=1`, m.locale);
  const blocks = useOpenBlocks('costs');
  const go = (id: string) => {
    const block = document.getElementById(`${id}-section`);
    if (block instanceof HTMLDetailsElement) block.open = true;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  };
  // Шаг 174 (BUG-01): импорт себестоимости или границ применён — список границ того же экрана перечитывается сам
  const [refresh, setRefresh] = useState(0);
  const applied = () => setRefresh((n) => n + 1);
  // Шаг 188: правка границ есть, когда есть предложения (шаг 79) — кнопка ведёт к ней только тогда
  const offers = rights.state === 'ready' && rights.data.page.total > 0;
  const importSection = (kind: ImportKind, anchor: string, focused: boolean, shared: boolean) => (
    <>
      <SectionAnchor id={anchor} focus={focused} />
      <details id={`${anchor}-section`} className={`card more-block import-section import-section-${kind.toLowerCase()}`} open={focused || blocks.isOpen(anchor)} onToggle={blocks.toggle(anchor)}>
        <summary>{m.ui.imports.titles[kind]}</summary>
        <Load shape="cards" resource={rights} retry={retry}>{(view) => <ImportPanel worldId={worldId} kind={kind} canEdit={view.canEdit} shared={shared} heading={false} onApplied={applied} />}</Load>
      </details>
    </>
  );
  return (
    <section className="costs">
      <h2>{m.ui.app.screens.costs}</h2>
      <p className="subtitle">{m.ui.app.subtitles.costs}</p>
      <p className="page-actions">
        {offers ? <button type="button" className="primary" onClick={() => go('bounds-edit')}>{m.ui.costs.bulkEditAction}</button> : null}
        <button type="button" onClick={() => go('cost-import')}>{m.ui.costs.importAction}</button>
        <button type="button" onClick={() => go('bounds-import')}>{m.ui.costs.importBoundsAction}</button>
      </p>
      {/* Шаг 96 (В20): `costs/edit/<предложение>` — правка границ с этим предложением выбранным, прокручена к ней */}
      <BoundsIndex worldId={worldId} preselect={section === 'edit' ? target : null} focusEdit={section === 'edit'} refresh={refresh} />
      {importSection('COSTS', 'cost-import', section === 'import', true)}
      {importSection('BOUNDS', 'bounds-import', section === 'bounds-import', false)}
    </section>
  );
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPickMore, MAX_MATCHES, MAX_PICKED, NO_SELECTION, parseOfferSelection, removeMatch, selectAllMatching, toggleOffer } from './selection.ts';

/**
 * Шаг 177 (#39, уточнение Р-140 2026-11-25): выбор переживает страницы и фильтры — отмеченные строки, «все подходящие» бейджами и снятые
 * вручную. Разбор держит пределы тела запроса; отметка и снятие ведут себя так, как продавец видит строку
 */
test('step 177: a selection is ticked rows, «all matching» filters and unticked rows; the request keeps within its limits', () => {
  assert.deepEqual(parseOfferSelection({ ids: ['a', 'a', 'b'], matches: [{ storefront: 'acc|de', q: '' }, { storefront: 'acc|de' }], except: [] }),
    { ids: ['a', 'b'], matches: [{ storefront: 'acc|de' }], except: [] }, 'duplicates and empty filter values are dropped');
  assert.deepEqual(parseOfferSelection({ matches: [{}] }), { ids: [], matches: [{}], except: [] }, 'an empty filter is the whole catalog');
  assert.equal(parseOfferSelection({ ids: [], matches: [{ secret: 'x' }], except: [] }), null, 'an unknown filter key');
  assert.equal(parseOfferSelection({ ids: Array.from({ length: MAX_PICKED }, (_, i) => `a${i}`), matches: [], except: ['b'] }), null, 'ticked and unticked together beyond the limit');
  assert.equal(parseOfferSelection({ ids: [], matches: Array.from({ length: MAX_MATCHES + 1 }, (_, i) => ({ q: `x${i}` })), except: [] }), null, 'too many filter badges');
  assert.equal(parseOfferSelection('everything'), null);

  // Отметка и снятие: снятая строка, выбранная фильтром, уходит в «снятые»; отмеченная вручную — из отмеченных; снятая раньше — возвращается
  const byFilter = selectAllMatching(NO_SELECTION, { storefront: 'acc|de' });
  const unticked = toggleOffer(byFilter, 'r1', false, true);
  assert.deepEqual(unticked.except, ['r1']);
  assert.deepEqual(toggleOffer(unticked, 'r1', true, false), byFilter, 'ticking it again brings it back');
  assert.deepEqual(toggleOffer(NO_SELECTION, 'r2', true, false).ids, ['r2']);
  assert.deepEqual(toggleOffer({ ...NO_SELECTION, ids: ['r2'] }, 'r2', false, true).ids, []);
  // «Select all matching» — явное действие: тот же фильтр дважды — один бейдж; выбранное раньше снова выбрано
  assert.deepEqual(selectAllMatching(unticked, { storefront: 'acc|de' }), byFilter);
  assert.deepEqual(removeMatch(byFilter, { storefront: 'acc|de' }).matches, []);
  assert.equal(canPickMore({ ids: Array.from({ length: MAX_PICKED - 1 }, (_, i) => `a${i}`), matches: [], except: ['b'] }), false);
  assert.equal(canPickMore(NO_SELECTION), true);
});

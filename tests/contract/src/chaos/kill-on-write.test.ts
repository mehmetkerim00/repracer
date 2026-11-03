import assert from 'node:assert/strict';
import { test } from 'node:test';
import { killOnWriteExpected, killOnWriteMissProbability } from './kill-on-write.ts';

/**
 * Шаг 113: «диспетчер убит в момент записи» обязано случиться, только когда промах почти невозможен. Красное сначала — прежнее условие
 * требовало события на прогоне 41700831667 (семя 1816539284), где инварианты всех раундов были чисты, а промах — около 3 %
 */
const oldExpected = (rounds: ReadonlyArray<{ share: number }>, journal: number) => rounds.some((r) => r.share > 0) && journal > 20;

test('step 113: a kill on a write is demanded only when missing it is next to impossible, not whenever the plan had a share', () => {
  // Прогон 41700831667: доля 0,17 только в раунде 1, к его концу 19 записей (шансов не больше), за весь прогон — 92
  const run = [{ share: 0.17, chances: 19 }, { share: 0, chances: 18 }, { share: 0, chances: 30 }, { share: 0, chances: 25 }];
  assert.equal(oldExpected(run, 92), true, 'the old rule demanded the kill on this run');
  assert.ok(Math.abs(killOnWriteMissProbability(run) - 0.83 ** 19) < 1e-12);
  assert.equal(killOnWriteExpected(run), false, 'a miss of about 3 % is not a defect');
  // Зубы [Р-94]: при достаточных шансах промах невозможен — событие требуется; без доли — никогда
  assert.equal(killOnWriteExpected([{ share: 0.17, chances: 60 }]), true);
  assert.equal(killOnWriteExpected([{ share: 0.05, chances: 100 }, { share: 0.2, chances: 20 }]), true);
  assert.equal(killOnWriteExpected([{ share: 0, chances: 1000 }]), false);
});

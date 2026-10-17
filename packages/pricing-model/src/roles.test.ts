import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, EXTENDED_ROLES, MEMBER_ROLES, offeredRoles, PRICING_ACTIONS, PRICING_PERMISSIONS, VISIBLE_ROLES, type MemberRole, type PricingAction } from './index.ts';

/**
 * Шаг 88 [Р-213], шаг 98 [Р-222]: матрица прав — таблицей, написанной РУКАМИ, а не выведенной из PRICING_PERMISSIONS (сравнение матрицы с
 * самой собой — тавтология [Р-94]). Каждая клетка — своя проверка с меткой «роль × право»: снятое или добавленное право у любой роли
 * краснеет ровно своей клеткой, и отказ проверяется так же, как разрешение. Совпадение с базой — тест step14 (finding 2), набор ролей
 * ограничения членства — тест на PostgreSQL.
 *
 * Шаг 98 (решение владельца): ролей для людей две — Owner и Manager, права одинаковые во всём, кроме денег (биллинга в продукте ещё нет —
 * ADR «billing is Owner-only»). Наблюдателя нет. Технический гость публичного демо (GUEST) — не роль продукта: только чтение, людям не
 * назначается и не показывается.
 */
const Y = true;
const N = false;
//                                         VIEW STOP RES_T RES_C HALT DISTR ENABLE SHADOW PRICE CATAL TENANT CONSENT
const EXPECTED: Readonly<Record<MemberRole, readonly boolean[]>> = {
  OWNER:             [Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y],
  MANAGER:           [Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y],
  GUEST:             [Y, N, N, N, N, N, N, N, N, N, N, N],
  ADMIN:             [Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, N],
  OPERATOR:          [Y, Y, N, Y, Y, N, Y, N, N, N, N, N],
  PRICING_MANAGER:   [Y, Y, N, Y, Y, N, Y, N, Y, N, N, N],
  INVENTORY_MANAGER: [Y, N, N, N, N, N, N, N, N, Y, N, N],
};
const COLUMNS: readonly PricingAction[] = ['VIEW_PRICING', 'STOP_PRICING', 'RESUME_TENANT_STOP', 'RESUME_CHANNEL_STOP', 'RELEASE_CHANNEL_HALT',
  'RELEASE_CHANNEL_DISTRUST', 'ENABLE_REPRICING', 'RETURN_TO_SHADOW', 'MANAGE_PRICING', 'MANAGE_CATALOG', 'MANAGE_TENANT', 'GIVE_MIGRATION_CONSENT'];

test('step 88 (Р-213), step 98 (Р-222): every right of every role is its own check, including every refusal', () => {
  // Таблица покрывает матрицу целиком: роль или право без клетки — красный тест, а не пропущенная проверка
  assert.deepEqual([...COLUMNS].sort(), [...PRICING_ACTIONS].sort(), 'the table names every right of the matrix');
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...MEMBER_ROLES].sort(), 'the table names every role of the model');
  for (const role of MEMBER_ROLES) {
    COLUMNS.forEach((action, i) => assert.equal(can(role, action), EXPECTED[role][i], `${role} × ${action}`));
  }
  // Ни одно право матрицы не пусто и не у всех сразу, кроме чтения: таблица не вырождена
  for (const action of PRICING_ACTIONS.filter((a) => a !== 'VIEW_PRICING')) {
    const holders = PRICING_PERMISSIONS[action].length;
    assert.ok(holders > 0 && holders < MEMBER_ROLES.length, `${action} is held by some roles, not all (${holders})`);
  }
});

test('step 98 (Р-222): owner and manager hold the same rights; the demo guest only reads; there is no viewer', () => {
  assert.deepEqual(PRICING_ACTIONS.filter((a) => can('OWNER', a) !== can('MANAGER', a)), [], 'the manager holds every right of the owner (money is not in the matrix yet)');
  assert.deepEqual(PRICING_ACTIONS.filter((a) => !can('OWNER', a)), [], 'the owner holds every right');
  assert.deepEqual(PRICING_ACTIONS.filter((a) => can('GUEST', a)), ['VIEW_PRICING'], 'the technical demo guest only reads');
  assert.equal((MEMBER_ROLES as readonly string[]).includes('VIEWER'), false, 'the viewer role is gone');
});

test('step 98 (Р-222): two roles for people; the extended set adds admin and operator; the guest is never offered; older roles stay in the model', () => {
  assert.deepEqual(offeredRoles(false), ['OWNER', 'MANAGER']);
  assert.deepEqual(offeredRoles(true), ['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR']);
  assert.deepEqual([VISIBLE_ROLES.length, EXTENDED_ROLES.length], [2, 4]);
  assert.ok(!offeredRoles(true).includes('GUEST'), 'the technical demo guest is not a product role');
  // Прежние роли не удалены: их назначения продолжают работать, хотя консоль их не предлагает
  for (const legacy of ['ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER'] as const) assert.ok(MEMBER_ROLES.includes(legacy), legacy);
  assert.ok(!offeredRoles(true).includes('PRICING_MANAGER') && !offeredRoles(true).includes('INVENTORY_MANAGER'), 'older roles are not offered for new assignments');
});

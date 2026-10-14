import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, EXTENDED_ROLES, MEMBER_ROLES, offeredRoles, PRICING_ACTIONS, PRICING_PERMISSIONS, VISIBLE_ROLES, type MemberRole, type PricingAction } from './index.ts';

/**
 * Шаг 88 [Р-213]: матрица прав — таблицей, написанной РУКАМИ, а не выведенной из PRICING_PERMISSIONS (сравнение матрицы с самой
 * собой — тавтология [Р-94]). Каждая клетка — своя проверка с меткой «роль × право»: снятое или добавленное право у любой роли
 * краснеет ровно своей клеткой, и отказ проверяется так же, как разрешение (менеджер не управляет тенантом, наблюдатель ничего не
 * меняет). Совпадение с базой — тест step14 (finding 2), набор ролей ограничения членства — тест шага 88 на PostgreSQL.
 */
const Y = true;
const N = false;
// Шаг 89 (ADR-0054, решение владельца): снятие недоверия каналу (DISTR) — только владелец и прежний администратор; обратно в тень (SHADOW) —
// и менеджер
//                                         VIEW STOP RES_T RES_C HALT DISTR ENABLE SHADOW PRICE CATAL TENANT CONSENT
const EXPECTED: Readonly<Record<MemberRole, readonly boolean[]>> = {
  OWNER:             [Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y],
  MANAGER:           [Y, Y, Y, Y, Y, N, Y, Y, Y, Y, N, N],
  VIEWER:            [Y, N, N, N, N, N, N, N, N, N, N, N],
  ADMIN:             [Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, Y, N],
  OPERATOR:          [Y, Y, N, Y, Y, N, Y, N, N, N, N, N],
  PRICING_MANAGER:   [Y, Y, N, Y, Y, N, Y, N, Y, N, N, N],
  INVENTORY_MANAGER: [Y, N, N, N, N, N, N, N, N, Y, N, N],
};
const COLUMNS: readonly PricingAction[] = ['VIEW_PRICING', 'STOP_PRICING', 'RESUME_TENANT_STOP', 'RESUME_CHANNEL_STOP', 'RELEASE_CHANNEL_HALT',
  'RELEASE_CHANNEL_DISTRUST', 'ENABLE_REPRICING', 'RETURN_TO_SHADOW', 'MANAGE_PRICING', 'MANAGE_CATALOG', 'MANAGE_TENANT', 'GIVE_MIGRATION_CONSENT'];

test('step 88 (Р-213): every right of every role is its own check, including every refusal', () => {
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

test('step 88 (Р-213): the manager is the daily work, the owner keeps people and channel accounts, the viewer changes nothing', () => {
  // Менеджер: цены, границы, стратегии, остатки, импорт себестоимости, массовые операции, стоп-кран
  for (const action of ['MANAGE_PRICING', 'MANAGE_CATALOG', 'ENABLE_REPRICING', 'STOP_PRICING', 'RESUME_TENANT_STOP', 'RETURN_TO_SHADOW'] as const) {
    assert.equal(can('MANAGER', action), true, `MANAGER × ${action}`);
  }
  // Люди, аккаунты каналов и согласие на миграцию eBay — не у менеджера
  assert.deepEqual([can('MANAGER', 'MANAGE_TENANT'), can('MANAGER', 'GIVE_MIGRATION_CONSENT')], [false, false]);
  // Шаг 89 (ADR-0054): снова поверить каналу решает владелец; вернуть аккаунт в тень — безопасная сторона, может и менеджер
  assert.deepEqual([can('MANAGER', 'RELEASE_CHANNEL_DISTRUST'), can('OWNER', 'RELEASE_CHANNEL_DISTRUST'), can('MANAGER', 'RETURN_TO_SHADOW'), can('VIEWER', 'RETURN_TO_SHADOW')],
    [false, true, true, false]);
  assert.deepEqual(PRICING_ACTIONS.filter((a) => can('VIEWER', a)), ['VIEW_PRICING'], 'the viewer only reads');
  assert.deepEqual(PRICING_ACTIONS.filter((a) => !can('OWNER', a)), [], 'the owner holds every right');
});

test('step 88 (Р-213): three visible roles; the extended set adds admin and operator; older roles stay in the model', () => {
  assert.deepEqual(offeredRoles(false), ['OWNER', 'MANAGER', 'VIEWER']);
  assert.deepEqual(offeredRoles(true), ['OWNER', 'MANAGER', 'VIEWER', 'ADMIN', 'OPERATOR']);
  assert.deepEqual([VISIBLE_ROLES.length, EXTENDED_ROLES.length], [3, 5]);
  // Прежние роли не удалены: их назначения продолжают работать, хотя консоль их не предлагает
  for (const legacy of ['ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER'] as const) assert.ok(MEMBER_ROLES.includes(legacy), legacy);
  assert.ok(!offeredRoles(true).includes('PRICING_MANAGER') && !offeredRoles(true).includes('INVENTORY_MANAGER'), 'older roles are not offered for new assignments');
});

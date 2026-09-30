import assert from 'node:assert/strict';
import type { ConnectionsView } from '@repracer/console-model';
import type { PgChannelConnectStore } from '@repracer/pricing-store-pg';
import type { ChannelConnectService } from '../server/connect.ts';

/**
 * Шаг 60 [Р-202]: запись количества в канал выключена, пока владелец не подтвердил на экране подключений, что другие
 * инструменты количество в этом канале не ведут. Прогоны через консоль [Р-136] делают это так же, как продавец: читают
 * экран подключений, отвечают «других инструментов нет» и набирают идентификатор аккаунта, который экран показал.
 */

/** Ответ консоли: статус и тело (JSON) — у каждого прогона свой способ ходить по HTTP */
export type ConsoleRequest = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * Экран подключений мира без приложений каналов (стенд на базе): аккаунты и их состояние читает то же хранилище, что в
 * работе (`PgChannelConnectStore`), а подключать новые каналы нечем — кнопок подключения нет, как у мира без приложения
 */
export function connectionsOnly(store: PgChannelConnectStore): ChannelConnectService {
  return {
    connectable: () => [],
    connections: (tenantId) => store.connections(tenantId),
    start: async () => ({ status: 'UNAVAILABLE' }),
    callback: async () => ({ status: 'BAD_CALLBACK' }),
    cancel: async () => false,
  };
}

/** Владелец: «других инструментов нет» и подтверждение набранным идентификатором аккаунта — оба ответа консоли 200 */
export async function confirmQuantityWritesAsOwner(request: ConsoleRequest, connectionsUrl: string, channelAccountId: string): Promise<void> {
  const answered = await request('POST', `${connectionsUrl}/other-tools`, { channelAccountId, answer: 'NONE' });
  assert.equal(answered.status, 200, `ответ «других инструментов нет»: ${JSON.stringify(answered.body)}`);
  const screen = await request('GET', connectionsUrl);
  assert.equal(screen.status, 200, JSON.stringify(screen.body).slice(0, 300));
  const account = (screen.body as ConnectionsView).accounts.find((a) => a.channelAccountId === channelAccountId);
  assert.ok(account, `аккаунт ${channelAccountId} на экране подключений`);
  assert.ok(account.quantityWrites.canConfirm && account.quantityWrites.typeToConfirm, `владелец может подтвердить: ${account.quantityWrites.blockedText}`);
  const confirmed = await request('POST', `${connectionsUrl}/quantity-writes`, { channelAccountId, typedConfirmation: account.quantityWrites.typeToConfirm });
  assert.equal(confirmed.status, 200, `подтверждение записи количества: ${JSON.stringify(confirmed.body)}`);
}

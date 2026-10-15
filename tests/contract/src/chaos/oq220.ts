/**
 * Шаг 90 (OQ-220, решение владельца — docs/deferred.md): признание инварианта d) хаоса «канал ниже нашего количества на число отмен».
 *
 * Модель Kaufland списывает `amount` при заказе и при отмене его не возвращает (допущение K-11, Kaufland не подтвердил). Наша запись
 * количества — абсолютное значение, посчитанное из резерваций на момент РАСЧЁТА: отмена, которую расчёт не видел, в канал не доходит,
 * пока не уйдёт следующая запись, а её может не быть — освобождённое тут же занимает новый заказ, и цель не меняется. Окно признания
 * поэтому — от расчёта последней применённой каналом записи, а не от её применения (до шага 90).
 *
 * «Расчёт не видел отмену» — по факту базы: резервацию строки заказа освободили ПОСЛЕ начала расчёта (`released_at` позже `created_at`
 * версии записи; в одной транзакции они равны — такой расчёт отмену видел). Отмену, которую мы не прочитали вовсе (резервации нет),
 * расчёт тоже не видел, если канал отменил заказ после расчёта. Время отмены в канале само по себе признаком не служит: семя 374308551
 * (шаг 84.1) — канал отменил заказ за 10,7 с до применения записи «19», а мы прочитали отмену позже её расчёта.
 *
 * Момент расчёта — `created_at` версии с тем же количеством, созданной не позже применения; из таких — самая поздняя (окно узкое:
 * признаётся меньше, а не больше). Нет такой версии — окно от применения, как до шага 90.
 */

export interface AppliedAmountWrite { atMs: number; amount: number }
export interface QuantityVersion { createdAtMs: number; quantity: number | null }
/**
 * Заказ канала и наша резервация его строки: `releasedAtMs` — когда мы освободили резервацию (прочли отмену); `null` — резервация есть,
 * но не освобождена; поля нет — резервации не было (заказ отменён раньше, чем мы его прочли)
 */
export interface ChannelOrder { status: 'open' | 'sent' | 'cancelled'; tsUpdatedMs: number; releasedAtMs?: number | null }

/** Последняя применённая каналом запись количества предложения и момент её расчёта; записи нет — null */
export function lastAppliedWrite(applied: readonly AppliedAmountWrite[], versions: readonly QuantityVersion[]): { appliedAtMs: number; computedAtMs: number; amount: number } | null {
  const last = applied.reduce<AppliedAmountWrite | null>((a, w) => (a === null || w.atMs >= a.atMs ? w : a), null);
  if (last === null) return null;
  const computedAtMs = versions
    .filter((v) => v.quantity === last.amount && v.createdAtMs <= last.atMs)
    .reduce((at, v) => Math.max(at, v.createdAtMs), Number.NEGATIVE_INFINITY);
  return { appliedAtMs: last.atMs, computedAtMs: Number.isFinite(computedAtMs) ? computedAtMs : last.atMs, amount: last.amount };
}

/** Отмены, которых расчёт последней применённой записи не видел */
export function oq220Drift(applied: readonly AppliedAmountWrite[], versions: readonly QuantityVersion[], orders: readonly ChannelOrder[]): number {
  const last = lastAppliedWrite(applied, versions);
  const from = last === null ? Number.NEGATIVE_INFINITY : last.computedAtMs;
  return orders.filter((o) => {
    if (o.status !== 'cancelled') return false;
    const seenAt = o.releasedAtMs === undefined || o.releasedAtMs === null ? o.tsUpdatedMs : o.releasedAtMs;
    return seenAt > from;
  }).length;
}

/** Признано OQ-220: канал НИЖЕ нашего значения ровно на число неучтённых отмен (безопасная сторона); иначе — расхождение */
export function recognisedAsOq220(ours: number, channelValue: number, drift: number): boolean {
  return channelValue < ours && drift > 0 && ours - channelValue === drift;
}

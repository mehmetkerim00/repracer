/**
 * Шаг 56: нарушение порядка — версия МЕНЬШЕ наибольшей, уже отправленной по единице (старая после новой), либо та же версия с ДРУГОЙ
 * суммой. Повтор той же версии с той же суммой — законная повторная отправка после убитого экземпляра (at-least-once до канала,
 * идемпотентно по версии): прежнее `<=` считал её нарушением, и полный прогон шага 53 краснел на законном поведении (2 повтора)
 */
export function adapterOrder(calls: ReadonlyArray<{ write_scope_id: string; version: number | string; amount_minor: number | string }>) {
  const lastCall = new Map<string, { version: number; amount: number }>();
  let adapterVersionViolations = 0;
  let adapterIdempotentRepeats = 0;
  for (const c of calls) {
    const prev = lastCall.get(c.write_scope_id);
    const version = Number(c.version);
    const amount = Number(c.amount_minor);
    if (prev && version < prev.version) adapterVersionViolations++;
    else if (prev && version === prev.version) {
      if (amount === prev.amount) adapterIdempotentRepeats++;
      else adapterVersionViolations++;
    }
    if (!prev || version >= prev.version) lastCall.set(c.write_scope_id, { version, amount });
  }
  return { lastCall, adapterVersionViolations, adapterIdempotentRepeats };
}

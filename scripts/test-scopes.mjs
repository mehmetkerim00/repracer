// Р-137 (шаг 29): CI делится на быстрый и полный прогон.
//
// Быстрый — на каждый коммит: типы, юнит-тесты и всё, чему хватает PostgreSQL. Полный — при слиянии в main: сверх быстрого ещё
// мутационная проверка схемы, брокер, ClickHouse и запуск развёртываний. Причина разделения: на шаге 28 прогон отменился по
// лимиту в 40 минут, и разбор простой опечатки стоил трёх четвертей часа.
//
// Здесь — ИМЕНА файлов, которым нужна инфраструктура сверх PostgreSQL. Список явный, а не догадка по имени файла: тест,
// случайно попавший сюда, перестанет идти в быстром прогоне, поэтому каждая строка названа с причиной. Тест не «пропускается»
// [Р-84] — он идёт в полном прогоне, и быстрый печатает, что именно отложено.

/** @type {{ file: string; needs: 'CLICKHOUSE' | 'BROKER'; why: string }[]} */
export const INFRASTRUCTURE_TESTS = [
  {
    file: 'packages/pricing-store-pg/test/clickhouse-export.pg.test.ts', needs: 'CLICKHOUSE',
    why: 'выгрузка суток в аналитический слой и сверка разбора: пишет и читает настоящий ClickHouse',
  },
  {
    file: 'services/scheduler/test/history-survives-stop.pg.test.ts', needs: 'CLICKHOUSE',
    why: 'история снимков переживает остановку планировщика — проверяется по данным в ClickHouse',
  },
  {
    file: 'services/pricing-worker/test/order-behind-broker.test.ts', needs: 'BROKER',
    why: 'порядок записей за брокером: нужен настоящий Kafka-совместимый брокер (Redpanda)',
  },
];

export const INFRASTRUCTURE_FILES = new Set(INFRASTRUCTURE_TESTS.map((t) => t.file));

/** Файлы области: быстрый прогон — всё, кроме инфраструктурных; полный — всё */
export function filesForScope(included, scope) {
  return scope === 'fast' ? included.filter((f) => !INFRASTRUCTURE_FILES.has(f)) : [...included];
}

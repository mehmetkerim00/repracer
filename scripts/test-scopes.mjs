// Р-137 (шаг 29): CI делится на быстрый и полный прогон.
//
// Быстрый — на каждый коммит: типы, юнит-тесты и всё, чему хватает PostgreSQL. Полный — при слиянии в main: сверх быстрого ещё
// мутационная проверка схемы, брокер, ClickHouse и запуск развёртываний. Причина разделения: на шаге 28 прогон отменился по
// лимиту в 40 минут, и разбор простой опечатки стоил трёх четвертей часа.
//
// Здесь — ИМЕНА файлов, которым нужна инфраструктура сверх PostgreSQL. Список явный, а не догадка по имени файла: тест,
// случайно попавший сюда, перестанет идти в быстром прогоне, поэтому каждая строка названа с причиной. Тест не «пропускается»
// [Р-84] — он идёт в полном прогоне, и быстрый печатает, что именно отложено.

/** @type {{ file: string; needs: 'CLICKHOUSE' | 'BROKER' | 'TIME'; why: string }[]} */
export const INFRASTRUCTURE_TESTS = [
  {
    // Шаг 35 [Р-154]: критерий закрытия OQ-214 — стенд живёт виртуальные СУТКИ, и все экраны отвечают в пределе. Сутки на 200
    // предложениях — около получаса настоящего времени: в быстрый прогон не помещается, в полном идёт своим заданием
    file: 'apps/console/test/demo-day-live.pg.test.ts', needs: 'TIME',
    why: 'демо-стенд живёт виртуальные сутки (~30 мин работы планировщика), затем все экраны обходятся как браузер',
  },
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

/** Долгие прогоны идут СВОИМ заданием CI (ci.yml: demo-day), а не внутри полного — иначе полный вышел бы за предел */
export const LONG_FILES = new Set(INFRASTRUCTURE_TESTS.filter((t) => t.needs === 'TIME').map((t) => t.file));

/** Файлы области: быстрый прогон — всё, кроме инфраструктурных и долгих; полный — всё, кроме долгих; `long` — только долгие */
export function filesForScope(included, scope) {
  if (scope === 'fast') return included.filter((f) => !INFRASTRUCTURE_FILES.has(f));
  if (scope === 'long') return included.filter((f) => LONG_FILES.has(f));
  return included.filter((f) => !LONG_FILES.has(f));
}

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
    // Шаг 36 [Р-155]: замер пакетной записи на каталоге целевого клиента — 10 000 предложений отправляются дважды,
    // по одной и пакетами. Посев каталога и 10 000 одиночных отправок — десятки минут: в быстрый прогон не помещается
    file: 'tests/contract/src/bulk-dispatch.pg.test.ts', needs: 'TIME',
    why: 'запись 10 000 предложений в канал дважды: по одной (столько же запросов) и пакетами (до 150 единиц в запросе)',
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

/**
 * Шаг 36: прогоны, которые УТВЕРЖДАЮТ время. Node запускает файлы одного рабочего пространства параллельно, и такой прогон
 * делит процессор и PostgreSQL с соседями — тогда он измеряет не продукт, а загрузку машины. На шаге 36 это увидели прямо:
 * предпросмотр стратегии на 10 000 предложений шёл 58 секунд в одиночку и не уложился в предел 120 секунд, пока рядом шли
 * остальные живые прогоны консоли. Поэтому такие файлы идут ПО ОДНОМУ, без соседей в том же рабочем пространстве.
 *
 * Список явный: файл, утверждающий секунды и не названный здесь, снова начнёт мерить чужую нагрузку.
 */
export const MEASURED_FILES = new Set([
  'apps/console/test/console-live.pg.test.ts',
  'apps/console/test/onboarding-live.pg.test.ts',
  'apps/console/test/stock-only-live.pg.test.ts',
  'apps/console/test/demo-day-live.pg.test.ts',
  'tests/contract/src/cost-import-live.pg.test.ts',
]);

/** Файлы области: быстрый прогон — всё, кроме инфраструктурных и долгих; полный — всё, кроме долгих; `long` — только долгие */
export function filesForScope(included, scope) {
  if (scope === 'fast') return included.filter((f) => !INFRASTRUCTURE_FILES.has(f));
  if (scope === 'long') return included.filter((f) => LONG_FILES.has(f));
  return included.filter((f) => !LONG_FILES.has(f));
}

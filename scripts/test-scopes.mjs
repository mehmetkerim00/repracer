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
    // Шаг 41 [Р-169…Р-171]: сутки демо В ТЕНИ — движок работает целиком, к каналу не уходит ни одного изменяющего запроса.
    // Сутки на 200 предложениях — около получаса настоящего времени, как и боевые сутки шага 35
    file: 'apps/console/test/shadow-live.pg.test.ts', needs: 'TIME',
    why: 'сутки демо в теневом режиме, затем включение боя через консоль и возврат в тень',
  },
  {
    // Шаг 36 [Р-155]: замер пакетной записи на каталоге целевого клиента — 10 000 предложений отправляются дважды,
    // по одной и пакетами. Посев каталога и 10 000 одиночных отправок — десятки минут: в быстрый прогон не помещается
    file: 'tests/contract/src/bulk-dispatch.pg.test.ts', needs: 'TIME',
    why: 'запись 10 000 предложений в канал дважды: по одной (столько же запросов) и пакетами (до 150 единиц в запросе)',
  },
  {
    // Находка 17 ревью шага 42: два виртуальных часа витрины США со своей базой шли в БЫСТРОЙ области на каждый коммит
    file: 'apps/console/test/us-shadow-live.pg.test.ts', needs: 'TIME',
    why: 'витрина США в тени два виртуальных часа через консоль: решения в долларах, бой закрыт неизвестной границей суток, дайджест',
  },
  {
    // Шаг 65, часть 1: хаос — настоящие процессы убиваются посреди работы, канал портит ответы; раунд — минута работы и до шести минут
    // затишья (запись, оставленная убитым диспетчером в полёте, сверяется после срока в 120 с). Своё задание CI
    file: 'tests/contract/src/chaos.pg.test.ts', needs: 'TIME',
    why: 'раунды хаоса: SIGKILL планировщика, диспетчера, консоли и исполнителя заданий, порча канала, инварианты после каждого раунда',
  },
  {
    // Шаг 65, часть 3: масштаб — каталог в 50 000 предложений: посев, пересчёт, кандидаты, экраны, круги и суточные работы. Своё задание CI
    file: 'tests/contract/src/scale.pg.test.ts', needs: 'TIME',
    why: 'каталог 50 000 предложений: пересчёт остатков, выборка кандидатов, экраны консоли, круги обнаружения и сверки, суточные работы',
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
 * Шаг 41 [Р-169]: сутки в ТЕНИ — своё задание CI (`shadow-day`), а не внутри `demo-day`. Причина арифметическая: в
 * задании суток уже живут боевые сутки демо и замер пакетной записи, вместе это 91 минута при пределе 110 — третьи сутки
 * в том же задании его гарантированно перерастили бы.
 */
export const SHADOW_FILES = new Set(['apps/console/test/shadow-live.pg.test.ts']);

/** Шаг 65: хаос и масштаб — каждый своим заданием CI: в задании long (сутки демо и замеры) они не помещаются в предел */
export const CHAOS_FILES = new Set(['tests/contract/src/chaos.pg.test.ts']);
export const SCALE_FILES = new Set(['tests/contract/src/scale.pg.test.ts']);

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
  'apps/console/test/guest-demo-live.pg.test.ts',
  'tests/contract/src/cost-import-live.pg.test.ts',
  // Шаг 40 [Р-165]: прогон панели оператора утверждает секунды экранов и держит под собой живой демо-мир
  'apps/operator/test/operator-live.pg.test.ts',
  // Шаг 41: прогон тени утверждает секунды экрана и держит под собой суточный демо-мир
  'apps/console/test/shadow-live.pg.test.ts',
  // Шаг 42: прогон витрины США утверждает секунды экранов и держит под собой мир amazon.com
  'apps/console/test/us-shadow-live.pg.test.ts',
  // Шаг 56: замер запроса остатков на 10 000 единиц утверждает секунды — идёт в одиночку (задание long CI)
  'tests/contract/src/bulk-dispatch.pg.test.ts',
  // Шаг 43: прогон подключения канала утверждает секунды экранов и держит под собой планировщик и мир Kaufland
  'apps/console/test/connect-live.pg.test.ts',
  // Шаг 44 [Р-179]: полный путь пилота утверждает секунды экранов и держит под собой панель, поставщика входа и исполнителя заданий
  'apps/console/test/pilot-live.pg.test.ts',
  // Шаг 47, D: путь пилота с каналом eBay утверждает секунды экранов и держит под собой панель, модели поставщиков и исполнителя
  'apps/console/test/pilot-ebay-live.pg.test.ts',
  // Шаг 64: путь продавца из США (EBAY_US, USD, английский) до записи цены в бою стенда
  'apps/console/test/pilot-us-live.pg.test.ts',
  // Шаг 65: хаос держит четыре настоящих процесса и ждёт затишья по секундам; масштаб утверждает секунды на 50 000 предложений
  'tests/contract/src/chaos.pg.test.ts',
  'tests/contract/src/scale.pg.test.ts',
  // Шаг 65: учение восстановления утверждает время «от файлов копии до ответа консоли» и держит под собой процесс консоли
  'packages/pricing-store-pg/test/disaster-recovery.pg.test.ts',
  // Шаг 67 (ревью, находка 1): чтения каталога без статистики — пределы в секундах и контроль, упирающийся в предел времени
  'packages/pricing-store-pg/test/console-fresh-stats.pg.test.ts',
]);

/**
 * Области прогона — ОДНИМ списком, и он же проверяет аргумент `--scope=` в `test-all.mjs`. До шага 42 список жил в двух
 * местах: здесь (какие файлы брать) и там (какое значение считать известным). Новая область `shadow` была добавлена только
 * здесь, и задание CI `shadow-day` падало строкой «неизвестная область прогона» — ни одного теста не запустив.
 */
export const SCOPES = ['fast', 'full', 'long', 'shadow', 'chaos', 'scale'];

/** Файлы области: быстрый прогон — всё, кроме инфраструктурных и долгих; полный — всё, кроме долгих; `long` — только долгие */
export function filesForScope(included, scope) {
  if (scope === 'fast') return included.filter((f) => !INFRASTRUCTURE_FILES.has(f));
  if (scope === 'shadow') return included.filter((f) => SHADOW_FILES.has(f));
  if (scope === 'chaos') return included.filter((f) => CHAOS_FILES.has(f));
  if (scope === 'scale') return included.filter((f) => SCALE_FILES.has(f));
  if (scope === 'long') return included.filter((f) => LONG_FILES.has(f) && !SHADOW_FILES.has(f) && !CHAOS_FILES.has(f) && !SCALE_FILES.has(f));
  return included.filter((f) => !LONG_FILES.has(f));
}

/**
 * Шаг 106 (решение владельца после шага 105): быстрая область идёт ДВУМЯ параллельными заданиями CI, у каждого предел 40 минут. Предел
 * не поднят — быстрый прогон растёт с каждым шагом, и подъём только отсрочил бы снятие: push-прогон шага 105 снят на 40-й минуте, тот же
 * код в соседнем прогоне прошёл за 36 (раннер был на четверть медленнее по всему прогону, зависших тестов не было).
 *
 * Единица деления — общий прогон рабочего пространства или файл-замер (они идут по одному, MEASURED_FILES). Вес — минуты из журнала
 * зелёного быстрого прогона шага 105 по запросу (39600159918); единице без веса — FAST_UNIT_DEFAULT_MINUTES. Деление жадное: тяжёлые
 * единицы первыми в более лёгкий шард, при равенстве — в меньший номер; каждый файл — ровно в одном шарде (правило репозитория).
 * Веса — не предел и не обещание: при сильном перекосе шардов в CI таблицу обновляют по свежему журналу.
 */
export const FAST_SHARDS = 2;
const FAST_UNIT_DEFAULT_MINUTES = 0.1;
const FAST_UNIT_MINUTES = {
  'tests/contract': 9.3,
  'apps/console': 7.9,
  'apps/console/test/console-live.pg.test.ts': 6.5,
  'apps/console/test/onboarding-live.pg.test.ts': 4.1,
  'tests/contract/src/cost-import-live.pg.test.ts': 2.1,
  'apps/operator': 0.8,
  'packages/pricing-store-pg': 0.6,
  'apps/console/test/pilot-live.pg.test.ts': 0.4,
  'apps/console/test/pilot-us-live.pg.test.ts': 0.4,
  'apps/console/test/pilot-ebay-live.pg.test.ts': 0.3,
  'apps/console/test/stock-only-live.pg.test.ts': 0.3,
  'apps/console/test/connect-live.pg.test.ts': 0.2,
  'apps/console/test/guest-demo-live.pg.test.ts': 0.2,
  'apps/operator/test/operator-live.pg.test.ts': 0.2,
};

/**
 * Шарды быстрой области: массив из FAST_SHARDS списков файлов. `workspaceOf(file)` — рабочее пространство файла относительно корня
 * ('.' — корень), как его считает test-all
 */
export function fastShards(files, workspaceOf) {
  const units = new Map();
  for (const f of files) {
    const key = MEASURED_FILES.has(f) ? f : workspaceOf(f);
    units.set(key, [...(units.get(key) ?? []), f]);
  }
  const order = [...units.keys()].sort((a, b) => ((FAST_UNIT_MINUTES[b] ?? FAST_UNIT_DEFAULT_MINUTES) - (FAST_UNIT_MINUTES[a] ?? FAST_UNIT_DEFAULT_MINUTES)) || a.localeCompare(b));
  const shards = Array.from({ length: FAST_SHARDS }, () => ({ minutes: 0, files: [] }));
  for (const key of order) {
    const lightest = shards.reduce((best, s, i) => (s.minutes < shards[best].minutes ? i : best), 0);
    shards[lightest].minutes += FAST_UNIT_MINUTES[key] ?? FAST_UNIT_DEFAULT_MINUTES;
    shards[lightest].files.push(...units.get(key));
  }
  return shards.map((s) => s.files);
}

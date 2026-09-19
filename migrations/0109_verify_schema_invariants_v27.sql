-- 0109_verify_schema_invariants_v27.sql
-- Проверка схемы после шага 30 — последняя в наборе (0107 остаётся историей); правила v26 без изменений.
-- Шаг 30: 0108 — массовые операции продавца как фоновые задания [Р-139]: `tenant_data.bulk_job` и `tenant_data.bulk_job_artifact`,
-- второй фактор, предъявленный при СОЗДАНИИ задания (`security.second_factor_present`), право по виду задания [Р-100], аренда
-- задания и неизменяемость его итога; роль исполнителя `repracer_bulk_worker` ведёт задание отдельно от административной записи
-- человека [Р-90], поэтому ход задания не становится строкой аудита. Поведение — смоук-тесты и мутационная проверка [Р-108].
-- Проверка схемы после шага 29 — последняя в наборе (0105 остаётся историей); правила v25 без изменений.
-- Шаг 29: 0106 — комиссия «от продавца» отдельным источником оценки [Р-138] (число продавца не выдаёт себя за тарифную таблицу
-- репозитория [Р-32], пол маржи считается по большей из действующих оценок) и гардрейл шире одного предложения в окне массовой
-- правки [Р-135]: пол маржи всех предложений тенанта меняют со вторым фактором, и следующая правка в те же десять минут — тоже.
-- Поведение — смоук-тесты и мутационная проверка [Р-108].
-- Проверка схемы после шага 28 — последняя в наборе (0102 остаётся историей); правила v24 без изменений.
-- Шаг 28: 0103 — массовый импорт себестоимости [Р-134] и второй фактор массового изменения [Р-135, риск 17]: пакет `cost_import`,
-- строки импорта только внутри транзакции пакета, отложенная проверка «принесено ровно объявленное», окно десяти минут и признак
-- `created_with_mfa` у версий цены и себестоимости; 0104 — вид повтора работы в базе [Р-133]: у внутренних работ пауза растёт от
-- минуты, у работ канала — от периода работы. Поведение — смоук-тесты и мутационная проверка [Р-108].
-- Проверка схемы после шага 27 — последняя в наборе (0097 остаётся историей). Изменение правил одно, задача F шага 27: «таблица тенанта
-- названа в очистке тенанта» теперь проверяет ВСЕ таблицы данных тенанта и канала, а не только те, у которых срок — TENANT_CLOSURE_ONLY.
-- Правило нашло три таблицы данных канала, которые закрытие тенанта не удаляло (0100): ссылку решения на снимок, наблюдения выборки для
-- снятия остановки и подрез версии стратегии. Классы AUDIT и LEGAL из правила исключены сознательно: их строки переживают закрытие тенанта
-- и удаляются по времени (правило 4 выше), иначе доказательства исчезали бы вместе с клиентом.
-- Шаг 27: 0098 — себестоимость как условие включения репрайсинга [Р-131]; 0099 — реестр параметров причин знает COST_REQUIRED;
-- 0100 — закрытие тенанта удаляет все таблицы данных канала; 0101 — поправка суток после опоздавшего подтверждения [Р-29, OQ-192];
-- поведение — смоук-тесты и мутационная проверка [Р-108].
-- Проверка схемы после шага 26 — последняя в наборе (0093 остаётся историей); правила v22 без изменений. Шаг 26: 0094 — момент регистрации
-- работы и уровень отставания планировщика в базе [риск 31]; 0095 — учётная запись оператора платформы для разбора пропусков выгрузки и
-- сверка «выгружен после исправления» с ClickHouse [OQ-182]; 0096 — окно Omnibus и суточная свёртка по времени применения цены каналом
-- [OQ-180]; поведение — смоук-тесты и мутационная проверка [Р-108].
-- Проверка схемы после шага 25 — последняя в наборе (0089 остаётся историей); правила v21 без изменений. Шаг 25: 0090 — планировщик
-- периодических работ [Р-126]. Проверка схемы после шага 24 (0084 — история). Одно изменение правил: в список функций SECURITY DEFINER,
-- которые исполняет путь решения, добавлена channel_data.review_notification_loss — вердикт сверки опросом ставит база [Р-121, 0088].
-- Шаг 24: 0085 — остановка человеком держит CHANNEL_MIN_PRICE [OQ-172], назначается только действующая версия стратегии [OQ-169];
-- 0086 — журнал полных снимков конкурентов для ClickHouse [Р-122]; 0087 — наименьшая цена 30 суток витрины и объявления скидок [Р-123];
-- 0088 — проверка потери уведомлений и её вердикт [Р-121]; поведение — смоук-тесты и мутационная проверка [Р-108].
-- Шаг 23: 0082 — остановка по
-- недоверию каналу [Р-118], справочники поведения каналов и источников конкурентов [Р-119, Р-39], страж назначения стратегии [OQ-166, Р-120];
-- 0083 — приёмник уведомлений Amazon (маршрут продавца, журнал уведомлений, PRICING_HEALTH); поведение — смоук-тесты и мутационная
-- проверка [Р-108].
-- Шаг 22: 0080 — остановка витрины по неверной базе цены [Р-116] (заменена 0082), реестры параметров Р-115 и Р-116.
-- Шаг 21: 0077 даёт имена ограничениям Р-111, 0078 — страж массовой правки границ [Р-88, OQ-144].
-- Шаг 20: миграции 0074–0075 добавили
-- проверку элемента согласия eBay по предполётной проверке [Р-109] — её поведение проверяют смоук-тесты и мутационная проверка [Р-108].
-- Р-93: правило проверяет ПОВЕДЕНИЕ либо не существует. Р-94: правило,
-- зеленеющее из-за другой защиты, считается несуществующим — поэтому список разрешённого сверяется в обе стороны, а неизменяемость
-- проверяется свойством триггера и попыткой изменения, а не именем zz_append_only (находка 4 ревью шага 16).
-- Остались:
--   - свойства каталога, которые и есть поведение: RLS ENABLE+FORCE, регистрация и сроки хранения, политики, неизменяемость как
--     свойство триггера, точное соответствие прав пути решения списку разрешённого [Р-96], страж и аудит административной записи
--     [Р-97], отсутствие BYPASSRLS, SECURITY DEFINER с фиксированным search_path, security_invoker;
--   - данные справочников, от которых зависит поведение (НДС по умолчанию, витрины и их пояса, срок ссылки на снимок);
--   - поведенческие проверки в откатываемой подтранзакции: синтетический тенант строится и полностью откатывается, в базе не
--     остаётся ничего — Р-83 (отправка ниже пересчитанного пола маржи), находка 15 и Р-91 (слепок и стратегия), плюс поведение
--     самой защиты неизменяемости на временной таблице.
-- Удалены правила, сверявшие имена триггеров, ограничений и текст функций, и перечень запретов пути решения (Р-96: перечисляется
-- разрешённое). Какое поведенческое правило заменяет каждое — migrations/README.md, разделы «Р-93» и «Р-96».
-- Шаг 18: роль остатков сверяется со своим списком разрешённого [Р-102]; страж административной записи — по операциям и столбцам,
-- у каждой административной таблицы объявлено действие (роль, а не членство) [Р-100]; у привязок входа — срок хранения [OQ-153].
-- Шаг 19: права роли остатков сверяются и по столбцам, запись в канал — только поле QUANTITY [Р-105]; условие WHEN есть только у
-- перечисленных триггеров (условие WHEN (false) выключает защиту, не удаляя её); функция, принадлежащая служебной роли, — SECURITY
-- DEFINER (CREATE OR REPLACE сбрасывает атрибут: так 0069 незаметно лишила атрибута проверку привязок входа); привязки входа удаляет
-- только роль удаления привязок, у роли хранения прав на них нет (находка 5 ревью шага 18).

BEGIN;

DO $$
DECLARE
  r   record;
  bad text[] := '{}';
  -- поведенческие проверки
  verdict text;
  cap     record;
  t   constant uuid := 'f0930000-0000-4000-8000-000000000001';
  u   constant uuid := 'f0930000-0000-4000-8000-000000000002';
  m   constant uuid := 'f0930000-0000-4000-8000-000000000003';
  acc constant uuid := 'f0930000-0000-4000-8000-000000000004';
  prod constant uuid := 'f0930000-0000-4000-8000-000000000005';
  ws  constant uuid := 'f0930000-0000-4000-8000-000000000006';
  st  constant uuid := 'f0930000-0000-4000-8000-000000000007';
  intent_at timestamptz;
  min_id uuid;
  max_id uuid;
BEGIN
  -- 1. Таблицы и партиции: tenant_id NOT NULL, RLS ENABLE + FORCE, регистрация, нет прямого доступа к партициям
  FOR r IN
    SELECT c.oid::regclass AS t, c.relrowsecurity, c.relforcerowsecurity, c.relispartition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p')
  LOOP
    IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
      bad := bad || format('%s: RLS is not enabled and forced', r.t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = r.t AND attname = 'tenant_id' AND attnotnull AND NOT attisdropped) THEN
      bad := bad || format('%s: no NOT NULL tenant_id', r.t);
    END IF;
    IF NOT r.relispartition AND NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = r.t) THEN
      bad := bad || format('%s: not registered', r.t);
    END IF;
    IF r.relispartition AND (has_table_privilege('repracer_app', r.t, 'SELECT') OR has_table_privilege('repracer_app', r.t, 'INSERT')
                             OR has_table_privilege('repracer_exporter', r.t, 'SELECT')) THEN
      bad := bad || format('%s: partition is directly accessible', r.t);
    END IF;
  END LOOP;

  -- 2. Политика для приложения у тенантных, канальных, аудиторских и платформенных таблиц; у LEGAL приложения нет вовсе
  FOR r IN SELECT table_name, storage_class FROM security.table_registry LOOP
    IF r.storage_class IN ('TENANT', 'CHANNEL', 'AUDIT', 'PLATFORM')
       AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = r.table_name AND 'repracer_app'::regrole::oid = ANY (polroles)) THEN
      bad := bad || format('%s: no policy for repracer_app', r.table_name);
    END IF;
    IF r.storage_class = 'LEGAL' AND has_table_privilege('repracer_app', r.table_name, 'SELECT') THEN
      bad := bad || format('%s: legal hold data readable by repracer_app', r.table_name);
    END IF;
  END LOOP;

  -- 3. Неизменяемость — свойство, а не имя (находка 4 ревью шага 16): включённый строчный триггер BEFORE UPDATE OR DELETE,
  --    выполняющий security.forbid_mutation, и у пути решения нет прав на изменение. Сама защита проверяется попыткой изменения
  --    строки временной таблицы под тем же триггером (ниже, в поведенческом блоке).
  FOR r IN SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                    WHERE tg.tgrelid = r.table_name AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
                      AND tg.tgfoid = 'security.forbid_mutation()'::regprocedure
                      AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 8) = 8 AND (tg.tgtype & 16) = 16) THEN
      bad := bad || format('%s: no enabled BEFORE UPDATE OR DELETE row trigger executing security.forbid_mutation', r.table_name);
    END IF;
    IF has_table_privilege('repracer_app', r.table_name, 'UPDATE') OR has_table_privilege('repracer_app', r.table_name, 'DELETE')
       OR has_table_privilege('repracer_app', r.table_name, 'TRUNCATE') THEN
      bad := bad || format('%s: repracer_app may mutate an append-only table', r.table_name);
    END IF;
  END LOOP;

  -- 4. Сроки: у каждой таблицы есть политика; CHANNEL/AUDIT/LEGAL — удаление по времени;
  --    данные каналов не старше 18 месяцев; данные тенанта удаляются по времени только после экспорта
  --    (исключение — операционные счётчики edit_budget).
  FOR r IN
    SELECT tr.table_name, tr.storage_class, rp.method, rp.retention, rp.requires_export
      FROM security.table_registry tr
      LEFT JOIN maintenance.retention_policy rp ON rp.table_name = tr.table_name
     WHERE tr.storage_class IN ('TENANT', 'CHANNEL', 'AUDIT', 'LEGAL')
  LOOP
    IF r.method IS NULL THEN
      bad := bad || format('%s: no retention policy', r.table_name);
    ELSIF r.storage_class IN ('CHANNEL', 'AUDIT', 'LEGAL') AND r.method = 'TENANT_CLOSURE_ONLY' THEN
      bad := bad || format('%s: no time-based retention', r.table_name);
    ELSIF r.storage_class IN ('CHANNEL', 'AUDIT') AND r.retention > interval '18 months' THEN
      bad := bad || format('%s: retention exceeds 18 months', r.table_name);
    ELSIF r.storage_class = 'TENANT' AND r.method <> 'TENANT_CLOSURE_ONLY' AND cardinality(r.requires_export) = 0
          AND r.table_name <> 'tenant_data.edit_budget'::regclass THEN
      bad := bad || format('%s: tenant data deleted by time without export', r.table_name);
    END IF;
    -- Шаг 27, задача F (расширение правила шага 26): КАЖДАЯ таблица данных тенанта и данных канала обязана быть названа в очистке
    -- тенанта — в purge_tenant_data или purge_tenant_channel_data. Срок хранения тут ни при чём: закрытие тенанта обещает удалить его
    -- данные сразу, а не через 18 месяцев. AUDIT и LEGAL исключены: они переживают закрытие и уходят по времени (правило выше)
    -- Имя ищется В КАВЫЧКАХ, как оно стоит в списке очистки: по подстроке имя более длинной таблицы засчитывало бы более короткую
    -- (`price_daily` внутри `price_daily_correction` — ревью шага 27, находка 6), и вечная свёртка могла бы выпасть из очистки молча
    -- Строка самого тенанта остаётся: в ней записано закрытие (очистка проверяет по ней статус и обезличивает имя), удалять её нечем
    IF r.storage_class IN ('TENANT', 'CHANNEL') AND r.table_name <> 'tenant_data.tenant'::regclass
       AND position('''' || r.table_name::text || '''' IN
             pg_get_functiondef('maintenance.purge_tenant_data(uuid,boolean)'::regprocedure)
             || pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure)) = 0 THEN
      bad := bad || format('%s: tenant closure does not delete the table (purge_tenant_data)', r.table_name);
    END IF;
  END LOOP;

  -- 5. Партиционированные таблицы управляются политикой DROP_PARTITION, и наоборот
  FOR r IN
    SELECT tr.table_name, c.relkind, rp.method
      FROM security.table_registry tr JOIN pg_class c ON c.oid = tr.table_name
      LEFT JOIN maintenance.retention_policy rp ON rp.table_name = tr.table_name
  LOOP
    IF (r.relkind = 'p') <> (r.method IS NOT DISTINCT FROM 'DROP_PARTITION') THEN
      bad := bad || format('%s: partitioned table and DROP_PARTITION policy must go together', r.table_name);
    END IF;
  END LOOP;

  -- 6. Р-20: аналитические таблицы не возвращаются в PostgreSQL
  FOR r IN SELECT unnest(ARRAY['channel_data.channel_observation', 'channel_data.competitor_snapshot',
                               'channel_data.channel_write_response', 'channel_data.fee_actual']) AS t LOOP
    IF to_regclass(r.t) IS NOT NULL THEN
      bad := bad || format('%s: belongs to the ClickHouse layer (Р-20)', r.t);
    END IF;
  END LOOP;

  -- 7. Нет FK из данных тенанта в данные каналов, аудит и legal
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS src, con.confrelid::regclass AS dst
      FROM pg_constraint con
      JOIN pg_class s ON s.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_class d ON d.oid = con.confrelid JOIN pg_namespace dn ON dn.oid = d.relnamespace
     WHERE con.contype = 'f' AND sn.nspname = 'tenant_data' AND dn.nspname IN ('channel_data', 'audit', 'legal')
       AND NOT s.relispartition
  LOOP
    bad := bad || format('%s -> %s (%s): tenant data must not reference channel/audit/legal data', r.src, r.dst, r.conname);
  END LOOP;

  -- 8. Ни одна роль проекта не обходит RLS
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolbypassrls LOOP
    bad := bad || format('role %s has BYPASSRLS', r.rolname);
  END LOOP;

  -- 9. SECURITY DEFINER: фиксированный search_path, нет EXECUTE у PUBLIC
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND p.prosecdef
  LOOP
    IF r.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) cfg WHERE cfg LIKE 'search_path=%') THEN
      bad := bad || format('%s: SECURITY DEFINER without fixed search_path', r.f);
    END IF;
    IF has_function_privilege('public', r.f, 'EXECUTE') THEN
      bad := bad || format('%s: SECURITY DEFINER executable by PUBLIC', r.f);
    END IF;
  END LOOP;

  -- 10. Представления в прикладных схемах читают данные от имени читающего (RLS не обходится через представление)
  FOR r IN
    SELECT c.oid::regclass AS v, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind = 'v'
  LOOP
    IF r.reloptions IS NULL OR NOT ('security_invoker=true' = ANY (r.reloptions)) THEN
      bad := bad || format('%s: view without security_invoker = true', r.v);
    END IF;
  END LOOP;

  -- 11. Р-35: шаблон остатка Kaufland не содержит витрину
  IF EXISTS (SELECT 1 FROM platform.channel_capability
              WHERE channel = 'KAUFLAND' AND field = 'QUANTITY' AND 'marketplace' = ANY (write_scope_key_template)) THEN
    bad := bad || 'Kaufland QUANTITY capability keyed by storefront (Р-35)'::text;
  END IF;

  -- 12. Данные, от которых зависит поведение: НДС по умолчанию для витрин Release 1.0 [Р-53]; витрина ЕС с НДС и витрина США с налогом
  --     с продаж [Р-58]; витрине США пояс не подставлен без подтверждения [Р-65]; ссылка на снимок не дольше 18 месяцев [Р-38, Р-68]
  IF (SELECT count(DISTINCT country) FROM platform.vat_rate_default WHERE country IN ('DE', 'AT')) <> 2 THEN
    bad := bad || 'platform.vat_rate_default lacks DE or AT (Р-53)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE channel = 'KAUFLAND' AND marketplace = 'de' AND tax_regime = 'VAT_INCLUDED')
     OR NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE tax_regime = 'SALES_TAX_EXCLUDED' AND currency = 'USD' AND price_basis = 'NET') THEN
    bad := bad || 'platform.marketplace lacks an EU VAT or a US sales tax storefront (Р-58)'::text;
  END IF;
  FOR r IN SELECT channel, marketplace FROM platform.marketplace WHERE country = 'US' AND time_zone IS NOT NULL AND time_zone_status <> 'CONFIRMED' LOOP
    bad := bad || format('%s %s: unconfirmed time zone substituted for a US storefront (Р-65)', r.channel, r.marketplace);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM maintenance.retention_policy
                  WHERE table_name = 'channel_data.price_decision_snapshot_ref'::regclass AND retention + coalesce(safety_margin, interval '0') <= interval '18 months') THEN
    bad := bad || 'snapshot reference of a decision may outlive 18 months (Р-38, Р-68)'::text;
  END IF;

  -- 13. Привилегии служебных ролей: обход диспетчера [Р-64], ретранслятор [Р-34], загрузчик курсов [Р-61], экспортёр [Р-79]
  IF NOT has_function_privilege('repracer_dispatcher', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE')
     OR has_function_privilege('repracer_app', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE')
     OR has_column_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'amount_minor', 'SELECT')
     OR has_table_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'UPDATE')
     OR has_column_privilege('repracer_dispatcher', 'tenant_data.write_scope', 'scope_key', 'SELECT') THEN
    bad := bad || 'the dispatcher sweep is executable beyond repracer_dispatcher or sees write amounts and scope keys (Р-64)'::text;
  END IF;
  IF NOT has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'SELECT')
     OR has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'INSERT')
     OR has_table_privilege('repracer_relay', 'tenant_data.channel_write', 'SELECT')
     OR has_table_privilege('repracer_relay', 'channel_data.price_decision', 'SELECT') THEN
    bad := bad || 'outbox relay role is broader than the outbox (Р-34)'::text;
  END IF;
  IF has_table_privilege('repracer_app', 'platform.fx_rate', 'INSERT') OR NOT has_table_privilege('repracer_fx_loader', 'platform.fx_rate', 'INSERT') THEN
    bad := bad || 'ECB rates are writable by repracer_app or not by the loader (Р-61)'::text;
  END IF;
  IF NOT has_table_privilege('repracer_exporter', 'tenant_data.pricing_strategy', 'SELECT')
     OR NOT has_table_privilege('repracer_exporter', 'platform.explanation_ruleset', 'SELECT') THEN
    bad := bad || 'the core archive exporter cannot read the strategy versions and rulesets its explanations refer to (Р-79)'::text;
  END IF;
  -- Р-86: у листовых секций ядра и решения нет порога сжатия
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'maintenance.retention_policy'::regclass AND attname = 'leaf_toast_tuple_target' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM (VALUES ('channel_data.price_decision'::regclass), ('tenant_data.price_intent_core'::regclass)) AS tt(tbl)
                  CROSS JOIN LATERAL pg_partition_tree(tt.tbl) pt JOIN pg_class c ON c.oid = pt.relid
                 WHERE pt.isleaf AND c.reloptions::text LIKE '%toast_tuple_target%') THEN
    bad := bad || 'partition compression settings of step 14 are still present (Р-86)'::text;
  END IF;

  -- 14. Р-96: право пути решения существует тогда и только тогда, когда оно перечислено в списке разрешённого. Перечня запретов
  --     больше нет: забыть запрет невозможно, потому что сверка идёт в обе стороны.
  FOR r IN
    SELECT c.oid::regclass AS t, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_table_privilege('repracer_app', r.t, r.privilege)
         <> EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() a
                     WHERE a.table_name::regclass = r.t AND a.privilege = r.privilege AND a.column_name IS NULL) THEN
      bad := bad || format('%s: %s of the decision path does not match the allow list (Р-96)', r.t, r.privilege);
    END IF;
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS t, a.attname, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_column_privilege('repracer_app', r.t, r.attname, r.privilege)
       AND NOT EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() al
                        WHERE al.table_name::regclass = r.t AND al.privilege = r.privilege
                          AND (al.column_name IS NULL OR al.column_name = r.attname)) THEN
      bad := bad || format('%s.%s: %s of the decision path is not in the allow list (Р-96)', r.t, r.attname, r.privilege);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM security.decision_path_allowed_privileges() LOOP
    IF NOT (CASE WHEN r.column_name IS NULL THEN has_table_privilege('repracer_app', r.table_name::regclass, r.privilege)
                 ELSE has_column_privilege('repracer_app', r.table_name::regclass, r.column_name, r.privilege) END) THEN
      bad := bad || format('%s: the allow list grants %s%s, the decision path does not have it (Р-96)', r.table_name, r.privilege,
                           coalesce(' (' || r.column_name || ')', ''));
    END IF;
  END LOOP;
  -- Функции SECURITY DEFINER действуют правами владельца: путь решения исполняет только те, что нужны для вычисления и записи цены
  FOR r IN
    SELECT p.oid::regprocedure AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND p.prosecdef AND has_function_privilege('repracer_app', p.oid, 'EXECUTE')
  LOOP
    IF r.f::text NOT IN ('security.resolve_channel_account(text,text,text)', 'tenant_data.lock_decision_products(uuid,uuid[])',
                         'channel_data.review_halt_by_sample(uuid,uuid,timestamp with time zone)',
                         -- Шаг 24 [Р-121]: вердикт сверки опросом ставит база, путь решения только вызывает проверку
                         'channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)') THEN
      bad := bad || format('%s: SECURITY DEFINER function executable by the decision path is not in the allow list (Р-96)', r.f);
    END IF;
  END LOOP;
  IF pg_has_role('repracer_app', 'repracer_admin', 'MEMBER') OR pg_has_role('repracer_app', 'repracer_provisioning', 'MEMBER')
     OR pg_has_role('repracer_app', 'repracer_authenticator', 'MEMBER') THEN
    bad := bad || 'the decision path role is a member of the administrative, provisioning or authenticator role (Р-90)'::text;
  END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolname NOT IN ('repracer_owner', 'repracer_audit_writer')
                                          AND has_table_privilege(rolname, 'audit.audit_event', 'INSERT') LOOP
    bad := bad || format('role %s may insert audit events directly; only the audit trigger role may (Р-90)', r.rolname);
  END LOOP;
  IF has_table_privilege('repracer_admin', 'tenant_data.membership', 'INSERT') THEN
    bad := bad || 'the administrative role may insert memberships directly; only invitations and provisioning create them (Р-90)'::text;
  END IF;
  IF has_table_privilege('repracer_admin', 'platform.app_user', 'UPDATE') THEN
    bad := bad || 'the administrative role may change users, including their second factor (step 16 finding 7, Р-97)'::text;
  END IF;

  -- 14a. Р-97, Р-100: административная запись под стражем «действие человека с ролью» и в аудите — по операциям; у UPDATE аргументы
  --      стража — ровно административные столбцы; у каждой таблицы объявлено административное действие
  FOR r IN SELECT * FROM security.admin_only_writes() LOOP
    IF security.admin_write_action(r.table_name::text) IS NULL THEN
      bad := bad || format('%s: no administrative action is declared for the table (Р-100)', r.table_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                    WHERE tg.tgrelid = r.table_name AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
                      AND tg.tgfoid = 'security.require_person_for_admin_write()'::regprocedure
                      AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2
                      AND (tg.tgtype & CASE r.privilege WHEN 'INSERT' THEN 4 WHEN 'DELETE' THEN 8 ELSE 16 END) <> 0
                      AND coalesce((SELECT array_agg(x ORDER BY x) FROM unnest(string_to_array(encode(tg.tgargs, 'escape'), '\000')) AS x WHERE x <> ''), '{}')
                          = coalesce(r.admin_columns, '{}')) THEN
      bad := bad || format('%s: administrative %s without the person guard over its administrative columns (Р-97, Р-100)', r.table_name, r.privilege);
    END IF;
    IF r.table_name NOT IN ('tenant_data.price_stop'::regclass, 'channel_data.pricing_halt_review'::regclass, 'tenant_data.membership'::regclass)
       AND NOT (r.table_name = 'channel_data.pricing_halt'::regclass AND r.privilege = 'INSERT')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                        WHERE tg.tgrelid = r.table_name AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
                          AND tg.tgfoid = 'security.audit_admin_write()'::regprocedure
                          AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 0
                          AND (tg.tgtype & CASE r.privilege WHEN 'INSERT' THEN 4 WHEN 'DELETE' THEN 8 ELSE 16 END) <> 0) THEN
      bad := bad || format('%s: administrative %s is not written to the audit log (Р-97)', r.table_name, r.privilege);
    END IF;
  END LOOP;

  -- 14в. Р-90, Р-139 (шаг 30): роль фонового исполнителя — ровно свой список разрешённого, в обе стороны
  FOR r IN
    SELECT c.oid::regclass AS t, a.attname, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      -- Права по столбцам бывают только у этих четырёх: DELETE и TRUNCATE — права таблицы, они проверяются вторым проходом
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_column_privilege('repracer_bulk_worker', r.t, r.attname, r.privilege)
       AND NOT EXISTS (SELECT 1 FROM security.bulk_worker_allowed_privileges() al
                        WHERE al.table_name::regclass = r.t AND al.privilege = r.privilege
                          AND (al.column_name IS NULL OR al.column_name = r.attname)) THEN
      bad := bad || format('%s.%s: %s of the bulk worker role is not in its allow list (Р-90, Р-139)', r.t, r.attname, r.privilege);
    END IF;
  END LOOP;
  -- Права таблицы целиком: у роли исполнителя не должно быть ни DELETE, ни TRUNCATE нигде
  FOR r IN
    SELECT c.oid::regclass AS t, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['DELETE', 'TRUNCATE']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_table_privilege('repracer_bulk_worker', r.t, r.privilege) THEN
      bad := bad || format('%s: %s of the bulk worker role is not in its allow list (Р-90, Р-139)', r.t, r.privilege);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM security.bulk_worker_allowed_privileges() LOOP
    IF NOT (CASE WHEN r.column_name IS NULL THEN has_table_privilege('repracer_bulk_worker', r.table_name::regclass, r.privilege)
                 ELSE has_column_privilege('repracer_bulk_worker', r.table_name::regclass, r.column_name, r.privilege) END) THEN
      bad := bad || format('%s: %s of the bulk worker role is declared but not granted (Р-90, Р-139)', r.table_name, r.privilege);
    END IF;
  END LOOP;

  -- 14b. Р-102: роль остатков — ровно свой список разрешённого, без цен, без аудита, не член других ролей
  FOR r IN
    SELECT c.oid::regclass AS t, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_table_privilege('repracer_stock', r.t, r.privilege)
         <> EXISTS (SELECT 1 FROM security.stock_path_allowed_privileges() a
                     WHERE a.table_name::regclass = r.t AND a.privilege = r.privilege AND a.column_name IS NULL) THEN
      bad := bad || format('%s: %s of the stock role does not match its allow list (Р-102)', r.t, r.privilege);
    END IF;
  END LOOP;
  -- Шаг 19 [Р-105]: права по столбцам — в обе стороны, как у пути решения
  FOR r IN
    SELECT c.oid::regclass AS t, a.attname, p.privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    IF has_column_privilege('repracer_stock', r.t, r.attname, r.privilege)
       AND NOT EXISTS (SELECT 1 FROM security.stock_path_allowed_privileges() al
                        WHERE al.table_name::regclass = r.t AND al.privilege = r.privilege
                          AND (al.column_name IS NULL OR al.column_name = r.attname)) THEN
      bad := bad || format('%s.%s: %s of the stock role is not in its allow list (Р-102, Р-105)', r.t, r.attname, r.privilege);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM security.stock_path_allowed_privileges() LOOP
    IF NOT (CASE WHEN r.column_name IS NULL THEN has_table_privilege('repracer_stock', r.table_name::regclass, r.privilege)
                 ELSE has_column_privilege('repracer_stock', r.table_name::regclass, r.column_name, r.privilege) END) THEN
      bad := bad || format('%s: the allow list grants %s%s, the stock role does not have it (Р-102)', r.table_name, r.privilege,
                           coalesce(' (' || r.column_name || ')', ''));
    END IF;
  END LOOP;
  -- Р-105: запись в канал и её история видны и пишутся ролью остатков только для поля QUANTITY — политики без условия по полю нет
  FOR r IN SELECT pol.polrelid::regclass AS t, pol.polname, coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') AS q, coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS w
             FROM pg_policy pol
            WHERE pol.polrelid IN ('tenant_data.channel_write'::regclass, 'tenant_data.channel_write_history'::regclass, 'tenant_data.write_scope'::regclass,
                                   'channel_data.write_submission'::regclass)
              AND (SELECT oid FROM pg_roles WHERE rolname = 'repracer_stock') = ANY (pol.polroles) LOOP
    IF r.q NOT LIKE '%field = ''QUANTITY''%' OR (r.w <> '' AND r.w NOT LIKE '%field = ''QUANTITY''%') THEN
      bad := bad || format('%s: policy %s of the stock role is not limited to the QUANTITY field (Р-105)', r.t, r.polname);
    END IF;
  END LOOP;
  IF pg_has_role('repracer_stock', 'repracer_app', 'MEMBER') OR pg_has_role('repracer_stock', 'repracer_admin', 'MEMBER')
     OR pg_has_role('repracer_app', 'repracer_stock', 'MEMBER') THEN
    bad := bad || 'the stock role and the decision path role are members of each other or of the administrative role (Р-102)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
                AND p.prosecdef AND has_function_privilege('repracer_stock', p.oid, 'EXECUTE')) THEN
    bad := bad || 'the stock role executes a SECURITY DEFINER function (Р-102)'::text;
  END IF;

  -- 14c. OQ-153: у неизменяемых платформенных таблиц входа — срок хранения (время жизни пользователя)
  FOR r IN SELECT tr.table_name FROM security.table_registry tr
            WHERE tr.storage_class = 'PLATFORM' AND tr.mutation_mode = 'append_only'
              AND NOT EXISTS (SELECT 1 FROM maintenance.retention_policy rp WHERE rp.table_name = tr.table_name)
              AND NOT has_table_privilege('repracer_identity_purger', tr.table_name, 'DELETE') LOOP
    bad := bad || format('%s: append-only platform table without a retention policy or a purge of the user (OQ-153)', r.table_name);
  END LOOP;

  -- 14d. Находка 5 ревью шага 18: привязки входа удаляет только функция удаления привязок пользователя; роль хранения их не трогает
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolname NOT IN ('repracer_owner', 'repracer_identity_purger') LOOP
    IF has_table_privilege(r.rolname, 'platform.external_identity', 'DELETE') OR has_table_privilege(r.rolname, 'platform.external_identity_revocation', 'DELETE') THEN
      bad := bad || format('role %s may delete sign-in links; only the purge of a disabled user may (step 18 finding 5, OQ-153)', r.rolname);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
                AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'repracer_identity_purger' AND p.oid <> 'maintenance.purge_user_identities(uuid)'::regprocedure) THEN
    bad := bad || 'the identity purger owns a SECURITY DEFINER function other than the purge of a disabled user (step 18 finding 5)'::text;
  END IF;

  -- 14e. Шаг 19: условие WHEN у триггера — только из перечня; WHEN (false) выключил бы защиту, оставив её имя и функцию на месте
  FOR r IN SELECT tg.tgrelid::regclass AS t, tg.tgname, substring(pg_get_triggerdef(tg.oid) FROM 'WHEN \((.*)\) EXECUTE') AS cond
             FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT tg.tgisinternal AND tg.tgqual IS NOT NULL AND NOT c.relispartition
              AND n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal') LOOP
    IF NOT EXISTS (SELECT 1 FROM (VALUES
         ('channel_data.pricing_halt_review'::regclass, 'zb_pricing_halt_review_audit', '(new.outcome = ''RELEASED''::text)'),
         ('tenant_data.channel_write'::regclass, 'ab_channel_write_budget_day_retry', '((old.status = ''FAILED''::text) AND (new.status = ''DISPATCHED''::text) AND (new.budget_scope_key IS NOT NULL))'),
         ('tenant_data.membership'::regclass, 'zb_membership_audit', '((new.role IS DISTINCT FROM old.role) OR (new.status IS DISTINCT FROM old.status))'),
         ('platform.identity_invitation'::regclass, 'zz_identity_relink_invited_audit', 'new.relink'),
         ('platform.identity_invitation'::regclass, 'zz_identity_relinked_audit', '(new.relink AND (old.accepted_at IS NULL) AND (new.accepted_at IS NOT NULL))')
       ) AS al(t, name, cond) WHERE al.t = r.t AND al.name = r.tgname AND al.cond = r.cond) THEN
      bad := bad || format('%s: trigger %s has a WHEN condition that is not in the list: %s (step 19)', r.t, r.tgname, r.cond);
    END IF;
  END LOOP;

  -- 14f. Шаг 19: функция, принадлежащая служебной роли, исполняется правами этой роли — иначе владелец ничего не значит, а проверка
  --      внутри неё идёт правами вызывающего (CREATE OR REPLACE сбрасывает SECURITY DEFINER и search_path)
  FOR r IN SELECT p.oid::regprocedure AS f, pg_get_userbyid(p.proowner) AS owner
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
              AND pg_get_userbyid(p.proowner) LIKE 'repracer\_%' AND pg_get_userbyid(p.proowner) <> 'repracer_owner' AND NOT p.prosecdef LOOP
    bad := bad || format('%s: owned by %s but not SECURITY DEFINER (step 19)', r.f, r.owner);
  END LOOP;

  -- 15. Р-83 — поведение: запись цены, созданная при полу маржи 15,24 €, после роста себестоимости (пол 16,76 €) не отправляется;
  --     запись не ниже нового пола — отправляется. Синтетический мир строится в подтранзакции и откатывается целиком.
  verdict := NULL;
  BEGIN
    PERFORM set_config('app.tenant_id', t::text, true);
    SELECT capability_id, version, write_scope_kind, write_scope_key_template INTO cap FROM platform.channel_capability
     WHERE channel = 'KAUFLAND' AND field = 'PRICE' AND status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1;
    IF cap IS NULL THEN
      INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind,
          write_scope_key_template, budget_scope_attribute, object_edit_limit, processing_mode, requires_side_effects_ack, observation_data_class)
      VALUES ('f0930000-0000-4000-8000-0000000000c0', 1, 'ACTIVE', now() - interval '1 day', 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
              'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account', 'marketplace', 'external_unit_id'], NULL, NULL, 'SYNC', false, 'CHANNEL_INFO')
      RETURNING capability_id, version, write_scope_kind, write_scope_key_template INTO cap;
    END IF;
    PERFORM security.provision_tenant(t, 'schema verification (rolled back)', coalesce(nullif(current_setting('repracer.region', true), ''), 'EU'),
      jsonb_build_array(jsonb_build_object('membershipId', m, 'userId', u, 'email', 'verify-0061@example.invalid', 'role', 'OWNER')));
    INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
    VALUES (t, acc, 'KAUFLAND', 'verify-0061', ARRAY['de'], 'secret-ref:verify', m);
    INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES (t, prod, 'verify-0061', 'SIMPLE');
    INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
        scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
    VALUES (t, ws, acc, 'KAUFLAND', 'PRICE', prod, cap.capability_id, cap.version, cap.write_scope_kind,
            tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"V0061"}', cap.write_scope_key_template), 'EUR', 'GROSS', 'VAT_INCLUDED', 'OFF');
    INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, status, price_write_scope_id)
    VALUES (t, prod, acc, 'KAUFLAND', 'de', 'V0061@de', 'V0061', 'ACTIVE', ws);
    INSERT INTO tenant_data.min_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 'EUR', 'GROSS', 1000, 1, m) RETURNING min_price_id INTO min_id;
    INSERT INTO tenant_data.max_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 'EUR', 'GROSS', 5000, 1, m) RETURNING max_price_id INTO max_id;
    INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES (t, st, 1, 'verify fixed', 'FIXED', '{"type":"FIXED","priceMinor":1600,"deadbandMinor":0}', ARRAY['SCHEDULE'], 'ACTIVE', m);
    UPDATE tenant_data.write_scope SET pricing_strategy_id = st, pricing_strategy_version = 1, pricing_mode = 'ENGINE' WHERE tenant_id = t AND write_scope_id = ws;
    -- Пол маржи 10 % при комиссии 10 % и НДС 19 %: себестоимость 10,00 € → 15,24 €; 11,00 € → 16,76 €
    INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, on_violation, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 1000, 'HOLD', 1, m);
    INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
    VALUES (t, prod, acc, 'de', 1, now() - interval '1 hour', 'EUR', 1000, 'MANUAL', m);
    INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
    VALUES (t, ws, 'FEE_SCHEDULE', '{"feeRateBp": 1000, "fixedFeeMinor": 0}', 'verify', now() - interval '1 hour', now() + interval '1 day');
    INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
        currency, price_basis, expires_at, rule_code)
    VALUES (t, 'f0930000-0000-4000-8000-000000000011', now(), ws, m, 'MANUAL', 1600, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
    RETURNING created_at INTO intent_at;
    INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
        rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
        sanity_ruleset, gate_profile)
    VALUES (t, 'f0930000-0000-4000-8000-000000000012', intent_at, 'f0930000-0000-4000-8000-000000000011', ws, 'APPROVED', 1600, NULL, 'EUR', 'GROSS', 1524,
            ARRAY[min_id], 5000, ARRAY[max_id], '{}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}',
            'r49.1', 'g74.1');
    INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
    VALUES (t, 'f0930000-0000-4000-8000-000000000013', ws, 'PRICE', 1600, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'f0930000-0000-4000-8000-000000000012');
    -- Себестоимость выросла между созданием записи и отправкой
    INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
    VALUES (t, prod, acc, 'de', 2, now() - interval '1 minute', 'EUR', 1100, 'MANUAL', m);
    BEGIN
      UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1, dispatched_at = now()
       WHERE tenant_id = t AND channel_write_id = 'f0930000-0000-4000-8000-000000000013';
      verdict := 'a price write below the recomputed margin floor was dispatched';
    EXCEPTION WHEN check_violation OR integrity_constraint_violation THEN
      NULL;
    END;
    -- Контроль: та же единица, цена не ниже нового пола — отправка проходит (правило не отказывает всем)
    IF verdict IS NULL THEN
      INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
          currency, price_basis, expires_at, rule_code)
      VALUES (t, 'f0930000-0000-4000-8000-000000000021', now(), ws, m, 'MANUAL', 1700, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
      RETURNING created_at INTO intent_at;
      INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
          rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
          sanity_ruleset, gate_profile)
      VALUES (t, 'f0930000-0000-4000-8000-000000000022', intent_at, 'f0930000-0000-4000-8000-000000000021', ws, 'APPROVED', 1700, NULL, 'EUR', 'GROSS', 1676,
              ARRAY[min_id], 5000, ARRAY[max_id], '{}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}',
              'r49.1', 'g74.1');
      INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
      VALUES (t, 'f0930000-0000-4000-8000-000000000023', ws, 'PRICE', 1700, 'EUR', 'GROSS', 2, 'PRICE_DECISION', 'f0930000-0000-4000-8000-000000000022');
      UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1, dispatched_at = now()
       WHERE tenant_id = t AND channel_write_id = 'f0930000-0000-4000-8000-000000000023';
      IF NOT FOUND THEN
        verdict := 'a price write not below the recomputed floor was not dispatched';
      END IF;
    END IF;

    -- Находка 15 — поведение: то же решение с незаявленным ключом в параметрах причины база не принимает
    IF verdict IS NULL THEN
      BEGIN
        INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
            currency, price_basis, expires_at, rule_code)
        VALUES (t, 'f0930000-0000-4000-8000-000000000031', now(), ws, m, 'MANUAL', 1700, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
        RETURNING created_at INTO intent_at;
        INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
            rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
            sanity_ruleset, gate_profile)
        VALUES (t, 'f0930000-0000-4000-8000-000000000032', intent_at, 'f0930000-0000-4000-8000-000000000031', ws, 'APPROVED', 1700, NULL, 'EUR', 'GROSS', 1676,
                ARRAY[min_id], 5000, ARRAY[max_id], '{}',
                '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE","params":{"target":1780}}}}', 'r49.1', 'g74.1');
        verdict := 'an explanation with an undeclared reason parameter was stored (finding 15)';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
    END IF;

    -- Р-91 — поведение: версия стратегии с подрезом в параметрах не сохраняется
    IF verdict IS NULL THEN
      BEGIN
        INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
        VALUES (t, st, 2, 'verify fixed', 'FIXED', '{"type":"FIXED","priceMinor":1600,"deadbandMinor":0,"undercutMinor":5}', ARRAY['SCHEDULE'], 'ACTIVE', m);
        verdict := 'a strategy version kept the undercut (Р-91)';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
    END IF;

    -- Находка 4 ревью шага 16 — поведение защиты неизменяемости: строка под тем же триггером не меняется и не удаляется
    IF verdict IS NULL THEN
      CREATE TEMP TABLE verify_append_only (tenant_id uuid NOT NULL, n int) ON COMMIT DROP;
      CREATE TRIGGER zz_append_only BEFORE UPDATE OR DELETE ON verify_append_only FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();
      INSERT INTO verify_append_only VALUES (t, 1);
      BEGIN
        UPDATE verify_append_only SET n = 2;
        verdict := 'security.forbid_mutation does not refuse an UPDATE (finding 4)';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
      IF verdict IS NULL THEN
        BEGIN
          DELETE FROM verify_append_only;
          verdict := 'security.forbid_mutation does not refuse a DELETE (finding 4)';
        EXCEPTION WHEN insufficient_privilege THEN
          NULL;
        END;
      END IF;
    END IF;

    RAISE EXCEPTION 'rollback of the verification world' USING ERRCODE = 'RR093';
  EXCEPTION
    WHEN SQLSTATE 'RR093' THEN
      NULL;
    WHEN OTHERS THEN
      verdict := coalesce(verdict, 'the verification world could not be built: ' || SQLERRM);
  END;
  IF verdict IS NOT NULL THEN
    bad := bad || ('behaviour check (Р-83, findings 4 and 15, Р-91): ' || verdict);
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.tenant WHERE tenant_id = t) THEN
    bad := bad || 'the verification world was not rolled back'::text;
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'schema invariant violations:\n%', array_to_string(bad, E'\n');
  END IF;
END $$;

COMMIT;

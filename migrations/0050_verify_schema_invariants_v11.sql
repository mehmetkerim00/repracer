-- 0050_verify_schema_invariants_v11.sql
-- Проверка схемы после шага 14 (последняя проверка набора): правила 0047, кроме входа по паролю, + внешний поставщик identity [Р-78],
-- автор действия — пользователь сессии (находка 4), NO_OP без ссылки на снимок (находка 10), слепок без копий столбцов и сжатие
-- в секциях [Р-80], самодостаточный архив ядра [Р-79].
-- Ограничение этой проверки (ретроспективное ревью шага 14, C1): правила сверяют каталог — имена, столбцы, наличие текста в функции,
-- а не поведение. Поведение правил шагов 13–14 проверяет packages/pricing-store-pg/test/step14.pg.test.ts.

BEGIN;

DO $$
DECLARE
  r   record;
  bad text[] := '{}';
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

  -- 3. Append-only
  FOR r IN SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = r.table_name AND tgname = 'zz_append_only') THEN
      bad := bad || format('%s: append-only guard trigger missing', r.table_name);
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
    bad := bad || 'Kaufland QUANTITY capability keyed by storefront (Р-35)';
  END IF;

  -- 12. Р-43: потолок цены — таблица max_price (append-only), проверяется при создании и отправке записи цены
  IF to_regclass('tenant_data.max_price') IS NULL
     OR NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = 'tenant_data.max_price'::regclass AND mutation_mode = 'append_only') THEN
    bad := bad || 'tenant_data.max_price missing or not append-only (Р-43)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'tenant_data.channel_write'::regclass
        AND tgname IN ('ba_channel_write_ceiling_insert', 'ba_channel_write_ceiling_dispatch')) <> 2 THEN
    bad := bad || 'channel_write ceiling guards missing (Р-44)';
  END IF;

  -- 13. Р-44: решение не округляется до абсолютной границы; причина отклонения обязательна
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_no_bound_clamp')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_rejection_reason_iff') THEN
    bad := bad || 'price_decision bound constraints missing (Р-44)';
  END IF;

  -- 14. Потолок не задаётся через guardrail
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.guardrail'::regclass AND conname = 'guardrail_ceiling_moved_to_max_price') THEN
    bad := bad || 'guardrail may still carry max_price_minor (Р-43)';
  END IF;

  -- 15. Р-53: ставки НДС по умолчанию для витрин Release 1.0
  IF (SELECT count(DISTINCT country) FROM platform.vat_rate_default WHERE country IN ('DE', 'AT')) <> 2 THEN
    bad := bad || 'platform.vat_rate_default lacks DE or AT (Р-53)';
  END IF;

  -- 16. Р-52: снятие остановки требует записи в журнале; журнал append-only
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.pricing_halt'::regclass AND tgname = 'c_pricing_halt_release_journal')
     OR NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = 'channel_data.pricing_halt_review'::regclass AND mutation_mode = 'append_only') THEN
    bad := bad || 'pricing halt review journal is not enforced (Р-52)';
  END IF;

  -- 17. Р-51: признак цены по конкурентам копируется в решение до проверки остановки
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision'::regclass AND tgname = 'aa_price_decision_copy_derivation') THEN
    bad := bad || 'price_decision.competitor_derived is not derived from the intent (Р-51)';
  END IF;

  -- 18. Р-57: ни одного ограничения «только EUR»; EUR и USD допустимы в валютных столбцах цены
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE '%release_1_0_currency%') THEN
    bad := bad || 'EUR-only Release 1.0 currency constraints remain (Р-57)';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('write_scope_supported_currency', 'min_price_supported_currency', 'max_price_supported_currency',
        'cost_profile_supported_currency', 'guardrail_supported_currency', 'tenant_supported_currency', 'observed_price_daily_supported_currency')) <> 7 THEN
    bad := bad || 'supported currency constraints missing (Р-57)';
  END IF;

  -- 19. Р-58: у каждой витрины налоговый режим согласован с базой цены; единица записи цены несёт режим
  IF NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE channel = 'KAUFLAND' AND marketplace = 'de' AND tax_regime = 'VAT_INCLUDED')
     OR NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE tax_regime = 'SALES_TAX_EXCLUDED' AND currency = 'USD' AND price_basis = 'NET') THEN
    bad := bad || 'platform.marketplace lacks an EU VAT or a US sales tax storefront (Р-58)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.write_scope'::regclass AND conname = 'write_scope_tax_regime_for_price')
     OR position('platform.marketplace' IN pg_get_functiondef('tenant_data.offer_mapping_scope_guard'::regproc)) = 0 THEN
    bad := bad || 'write scope tax regime is not enforced against the storefront (Р-58)';
  END IF;

  -- 20. OQ-93, OQ-94: проекции пути решения
  IF to_regclass('channel_data.competitor_move_latest') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'channel_data.competitor_state'::regclass AND attname = 'suggested_price_minor' AND NOT attisdropped) THEN
    bad := bad || 'decision path projections missing (OQ-93, OQ-94)';
  END IF;

  -- 21. OQ-98: отказ решения хранит параметры причины
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_rejection_explained') THEN
    bad := bad || 'price_decision rejection parameters are not required (OQ-98)';
  END IF;

  -- 22. Р-64: запись не завершается без причины; очередь объявляет себя событием; обход видит только идентификаторы и сроки
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.channel_write'::regclass AND conname = 'channel_write_end_explained')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.channel_write_history'::regclass AND conname = 'channel_write_history_end_explained') THEN
    bad := bad || 'channel_write may end SUPERSEDED/DISCARDED without a recorded reason (Р-64)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.channel_write'::regclass AND tgname = 'zz_channel_write_announce_dispatch'
                  AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred) THEN
    bad := bad || 'queued writes are not announced by a deferred trigger (Р-64)';
  END IF;
  IF to_regprocedure('maintenance.due_write_scopes(timestamptz, interval, interval, int)') IS NULL
     OR NOT has_function_privilege('repracer_dispatcher', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE')
     OR has_function_privilege('repracer_app', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE') THEN
    bad := bad || 'dispatcher sweep function missing or executable beyond repracer_dispatcher (Р-64)';
  END IF;
  IF has_column_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'amount_minor', 'SELECT')
     OR has_table_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'UPDATE') THEN
    bad := bad || 'repracer_dispatcher sees write amounts or may change writes directly (Р-64)';
  END IF;

  -- 22a. Р-34: ретранслятор читает outbox всех тенантов и своё состояние, но не меняет события и не читает бизнес-таблицы
  IF to_regclass('maintenance.outbox_relay_state') IS NULL
     OR NOT has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'SELECT')
     OR has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'INSERT')
     OR has_table_privilege('repracer_relay', 'tenant_data.channel_write', 'SELECT')
     OR has_table_privilege('repracer_relay', 'channel_data.price_decision', 'SELECT') THEN
    bad := bad || 'outbox relay role missing or broader than the outbox (Р-34)';
  END IF;

  -- 23. Р-61: курсы ЕЦБ неизменяемы и загружаются только загрузчиком; себестоимость в другой валюте — с курсом в решении
  IF to_regclass('platform.fx_rate') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'platform.fx_rate'::regclass AND tgname = 'zz_fx_rate_immutable')
     OR has_table_privilege('repracer_app', 'platform.fx_rate', 'INSERT') THEN
    bad := bad || 'platform.fx_rate missing, mutable or writable by repracer_app (Р-61)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision'::regclass AND tgname = 'aa_price_decision_fx_recorded')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_fx_shape') THEN
    bad := bad || 'price_decision does not require the exchange rate of a converted cost (Р-61)';
  END IF;

  -- 24. Р-62: граница суток — часовой пояс витрины, не константа
  -- Р-65 уточняет Р-62: пояс может быть неизвестен только у неподтверждённой витрины
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'platform.marketplace'::regclass AND attname = 'time_zone')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform.marketplace'::regclass AND conname = 'marketplace_time_zone_known_if_confirmed') THEN
    bad := bad || 'platform.marketplace.time_zone is missing or may be unknown for a confirmed storefront (Р-62, Р-65)';
  END IF;
  FOR r IN
    SELECT conrelid::regclass AS t, conname FROM pg_constraint
     WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%Europe/Berlin%'
       AND conrelid IN ('tenant_data.price_daily'::regclass, 'channel_data.observed_price_daily'::regclass, 'maintenance.price_day_close'::regclass)
  LOOP
    bad := bad || format('%s.%s: day boundary fixed to Europe/Berlin (Р-62)', r.t, r.conname);
  END LOOP;
  IF position('Europe/Berlin' IN pg_get_functiondef('maintenance.close_price_days(timestamptz, int)'::regprocedure)) > 0
     OR position('Europe/Berlin' IN pg_get_functiondef('maintenance.drop_expired_partitions(timestamptz, int)'::regprocedure)) > 0 THEN
    bad := bad || 'day closing or partition dropping still assumes Europe/Berlin (Р-62)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                  WHERE i.indrelid = 'maintenance.price_day_close'::regclass AND i.indisprimary AND a.attname = 'day_tz')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.price_daily'::regclass AND tgname = 'aa_price_daily_day_tz') THEN
    bad := bad || 'closed days or daily rollups are not keyed by the storefront time zone (Р-62)';
  END IF;

  -- 25. Р-60: регион хранения — место клиента; витрина и аккаунт канала регион тенанта не определяют
  FOR r IN
    SELECT conrelid::regclass AS t, conname FROM pg_constraint
     WHERE pg_get_constraintdef(oid) LIKE '%data_region%'
       AND conrelid IN ('tenant_data.channel_account'::regclass, 'tenant_data.offer_mapping'::regclass, 'tenant_data.write_scope'::regclass, 'platform.marketplace'::regclass)
  LOOP
    bad := bad || format('%s.%s: storefront or account constrains the tenant data region (Р-60)', r.t, r.conname);
  END LOOP;

  -- 26. Р-65: пояс витрины — по витрине; витрине США значение не подставлено, пока не подтверждено
  FOR r IN SELECT channel, marketplace FROM platform.marketplace WHERE country = 'US' AND time_zone IS NOT NULL AND time_zone_status <> 'CONFIRMED' LOOP
    bad := bad || format('%s %s: unconfirmed time zone substituted for a US storefront (Р-65)', r.channel, r.marketplace);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.channel_write'::regclass AND tgname = 'aa_channel_write_budget_day_tz')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'platform.marketplace'::regclass AND attname = 'time_zone_status' AND attnotnull) THEN
    bad := bad || 'edit budget day is not tied to a confirmed storefront time zone (Р-65)';
  END IF;
  IF position('time_zone IS NOT NULL' IN pg_get_functiondef('maintenance.close_price_days(timestamptz, int)'::regprocedure)) = 0
     OR position('price_history_in_unknown_time_zone' IN pg_get_functiondef('maintenance.drop_expired_partitions(timestamptz, int)'::regprocedure)) = 0 THEN
    bad := bad || 'day closing or partition dropping ignores storefronts with an unknown time zone (Р-65)';
  END IF;

  -- 27. Р-69, Р-70: системная остановка — только по испорченным данным; остановка человеком — объект с правами, для любой цены
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.pricing_halt'::regclass AND conname = 'pricing_halt_system_only')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.price_stop'::regclass AND tgname = 'aa_price_stop_role_guard')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision'::regclass AND tgname = 'ab_price_decision_stop_guard')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.channel_write'::regclass AND tgname = 'bb_channel_write_stop_guard')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.pricing_halt'::regclass AND tgname = 'ca_pricing_halt_release_role_guard') THEN
    bad := bad || 'human price stops or channel halts are not enforced (Р-69, Р-70)';
  END IF;
  -- Остановка тенанта не зависит от аккаунтов: условие TENANT без аккаунта
  IF position('st.scope_type = ''TENANT''' IN pg_get_functiondef('tenant_data.pricing_stop_for(uuid, uuid)'::regprocedure)) = 0 THEN
    bad := bad || 'a tenant stop must cover accounts connected after it (Р-70)';
  END IF;

  -- 28. Р-68: слепок объяснения обязателен, без данных канала, копируется в вечное ядро; ссылка на снимок — не дольше 18 месяцев
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_explanation_by_class')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_explanation_no_channel_data')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.price_intent_core'::regclass AND conname = 'price_intent_core_explanation_no_channel_data')
     OR position('explanation' IN pg_get_functiondef('channel_data.price_decision_record_core()'::regprocedure)) = 0 THEN
    bad := bad || 'decision explanation snapshot is not enforced or not kept with the intent core (Р-68)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.retention_policy
                  WHERE table_name = 'channel_data.price_decision_snapshot_ref'::regclass AND retention + coalesce(safety_margin, interval '0') <= interval '18 months') THEN
    bad := bad || 'snapshot reference of a decision may outlive 18 months (Р-38, Р-68)';
  END IF;

  -- 29. Р-71: суммы с валютой
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_amounts_have_currency')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.channel_write'::regclass AND conname = 'channel_write_end_params_currency')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.rejected_competitor_snapshot'::regclass AND conname = 'rejected_competitor_snapshot_details_currency') THEN
    bad := bad || 'reason parameters with amounts may omit the currency (Р-71)';
  END IF;

  -- 30. Р-73: опасное изменение — отклонение больше 10 %, сверено с предложенной ценой
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'tenant_data.price_intent_core'::regclass AND attname = 'dangerous' AND attgenerated = 's')
     OR position('bound_deviation_bp' IN pg_get_functiondef('channel_data.price_decision_floor_guard()'::regprocedure)) = 0 THEN
    bad := bad || 'dangerous price changes are not derived from the bound deviation (Р-73)';
  END IF;

  -- 31. OQ-125: роль оператора
  IF position('OPERATOR' IN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                              WHERE c.conrelid = 'tenant_data.membership'::regclass AND c.conname = 'membership_role_check')) = 0 THEN
    bad := bad || 'membership has no OPERATOR role';
  END IF;

  -- 32. Р-74: слепок — у решений CHANGED и REJECTED_BY_GATE; у NO_OP — только код причины
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_explanation_by_class')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_no_change_reason_code') THEN
    bad := bad || 'a NO_OP decision may keep an explanation or lose its reason code (Р-74)';
  END IF;

  -- 33. Р-75: справочник слепка неизменяем; решение и ядро ссылаются на него, ядро — на существующую версию стратегии
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'platform.explanation_ruleset'::regclass AND tgname = 'explanation_ruleset_immutable')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND contype = 'f' AND confrelid = 'platform.explanation_ruleset'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.price_intent_core'::regclass AND contype = 'f' AND confrelid = 'platform.explanation_ruleset'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.price_intent_core'::regclass AND conname = 'price_intent_core_strategy_version_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.price_intent_core'::regclass AND conname = 'price_intent_core_explanation_present')
     OR position('gate_profile' IN pg_get_functiondef('channel_data.price_decision_record_core()'::regprocedure)) = 0 THEN
    bad := bad || 'explanation parts are not taken from immutable dictionaries (Р-75)';
  END IF;
  IF EXISTS (SELECT 1 FROM security.table_registry tr WHERE tr.table_name = 'tenant_data.pricing_strategy'::regclass AND tr.mutation_mode <> 'append_only') THEN
    bad := bad || 'strategy versions referenced by explanations must be append-only (Р-75)';
  END IF;

  -- 34. Р-76: остановки и системные остановки — в журнале аудита
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'tenant_data.price_stop'::regclass AND tgname = 'zb_price_stop_audit')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.pricing_halt'::regclass AND tgname = 'zb_pricing_halt_audit')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.pricing_halt_review'::regclass AND tgname = 'zb_pricing_halt_review_audit') THEN
    bad := bad || 'price stops and channel halts are not written to the audit log (Р-76)';
  END IF;

  -- 35. Р-77: стратегия хранится независимо от режима, движок без стратегии не включается
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.write_scope'::regclass AND pg_get_constraintdef(oid) LIKE '%pricing_mode = ''ENGINE''::text))')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.write_scope'::regclass AND conname = 'write_scope_engine_has_strategy') THEN
    bad := bad || 'the strategy of a write scope must be kept regardless of its pricing mode (Р-77)';
  END IF;

  -- 36. Р-78: паролей, сессий и функций входа нет; внешний пользователь (издатель, subject) сопоставляется функцией роли входа
  IF to_regclass('platform.user_credential') IS NOT NULL OR to_regclass('platform.user_session') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                 WHERE c.relnamespace = 'platform'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%password%')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'security'::regnamespace
                 AND p.proname IN ('login_credential', 'record_failed_login', 'open_session', 'find_session', 'close_session', 'session_memberships'))
     OR to_regclass('platform.external_identity') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform.external_identity'::regclass AND contype = 'p'
                     AND pg_get_constraintdef(oid) = 'PRIMARY KEY (issuer, subject)')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('security.resolve_external_identity(text, text)')
                     AND p.prosecdef AND p.proowner = 'repracer_resolver'::regrole) THEN
    bad := bad || 'own sign-in secrets or sessions exist, or external identities are not mapped by the resolver (Р-78)';
  END IF;

  -- 37. OQ-129: одна матрица прав для остановок и снятий
  IF to_regprocedure('security.pricing_permission(text, text)') IS NULL
     OR position('pricing_permission' IN pg_get_functiondef('tenant_data.price_stop_role_guard()'::regprocedure)) = 0
     OR position('pricing_permission' IN pg_get_functiondef('channel_data.pricing_halt_release_role_guard()'::regprocedure)) = 0 THEN
    bad := bad || 'price stop permissions are not taken from security.pricing_permission (OQ-129)';
  END IF;

  -- 38. Находка 4: автор остановки, возобновления и ручного снятия — членство пользователя сессии
  IF position('security.current_user_id()' IN pg_get_functiondef('tenant_data.price_stop_role_guard()'::regprocedure)) = 0
     OR position('security.current_user_id()' IN pg_get_functiondef('channel_data.pricing_halt_release_role_guard()'::regprocedure)) = 0
     OR position('security.current_user_id()' IN pg_get_functiondef('channel_data.pricing_halt_review_audit()'::regprocedure)) = 0 THEN
    bad := bad || 'the author of a stop or a manual release is not bound to the session user (finding 4)';
  END IF;

  -- 39. Находка 10: у решения NO_OP нет ссылки на снимок
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision_snapshot_ref'::regclass AND tgname = 'a_price_decision_snapshot_ref_guard') THEN
    bad := bad || 'a NO_OP decision may keep a snapshot reference (Р-74, finding 10)';
  END IF;

  -- 40. Р-80: слепок не повторяет столбцы; столбцы intent в решении — из intent; jsonb сжимается в строке в каждой секции
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_explanation_no_column_copies')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.price_intent_core'::regclass AND conname = 'price_intent_core_explanation_no_column_copies')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision'::regclass AND tgname = 'a0_price_decision_intent_columns')
     OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'channel_data.price_decision'::regclass
          AND attname IN ('trigger_type', 'proposed_amount_minor') AND attnotnull) <> 2 THEN
    bad := bad || 'explanations may repeat row columns or decisions lack the intent columns (Р-80)';
  END IF;
  FOR r IN
    SELECT t.tbl, pt.relid, pt.isleaf, c.reloptions, pol.leaf_toast_tuple_target
      FROM (VALUES ('channel_data.price_decision'::regclass), ('tenant_data.price_intent_core'::regclass)) AS t(tbl)
      CROSS JOIN LATERAL pg_partition_tree(t.tbl) pt
      JOIN pg_class c ON c.oid = pt.relid
      LEFT JOIN maintenance.retention_policy pol ON pol.table_name = t.tbl
  LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.relid AND a.attname = 'explanation' AND (a.attcompression <> 'l' OR a.attstorage <> 'm'))
       OR (r.isleaf AND (r.leaf_toast_tuple_target IS NULL
                         OR NOT coalesce(r.reloptions @> ARRAY['toast_tuple_target=' || r.leaf_toast_tuple_target], false))) THEN
      bad := bad || format('%s: the explanation is not compressed in the row (Р-80)', r.relid::regclass);
    END IF;
  END LOOP;

  -- 41. Р-79: подтверждённый архив ядра — со справочниками объяснения; экспортёр их читает
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'maintenance.partition_export'::regclass AND conname = 'partition_export_core_archive_self_contained')
     OR NOT has_table_privilege('repracer_exporter', 'tenant_data.pricing_strategy', 'SELECT')
     OR NOT has_table_privilege('repracer_exporter', 'platform.explanation_ruleset', 'SELECT') THEN
    bad := bad || 'the core archive may be confirmed without the strategy versions and rulesets its explanations refer to (Р-79)';
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'schema invariant violations:\n%', array_to_string(bad, E'\n');
  END IF;
END $$;

COMMIT;

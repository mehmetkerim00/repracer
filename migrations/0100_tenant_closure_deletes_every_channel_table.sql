-- 0100: закрытие тенанта удаляет ВСЕ его таблицы данных канала [шаг 27, задача F]
-- Правило шага 26 («таблица тенанта названа в очистке тенанта») проверяло только таблицы со сроком TENANT_CLOSURE_ONLY. Проверка
-- всех таблиц сразу нашла три таблицы данных канала, которые закрытие тенанта не удаляло: строки закрытого тенанта оставались в базе
-- до срабатывания срока (до 18 месяцев), хотя закрытие обещает удалить данные канала целиком.
--   channel_data.price_decision_snapshot_ref  — ссылка решения на снимок (0086)
--   channel_data.pricing_halt_sample          — наблюдения выборки для снятия остановки [Р-52]
--   channel_data.pricing_strategy_undercut    — подрез версии стратегии [Р-91]
-- Порядок удаления: ссылка на снимок — до решений, выборка — до остановок (внешние ключи).

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'channel_data.price_decision_snapshot_ref', 'channel_data.price_decision', 'channel_data.price_intent',
    'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_sample', 'channel_data.pricing_halt_review', 'channel_data.pricing_halt',
    'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification',
    'channel_data.offer_pricing_health', 'channel_data.notification_loss_verdict', 'channel_data.notification_loss_check',
    'channel_data.competitor_poll_state', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest',
    'channel_data.competitor_move', 'channel_data.competitor_price_daily', 'channel_data.pricing_strategy_undercut',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  -- Шаг 25 (ревью, находка 10): пропуски выгрузки и их разбор хранят идентификаторы снимков тенанта
  DELETE FROM maintenance.snapshot_export_skip_resolution r
   USING maintenance.snapshot_export_skip s WHERE s.competitor_snapshot_id = r.competitor_snapshot_id AND s.subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM maintenance.snapshot_export_skip WHERE subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

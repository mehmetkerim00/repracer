-- 0227_discovery_report_skus_not_found.sql
-- Шаг 122 (П7, аудит авторизации Amazon 2026-11-14): SKU, которые назвал отчёт каталога (GET_MERCHANT_LISTINGS_ALL_DATA, шаг 117), а поиск подробностей по SKU
-- не вернул (A-39: листинг снят между отчётом и поиском, предложения нет), до этого шага были только числом в журнале процесса (AMZ_C16 `SKU_NOT_FOUND`).
-- Продавец их не видел: «нашли 2 500» на Channels и 2 497 в каталоге — без объяснения, куда делись три.
--
-- Теперь у источника витрины (`tenant_data.discovery_catalog_source`, 0220) — число таких SKU за круг и первые 20 из них. Пишет только обнаружение функцией
-- `record_discovery_not_found`; новый круг (`record_discovery_catalog`) начинает счёт заново; экран Channels читает их функцией `discovery_catalog_sources`.
-- Только у отчёта: у поиска по витрине сравнивать не с чем. Форму держит одно ограничение: число не отрицательное, названо не больше 20 и не больше числа,
-- у поиска — ноль.
BEGIN;
SET ROLE repracer_owner;

ALTER TABLE tenant_data.discovery_catalog_source
  -- Сколько SKU отчёта поиск подробностей не вернул за этот круг
  ADD COLUMN not_found integer NOT NULL DEFAULT 0,
  -- Первые 20 из них, в порядке обнаружения — продавцу на экране Channels; остальные — числом
  ADD COLUMN not_found_sample text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT discovery_catalog_source_not_found CHECK (
    not_found >= cardinality(not_found_sample) AND cardinality(not_found_sample) <= 20 AND (source = 'REPORT' OR not_found = 0));
COMMENT ON COLUMN tenant_data.discovery_catalog_source.not_found IS
  'Шаг 122 (П7, A-39): SKU отчёта каталога, которых поиск подробностей не вернул за этот круг; у поиска по витрине — 0';
COMMENT ON COLUMN tenant_data.discovery_catalog_source.not_found_sample IS
  'Шаг 122 (П7): первые 20 таких SKU в порядке обнаружения — для экрана Channels';
GRANT INSERT (not_found, not_found_sample), UPDATE (not_found, not_found_sample) ON tenant_data.discovery_catalog_source TO repracer_discovery;
RESET ROLE;

/** Новый круг витрины — новый счёт: строка источника заменяется, и пропуски прошлого круга к нему не относятся */
CREATE OR REPLACE FUNCTION tenant_data.record_discovery_catalog(p_tenant_id uuid, p_channel_account_id uuid, p_marketplace text, p_source text, p_listed integer,
                                                                p_fallback_reason text, p_may_be_incomplete boolean, p_at timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  INSERT INTO tenant_data.discovery_catalog_source AS c
         (tenant_id, channel_account_id, marketplace, source, listed, fallback_reason, may_be_incomplete, observed_at)
  VALUES (p_tenant_id, p_channel_account_id, p_marketplace, p_source, p_listed, p_fallback_reason, p_may_be_incomplete, p_at)
  ON CONFLICT (tenant_id, channel_account_id, marketplace) DO UPDATE SET
    source = excluded.source, listed = excluded.listed, fallback_reason = excluded.fallback_reason,
    may_be_incomplete = excluded.may_be_incomplete, observed_at = excluded.observed_at, not_found = 0, not_found_sample = '{}'
$fn$;

/**
 * Обнаружение называет SKU отчёта, которых поиск не вернул на странице. Только у строки отчёта (у поиска сравнивать не с чем — строка не меняется); число
 * растёт на всех, имена — до 20. Строки нет — круг этой витрины ещё не назван, и записывать не к чему
 */
CREATE FUNCTION tenant_data.record_discovery_not_found(p_tenant_id uuid, p_channel_account_id uuid, p_marketplace text, p_skus text[])
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  UPDATE tenant_data.discovery_catalog_source c
     SET not_found = c.not_found + cardinality(p_skus),
         not_found_sample = (c.not_found_sample || p_skus)[1:20]
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id AND c.marketplace = p_marketplace AND c.source = 'REPORT'
$fn$;
ALTER FUNCTION tenant_data.record_discovery_not_found(uuid, uuid, text, text[]) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.record_discovery_not_found(uuid, uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.record_discovery_not_found(uuid, uuid, text, text[]) TO repracer_app;

/** Экран Channels: источники каталога витрин аккаунта — и пропуски отчёта (форма ответа другая: функция пересоздаётся) */
DROP FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid);
CREATE FUNCTION tenant_data.discovery_catalog_sources(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (marketplace text, source text, listed integer, fallback_reason text, may_be_incomplete boolean, observed_at timestamptz,
                 not_found integer, not_found_sample text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.marketplace, c.source, c.listed, c.fallback_reason, c.may_be_incomplete, c.observed_at, c.not_found, c.not_found_sample
    FROM tenant_data.discovery_catalog_source c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id ORDER BY c.marketplace
$fn$;
ALTER FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) TO repracer_app, repracer_admin;

COMMIT;

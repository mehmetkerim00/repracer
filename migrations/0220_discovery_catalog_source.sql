-- 0220_discovery_catalog_source.sql
-- Шаг 117 (P0-16 аудита, A-31, решение владельца 2026-11-07): каталог Amazon обнаруживается отчётом GET_MERCHANT_LISTINGS_ALL_DATA, поиск
-- searchListingsItems остаётся резервом. Поиск отдаёт не больше 1 000 SKU на все страницы, поэтому продавец должен видеть, откуда круг
-- взял каталог витрины и полон ли он: «каталог может быть виден не полностью» — словами на экране Channels, а не молча.
--
-- `tenant_data.discovery_catalog_source` — одна строка на аккаунт и витрину: источник последнего круга (отчёт или поиск), сколько предложений
-- он назвал, почему отчёт не годился и может ли каталог быть неполным. Пишет только функция `record_discovery_catalog` (обнаружение), читает
-- экран Channels функцией `discovery_catalog_sources`. Форму строки держат ограничения: у отчёта нет причины отказа и неполноты, у поиска
-- причина из известного списка.
BEGIN;
SET ROLE repracer_owner;

CREATE TABLE tenant_data.discovery_catalog_source (
  tenant_id           uuid NOT NULL,
  channel_account_id  uuid NOT NULL,
  marketplace         text NOT NULL,
  -- REPORT — список SKU из отчёта, подробности поиском по SKU; SEARCH — поиск по витрине (резерв, до 1 000 SKU)
  source              text NOT NULL,
  -- Сколько предложений назвал источник: SKU отчёта или numberOfResults поиска; NULL — канал числа не назвал
  listed              integer,
  -- Почему отчёт не годился (только у поиска)
  fallback_reason     text,
  -- Поиск упёрся в предел или не назвал числа: каталог витрины может быть виден не полностью
  may_be_incomplete   boolean NOT NULL,
  observed_at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, channel_account_id, marketplace),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  -- Источник — только REPORT или SEARCH: это держит форма строки (отдельное ограничение было бы дублем, Р-104)
  CONSTRAINT discovery_catalog_source_shape CHECK (
    source = 'REPORT' AND fallback_reason IS NULL AND NOT may_be_incomplete AND listed IS NOT NULL
    -- IS NOT NULL явно: IN по NULL даёт NULL, и CHECK пропустил бы поиск без причины (нашёл тест шага)
    OR source = 'SEARCH' AND fallback_reason IS NOT NULL AND fallback_reason IN ('REPORT_REFUSED', 'REPORT_CANCELLED', 'REPORT_FATAL', 'REPORT_TIMEOUT', 'REPORT_MISMATCH',
                                                 'REPORT_DOCUMENT', 'REPORT_ENCODING', 'REPORT_HEADER')),
  CONSTRAINT discovery_catalog_source_listed CHECK (listed IS NULL OR listed >= 0),
  CONSTRAINT discovery_catalog_source_marketplace_form CHECK (marketplace ~ '^[A-Z0-9_]{2,20}$')
);
COMMENT ON TABLE tenant_data.discovery_catalog_source IS
  'Шаг 117 (P0-16, A-31): откуда круг обнаружения взял каталог витрины — отчёт или поиск — и может ли он быть неполным; пишет только record_discovery_catalog';
SELECT security.register_table('tenant_data.discovery_catalog_source', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.discovery_catalog_source');
-- Строка на аккаунт и витрину, уходит вместе с тенантом
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.discovery_catalog_source', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
GRANT SELECT, INSERT (tenant_id, channel_account_id, marketplace, source, listed, fallback_reason, may_be_incomplete, observed_at),
      UPDATE (source, listed, fallback_reason, may_be_incomplete, observed_at) ON tenant_data.discovery_catalog_source TO repracer_discovery;
CREATE POLICY discovery_catalog_source ON tenant_data.discovery_catalog_source FOR ALL TO repracer_discovery
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
-- Путь решения и консоль — только функциями (прав на таблицу нет, список разрешённого не растёт [Р-96])
REVOKE ALL ON tenant_data.discovery_catalog_source FROM repracer_admin, repracer_app;
RESET ROLE;

/**
 * Обнаружение записывает источник витрины. Аккаунт вне тенанта отклоняет составной внешний ключ, чужого тенанта — политика строк [Р-104]
 */
CREATE FUNCTION tenant_data.record_discovery_catalog(p_tenant_id uuid, p_channel_account_id uuid, p_marketplace text, p_source text, p_listed integer,
                                                     p_fallback_reason text, p_may_be_incomplete boolean, p_at timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  INSERT INTO tenant_data.discovery_catalog_source AS c
         (tenant_id, channel_account_id, marketplace, source, listed, fallback_reason, may_be_incomplete, observed_at)
  VALUES (p_tenant_id, p_channel_account_id, p_marketplace, p_source, p_listed, p_fallback_reason, p_may_be_incomplete, p_at)
  ON CONFLICT (tenant_id, channel_account_id, marketplace) DO UPDATE SET
    source = excluded.source, listed = excluded.listed, fallback_reason = excluded.fallback_reason,
    may_be_incomplete = excluded.may_be_incomplete, observed_at = excluded.observed_at
$fn$;
ALTER FUNCTION tenant_data.record_discovery_catalog(uuid, uuid, text, text, integer, text, boolean, timestamptz) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.record_discovery_catalog(uuid, uuid, text, text, integer, text, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.record_discovery_catalog(uuid, uuid, text, text, integer, text, boolean, timestamptz) TO repracer_app;

/** Экран Channels: источники каталога витрин аккаунта */
CREATE FUNCTION tenant_data.discovery_catalog_sources(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (marketplace text, source text, listed integer, fallback_reason text, may_be_incomplete boolean, observed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.marketplace, c.source, c.listed, c.fallback_reason, c.may_be_incomplete, c.observed_at FROM tenant_data.discovery_catalog_source c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id ORDER BY c.marketplace
$fn$;
ALTER FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.discovery_catalog_sources(uuid, uuid) TO repracer_app, repracer_admin;

-- Закрытие тенанта уносит источник каталога РАНЬШЕ аккаунта, на который он ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.channel_discovery_circle',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0220: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.discovery_catalog_source', 'tenant_data.channel_discovery_circle',$s$);
END $do$;

COMMIT;

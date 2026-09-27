-- 0136_credential_keeper_and_claim_window.sql
-- Шаг 44, задача C: хвосты ревью шага 43 по токенам каналов. Миграция 0132 слита в main и задним числом не правится [Р-146]:
-- её поправки — здесь.
--   находка 16 — очередь проверок авторизаций по времени ПОСЛЕДНЕЙ проверки с любым исходом (`last_checked_at`);
--   находка 17 — обмен кода, захваченный до срока запроса, завершается ещё две минуты после срока;
--   находка 21 — отметки проверки, перевод аккаунта в REVOKED и алерт делает узкая роль-хранитель, владелец функций;
--                у роли адаптеров остаются чтение токена и вызов проверки.
BEGIN;

ALTER TABLE tenant_data.channel_credential ADD COLUMN last_checked_at timestamptz;
COMMENT ON COLUMN tenant_data.channel_credential.last_checked_at IS
  'Шаг 44 (находка 16 ревью шага 43): последняя проверка с любым исходом — очередь проверок идёт по ней, и падающие не голодят остальных';
DROP INDEX tenant_data.channel_credential_check_due_idx;
-- Проверка авторизаций планировщиком: действующие версии, дольше всех не проверявшиеся, — первыми
CREATE INDEX channel_credential_check_due_idx ON tenant_data.channel_credential (last_checked_at NULLS FIRST)
  WHERE superseded_at IS NULL;

-- ================================================================ роль-хранитель
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_credential_keeper') THEN CREATE ROLE repracer_credential_keeper NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data, security TO repracer_credential_keeper;
GRANT SELECT (tenant_id, channel_credential_id, channel_account_id, version, superseded_at, check_failures, verified_at, last_check_code, last_checked_at)
  ON tenant_data.channel_credential TO repracer_credential_keeper;
GRANT UPDATE (verified_at, check_failures, last_check_code, superseded_at, last_checked_at) ON tenant_data.channel_credential TO repracer_credential_keeper;
CREATE POLICY keeper_read ON tenant_data.channel_credential FOR SELECT TO repracer_credential_keeper USING (true);
CREATE POLICY keeper_mark ON tenant_data.channel_credential FOR UPDATE TO repracer_credential_keeper USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, channel_account_id, auth_status) ON tenant_data.channel_account TO repracer_credential_keeper;
CREATE POLICY keeper_account_read ON tenant_data.channel_account FOR SELECT TO repracer_credential_keeper USING (true);
GRANT UPDATE (auth_status) ON tenant_data.channel_account TO repracer_credential_keeper;
CREATE POLICY keeper_account_revoke ON tenant_data.channel_account FOR UPDATE TO repracer_credential_keeper USING (true) WITH CHECK (true);
GRANT INSERT ON tenant_data.alert TO repracer_credential_keeper;
CREATE POLICY keeper_alert_raise ON tenant_data.alert FOR INSERT TO repracer_credential_keeper WITH CHECK (true);

-- У роли адаптеров прямых прав на отметки, статус аккаунта и алерты больше нет
REVOKE UPDATE (verified_at, check_failures, last_check_code, superseded_at) ON tenant_data.channel_credential FROM repracer_credentials;
DROP POLICY credentials_mark ON tenant_data.channel_credential;
REVOKE UPDATE (auth_status) ON tenant_data.channel_account FROM repracer_credentials;
DROP POLICY credentials_account_revoke ON tenant_data.channel_account;
REVOKE INSERT ON tenant_data.alert FROM repracer_credentials;
DROP POLICY credentials_alert_raise ON tenant_data.alert;

-- ================================================================ функции: владелец — хранитель
ALTER FUNCTION tenant_data.channel_credential_before_insert() OWNER TO repracer_credential_keeper;

CREATE OR REPLACE FUNCTION security.channel_authorization_checked(p_tenant_id uuid, p_credential_id uuid, p_outcome text, p_code text DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  c record;
  failures int;
BEGIN
  IF p_outcome NOT IN ('OK', 'REVOKED', 'TRANSIENT', 'PLATFORM') THEN
    RAISE EXCEPTION 'unknown authorization check outcome %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT cr.channel_account_id, cr.superseded_at, ca.auth_status INTO c
    FROM tenant_data.channel_credential cr
    JOIN tenant_data.channel_account ca ON ca.tenant_id = cr.tenant_id AND ca.channel_account_id = cr.channel_account_id
   WHERE cr.tenant_id = p_tenant_id AND cr.channel_credential_id = p_credential_id;
  IF c.channel_account_id IS NULL THEN
    RAISE EXCEPTION 'credential % of tenant % is unknown', p_credential_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Итог проверки ВЫТЕСНЕННОЙ версии аккаунт не трогает: продавец уже авторизовал заново, и старый отказ — не новость
  IF c.superseded_at IS NOT NULL THEN
    RETURN 'SUPERSEDED';
  END IF;
  IF p_outcome = 'OK' THEN
    UPDATE tenant_data.channel_credential SET verified_at = now(), check_failures = 0, last_check_code = NULL, last_checked_at = now()
     WHERE tenant_id = p_tenant_id AND channel_credential_id = p_credential_id;
    RETURN 'OK';
  END IF;
  UPDATE tenant_data.channel_credential SET check_failures = check_failures + 1, last_check_code = left(coalesce(p_code, p_outcome), 64), last_checked_at = now()
   WHERE tenant_id = p_tenant_id AND channel_credential_id = p_credential_id
  RETURNING check_failures INTO failures;
  IF p_outcome = 'REVOKED' THEN
    IF c.auth_status = 'ACTIVE' THEN
      UPDATE tenant_data.channel_account SET auth_status = 'REVOKED'
       WHERE tenant_id = p_tenant_id AND channel_account_id = c.channel_account_id;
      INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
      VALUES (p_tenant_id, 'CHANNEL_AUTHORIZATION_REVOKED', 'CRITICAL', c.channel_account_id,
              jsonb_build_object('code', left(coalesce(p_code, 'invalid_grant'), 64)));
    END IF;
    RETURN 'REVOKED';
  END IF;
  IF p_outcome = 'TRANSIENT' AND failures = 3 THEN
    INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
    VALUES (p_tenant_id, 'CHANNEL_AUTHORIZATION_CHECK_FAILING', 'WARNING', c.channel_account_id,
            jsonb_build_object('failures', failures, 'code', left(coalesce(p_code, 'TRANSIENT'), 64)));
  END IF;
  RETURN p_outcome;
END $fn$;
ALTER FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) OWNER TO repracer_credential_keeper;
REVOKE EXECUTE ON FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) TO repracer_credentials;

-- ================================================================ окно завершения захваченного обмена
CREATE OR REPLACE FUNCTION tenant_data.channel_authorization_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requested_at := now();
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'an authorization request starts PENDING (Р-175)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'authorization request % is already %', OLD.authorization_request_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.exchange_started_at IS DISTINCT FROM OLD.exchange_started_at THEN
    IF OLD.exchange_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'the code exchange of authorization request % is already claimed (Р-175)', OLD.authorization_request_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF now() > OLD.expires_at THEN
      RAISE EXCEPTION 'authorization request % expired at %: the consent came back too late (Р-175)', OLD.authorization_request_id, OLD.expires_at
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  /**
   * Находка 17 ревью шага 43: обмен, ЗАХВАЧЕННЫЙ до срока, завершается и чуть позже — иначе ответ канала, пришедший через
   * секунду после срока, выбрасывал бы уже полученный токен. Незахваченный запрос после срока не завершается никак.
   */
  IF NEW.status = 'COMPLETED' AND now() > OLD.expires_at + (CASE WHEN OLD.exchange_started_at <= OLD.expires_at THEN interval '2 minutes' ELSE interval '0' END) THEN
    RAISE EXCEPTION 'authorization request % expired at %: the consent came back too late (Р-175)', OLD.authorization_request_id, OLD.expires_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> 'PENDING' THEN NEW.completed_at := now(); END IF;
  RETURN NEW;
END $fn$;

COMMIT;

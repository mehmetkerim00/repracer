-- 0074: шаг 20 — Р-109. Элемент согласия на миграцию eBay сверяется с предполётной проверкой по существу, а не только по
-- существованию: вердикт согласия равен вердикту проверки; проверка — последняя для листинга и не старше 24 часов; принятые
-- потери поимённо равны потерям проверки. Причина: миграция необратима (Р-2) — согласие на листинг, который проверка признала
-- непригодным или проверяла давно, ломает аккаунт продавца навсегда. Закрывает принятый риск 12б.
-- Срок 24 часа выбран нами, а не каналом: документация eBay срока не задаёт; изменение — решением владельца (docs/decisions.md, Р-109).

BEGIN;

-- Находки проверки — объекты { code, severity, loss? }; у LOSS обязательно имя потери, которое продавец принимает поимённо
CREATE FUNCTION channel_data.migration_findings_valid(p_findings jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p_findings) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_findings) f
        WHERE jsonb_typeof(f.value) <> 'object'
           OR jsonb_typeof(f.value -> 'code') IS DISTINCT FROM 'string'
           OR (f.value ->> 'severity') IS NULL OR (f.value ->> 'severity') NOT IN ('BLOCKER', 'LOSS', 'WARNING', 'INFO')
           OR ((f.value ->> 'severity') = 'LOSS') IS DISTINCT FROM (jsonb_typeof(f.value -> 'loss') IS NOT DISTINCT FROM 'string')
           -- ревью шага 20 (находка 13): имя потери не пустое
           OR ((f.value ->> 'severity') = 'LOSS' AND (f.value ->> 'loss') !~ '^[A-Z][A-Z0-9_]{1,63}$'))
$$;
ALTER TABLE channel_data.listing_migration_check
  ADD CONSTRAINT listing_migration_check_findings_shape CHECK (channel_data.migration_findings_valid(findings));

-- Потери проверки — отсортированный набор имён находок LOSS (одно определение для элемента согласия и для старта миграции)
CREATE FUNCTION channel_data.migration_check_losses(p_findings jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT f.value ->> 'loss' ORDER BY f.value ->> 'loss'), '{}')
    FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' = 'LOSS'
$$;

-- Ревью шага 20 (находка 13): вердикт согласован с находками — READY без BLOCKER и LOSS, READY_WITH_LOSSES с LOSS и без BLOCKER,
-- FIXABLE и INELIGIBLE — с BLOCKER. Иначе «READY» с блокирующей находкой проходит сверку вердикта
CREATE FUNCTION channel_data.migration_verdict_matches_findings(p_verdict text, p_findings jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_verdict
    WHEN 'READY' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' IN ('BLOCKER', 'LOSS'))
    WHEN 'READY_WITH_LOSSES' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' = 'LOSS')
                              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' = 'BLOCKER')
    WHEN 'FIXABLE' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' = 'BLOCKER')
    WHEN 'INELIGIBLE' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_findings) f WHERE f.value ->> 'severity' = 'BLOCKER')
    ELSE true END
$$;
ALTER TABLE channel_data.listing_migration_check
  ADD CONSTRAINT listing_migration_check_verdict_matches_findings CHECK (channel_data.migration_verdict_matches_findings(verdict, findings));

-- Ревью шага 20 (находки 2, 3): момент проверки из будущего делал её «последней» и «свежей» навсегда. Проверка записывается, когда
-- выполнена: момент не позже часов базы. Исключений нет — и у суперпользователя
CREATE FUNCTION channel_data.listing_migration_check_not_future() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checked_at > now() THEN
    RAISE EXCEPTION 'preflight check of listing % is dated in the future (%): a check is recorded after it ran (Р-109)', NEW.listing_id, NEW.checked_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_listing_migration_check_not_future BEFORE INSERT ON channel_data.listing_migration_check
  FOR EACH ROW EXECUTE FUNCTION channel_data.listing_migration_check_not_future();

SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION tenant_data.migration_consent_item_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c      record;
  lc     record;
  losses text[];
BEGIN
  IF security.superuser_session() THEN
    RETURN NEW;
  END IF;
  SELECT mc.user_id, mc.given_at, mc.channel_account_id INTO c FROM tenant_data.migration_consent mc
   WHERE mc.tenant_id = NEW.tenant_id AND mc.migration_consent_id = NEW.migration_consent_id;
  IF c.user_id IS NULL OR c.user_id IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'a listing is added to a migration consent only by the owner who gave it (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'adding a listing to a migration consent requires a second factor of the session (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.given_at <> now() THEN
    RAISE EXCEPTION 'listings are added to a migration consent only in the transaction that gives it (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT l.verdict, l.checked_at, l.findings INTO lc FROM channel_data.listing_migration_check l
   WHERE l.tenant_id = NEW.tenant_id AND l.channel_account_id = c.channel_account_id AND l.listing_id = NEW.listing_id
     AND l.listing_migration_check_id = NEW.listing_migration_check_id AND l.listing_snapshot_sha256 = NEW.listing_snapshot_sha256;
  -- Р-109: продавец соглашается с тем, что показала проверка, — вердикт согласия и вердикт проверки совпадают. Отсутствие проверки —
  -- то же условие (вердикт NULL отличается от любого): отдельная ветка была бы недостижима своей причиной [Р-104]
  IF lc.verdict IS NULL OR lc.verdict IS DISTINCT FROM NEW.verdict_at_consent THEN
    RAISE EXCEPTION '%', CASE WHEN lc.verdict IS NULL
      THEN format('migration consent item for listing %s refers to no preflight check of this listing (Р-101, Р-2)', NEW.listing_id)
      ELSE format('migration consent verdict %s for listing %s does not match the preflight verdict %s (Р-109)', NEW.verdict_at_consent, NEW.listing_id, lc.verdict) END
      USING ERRCODE = 'check_violation';
  END IF;
  -- Р-109: более поздняя проверка листинга отменяет показанную раньше
  -- Ревью шага 20 (находка 5): проверка с тем же моментом — тоже «более поздняя»: какая из двух последняя, не определено, отказ
  IF EXISTS (SELECT 1 FROM channel_data.listing_migration_check l
              WHERE l.tenant_id = NEW.tenant_id AND l.channel_account_id = c.channel_account_id AND l.listing_id = NEW.listing_id
                AND l.listing_migration_check_id <> NEW.listing_migration_check_id AND l.checked_at >= lc.checked_at) THEN
    RAISE EXCEPTION 'migration consent item for listing % refers to a superseded preflight check (Р-109)', NEW.listing_id USING ERRCODE = 'check_violation';
  END IF;
  -- Р-109: проверка не старше 24 часов на момент согласия
  IF lc.checked_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'the preflight check of listing % is older than 24 hours at consent (Р-109)', NEW.listing_id USING ERRCODE = 'check_violation';
  END IF;
  -- Р-109: принятые потери поимённо равны потерям проверки — ни одной непринятой, ни одной выдуманной
  losses := channel_data.migration_check_losses(lc.findings);
  IF losses IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(NEW.acknowledged_losses) x) THEN
    RAISE EXCEPTION 'acknowledged losses % of listing % do not match the losses % of the preflight check (Р-109)', NEW.acknowledged_losses, NEW.listing_id, losses
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Ревью шага 20 (находка 4, INV-12): старт миграции — по последней проверке листинга после согласия, и она совпадает с согласием по
-- существу: тот же снимок, тот же вердикт, те же поимённые потери. До исправления сверялись только снимок и вердикт из READY*:
-- согласие на READY без потерь запускало миграцию после перепроверки READY_WITH_LOSSES с потерей Best Offer.
-- «Последняя» — все проверки с наибольшим моментом: при равных моментах каждая обязана совпасть (иначе порядок не определён)
CREATE OR REPLACE FUNCTION tenant_data.offer_mapping_migration_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ebay_migration_status IS NOT DISTINCT FROM OLD.ebay_migration_status THEN
    RETURN NEW;
  END IF;

  IF (OLD.ebay_migration_status, NEW.ebay_migration_status) NOT IN (VALUES
       ('REQUIRED', 'MIGRATION_STARTED'), ('REQUIRED', 'INELIGIBLE'), ('INELIGIBLE', 'REQUIRED'),
       ('MIGRATION_STARTED', 'MIGRATED'), ('MIGRATION_STARTED', 'FAILED'), ('MIGRATION_STARTED', 'OUTCOME_UNKNOWN'),
       ('OUTCOME_UNKNOWN', 'MIGRATED'), ('OUTCOME_UNKNOWN', 'FAILED'),
       ('FAILED', 'MIGRATION_STARTED'), ('FAILED', 'INELIGIBLE')) THEN
    RAISE EXCEPTION 'ebay_migration_status transition % -> % is not allowed', OLD.ebay_migration_status, NEW.ebay_migration_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.ebay_migration_status = 'MIGRATION_STARTED' AND NOT EXISTS (
       SELECT 1
         FROM tenant_data.migration_consent_item i
         JOIN tenant_data.migration_consent c
           ON c.tenant_id = i.tenant_id AND c.migration_consent_id = i.migration_consent_id
        WHERE i.tenant_id = NEW.tenant_id AND i.listing_id = NEW.external_listing_id
          AND c.channel_account_id = NEW.channel_account_id
          AND c.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM tenant_data.migration_consent_revocation r
                           WHERE r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id)
          AND EXISTS (SELECT 1 FROM channel_data.listing_migration_check lc
                       WHERE lc.tenant_id = NEW.tenant_id AND lc.channel_account_id = NEW.channel_account_id AND lc.listing_id = NEW.external_listing_id)
          AND NOT EXISTS (
                SELECT 1 FROM channel_data.listing_migration_check latest
                 WHERE latest.tenant_id = NEW.tenant_id AND latest.channel_account_id = NEW.channel_account_id
                   AND latest.listing_id = NEW.external_listing_id
                   AND latest.checked_at = (SELECT max(l2.checked_at) FROM channel_data.listing_migration_check l2
                                             WHERE l2.tenant_id = NEW.tenant_id AND l2.channel_account_id = NEW.channel_account_id
                                               AND l2.listing_id = NEW.external_listing_id)
                   AND (latest.checked_at < c.given_at
                        OR latest.listing_snapshot_sha256 <> i.listing_snapshot_sha256
                        OR latest.verdict IS DISTINCT FROM i.verdict_at_consent
                        OR channel_data.migration_check_losses(latest.findings)
                           IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(i.acknowledged_losses) x)))) THEN
    RAISE EXCEPTION 'listing % has no valid migration consent matching a fresh preflight check', NEW.external_listing_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;

COMMIT;

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
           OR ((f.value ->> 'severity') = 'LOSS') IS DISTINCT FROM (jsonb_typeof(f.value -> 'loss') IS NOT DISTINCT FROM 'string'))
$$;
ALTER TABLE channel_data.listing_migration_check
  ADD CONSTRAINT listing_migration_check_findings_shape CHECK (channel_data.migration_findings_valid(findings));

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
  IF EXISTS (SELECT 1 FROM channel_data.listing_migration_check l
              WHERE l.tenant_id = NEW.tenant_id AND l.channel_account_id = c.channel_account_id AND l.listing_id = NEW.listing_id
                AND l.checked_at > lc.checked_at) THEN
    RAISE EXCEPTION 'migration consent item for listing % refers to a superseded preflight check (Р-109)', NEW.listing_id USING ERRCODE = 'check_violation';
  END IF;
  -- Р-109: проверка не старше 24 часов на момент согласия
  IF lc.checked_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'the preflight check of listing % is older than 24 hours at consent (Р-109)', NEW.listing_id USING ERRCODE = 'check_violation';
  END IF;
  -- Р-109: принятые потери поимённо равны потерям проверки — ни одной непринятой, ни одной выдуманной
  SELECT coalesce(array_agg(DISTINCT f.value ->> 'loss' ORDER BY f.value ->> 'loss'), '{}') INTO losses
    FROM jsonb_array_elements(lc.findings) f WHERE f.value ->> 'severity' = 'LOSS';
  IF losses IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(NEW.acknowledged_losses) x) THEN
    RAISE EXCEPTION 'acknowledged losses % of listing % do not match the losses % of the preflight check (Р-109)', NEW.acknowledged_losses, NEW.listing_id, losses
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;

COMMIT;

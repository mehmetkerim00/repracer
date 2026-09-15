-- 0011_audit.sql
-- Журнал аудита: действия людей, изменения конфигурации, события безопасности.
-- Решения о цене и записи в каналы не дублируются сюда: они сами append-only/со статусами и временем.
-- Срок: 18 месяцев (≥ 12 по DPP; ≤ 18, если попадёт производное от данных Amazon). Без FK — переживает удаление сущностей.

BEGIN;
SET ROLE repracer_owner;

CREATE TABLE audit.audit_event (
  tenant_id           uuid NOT NULL,
  audit_event_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  occurred_at         timestamptz NOT NULL,
  actor_type          text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'CHANNEL', 'SUPPORT_STAFF')),
  actor_user_id       uuid,
  actor_membership_id uuid,
  action              text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type         text NOT NULL,
  entity_id           uuid,
  changes             jsonb,
  correlation_id      uuid,
  causation_id        uuid,
  source_ip           inet,
  user_agent          text,
  PRIMARY KEY (tenant_id, recorded_at, audit_event_id),
  CHECK ((actor_type IN ('USER', 'SUPPORT_STAFF')) = (actor_user_id IS NOT NULL)),
  CHECK (actor_type <> 'USER' OR actor_membership_id IS NOT NULL),
  CHECK (occurred_at <= recorded_at + interval '5 minutes')
) PARTITION BY RANGE (recorded_at);

-- История конкретной сущности (карточка GuardRail, согласия, аккаунта). Журнал тенанта по времени — первичный ключ.
CREATE INDEX audit_event_entity_idx ON audit.audit_event (tenant_id, entity_type, entity_id, recorded_at DESC);

SELECT security.register_table('audit.audit_event', 'AUDIT', 'append_only');

RESET ROLE;
COMMIT;

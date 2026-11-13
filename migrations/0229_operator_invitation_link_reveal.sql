-- 0229_operator_invitation_link_reveal.sql
-- Шаг 123 [Р-245] (решение владельца по аудиту авторизации Amazon 2026-11-14, Б3; ADR-0075): почтового провайдера нет (OQ-224), а приглашение владельца
-- пилота уходит только письмом — в сухом режиме ссылка терялась, и продавцу было не войти. Панель под флагом развёртывания `REPRACER_INVITE_LINK_REVEAL=on`
-- показывает ссылку оператору ОДИН раз — в ответе действия «пригласить владельца». Это осознанное ослабление свойства «токен приглашения не попадает в
-- ответ» (0126), и база держит его рамки:
--   - показ — пятым событием аудита оператора `operator.invitation_link_revealed`, той же транзакцией, что выдача;
--   - только со вторым фактором и только действующим оператором (`security.operator_acting`, как у каждого действия панели [Р-165]);
--   - только приглашение, выданное ЭТОЙ транзакцией этим оператором этому тенанту (событие выдачи с тем же временем транзакции): ссылку на старое
--     приглашение не показать — её токена у панели нет, а запись «показал» о нём была бы неправдой;
--   - только один раз на приглашение.
-- Функцию выдачи (`operator_invite_owner`) шаг не трогает: показ — отдельное решение панели под флагом, и без флага ни одного события показа нет.
BEGIN;
SET ROLE repracer_owner;

CREATE FUNCTION security.operator_reveal_invitation_link(p_operator_id uuid, p_tenant_id uuid, p_invitation_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event a
                  WHERE a.action = 'operator.owner_invited' AND a.entity_id = p_invitation_id AND a.tenant_id = p_tenant_id
                    AND a.actor_user_id = p_operator_id AND a.occurred_at = now()) THEN
    RAISE EXCEPTION 'the link of invitation % is shown only in the transaction that issued it, by its operator, for its tenant (Р-245)', p_invitation_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.audit_event a WHERE a.action = 'operator.invitation_link_revealed' AND a.entity_id = p_invitation_id) THEN
    RAISE EXCEPTION 'the link of invitation % is already shown: once only (Р-245)', p_invitation_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'operator.invitation_link_revealed', 'platform.identity_invitation', p_invitation_id,
    jsonb_build_object('operator', who));
END $fn$;
RESET ROLE;

-- Владелец — узкая роль действий панели, как у четырёх действий 0126 [Р-90]: она читает аудит операторов своей политикой и пишет его функцией роли аудита
ALTER FUNCTION security.operator_reveal_invitation_link(uuid, uuid, uuid) OWNER TO repracer_operator_actions;
REVOKE EXECUTE ON FUNCTION security.operator_reveal_invitation_link(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.operator_reveal_invitation_link(uuid, uuid, uuid) TO repracer_operator;

COMMIT;

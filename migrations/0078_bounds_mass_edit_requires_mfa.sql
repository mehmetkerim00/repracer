-- 0078_bounds_mass_edit_requires_mfa.sql
-- Шаг 21 [Р-88, OQ-144]: массовая правка границ — только со вторым фактором. Консоль получила массовое редактирование min_price и
-- max_price (экран различий, затем применение); правило закрепляется в базе, а не только в консоли и хранилище.
--
-- «Массовая» — новые версии границ больше чем одного предложения (единица записи для уровня WRITE_SCOPE, товар для уровня PRODUCT)
-- в одной транзакции административного сервиса. Второй фактор сессии — security.session_mfa() (app.auth_mfa из amr токена, 0053),
-- как у снятия остановки тенанта и смены роли. Путь решения границ не пишет вовсе (Р-96), суперпользователь проверок не проходит
-- (принятый риск 11).
--
-- Строки текущей транзакции — видимые строки, чей xmin ещё выполняется: незавершённые строки чужих транзакций по MVCC не видны, а у
-- вставок в подтранзакциях (SAVEPOINT) свой xmin, поэтому сравнение с идентификатором верхней транзакции их пропустило бы — так
-- обходилась первая редакция (смоук-проверка внутри подтранзакции). Поиск сужает (tenant_id, created_at = now()), поэтому момент
-- версии границы в административной сессии — только время транзакции: версия «задним числом» не проходит и не прячется от подсчёта.
--
-- Чего правило не видит: ту же правку, разбитую на отдельные транзакции по одному предложению. Её может сделать только сам
-- административный сервис, а его компрометация — полная компрометация [Р-97]; риск записан в accepted-risks.md (п. 17).

BEGIN;

-- xmin строки (32 бита) с эпохой текущей транзакции → статус; «in progress» у видимой строки — только своя транзакция или подтранзакция
CREATE FUNCTION tenant_data.row_in_current_transaction(row_xmin xid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT pg_xact_status((((pg_current_xact_id()::text::bigint >> 32) << 32) + row_xmin::text::bigint)::text::xid8) = 'in progress'
$$;

CREATE FUNCTION tenant_data.bounds_mass_edit_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  offers integer;
BEGIN
  IF NOT security.admin_session() THEN
    RETURN NULL;
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a bound version is created at the transaction time, not %: backdated versions are not accepted from the administrative service (Р-88)', NEW.created_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF security.session_mfa() THEN
    RETURN NULL;
  END IF;
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text) AS k
      FROM tenant_data.min_price b
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
    UNION ALL
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text)
      FROM tenant_data.max_price b
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
  ) edited;
  IF offers > 1 THEN
    RAISE EXCEPTION 'bounds of % offers changed in one transaction without a second factor: a mass bounds edit requires it (Р-88)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION tenant_data.bounds_mass_edit_requires_mfa() IS
  'Р-88, OQ-144 (шаг 21): новые версии границ больше чем одного предложения в одной транзакции административного сервиса — только со вторым фактором; версия границы — время транзакции';

CREATE TRIGGER zc_min_price_mass_edit_requires_mfa AFTER INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bounds_mass_edit_requires_mfa();
CREATE TRIGGER zc_max_price_mass_edit_requires_mfa AFTER INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bounds_mass_edit_requires_mfa();

-- Страж массовой правки: версии границ тенанта, созданные в текущей транзакции (tenant_id, created_at = now())
CREATE INDEX min_price_tenant_created_idx ON tenant_data.min_price (tenant_id, created_at);
-- Страж массовой правки: то же для потолка
CREATE INDEX max_price_tenant_created_idx ON tenant_data.max_price (tenant_id, created_at);

COMMIT;

-- Р-139 (шаг 30): защиты фоновых заданий массовых операций. Каждая защита проверяется СВОЕЙ проверкой с её причиной [Р-94, Р-99],
-- и каждая названа строкой каталога мутаций при создании [Р-108]. Данные синтетические.
--
-- Порядок ролей повторяет работу [Р-90]: задание создаёт человек административной ролью (svc_admin), ведёт его роль исполнителя
-- (svc_bulk_worker) — аренда, ход и итог. Фикстуры заданий остаются в базе: на них смотрят проверки второй роли.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set owner '''a1000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set viewer '''a1000000-0000-0000-0000-0000000000a9'''
\set viewerM '''a2000000-0000-0000-0000-0000000000a9'''
\set j1 '''bf000000-0000-4000-8000-000000000001'''
\set j2 '''bf000000-0000-4000-8000-000000000002'''
\set j3 '''bf000000-0000-4000-8000-000000000003'''

-- Настройки сессии, а не транзакции: файл не обёрнут в одну транзакцию — фикстуры заданий нужны второй роли
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- страж административной записи: задание создаёт человек
SELECT pg_temp.expect_fail('bulk job created without a person in the session (Р-97)', format($q$
  DO $x$ BEGIN
    PERFORM set_config('app.user_id', '', true);
    INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
    VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L);
  END $x$ $q$, :tA, :ownerM), 'without a person');
SELECT set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- Р-135: задание, меняющее цены, — только со вторым фактором
SELECT pg_temp.expect_fail('cost import job created without a second factor (Р-135, Р-139)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'COST_IMPORT', '{}'::jsonb, %L) $q$, :tA, :ownerM), 'creating it needs a second factor');

-- Выгрузка доказательства ничего не меняет — ей второй фактор не нужен [Р-123]
SELECT pg_temp.ok('price evidence job created without a second factor (Р-123)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id)
  VALUES (%L, %L, 'PRICE_EVIDENCE', '{}'::jsonb, %L) $q$, :tA, :j1, :ownerM));

SELECT set_config('app.auth_mfa', 'on', false) \gset

-- --------------------------------------------------------------- Р-100: право — по тому, что задание делает
SELECT set_config('app.user_id', :viewer, false) \gset
SELECT pg_temp.expect_fail('cost import job created by a viewer with a second factor (Р-100, Р-139)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'COST_IMPORT', '{}'::jsonb, %L) $q$, :tA, :viewerM), 'may not manage pricing');
SELECT set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- признак второго фактора ставит база, а не вызывающий [Р-90]
-- Вызывающий объявляет created_with_mfa = false при втором факторе в сессии: значение ставит база, и проверка смотрит на него
SELECT pg_temp.ok('the database sets the second factor of a bulk job, not the caller (Р-90)', $q$
  DO $x$
  DECLARE
    stored boolean;
  BEGIN
    INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id, created_with_mfa)
    VALUES ('a0000000-0000-0000-0000-00000000000a', 'bf000000-0000-4000-8000-000000000002', 'COST_IMPORT', '{}'::jsonb,
            'a2000000-0000-0000-0000-00000000000a', false);
    SELECT created_with_mfa INTO stored FROM tenant_data.bulk_job WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000002';
    IF stored IS NOT TRUE THEN
      RAISE EXCEPTION 'the second factor of a bulk job is declared by the caller, not by the database';
    END IF;
  END $x$ $q$);

-- --------------------------------------------------------------- аудит административной записи [Р-97]
SELECT pg_temp.ok('creating a bulk job is written to the audit log (Р-97)', $q$
  DO $x$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event
                    WHERE entity_type = 'tenant_data.bulk_job' AND entity_id = 'bf000000-0000-4000-8000-000000000002') THEN
      RAISE EXCEPTION 'creating a bulk job is not in the audit log';
    END IF;
  END $x$ $q$);

-- --------------------------------------------------------------- виды значений строки задания
SELECT pg_temp.expect_fail('bulk job of an unknown kind', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'SOMETHING_ELSE', '{}'::jsonb, %L) $q$, :tA, :ownerM), 'bulk_job_kind_known');
SELECT pg_temp.expect_fail('bulk job in an unknown status', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, status)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, 'ALMOST') $q$, :tA, :ownerM), 'bulk_job_status_known');
SELECT pg_temp.expect_fail('bulk job in an unknown phase', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, phase)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, 'THINKING') $q$, :tA, :ownerM), 'bulk_job_phase_known');
SELECT pg_temp.expect_fail('bulk job with a negative total', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, total_items)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, -1) $q$, :tA, :ownerM), 'bulk_job_total_non_negative');
SELECT pg_temp.expect_fail('bulk job with a negative progress', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, done_items)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, -1) $q$, :tA, :ownerM), 'bulk_job_done_non_negative');
SELECT pg_temp.expect_fail('bulk job with a negative attempt count', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, attempts)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, -1) $q$, :tA, :ownerM), 'bulk_job_attempts_non_negative');
SELECT pg_temp.expect_fail('bulk job leased by nobody until a moment', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, lease_until)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, now() + interval '1 minute') $q$, :tA, :ownerM), 'bulk_job_lease_pair');
SELECT pg_temp.expect_fail('bulk job finished without a moment of finishing', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, status)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, 'SUCCEEDED') $q$, :tA, :ownerM), 'bulk_job_finished_has_outcome');
SELECT pg_temp.expect_fail('bulk job failed without a reason', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, status, finished_at)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L, 'FAILED', now()) $q$, :tA, :ownerM), 'bulk_job_failed_has_reason');

-- Фикстуры для роли исполнителя: одно задание с ЧУЖОЙ живой арендой, одно завершённое, одно ожидающее
INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id, status, phase, finished_at, result)
VALUES (:tA, :j3, 'PRICE_EVIDENCE', '{}'::jsonb, :ownerM, 'SUCCEEDED', 'DONE', now(), '{}'::jsonb);
DO $$ BEGIN RAISE NOTICE 'PASS accept | bulk job fixtures for the worker role (Р-139)'; END $$;

\c - svc_bulk_worker
\i tests/db/smoke_helpers.sql
\set tA '''a0000000-0000-0000-0000-00000000000a'''
SELECT set_config('app.tenant_id', :tA, false) \gset

-- Исполнитель берёт ожидающее задание: он называет себя базе, и это его аренда
SELECT set_config('app.bulk_lease_owner', 'worker-one', false) \gset
SELECT pg_temp.ok('the worker takes a pending bulk job under its own name (Р-139)', $q$
  UPDATE tenant_data.bulk_job
     SET status = 'RUNNING', lease_owner = 'worker-one', lease_until = now() + interval '5 minutes', started_at = now(), attempts = attempts + 1
   WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000001' $q$);

-- --------------------------------------------------------------- аренда: чужую живую аренду не перехватить и не отпустить
SELECT set_config('app.bulk_lease_owner', 'worker-two', false) \gset
SELECT pg_temp.expect_fail('another process takes a live lease of a bulk job (Р-139)', $q$
  UPDATE tenant_data.bulk_job SET lease_owner = 'worker-two', lease_until = now() + interval '5 minutes'
   WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000001' $q$, 'is leased by');
SELECT pg_temp.expect_fail('another process releases a live lease of a bulk job (Р-139)', $q$
  UPDATE tenant_data.bulk_job SET lease_owner = NULL, lease_until = NULL
   WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000001' $q$, 'is leased by');

-- --------------------------------------------------------------- итог задания не переписывается
SELECT set_config('app.bulk_lease_owner', 'worker-one', false) \gset
SELECT pg_temp.expect_fail('a finished bulk job is started again (Р-139)', $q$
  UPDATE tenant_data.bulk_job SET status = 'RUNNING', finished_at = NULL
   WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000003' $q$, 'is not rewritten');
SELECT pg_temp.expect_fail('a pending bulk job jumps straight to succeeded (Р-139)', $q$
  UPDATE tenant_data.bulk_job SET status = 'SUCCEEDED', finished_at = now()
   WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000002' $q$, 'goes from PENDING to RUNNING');

-- --------------------------------------------------------------- файл задания: имя, вид, контрольная сумма, число строк
SELECT pg_temp.expect_fail('artifact with an empty file name', $q$
  INSERT INTO tenant_data.bulk_job_artifact (tenant_id, bulk_job_id, file_name, content_type, content, sha256, rows_count)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'bf000000-0000-4000-8000-000000000001', '', 'text/csv', 'a', repeat('0', 64), 1) $q$,
  'bulk_job_artifact_file_name_check');
SELECT pg_temp.expect_fail('artifact of a kind the console cannot show', $q$
  INSERT INTO tenant_data.bulk_job_artifact (tenant_id, bulk_job_id, file_name, content_type, content, sha256, rows_count)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'bf000000-0000-4000-8000-000000000001', 'x.bin', 'application/octet-stream', 'a', repeat('0', 64), 1) $q$,
  'bulk_job_artifact_content_type_check');
SELECT pg_temp.expect_fail('artifact with a checksum that is not a SHA-256', $q$
  INSERT INTO tenant_data.bulk_job_artifact (tenant_id, bulk_job_id, file_name, content_type, content, sha256, rows_count)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'bf000000-0000-4000-8000-000000000001', 'x.csv', 'text/csv', 'a', 'not-a-checksum', 1) $q$,
  'bulk_job_artifact_sha256_check');
SELECT pg_temp.expect_fail('artifact with a negative row count', $q$
  INSERT INTO tenant_data.bulk_job_artifact (tenant_id, bulk_job_id, file_name, content_type, content, sha256, rows_count)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'bf000000-0000-4000-8000-000000000001', 'x.csv', 'text/csv', 'a', repeat('0', 64), -1) $q$,
  'bulk_job_artifact_rows_count_check');

-- Исполнитель не создаёт заданий и не меняет того, что решил человек [Р-90]
SELECT pg_temp.expect_fail('the worker role creates a bulk job (Р-90)', $q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRICE_EVIDENCE', '{}'::jsonb, 'a2000000-0000-0000-0000-00000000000a') $q$,
  'permission denied');
SELECT pg_temp.expect_fail('the worker role changes what the bulk job must do (Р-90)', $q$
  UPDATE tenant_data.bulk_job SET params = '{"changed": true}'::jsonb WHERE bulk_job_id = 'bf000000-0000-4000-8000-000000000001' $q$,
  'permission denied');

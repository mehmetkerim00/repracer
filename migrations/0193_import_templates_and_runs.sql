-- 0193_import_templates_and_runs.sql
-- Шаг 99 [Р-224, Р-225]: импорты продавца — шаблон, примерка, применение ровно примерки и журнал. Четыре импорта (себестоимость,
-- остатки, границы, стратегии) идут одним путём: шаблон (задание IMPORT_TEMPLATE, файл CSV или XLSX с текущими значениями) →
-- примерка (задание IMPORT_CHECK: сколько строк изменится, сколько ошибок, каждая ошибка с номером строки и причиной) → применение
-- заданием своего вида (COST_IMPORT, STOCK_IMPORT, BOUNDS_EDIT, STRATEGY_ASSIGN) со ссылкой на примерку. Применение пересчитывает
-- примерку по текущим данным и отказывает, если она изменилась; файл с ошибочными строками не применяется вовсе.
--
-- Что здесь:
--   1. два новых вида задания — ничего не меняющих (второй фактор не нужен) и отдающих файл;
--   2. файл задания может быть XLSX: содержимое — base64, контрольная сумма — по байтам файла, а не по тексту base64;
--   3. журнал импортов `tenant_data.import_run` — только на добавление: кто, когда, какой импорт, файл (имя и сумма), сколько строк
--      изменится, без изменений и отклонено, итог и время; пишет его задание, которое сейчас идёт, автора и время ставит база;
--   4. минимальная маржа предложения из файла (гардрейл уровня единицы записи) — массовая правка, второй фактор как у границ [Р-135].

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Виды заданий: шаблон и примерка импорта
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_kind_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_kind_known
  CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT',
                  'REPRICING_ENABLE', 'STOCK_IMPORT', 'STOCK_SYNC_ENABLE', 'IMPORT_TEMPLATE', 'IMPORT_CHECK'));

/**
 * Р-143: шаблон и примерка НИЧЕГО НЕ МЕНЯЮТ — второй фактор им не нужен, и они не открывают операций, которым он нужен (правило
 * 14г). Прежний список не переписан, а дополнен: на его текст ссылаются строки каталога мутаций [Р-108]
 */
CREATE OR REPLACE FUNCTION security.read_only_job_kinds() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['BOUNDS_PLAN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT'])
  -- Шаг 99 [Р-224]: шаблон импорта и примерка файла
  UNION ALL SELECT unnest(ARRAY['IMPORT_TEMPLATE', 'IMPORT_CHECK'])
$fn$;

/**
 * Р-145: файл отдают шаблон (сам шаблон) и примерка (отчёт об ошибочных строках). Импорт себестоимости файла больше не отдаёт:
 * файл с ошибками не применяется вовсе [Р-224], и отчёта о «пропущенных при применении» строках не бывает — они в отчёте примерки
 */
CREATE OR REPLACE FUNCTION security.file_producing_job_kinds() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['IMPORT_TEMPLATE', 'IMPORT_CHECK', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT'])
$fn$;

/**
 * Право на вид операции [Р-143]: шаблон — выгрузка, его отмена стоит просмотра; примерка — первая половина импорта (применение
 * ссылается на неё, как правка каталога — на экран различий), и чужую отменяет тот, кто вправе менять цены
 */
DO $do$
DECLARE
  d text := pg_get_functiondef('security.bulk_job_cancel_action(text)'::regprocedure);
  a text := $s$WHEN p_kind IN ('STOCK_IMPORT', 'STOCK_SYNC_ENABLE') THEN 'MANAGE_CATALOG'$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0193: security.bulk_job_cancel_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
              -- Шаг 99 [Р-224]: шаблон импорта — выгрузка; примерка — первая половина импорта
              WHEN p_kind = 'IMPORT_TEMPLATE' THEN 'VIEW_PRICING'
              WHEN p_kind = 'IMPORT_CHECK' THEN 'MANAGE_PRICING'$s$);
END $do$;

-- ---------------------------------------------------------------- 2. Файл задания: CSV или XLSX
/**
 * XLSX — двоичный файл; в столбце содержимого он лежит base64. Контрольная сумма, которую продавец сверяет со скачанным файлом
 * [Р-123, Р-145], — по БАЙТАМ файла: сумма текста base64 не совпала бы ни с одним файлом на диске
 */
ALTER TABLE tenant_data.bulk_job_artifact DROP CONSTRAINT bulk_job_artifact_content_type_check;
ALTER TABLE tenant_data.bulk_job_artifact ADD CONSTRAINT bulk_job_artifact_content_type_check
  CHECK (content_type IN ('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

CREATE OR REPLACE FUNCTION tenant_data.bulk_job_artifact_digest_matches() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  bytes bytea;
BEGIN
  -- Шаг 99: XLSX лежит base64, и сумма считается по байтам файла; остальное — текст в UTF-8
  IF NEW.content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN
    bytes := decode(NEW.content, 'base64');
  ELSE
    bytes := convert_to(NEW.content, 'UTF8');
  END IF;
  IF NEW.sha256 IS DISTINCT FROM encode(sha256(bytes), 'hex') THEN
    RAISE EXCEPTION 'the checksum of the file of bulk job % does not match its content: the database computes it, it is not declared (Р-145)',
      NEW.bulk_job_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;

-- ---------------------------------------------------------------- 3. Журнал импортов
CREATE TABLE tenant_data.import_run (
  tenant_id                uuid NOT NULL,
  import_run_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Какой импорт: себестоимость, остатки, границы, стратегии
  kind                     text NOT NULL CONSTRAINT import_run_kind_known CHECK (kind IN ('COSTS', 'STOCK', 'BOUNDS', 'STRATEGY')),
  /**
   * Примерка (CHECKED), применение (APPLIED) или отказ применения (REFUSED: данные изменились после примерки, в файле ошибки, нужен второй
   * фактор…). Перечень держит страж «строку пишет её задание» ниже: другого итога ни одно задание не пишет, и отдельная проверка значения
   * была бы недостижимым дублем [Р-104]
   */
  outcome                  text NOT NULL,
  reason                   text CONSTRAINT import_run_reason_only_refused
                             CHECK ((reason IS NOT NULL) = (outcome = 'REFUSED') AND (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{2,59}$')),
  file_name                text NOT NULL CONSTRAINT import_run_file_name_length CHECK (length(file_name) BETWEEN 1 AND 200),
  file_sha256              text NOT NULL CONSTRAINT import_run_file_sha256_form CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- Строки файла с данными (без заголовка и строк-комментариев «#»): изменятся, без изменений, отклонены — в сумме все
  rows_total               int NOT NULL,
  rows_changed             int NOT NULL,
  rows_unchanged           int NOT NULL,
  rows_rejected            int NOT NULL,
  CONSTRAINT import_run_rows_non_negative CHECK (least(rows_total, rows_changed, rows_unchanged, rows_rejected) >= 0),
  CONSTRAINT import_run_rows_add_up CHECK (rows_changed + rows_unchanged + rows_rejected = rows_total),
  /**
   * Частично-молчаливых применений не бывает [Р-224]: применённый импорт не имел ни одной отклонённой строки и что-то менял.
   * Применено ровно `rows_changed` — отдельного счётчика «применено» нет, он был бы производной
   */
  CONSTRAINT import_run_applied_whole CHECK (outcome <> 'APPLIED' OR (rows_rejected = 0 AND rows_changed > 0)),
  -- От нажатия до итога: у примерки — от «Check», у применения — от «Apply» до фиксации; ставит страж из часов базы, не вызывающий
  duration_ms              int NOT NULL,
  bulk_job_id              uuid NOT NULL,
  -- Автор — человек, создавший задание [Р-97]; ставит база из задания, а не вызывающий
  created_by_membership_id uuid NOT NULL,
  created_by_user_id       uuid NOT NULL REFERENCES platform.app_user (user_id),
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, import_run_id),
  -- Одна строка журнала на задание: применение, повторённое после падения процесса, не записывается дважды
  CONSTRAINT import_run_one_per_job UNIQUE (tenant_id, bulk_job_id),
  FOREIGN KEY (tenant_id, bulk_job_id) REFERENCES tenant_data.bulk_job (tenant_id, bulk_job_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);
COMMENT ON TABLE tenant_data.import_run IS
  'Шаг 99 [Р-224]: журнал импортов продавца — кто, когда, какой импорт, файл (имя и SHA-256), сколько строк изменится, без изменений и отклонено, итог';
SELECT security.register_table('tenant_data.import_run', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.import_run');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.import_run', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Под запрос истории на странице импорта: последние записи одного вида импорта тенанта
CREATE INDEX import_run_kind_recent_idx ON tenant_data.import_run (tenant_id, kind, recorded_at DESC);

/**
 * Строку журнала пишет ЗАДАНИЕ, которое сейчас идёт и назвало себя базе (`app.bulk_job_id`), и только своего вида: примерка —
 * «проверено» своего импорта, применение — «применено» или «отказано». Автор, время и длительность — из задания и часов базы:
 * вызывающий их не объявляет [Р-90]. Иначе журнал «кто и что применил» писал бы тот, кого он описывает
 */
CREATE FUNCTION tenant_data.import_run_from_its_job() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  j tenant_data.bulk_job;
BEGIN
  SELECT * INTO j FROM tenant_data.bulk_job b WHERE b.tenant_id = NEW.tenant_id AND b.bulk_job_id = NEW.bulk_job_id;
  IF j.bulk_job_id IS NULL OR j.status <> 'RUNNING' OR j.lease_until <= now()
     OR NEW.bulk_job_id::text IS DISTINCT FROM nullif(current_setting('app.bulk_job_id', true), '') THEN
    RAISE EXCEPTION 'an import run is written by its own bulk job while it runs (Р-224)' USING ERRCODE = 'lock_not_available';
  END IF;
  /**
   * `coalesce(…, false)`: у задания чужого вида сопоставление даёт NULL, а `IF NOT NULL` не срабатывает — без него задание выгрузки с
   * `checkJobId` в параметрах записало бы «применено» (нашла мутационная проверка шага 99)
   */
  IF NOT coalesce((j.kind = 'IMPORT_CHECK' AND NEW.outcome = 'CHECKED' AND NEW.kind = j.params ->> 'importKind')
          OR (NEW.outcome IN ('APPLIED', 'REFUSED') AND j.params ? 'checkJobId'
              AND NEW.kind = CASE j.kind WHEN 'COST_IMPORT' THEN 'COSTS' WHEN 'STOCK_IMPORT' THEN 'STOCK'
                                         WHEN 'BOUNDS_EDIT' THEN 'BOUNDS' WHEN 'STRATEGY_ASSIGN' THEN 'STRATEGY' END), false) THEN
    RAISE EXCEPTION 'an import run % of % does not match its bulk job of kind % (Р-224)', NEW.outcome, NEW.kind, j.kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_by_membership_id := j.created_by_membership_id;
  NEW.created_by_user_id := j.created_by_user_id;
  NEW.duration_ms := greatest(0, round(extract(epoch FROM clock_timestamp() - j.created_at) * 1000))::int;
  NEW.recorded_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_import_run_from_its_job BEFORE INSERT ON tenant_data.import_run
  FOR EACH ROW EXECUTE FUNCTION tenant_data.import_run_from_its_job();

/**
 * Р-135: минимальная маржа больше чем одного предложения в одной транзакции — только со вторым фактором, как границы. До шага 99
 * гардрейлы уровня предложения писал только посев; импорт границ — первый путь, меняющий пол маржи сотен предложений сразу.
 * Считается один раз на оператор [0110]
 */
CREATE FUNCTION tenant_data.guardrail_mass_edit_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  offers integer;
  tenant uuid;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT']) THEN RETURN NULL; END IF;
  SELECT c.tenant_id INTO tenant FROM changed c LIMIT 1;
  IF tenant IS NULL THEN RETURN NULL; END IF;
  SELECT count(DISTINCT coalesce('WRITE_SCOPE:' || g.write_scope_id::text, 'PRODUCT:' || g.product_id::text)) INTO offers
    FROM tenant_data.guardrail g
   WHERE g.tenant_id = tenant AND g.scope_type IN ('WRITE_SCOPE', 'PRODUCT') AND g.created_at = now()
     AND tenant_data.row_in_current_transaction(g.xmin);
  IF offers > 1 THEN
    RAISE EXCEPTION 'minimum margins of % offers changed in one transaction without a second factor: a mass edit requires it (Р-135)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zh_guardrail_mass_edit_requires_mfa AFTER INSERT ON tenant_data.guardrail
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.guardrail_mass_edit_requires_mfa();

RESET ROLE;

-- Страж и аудит административной записи [Р-97, Р-100]: строку журнала пишет административная роль именем человека, создавшего задание
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.import_run
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.import_run
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Р-100: журнал пишет любой участник, создавший задание импорта; право на сам импорт проверено при создании задания
DO $do$
DECLARE
  d text := pg_get_functiondef('security.admin_write_action(text)'::regprocedure);
  a text := $s$('tenant_data.bulk_job', 'VIEW_PRICING'),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0193: security.admin_write_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 99 [Р-224]: журнал импортов — пишет задание импорта именем человека, который его создал
    ('tenant_data.import_run', 'VIEW_PRICING'),$s$);
END $do$;

-- Закрытие тенанта уносит журнал импортов РАНЬШЕ заданий, на которые он ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.bulk_job_artifact', 'tenant_data.bulk_job',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0193: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.import_run', 'tenant_data.bulk_job_artifact', 'tenant_data.bulk_job',$s$);
END $do$;

COMMIT;

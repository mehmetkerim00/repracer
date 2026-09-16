-- Помощники смоук-тестов (шаг 19): подключаются заново после \c — временные функции живут в сессии. Данные синтетические.
CREATE FUNCTION pg_temp.expect_fail(label text, q text, reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
-- Р-94: reason — ожидаемая причина отказа (SQLSTATE или шаблон сообщения); отказ по другой причине — провал проверки.
-- Р-95: при repracer.smoke_collect = on (мутационная проверка) провал не останавливает прогон, а пишется предупреждением CHECK FAILED.
DECLARE
  failure text;
BEGIN
  BEGIN
    EXECUTE q;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'did not happen' USING ERRCODE = 'RS001';
  EXCEPTION
    WHEN SQLSTATE 'RS001' THEN
      failure := 'EXPECTED FAILURE DID NOT HAPPEN';
    WHEN others THEN
      -- Р-94 (шаг 18): причина обязательна и сверяется с текстом отказа — SQLSTATE недостаточно (42501 дают и защитные триггеры)
      IF reason IS NOT NULL AND SQLERRM ~* reason THEN
        RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
        RETURN;
      END IF;
      failure := CASE WHEN reason IS NULL THEN format('EXPECTED FAILURE HAS NO DECLARED REASON (got %s %s)', SQLSTATE, left(SQLERRM, 160))
                      ELSE format('EXPECTED FAILURE HAD ANOTHER REASON (expected %s, got %s %s)', reason, SQLSTATE, left(SQLERRM, 160)) END;
  END;
  IF current_setting('repracer.smoke_collect', true) = 'on' THEN
    RAISE WARNING 'CHECK FAILED: % | %', label, failure;
  ELSE
    RAISE EXCEPTION '%: %', failure, label;
  END IF;
END $$;

CREATE FUNCTION pg_temp.ok(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'PASS accept | %', label;
END $$;


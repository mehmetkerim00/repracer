-- 0094_scheduler_live_mode.sql
-- Шаг 26, A и D [Р-128, риск 31]: планировщик после проверки в живом режиме.
-- 1. registered_at — момент регистрации работы по часам планировщика: отставание новой работы не считается от слота, который был до её
--    появления (суточная выгрузка, зарегистрированная днём, сообщала отставание 17 часов в первом такте).
-- 2. lag_level — уровень отставания, о котором уже сообщено. Хранился в памяти процесса: перезапуск и второй процесс повторяли алерт.
--    Смена уровня — сравнением со старым значением в одном UPDATE.

BEGIN;

SET ROLE repracer_owner;

-- По умолчанию — часы базы; планировщик передаёт свой момент регистрации
ALTER TABLE maintenance.scheduled_job ADD COLUMN registered_at timestamptz NOT NULL DEFAULT now();
UPDATE maintenance.scheduled_job SET registered_at = created_at;
ALTER TABLE maintenance.scheduled_job ADD COLUMN lag_level text NOT NULL DEFAULT 'OK'
  CONSTRAINT scheduled_job_lag_level_known CHECK (lag_level IN ('OK', 'WARNING', 'CRITICAL'));

RESET ROLE;

COMMIT;

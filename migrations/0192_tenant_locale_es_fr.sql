-- 0192_tenant_locale_es_fr.sql
-- Шаг 98 [Р-223] (решение владельца): у консоли и писем рабочего пространства два новых языка — испанский и французский. Язык тенанта
-- [Р-161] — из списка словаря консоли (`LOCALES`, packages/console-model/src/i18n): письмо на языке, которого у словаря нет, ушло бы кодами.
-- Немецкий остаётся в списке — его прячет профиль рынка развёртывания [Р-214], а не данные.

BEGIN;
SET ROLE repracer_owner;
ALTER TABLE tenant_data.tenant DROP CONSTRAINT tenant_locale_known;
ALTER TABLE tenant_data.tenant ADD CONSTRAINT tenant_locale_known CHECK (locale IN ('de', 'en', 'es', 'fr'));
RESET ROLE;
COMMIT;

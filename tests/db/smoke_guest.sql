-- Р-160 (шаг 37): гость публичного демо заводится ЕДИНСТВЕННЫМ путём — `security.create_demo_guest`, и только ролью
-- онбординга (svc_onboarding, член repracer_onboarding). Выполнять после smoke_provision.sql. Данные синтетические.
\set ON_ERROR_STOP 1

\i tests/db/smoke_helpers.sql

BEGIN;

-- Разрешённое: гость демо-тенанта. Издатель гостя — https-адрес: этого требует проверка значения у привязки входа (0048)
SELECT pg_temp.ok('a guest of the demo tenant is created without an invitation (Р-160)', $q$
  SELECT security.create_demo_guest('d0000000-0000-0000-0000-00000000000d', 'https://guest.repracer.invalid',
                                    'guest-smoke-0001', 'guest-smoke-0001@demo.invalid') $q$);

-- Запрещённое: гость НЕ демо-тенанта. Один вызов с чужим идентификатором открыл бы каталог настоящего продавца всякому,
-- кто нажал «посмотреть демо», — и это единственное, что стоит между публичной кнопкой и данными клиента
SELECT pg_temp.expect_fail('a guest of a tenant that is not a demo (Р-160)', $q$
  SELECT security.create_demo_guest('b0000000-0000-0000-0000-00000000000b', 'https://guest.repracer.invalid',
                                    'guest-smoke-0002', 'guest-smoke-0002@demo.invalid') $q$,
  'a guest membership exists only in a demo tenant');

-- Находка 4 ревью шага 37: издатель закреплён В БАЗЕ. Иначе один вызов заводил бы привязку к НАСТОЯЩЕМУ поставщику
-- мимо приглашения — и занимал бы пару (издатель, subject) настоящего человека, которого ещё не пригласили
SELECT pg_temp.expect_fail('a guest linked to the identity provider of the sellers (Р-160, Р-98)', $q$
  SELECT security.create_demo_guest('d0000000-0000-0000-0000-00000000000d', 'https://accounts.zitadel.example',
                                    'ceo-subject-42', 'guest-smoke-0003@demo.invalid') $q$,
  'a demo guest is linked to the guest issuer only');

COMMIT;

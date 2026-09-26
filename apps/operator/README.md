# Панель оператора платформы [Р-165…Р-168]

Отдельный **непубличный** процесс: семь экранов чтения и ровно четыре действия. Это не вкладка консоли продавца —
консоль публична (в ней живёт гостевой вход в демо [Р-160]), а панель наружу не выставляется вовсе.

## Запуск

```
REPRACER_OPERATOR_PG_URL_FILE=/run/secrets/operator_pg_url \
REPRACER_OPERATOR_OIDC_ISSUER=https://… REPRACER_OPERATOR_OIDC_AUDIENCE=repracer-operator \
REPRACER_OPERATOR_OIDC_JWKS_URL=https://…/keys \
REPRACER_OPERATOR_INVITATION_URL=https://app.example.com/invitation \
REPRACER_OPERATOR_HEARTBEAT=off \
npm start -w apps/operator
```

Развёртывание — [deploy/operator](../../deploy/operator/); в промышленном профиле панель берётся оттуда через `extends`
и слушает только `127.0.0.1` (доступ — SSH-туннелем, OQ-227).

## Что панель умеет

Чтение (`GET /api/operator/…`): `tenants`, `jobs`, `alerts`, `write-queue`, `notifications`, `snapshot-skips`, `actions`.
Действия (`POST`): создать тенанта, пригласить владельца, разобрать пропуск снимка, отметить алерт увиденным.

## Чего панель не умеет — и почему это не список маршрутов

У её роли подключения `repracer_operator` нет прав ни на одну таблицу: только EXECUTE на функции панели (0126).
Себестоимость, границы, решения о цене и остановки чужих тенантов недоступны ей физически — смоук
[tests/db/smoke_operator.sql](../../tests/db/smoke_operator.sql) получает `permission denied for table …`, а каталог
мутаций возвращает каждое право по одному и требует падения именно этой строки смоука.

Второй фактор обязателен для каждого действия, и проверяет его БАЗА (`security.operator_acting`): панель лишь объявляет
утверждение `amr` токена и не переписывает причину отказа [Р-94].

## Тесты

- `test/operator-config.test.ts` — при чём процесс отказывается стартовать (нет входа, ключ стенда в работе, половина
  почты, не-https ссылка приглашения, отметка внешнего контроля).
- `test/operator-live.pg.test.ts` — живой прогон через HTTP как браузер [Р-136, Р-142] на демо-мире: семь экранов,
  путь «завести пилота» целиком, четыре действия, отказы. Числа — [docs/evidence/step40-operator-panel.md](../../docs/evidence/step40-operator-panel.md).

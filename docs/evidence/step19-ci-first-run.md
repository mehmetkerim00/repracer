# Первый прогон CI (шаг 19)

Прогон [35108100917](https://github.com/mehmetkerim00/repracer/actions/runs/35108100917), ветка `ci-step19`, коммит `3fbbe5a`
(шаг 19 `7a63ace` + файл CI). Среда: GitHub Actions `ubuntu-24.04`, PostgreSQL 16 (сервис), Redpanda `v26.2.2` (docker).
Файл CI отправлен обычным `git push`: у git есть право `workflow`, хотя `gh auth status` показывает только `gist`, `read:org`,
`repo`. Шаги 16–18 считали отправку невозможной по правам `gh` и ни разу не проверили это на `git push`.

| Шаг | Итог |
|---|---|
| Полнота сборки [Р-89] | зелёный |
| Миграции, шаблон, смоук-тесты схемы | зелёный |
| Мутационная проверка [Р-95] | зелёный: 146 мутаций, 0 непойманных, контроль — 173 проверки — раннером до исправления находки 1 ревью шага 19: для проверок тестов это число не доказательство ([step19-review.md](step19-review.md)) |
| typecheck | зелёный |
| Все тесты без пропусков | **красный: 267 из 269**, 38 из 38 файлов запущено |

## Что красное

Оба упавших теста — `services/pricing-worker/test/order-behind-broker.test.ts`, первый в истории проекта запуск на настоящем
брокере (OQ-114: локально Docker образы не скачивает):

1. «Р-24, Р-64: three pricing path instances behind the broker, one killed mid-run — order within every write scope holds» —
   `the rebalance did not spread partitions over several instances`. Итог прогона:
   `{"consumedFirstOutOfOrder":0,…,"workersThatConsumed":0,"adapterCalls":0,"decisionsApproved":0}` — ни один экземпляр не
   получил ни одного сообщения; в логе 60 ошибок клиента `unknown partition` / `unknown topic or partition`.
2. «control — publishing without the partition key, the same checker finds reordering» — `without the key reordering is expected;
   a checker that sees none proves nothing`: контроль тоже ничего не обработал.

Нули в счётчиках нарушений порядка — не доказательство порядка: обработано ноль сообщений. Утверждение «порядок внутри единицы
записи за брокером держится» (Р-24, шаг 10) по-прежнему не проверено ни разу. Проверки-стражи теста (`workersThatConsumed >= 3`,
контроль с ненулевым переупорядочиванием) сработали как задуманы — пустой прогон не прошёл зелёным. Вероятная причина — темы не
созданы (автосоздание тем брокера или создание тем в тесте) — (проверить) при разборе, не исправлялось.

Полный вывод шага тестов — [step19-ci-first-run-tests.log](step19-ci-first-run-tests.log).

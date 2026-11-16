# Шаг 143: источник снимка в квитанции — что прочитано и как пришло (аудит UX, корзина 1.1)

Внешний аудит по снимкам QA-A: «Why this price» пишет «Amazon, notification of a competitor price change», а Channels того же аккаунта —
«polling only». Решение владельца: проверить, откуда текст; если квитанция называет уведомлением то, что пришло опросом или от
симулятора, — это ложь в квитанции, чинить словарём источников «notification / polling / simulator».

## Что было

- Слова источника в словаре несли способ доставки внутри: «Amazon, notification of a competitor price change», «Kaufland, Buy Box request».
- Демо США (`apps/console/server/demo-us.ts`) берёт снимки модели порта amazon.com (`port.drainSnapshots()`) и подаёт их прямо в путь
  решения. Приёмника уведомлений нет, очереди нет. Источник снимка — код `AMAZON_ANY_OFFER_CHANGED`, и квитанция называла его
  уведомлением Amazon. Channels при этом честно писал «polling only».
- У настоящего продавца слова верны: снимок `AMAZON_ANY_OFFER_CHANGED` приходит только приёмником уведомлений, а основной источник
  пилота — опрос сводки (`AMAZON_COMPETITIVE_SUMMARY`, Р-240). Ложь была только в демо.

## Что сделано

- **Слова источника — ЧТО прочитано** («Amazon, competitor price change», «Kaufland, Buy Box»). **Способ — отдельными словами**
  `sourceDelivery`: «notification from the channel», «polling (our request to the channel)», «report from the channel»,
  «simulator (demo data, not read from the channel)». EN/DE/ES/FR.
- **Способ у настоящего продавца** — `kind` источника в описании канала (PUSH → уведомление, PULL → опрос, REPORT → отчёт).
  Страница консоли описаний каналов не импортирует, поэтому таблица `SOURCE_KIND` лежит в `packages/console-model/src/snapshot-source.ts`.
  Равенство таблицы с описаниями всех четырёх каналов держит тест шага 143. Источник вне таблицы называется без способа: способ не
  придумывается.
- **Демо — симулятор у любого источника.** Признак — тенант демо из базы (`tenant.demo`, Р-151): данные демо синтетические целиком.
- **Одна функция** `snapshotSourceText` у квитанции и у строки «Seen … · источник» на странице Competition. Сервер больше не передаёт
  туда свои слова.
- Сценарий показа и чеклист дня показа называют новую строку и что сказать честно.

## Красное сначала

`tests/contract/src/console.test.ts`, «step 143». На коде до шага красный:

```
expected: 'Amazon, competitor price change · simulator (demo data, not read from the channel)'
actual:   'Amazon, notification of a competitor price change'
```

## Зелёное

- **шаг 143** — 1 из 1:
  - демо — симулятор;
  - уведомление, опрос и отчёт у настоящего продавца;
  - способ = `kind` описания у каждого объявленного источника на четырёх языках;
  - контроль неизвестного источника — без придуманного способа.
- **шаг 93** — 1 из 1: слова источника стоят первыми, кода на экране нет.
- **через консоль как браузер** (`apps/console/test/demo-us-live.pg.test.ts`, «шаг 68» на PostgreSQL):
  - квитанция amazon.com демо — «Amazon, competitor price change · simulator (demo data, not read from the channel)»;
  - Competition того же предложения — та же строка.
- **соседи:**
  - контрактные тесты консоли — 16 из 16;
  - консоль без базы — 58 из 58;
  - модель и словари — 97 из 97 (в списке совпадений ES/FR с английским добавлены «Kaufland, Buy Box» и «Walmart, Buy Box»);
- **типы** — 0 ошибок.

Миграций нет, новых защит базы нет.

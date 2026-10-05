# Шаг 70: мутации проверок сверки ответа и сопутствующих правок

Своя проверка без базы (у шага нет новых защит БД — каталог мутаций схемы не расширяется [Р-108]): каждая проверка снимается по одной в
исходнике, прогоняются тесты адаптера Amazon, транспорта SP-API, контрактный стенд Amazon, тест модели SP-API, переходы диспетчера,
обход обнаружения ядра; исходник возвращается. Мутация поймана, если упал тест, написанный для этой проверки. Прогон — после правок по
ревью шага 70.

**17 из 17 поймано.** Первый прогон этого набора дал 2 непойманные из 18, обе разобраны:

- запасной ход `productTypeOf` к первой сводке — тест не проверял случай, когда сводки своей витрины нет вовсе: добавлен (PATCH с типом
  чужой витрины не уходит, отказ `NOT_FOUND`);
- `continue` при несовпадении сводок FBA — дубль: `fbaQuantitiesOf` при несовпадении и так не отдаёт ни одного количества. Удалён [Р-104].

| № | Проверка | Файл | Итог — упавший тест |
|---|---|---|---|
| 1 | обратное чтение: SKU не тот — отказ | `packages/amazon-adapter/src/readback.ts` | поймана — «step 70» |
| 2 | чтение перед записью: SKU не тот — PATCH не уходит | `packages/amazon-adapter/src/dispatch.ts` | поймана — «step 70» |
| 3 | ответ на запись о чужом SKU — исход неизвестен | `packages/amazon-adapter/src/dispatch.ts` | поймана — «step 70» |
| 4 | ответ на запись о чужом SKU — алерт адаптера | `packages/amazon-adapter/src/dispatch.ts` | поймана — «step 70» |
| 5 | помощник: сверка SKU | `packages/amazon-adapter/src/mapping.ts` | поймана — «step 70» |
| 6 | тип товара: нет запасного хода к чужой сводке | `packages/amazon-adapter/src/mapping.ts` | поймана — «step 70» |
| 7 | обнаружение: предмет без sku пропускается | `packages/amazon-adapter/src/listing.ts` | поймана — «step 70» |
| 8 | обнаружение: сводка чужой витрины пропускается | `packages/amazon-adapter/src/listing.ts` | поймана — «step 70» |
| 9 | FBA: granularityId чужой витрины | `packages/amazon-adapter/src/listing.ts` | поймана — «step 70» |
| 10 | FBA: сводка о чужом SKU | `packages/amazon-adapter/src/listing.ts` | поймана — «step 70» |
| 11 | FBA: сводка без sellerSku — пропуск поштучно | `packages/amazon-adapter/src/listing.ts` | поймана — «step 70» |
| 12 | клиент: details в ошибке | `packages/amazon-client/src/transport.ts` | поймана — «step 70: a 403 Unauthorized drops the cached token, takes a new one and repeats the reques» |
| 13 | адаптер: details в тексте ошибки | `packages/amazon-adapter/src/errors.ts` | поймана — «step 70» |
| 14 | модель: витрина чужого региона — 403 | `tests/contract/src/simulator/amazon-channel.ts` | поймана — «step 70: the model refuses a storefront of another region like the sandbox does» |
| 15 | диспетчер: сверка RESPONSE_MISMATCH блокирует сразу | `packages/write-dispatcher/src/transitions.ts` | поймана — «step 70: a reconciliation that got a response about another SKU blocks the scope at once w» |
| 16 | ядро: причина сброса круга обнаружения | `packages/pricing-pipeline/src/pipeline.ts` | поймана — «step 56» |
| 17 | действие продавца при RESPONSE_MISMATCH | `packages/pricing-model/src/reasons.ts` | поймана — «step 70: a reconciliation that got a response about another SKU blocks the scope at once w» |

Мутации строки каталога шага 69 после переименования ограничения «тень подряд» (`day_boundary_acceptance_no_long_gap`) — своим прогоном
`scripts/db/mutation-check.mjs --only 'шаг 69 (Р-204, K4)'`: **17 из 17**, в том числе новое ограничение.

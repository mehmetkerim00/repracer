# Шаг 39: eBay — прогон против настоящей песочницы [Р-162…Р-164]

Все факты этого документа — **[песочница]** (Р-162): получены вызовами `api.sandbox.ebay.com` 27.09.2026 от имени тестового
продавца песочницы (тип аккаунта `INDIVIDUAL`, регистрация на EBAY_DE). Лимиты, тайминги и поведение Best Offer в песочнице
не считаются доказанными для боевого канала. Ключи приложения, токены и пароль тестового продавца лежат в файле секретов
вне репозитория и здесь не приводятся. Идентификаторы листингов и предложений — объекты песочницы, не данные продавцов.

## Вход (OAuth шага 43 на настоящей песочнице)

| Что | Ответ песочницы | Модель шага 43 |
|---|---|---|
| Ссылка согласия `auth.sandbox.ebay.com/oauth2/authorize` собрана `ebayOAuth(...).consentUrl` | вход тестового продавца, «Agree», возврат на адрес RuName с `state`, `code`, `expires_in=299` | совпало |
| Обмен кода `POST /identity/v1/oauth2/token` (Basic, `grant_type=authorization_code`, `redirect_uri=<RuName>`) | 200: `access_token`, `expires_in=7200`, `refresh_token`, `refresh_token_expires_in=47304000` (≈ 18 мес), `token_type` | совпало; **E-10 закрыт**: срок refresh-токена приходит полем `refresh_token_expires_in` |
| Ответ на обмен **не несёт scope** | полей `scope` нет | модель не полагалась на scope |
| Продавец в ответе токена | не назван | **E-11**: `GET https://apiz.sandbox.ebay.com/commerce/identity/v1/user/` (scope `commerce.identity.readonly`) → `userId`, `username`, `accountType`, `registrationMarketplaceId`; на `api.sandbox.ebay.com` этот путь — 404 |
| Обновление `grant_type=refresh_token` + scope | 200: `access_token`, `expires_in`, `token_type` (нового refresh-токена нет) | совпало |
| Неверный refresh-токен | 400 `{"error":"invalid_grant","error_description":"the provided authorization refresh token is invalid or was issued to another client"}` | **E-09**: `invalid_grant`, как у Amazon — модель верна |
| Trading API токеном OAuth (`X-EBAY-API-IAF-TOKEN`) | `GetUser` — `Success` | — |

Scope согласия, при которых работает всё ниже (**E-08**): `api_scope`, `sell.inventory`, `sell.account`,
`commerce.identity.readonly`.

## Лимиты

- `GET /developer/analytics/v1_beta/user_rate_limit/` — заглушка: `apiContext: "api context test"`, по 100 вызовов на
  окно 15 с для GET/PUT/POST/DELETE. `rate_limit/` приложения не называет Inventory API вовсе (только `listingapi` и
  `logistics`). **Лимиты песочницы ничего не доказывают** — Р-162 подтверждён на деле.
- Задержка записи: `bulk_update_price_quantity` одной цены — 4–9 с на вызов (тайминг песочницы, для боя не доказан).

## Запись цены и остатка

| Что отправлено | Ответ | Обратное чтение |
|---|---|---|
| `bulk_update_price_quantity`, цена и количество одного предложения | 200, `responses[].statusCode=200` | `GET offer`: цена и `availableQuantity` новые |
| цена `11.999` (три знака) | **200** | **`12.0`** — округлено ВВЕРХ молча |
| цена в **USD** у предложения EBAY_DE | **200** | **`{"value":"10.49","currency":"USD"}`** — валюта принята и сохранена |
| цена `0.00` | 400, в `responses[]`: `errorId 25016`, «below the minimum price of EUR 1.00», `parameters: MinValue=EUR 1.00, ItemID, SKU` | — |
| цена `-1.00` или `abc` | 400 **на весь запрос** (без `responses[]`): `errorId 25709` «Invalid value for Offers.price.value.» | — |
| чужое/несуществующее предложение `offerId` | 400, в `responses[]`: `errorId 25604` «Offer not found» | — |
| несуществующий SKU | 400, в `responses[]`: `errorId 25604` «SKU not found» | — |
| один верный и один чужой `offerId` в одном вызове | **207**: у верного 200, у чужого 400 `25604` | верный применён |
| 26 запросов в одном вызове | 400 на весь запрос: `errorId 25712` «Invalid request size. The maximum size allowed is 25.» | — |
| количество **0** | **400** `errorId 25004` «quantity must be a valid number greater than 0» | **применено**: `availableQuantity=0`, листинг `OUT_OF_STOCK` (**E-06**: не завершается) |
| количество снова 5 | 200 | `availableQuantity=5`, листинг **остался `OUT_OF_STOCK`** |
| соединение закрыто каналом посреди запроса | `SocketError: other side closed` | повтор прошёл |

Уровни количества: `inventory_item.availability.shipToLocationAvailability.quantity` — количество товара;
`offer.availableQuantity` — количество листинга. Запись `offers[].availableQuantity` меняет листинг, а количество товара
остаётся прежним (**E-03**: уровень записи — предложение).

## Обратное чтение

- `GET /sell/inventory/v1/offer/{offerId}` возвращает НАШУ запись о предложении, а не живой листинг: после правки листинга
  через Trading API (см. миграцию) предложение продолжало показывать старую цену.
- `GET /buy/browse/v1/item/v1|{listingId}|0` (Browse API, заголовок `X-EBAY-C-MARKETPLACE-ID`) показывает живую цену
  листинга, `estimatedAvailableQuantity` и счётчик **`sellerItemRevision`** — число правок листинга.

## Миграция (Р-164: ровно один цикл, один листинг)

Созданы через Trading API два «старых» листинга: фиксированная цена с SKU, бизнес-политиками и Best Offer, и аукцион.

| Проверка | Что показал `GetItem` |
|---|---|
| формат | `FixedPriceItem` / `Chinese` (аукцион → `INELIGIBLE`) |
| SKU | задан у обоих |
| Best Offer | `BestOfferEnabled=true` у фиксированной цены |
| бизнес-политики | `ShippingProfileID` задан |
| благотворительность, требования к покупателям, вариации | нет |
| шаблон оформления | `LayoutID=7710000`, `ThemeID=7710` — **у всех листингов по умолчанию**: по наличию `ThemeID` шаблон не отличить |
| out-of-stock control (`GetUserPreferences`) | `false` |

До миграции Inventory API листинга не видит: `GET offer?sku=` → 404 `25713` «This Offer is not available.»;
запись по SKU → 400 `25604` «SKU not found».

`POST /sell/inventory/v1/bulk_migrate_listing` с одним `listingId` → 200:
`responses[].statusCode=200, listingId, marketplaceId=EBAY_DE, inventoryItems[{sku, offerId}]`.

После миграции:
- предложение и товар появились в Inventory API; `merchantLocationKey` создан автоматически (`DE_10115`);
- **Best Offer сохранился** (`bestOfferTerms.bestOfferEnabled=true` у предложения, `BestOfferEnabled=true` в `GetItem`) —
  вопреки документации, которую пересказывает Р-2; по Р-162 это не доказывает поведения боевого канала;
- **идентификаторы бизнес-политик в `listingPolicies` предложения не вернулись**;
- **Trading `ReviseFixedPriceItem` после миграции — `Success`**, и живая цена листинга изменилась (13.99), а
  `GET offer` продолжал показывать 14.99 — расхождение «предложение ↔ листинг»;
- запись через Inventory API после этого применилась к листингу (13.49 в `GetItem` и Browse).

## Бюджет 250 правок в день

260 правок цены одного листинга подряд (`bulk_update_price_quantity`, 4–10 с каждая) — **все 200**: песочница лимит не
воспроизводит. Счётчик `sellerItemRevision` листинга после всех записей — 266 при 267 успешных ответах по элементу и двух
отказах по элементу (`25016`, `25004`): отказы ревизию не увеличили. Сколько из них списывает бюджет в бою, песочница не
показывает — Р-163: каждая попытка, граница суток — худшая.

## Цена покупателя в Browse — НДС сверху (E-17)

Через ~25 минут после первых записей Browse стал показывать цену покупателя = отправленная × 1,19 (11.31 → 13.46,
13.49 → 16.05) без новой ревизии листинга, с `taxes: [{taxType: VAT, taxPercentage: 19.0, includedInPrice: true,
ebayCollectAndRemitTax: true}]`. Тестовый продавец — частное лицо (`INDIVIDUAL`). По Р-116 расхождение ровно на ставку
НДС — «неверная база цены»: витрина под недоверием до решения человека. Адаптер отдаёт в обратное чтение цену покупателя из
Browse — проверка Р-116 получит её, когда путь решения eBay будет подключён (сценарии пути решения eBay на этом шаге не
сделаны: хранилище в памяти не знает канал EBAY). Одинаково ли у бизнес-продавца в бою — E-17.

## Ячейки eBay в channel-capabilities.md (26: разделы 1 и 2)

| Пометка | Ячеек | Какие |
|---|---|---|
| [док] | 0 | снимка спецификации нет (E-01) |
| [песочница] | 12 | PRICE: операция, единица записи, пакет, подтверждение; QUANTITY: операция, единица записи, пакет, подтверждение, обратимость; условная запись, предусловие записи, аутентификация |
| (проверить) для боя | 10 | лимит запросов PRICE и QUANTITY, лимит правок PRICE и QUANTITY, вебхуки PRICE и QUANTITY, «канал сам уменьшает остаток», единица лимитирования, цена в DE (брутто/нетто), источник конкурентов |
| решения и требования проекта | 4 | «обратимо» PRICE, p95 PRICE и QUANTITY [Р-8], класс данных наблюдений |

## Что подтвердит только боевой канал

- лимиты вызовов приложения и пользователя, Growth Check (E-04, OQ-35);
- бюджет 250/день: единица, граница суток EBAY_DE и EBAY_US, учёт неудачных попыток и миграции (E-02, OQ-47, OQ-112);
- база цены EBAY_DE для бизнес-продавца — брутто или НДС сверху (E-17, Р-58, Р-116);
- потеря Best Offer и работа правок Trading API после миграции (E-15, E-16);
- валюта и округление в `bulk_update_price_quantity` (E-12);
- поведение `quantity = 0` и выход из `OUT_OF_STOCK` (E-06);
- хост Commerce Identity API в бою (E-11);
- отзыв авторизации продавцом (E-09);
- Marketplace Account Deletion (E-18, OQ-30).

# Шаг 70: первая живая сессия песочницы Amazon SP-API

2026-10-05. Приложение repracer в Solution Provider Portal, тип Sandbox, регион NA. Учётные данные — Client ID, Client Secret и
refresh-токен со страницы **Sandbox Testing** (кнопка **Create Token**) — лежат в файле секретов вне репозитория. В репозитории их
нет, в журнал обменов они не попали: прогон вычищал их из записи и падал бы, найдя хоть один. Данные запросов синтетические: SKU
`SYN-SKU-70`, продавец `A1SYNSELLER0001`.

- Документация песочницы — снимок [vendor/amazon/sandbox/2026-10-05/SOURCE.md](../../vendor/amazon/sandbox/2026-10-05/SOURCE.md).
- Все 20 обменов с заголовками и телами ответов — [step70-amazon-sandbox-exchanges.json](step70-amazon-sandbox-exchanges.json).

Одноразовый прогон: голый клиент `createSpApiClient` и НАСТОЯЩИЙ адаптер `createAmazonAdapter`, у которого адрес региона NA заменён
адресом песочницы. Так проверяются наши заголовки и формы запросов, а не написанные руками.

## Что песочница проверяет, а что нет

Песочница SP-API статическая: на запрос, совпавший с образцом из модели операции (`x-amzn-api-sandbox.static`), она отдаёт ответ
этого образца. Данных в ней нет. FBA Inventory — динамическая: ответ зависит от запроса, состояние создают операции только для
песочницы.

| Проверяет | Не проверяет |
|---|---|
| Настоящий обмен LWA: `api.amazon.com` — боевой сервер токенов, у песочницы только приложение. Коды и статусы его отказов | Данные: листинги, цены, заказы, конкурентов. Образец один и тот же для любого SKU |
| Аутентификацию SP-API: без токена и с недействительным токеном — 403 | Наши формы запросов `searchListingsItems`, `searchOrders`, `getCompetitiveSummary`: совпасть могут только параметры образца, наши — нет (400 «Could not match input arguments») |
| Маршрут: операция существует, путь верен | Тело записи: `patchListingsItem` принимает любое тело, отвечает образцом ACCEPTED и ничего не применяет. «Принято ≠ применено» [AMZ_C05] здесь не проверить |
| Соответствие витрины региону адреса (403) | Боевые лимиты: заголовок `x-amzn-RateLimit-Limit` — 5.0 у любой операции. Это лимит песочницы (5 в секунду, burst 15), а не Usage Plan операции |
| Заголовки ответа: `x-amzn-RequestId`, `x-amzn-RateLimit-Limit`, `x-amzn-ErrorType` у отказов | Уведомления `ANY_OFFER_CHANGED` и `PRICING_HEALTH` из SQS |
| Форму тела ошибки: `{"errors":[{"code","message","details"}]}` | Отзыв авторизации продавцом (A-17): токен выдан страницей Sandbox Testing, продавца и согласия нет |
| Динамический FBA Inventory: можно наполнить операциями только для песочницы (`createInventoryItem`, `addInventory`) — в этом прогоне не делалось | Кто продавец по токену (A-19): `getMarketplaceParticipations` отдаёт образец без идентификатора продавца |

Строгость заголовков песочница не показывает. Запросы без `x-amz-date` прошли. Без нашего `user-agent` тоже, но `fetch` в этом
случае подставляет свой заголовок, так что проверка без заголовка вовсе не получилась. Стенд строже: требует оба заголовка по
документации.

## Вызовы и ответы

| № | Вызов | Ответ песочницы | Что сделал наш код |
|---|---|---|---|
| 1 | LWA `grant_type=refresh_token` | 200: `access_token` формы `Atza|…` (353 знака), `refresh_token`, `token_type: bearer`, `expires_in: 3600`. `refresh_token` — ТОТ ЖЕ, что отправлен: проверено двумя обменами подряд, прежний работает и после них. Каждый обмен даёт новый токен доступа | Клиент кэширует токен, refresh-токен из ответа обновления не берёт — верно |
| 2 | `getMarketplaceParticipations` (адрес NA) | 200, тело равно образцу модели (`vendor/amazon/sp-api-models/2026-09-29`, sellers.json): amazon.com, `storeName: BestSellerStore` | — (продукт этот вызов не делает) |
| 3 | Без `x-amz-access-token` | 403 `Unauthorized`, details «Access token is missing in the request header.», `x-amzn-ErrorType: AccessDeniedException` | — |
| 4 | Токен `syn-not-a-token` | 403 `Unauthorized`, details «The access token you provided is revoked, malformed or invalid.» | Клиент: новый обмен и один повтор — теперь закреплено тестом транспорта на этих телах |
| 5 | Токен NA на адресе песочницы EU | 200, тот же образец | — (A-27) |
| 6 | Неизвестный путь `/sellers/v1/syn-unknown` | 403 `Unauthorized`, `details` пустое. Не 404: модель снимка называет «Resource Not Found» среди причин 403 | — (A-26) |
| 7 | LWA, refresh-токен `Atzr|syn-…` | 400 `invalid_grant`: «The request has an invalid grant parameter : refresh_token. User may have revoked or didn't grant the permission.», плюс `error_index` и `request_id` | `invalid_grant` → `REVOKED` (Р-177) — совпадает |
| 8 | LWA, неверный секрет | 401 `invalid_client`, «Client authentication failed» | 401 / `invalid_client` → `PLATFORM` (наша поломка) — совпадает |
| 9 | Адаптер, `discoverOffers` | 400 `InvalidInput` «Could not match input arguments» | `VALIDATION` |
| 10 | Адаптер, `readBack` цены | 200 — образец о ДРУГОМ SKU (`GM-ZDPI-9B4E`), без `attributes`, хотя мы их просили | Отказ `NOT_FOUND` «no our_price»: цену из `offers[].price` за нашу не принял (fail-closed). SKU ответа с запрошенным не сверил |
| 11 | Адаптер, `readBack` SKU `BadSKU` (образец ошибки) | 400 `BAD_REQUEST` «Invalid input» | `VALIDATION`, область ITEM, код канала `BAD_REQUEST` |
| 12 | Адаптер, `dispatch` цены $12.99 | `getListingsItem` → образец (`productType: LUGGAGE`). Затем `patchListingsItem` с нашим телом (`purchasable_offer`, `our_price.schedule.value_with_tax: 12.99`, `audience: ALL`, USD) → 200 `ACCEPTED`, `submissionId` образца | `ACCEPTED`, `appliedImmediately: false`, ссылка на отправку — как в модели стенда |
| 13 | Адаптер, `readOrderLines` | 400 «Could not match input arguments» | `VALIDATION` |
| 14 | Адаптер, `readCompetitors` | 400 `InvalidInput` «Could not match input arguments» | Отказ запроса, `VALIDATION` |
| 15 | Образец `searchOrders` с `createdAfter=TEST_CASE_400` | 400 `InvalidInput` — ответ образца ошибки | — |
| 16 | Образец `searchOrders` 200 с витриной `A1VC38T7YXB528` (Япония) на адресе NA | 403 `Unauthorized` «The marketplaces you provided are not valid for region.» | — |
| 17 | `getInventorySummaries` (динамическая) | 200 `payload.granularity` и пустой `inventorySummaries`, без `pagination` | — |

Журнал адаптера — коды консервативных правил `AMZ_C07`, `AMZ_C09`, `AMZ_C10`, `AMZ_C11`. Алертов нет. Время ответа — 0,3–3,1 с, первые
вызовы медленнее.

## Расхождения стенда с песочницей

Стенд — HTTP-модель SP-API (`tests/contract/src/simulator/amazon-channel.ts`), проверки запросов стенда
(`tests/contract/src/harness/channel.ts`) и модель поставщика LWA (`packages/channel-oauth/src/model.ts`).

| № | Стенд | Песочница | Что значит | Сделано |
|---|---|---|---|---|
| 1 | Модель LWA на обмен refresh-токена Amazon не отдаёт `refresh_token` | Отдаёт тот же токен без изменений | Нашему коду всё равно: проверка авторизаций токен из ответа не берёт | Модель отдаёт тот же токен, как LWA. Прогон подключения на PostgreSQL — 6 из 6 |
| 2 | Тело `invalid_grant` модели короче | Ещё `error_index`, `request_id`, описание называет отзыв | Мы читаем только код ошибки: классификация та же | — |
| 3 | Запрос без токена или с чужим токеном — нарушение стенда (тест красный) | 403 `Unauthorized`, причина — в `details` | Стенд строже — так и нужно. Путь клиента «403 → новый токен → один повтор» модель не вызывает никогда, тестов у него не было | Тест транспорта на настоящих телах песочницы; снятие повтора он ловит (проверено мутацией) |
| 4 | Неизвестная операция — нарушение стенда | 403 `Unauthorized`, `details` пустое | Клиент сочтёт это протухшим токеном: лишний обмен и повтор, затем `FORBIDDEN` аккаунта | A-26 |
| 5 | Витрину чужого региона модель принимает | 403 «not valid for region» | Адаптер фильтрует витрины по региону аккаунта до вызова, запись берёт витрину из единицы записи | A-27; модель можно научить отказу (предложение) |
| 6 | Отвечает по состоянию мира на любую верную форму запроса | Отвечает только на параметры образца, иначе 400 «Could not match input arguments» | Форму наших запросов `searchListingsItems`, `searchOrders`, `getCompetitiveSummary` песочница не проверяет. Их держат модель и снимок | — |
| 7 | `getListingsItem` и `patchListingsItem` возвращают запрошенный SKU и наборы `includedData` | Образец о другом SKU, без `attributes` | Адаптер не сверяет SKU ответа с запрошенным. В бою ответ о своём SKU ожидаем; у статической песочницы — нет | Предложение: отказ, если SKU ответа другой |
| 8 | `x-amzn-RateLimit-Limit` — ставка Usage Plan операции, и у 429 | 5.0 у каждой операции (лимит песочницы), у 403 заголовка нет | AMZ_C10 заменяет ставку пары значением заголовка. Против песочницы бюджет `getCompetitiveSummary` стал бы 5 в секунду вместо 0,033 — артефакт песочницы. Направлять боевые бюджеты на песочницу нельзя | — |
| 9 | Стенд требует `x-amz-date` (по виртуальным часам) и `user-agent` | Принимает без `x-amz-date` | Стенд строже, по документации | — |
| 10 | Коды ошибок модели синтетические (`SYN_…`) | `Unauthorized`, `InvalidInput`, `BAD_REQUEST`. Тело `{code, message, details}` | Клиент хранит код и сообщение, `details` отбрасывает. В случае 16 причина только в `details`: текст отказа скажет «Access to requested resource is denied.» без «витрина не того региона» | Предложение: сохранять `details` в сообщении ошибки |
| 11 | FBA Inventory отдаёт SKU мира | Пусто для неизвестного SKU, `pagination` нет | Путь чтения количества FBA можно проверить живьём, наполнив динамическую песочницу операциями только для песочницы | Предложение — отдельной проверкой |

## Вопросы

- **A-17** (ответ LWA после отзыва): дополнен. На недействительный refresh-токен LWA отвечает `invalid_grant` и сам называет отзыв
  среди причин. Обмена после НАСТОЯЩЕГО отзыва не было — вопрос открыт.
- **A-26** (новый): что значит боевой 403 SP-API — роль, токен или путь, и всегда ли есть `details`.
- **A-27** (новый): привязан ли токен доступа к региону в бою.

Тексты — в [channel-capabilities.md §9](../channel-capabilities.md).

## Чего не сделано

- Адаптер и модель SP-API по расхождениям 5, 7, 10, 11 не менялись — это предложения.
- Боевой адрес SP-API ключами песочницы не вызывался.
- Песочница уведомлений (App Integrations API) не пробовалась.

# Шаг 49, B и C: решения по расхождениям снимка eBay [Р-189, Р-190, Р-191]

## Р-189 (E-22): пакет до 25 — с пробой в бою

Описание `bulkUpdatePriceQuantity` говорит «Only one SKU (one product) can be updated per call», а схема той же
спецификации и песочница — «до 25 предложений разных SKU». Пакет остаётся, но боевой аккаунт доказывает его сам.

- **Режим пакетов аккаунта eBay** (`channel_account.ebay_batch_mode`, 0142):
  - проба (NULL) — первый вызов пакета не больше 2 SKU, остальные записи — по одной;
  - `MULTI` — пакет разных SKU принят, до 25;
  - `SINGLE` — один SKU на вызов.

  Переход делает функция базы по итогу, который сообщает адаптер. Режим меняется только вперёд, и только у боевого аккаунта
  своего тенанта (тенант вызова = тенант сессии).
- **Отказ мультипакета** (EBAY_C18) — только ответ 400 на пакет из ≥2 SKU без ответов по элементам и без кодов значений
  (25709, 25604, 25016, 25002, 25712). Записи повторяются как временная ошибка, аккаунт переходит в `SINGLE`, база
  поднимает алерт `EBAY_MULTI_SKU_REFUSED` с вопросом E-22. Вернуть мультипакет может только человек.
- **«Принят»** — только если пришёл ответ по каждому предложению пакета. Иначе итог не сообщается, а числа пишутся в журнал.
- **Симулятор** [Р-187]: параметр E-22 «один SKU на вызов». Вариант сценария: проба отвергнута, аккаунт ушёл в `SINGLE`, обе
  записи дошли по одной во втором обходе диспетчера. Без варианта: принята, `MULTI` за один обход.

## Р-190 (E-21): Browse в бою недоступен — что видит продавец

Browse — Buy API, а страница лимитов говорит «Buy APIs require an additional license». В боевом окружении адаптер Browse не
вызывает. Подтверждение своей записи — только по записи предложения (`GET offer`), наблюдение помечено `ownRecordOnly`,
журнал EBAY_C19 пишется один раз на аккаунт. Цены покупателя и чужих правок листинга в бою нет, алерт
`EBAY_OFFER_LISTING_DIVERGENCE` недостижим. Признак доходит до базы (`confirmed_by_own_record`: только у применённой
записи) и до экранов.

**Экран подключений и экран тени** — у каждого аккаунта eBay (окружение модели экрана неизвестно, поэтому текст стоит у любого
аккаунта eBay — честнее):
- EN: «In live mode we do not yet see on eBay the price buyers see or edits made by other programs: our writes are confirmed
  by the offer record, and the price-basis check is limited (question E-21).»
- DE: «Den Preis, den Käufer sehen, und Änderungen anderer Programme sehen wir auf eBay im Live-Betrieb noch nicht: Unsere
  Änderungen werden über den Angebotsdatensatz bestätigt, die Prüfung der Preisbasis ist eingeschränkt (Frage E-21).»

**Лента цен, «почему эта цена» (шаг «Канал»), экран остатков** — у записи, подтверждённой по нашей записи:
- EN: «confirmed by the offer record, not by the live listing (question E-21)»
- DE: «bestätigt über den Angebotsdatensatz, nicht über das Live-Angebot (Frage E-21)»

**Канал eBay, пока приёмник Account Deletion региона не зарегистрирован** (Р-192):
- EN: «eBay account deletion notifications are not received for this region — eBay cannot be connected until our address is
  registered in the eBay developer portal»
- DE: «eBay-Benachrichtigungen über gelöschte Konten werden für diese Region nicht empfangen — eBay lässt sich erst verbinden,
  wenn unsere Adresse im eBay-Entwicklerportal registriert ist»

## Р-191: предполётная проверка миграции — требования документации

- **`C14_IMMEDIATE_PAY`** (препятствие): платёжная политика листинга (`SellerProfiles` → `SellerPaymentProfile` →
  `PaymentProfileID`) читается Account API `GET /sell/account/v1/payment_policy/{id}`. `immediatePay` false или платёжной
  политики нет — препятствие, вердикт FIXABLE. Прочитать не удалось или поле не пришло — `PREFLIGHT_INCOMPLETE` с подсказкой
  «make sure immediate payment is turned on». Документация говорит только «if … returned as true», поэтому отсутствие поля —
  незнание, а не «выключено». Scope `sell.account` теперь обязателен в конфигурации.
- **`C15_LOCATION`** (препятствие): у листинга нет ни `PostalCode`, ни `Location` верхнего уровня — так их называет
  описание `bulkMigrateListing`.
- **Ожидание бюджета.** Перепроверка перед миграцией стала дороже, и все её чтения ждут клиентский бюджет до `retryAt` в
  пределах срока вызова. Согласие на 5 листингов проходит целиком.
- **Сценарий песочницы `migration-preflight-only` стал FIXABLE** (C15) — было READY_WITH_LOSSES. В GetItem протокола
  песочницы шага 39 нет ни индекса, ни города. Ответы песочницы не дополнялись; вернуть прежний вердикт может только новая
  запись GetItem в песочнице. Сценарии с синтетическим GetItem получили `Location`, обмены с Account API помечены SYNTHETIC.
- **Р-2 уточнён:** документация 2026 и песочница показывают сохранение Best Offer. Чекер остаётся строгим — C03 и C04
  считаются потерей — до первой боевой миграции.

# Amazon — правила канала для продукта

Факты об API Amazon лежат в двух местах:
- снимок спецификации [`vendor/amazon/`](../../vendor/amazon/);
- [channel-capabilities.md](../channel-capabilities.md): ячейки AMZ_C01…C15, вопросы A-01…A-31.

Здесь — правила продукта, которые из них следуют. Каждый факт помечен источником:

| Пометка | Источник |
|---|---|
| **[док]** | страница документации SP-API с адресом и SHA-256 в `vendor/` или модель снимка |
| **[владелец]** | подтверждено владельцем по справке Seller Central. Справка закрыта входом, публичного адреса у Amazon нет; рядом — публичные подтверждения |
| **(проверить на живом аккаунте)** | ни документация, ни владелец не подтверждают |

Поведение API не выдумывается.

## Защита от ценовой ошибки (price error protection) — A-30

### Механика

1. **[владелец]** Цена вне рамок Min/Max price SKU деактивирует листинг: Amazon считает её «potential pricing error». Рамки бывают
   двух видов:
   - **заданные продавцом**;
   - **оценённые самим Amazon** — если продавец их не задал.

   Публичные подтверждения:
   - справки стороннего репрайсера: «If none are set… Amazon estimate that the price uploaded… is too high or too low», «the listings
     affected will be flagged as deactivated for potential pricing error» ([repricer.com](https://support.repricer.com/potential-pricing-errors));
   - без своих рамок Amazon «will still use their own limits in the background»
     ([repricer.com](https://support.repricer.com/how-to-set-min-max-prices-on-amazon-seller-central));
   - форумы Seller Central, например [«How to fix “Listing deactivated for potential pricing errors”?»](https://sellercentral.amazon.com/seller-forums/discussions/t/36c0a8dacbcb1434b93eb772d330e941).
2. **[владелец]** Реактивация — правкой цены или рамок в Seller Central. Стороннее подтверждение: «you'll simply need to revise the
   price on Seller Central to reactivate them» ([repricer.com](https://support.repricer.com/potential-pricing-errors)).
   **Возвращает ли Amazon листинг сам, когда следующая наша запись уже в рамках, — не подтверждено (проверить на живом аккаунте).**
3. **[док]** Класс статуса «Cancelled/Blocked listing — Blocked due to pricing rules violations… Not buyable but are still
   discoverable» существует. Источник — страница «Understanding Amazon listing status», адрес и SHA-256 — в
   [`vendor/amazon/listing-status/2026-10-21`](../../vendor/amazon/listing-status/2026-10-21/SOURCE.md).

### Где живут рамки

- **[владелец]** В Seller Central на SKU и в фиде Price & Quantity — колонки `minimum-seller-allowed-price` и
  `maximum-seller-allowed-price`. Стороннее подтверждение — «add two new columns to your file… minimum-seller-allowed-price and
  maximum-seller-allowed-price» ([repricer.com](https://support.repricer.com/how-to-set-min-max-prices-on-amazon-seller-central)).
- **[док]** В SP-API те же рамки — атрибуты `purchasable_offer`: `minimum_seller_allowed_price` и `maximum_seller_allowed_price`
  (страница manage-purchasable-offer, снимок [`2026-09-16`](../../vendor/amazon/sp-api-models/2026-09-16/SOURCE.md)). Мы их **не
  пишем никогда** [Р-111, Р-114]: это второй набор границ, наши границы — единственные.
- **С шага 107 [Р-233, Р-231]** наблюдение рамок хранит их **значения**, если канал их назвал (0205), и решает так:
  - рамки со значениями в валюте предложения предложение **не блокируют**: стратегия назначается, цена внутри рамок уходит; цена вне
    рамок не уходит — «без изменения» `CHANNEL_BOUNDS_HOLD` с обеими суммами (исключения: движение к рамкам из‑за них и распродажа ниже
    Min — тогда цена уходит, конфликт записан в квитанции `CLEARANCE_BELOW_CHANNEL_MIN`);
  - страница пола показывает блок «Channel price bounds» рядом с нашими границами, Offers — пилюлю конфликта (наш пол ниже Min, наш
    потолок выше Max);
  - рамки **без значений** или в чужой валюте — прежний блок предложения целиком (fail-closed): пилюля «Channel price bounds set» в
    «Issues from the channel» (`CHANNEL_BOUNDS`) с советом убрать их, перед записью — отказ `CHANNEL_BOUNDS_PRESENT` без PATCH
    (`packages/amazon-adapter/src/readback.ts`).
- **Настоящий адаптер значений пока не читает** — только факт «рамки есть». Значения называет модель Amazon симулятора (демо США —
  три товара); живое чтение `purchasable_offer` — с первым живым аккаунтом по плану A-30. До него у живого аккаунта любые рамки на SKU
  по-прежнему блокируют предложение, и рекомендацию «Min не выше минимума» (ниже) продавцу давать рано.
- **Оценённые Amazon рамки** документация SP-API не описывает. Видны ли они при чтении — **(проверить на живом аккаунте)**. Отсюда
  главный риск: у «чистого» предложения без рамок продавца наша цена может уйти и деактивировать листинг по рамкам, которых мы не
  видим. Увидеть это можно только по статусу и проблемам листинга (ниже).

### База сравнения: рамки Amazon — без доставки

**[владелец]** Рамки Amazon — **без доставки**. Стороннее подтверждение: «The Minimum and Maximum prices on Seller Central don't
include postage» ([repricer.com](https://support.repricer.com/potential-pricing-errors)).

У нас на той же базе: `min_price`, `max_price`, пол маржи и цена, которую мы пишем (`our_price`), — цена товара без доставки. Цель
стратегии, посчитанная по landed, переводится в цену товара вычитанием нашей доставки (движок, «compares landed prices and subtracts
own shipping»).

Правило сверки при живом чтении:
- рамки Amazon сравниваются **с нашими границами и с ценой, которую пишем**;
- landed-величины (цена Buy Box с доставкой, разрыв на Offers, цены на Competition) с рамками напрямую **не сравниваются** — только
  за вычетом нашей доставки.

### Как это видно через SP-API

Все факты раздела — **[док]**, страницы и суммы — в
[`vendor/amazon/listing-status/2026-10-21`](../../vendor/amazon/listing-status/2026-10-21/SOURCE.md).

| Что | Чем | Свойства |
|---|---|---|
| Статус листинга | `searchListingsItems` с фильтрами `withStatus` / `withoutStatus` (`BUYABLE`, `DISCOVERABLE`); «можно найти, нельзя купить» — `withoutStatus=BUYABLE` + `withStatus=DISCOVERABLE` | значения фильтров — и в модели снимка `2026-09-29`; **предел — 1000 листингов на все страницы (A-31)** |
| Точная причина | `getListingsItem` с `includedData=issues` | у `Issue` в модели — категории (среди них `INVALID_PRICE`) и действия Amazon (`LISTING_SUPPRESSED` снимает buyability) |
| Неактивные | отчёт `GET_MERCHANT_LISTINGS_INACTIVE_DATA` (ноль, заблокированные, подавленные, не открытые, истёкшие) | не в реальном времени: данные возрастом 1–6 ч |
| Подавленные | отчёт `GET_MERCHANTS_LISTINGS_FYP_REPORT` (с причинами и как снять) | то же |
| События | уведомления `LISTINGS_ITEM_STATUS_CHANGE` (смена buyability) и `LISTINGS_ITEM_ISSUES_CHANGE` (проблема создана, исправлена, изменена; серьёзность и действия Amazon) | доставка — **только Amazon EventBridge**; у `ISSUES_CHANGE` — версия `2023-12-13` («1.0» скоро уйдёт) |

Доставка через EventBridge — **не SQS**. У `ANY_OFFER_CHANGED` и `PRICING_HEALTH` способ доставки — SQS, и наш приёмник
(`packages/amazon-notifications`) принимает только их. Уведомления листингов он не получит, пока не построен путь через
EventBridge — это работа развёртывания, не адаптера.

`PRICING_HEALTH` — не про деактивацию: предложение не может быть Featured Offer из-за неконкурентной цены.

**[док]** Не у всех проблем листинга есть определённые issues: ни уведомление, ни Listings Items API не обязаны показывать всё
(«this notification does not necessarily represent all problems with a listing»). Значит, ценовая ошибка может быть видна только
снятой buyability, без проблемы с причиной. Код, категорию и действие для ценовой ошибки документация не называет **(проверить на
живом аккаунте)**.

Что уже есть в коде:
- обратное чтение после записи запрашивает `issues` и статус: `isLive` — по `BUYABLE`, иначе причина `NOT_BUYABLE`;
- обнаружение (`searchListingsItems`) статус читает, `issues` — нет;
- уведомления листингов приёмник не подписывает;
- причину «ценовая ошибка» словами никто не разбирает.

### Решения владельца (после шага 105)

1. **Уведомления листингов** — приёмник через Amazon EventBridge, работа развёртывания к боевому подключению. **До него** — суточный
   опрос отчёта `GET_MERCHANT_LISTINGS_INACTIVE_DATA` как страховка: деактивацию без нашей записи (Amazon пересчитал свои оценённые
   рамки) обратное чтение после записи не поймает. Оба пункта — в [deferred.md](../deferred.md).
2. **Р-114 уточнён:** запись цены вне рамок может быть **принята**, а листинг деактивирован; возвращает ли Amazon ошибку на саму запись —
   не подтверждено **(проверить на живом аккаунте)**. Поэтому обратное чтение статуса и `issues` после каждой записи обязательно.
   Рамки SKU по-прежнему не пишутся [Р-111, Р-114].
3. **Невидимые оценённые рамки — видимой настройкой продавца [Р-231].** Рамки Min/Max на SKU, которые не сужают наш диапазон (Min не
   выше самой низкой цены, которую мы можем отправить, Max не ниже `max_price`), репрайсинг не блокируют; более узкие — блок с
   названными значениями. При подключении боевого аккаунта продавцу рекомендуем задать рамки **«Min не выше вашего минимума, Max не ниже
   потолка»**, а не равными полу: пол маржи и безубыточность плывут с себестоимостью и курсом, а ступени лестницы [Р-208] и пол
   распродажи [Р-227] законно уходят ниже `min_price` — при рамках «равными полу» Amazon деактивировал бы листинг на наших же ценах.
   **Построено шагом 107** для рамок со значениями (страж, движок, консоль, словари, модель порта и симулятор); живое чтение значений
   настоящим адаптером — с первым живым аккаунтом (строка «Amazon (рамки SKU — живое чтение значений)» в [deferred.md](../deferred.md)).
4. **A-31:** при боевом подключении обнаружение каталога идёт через отчёт `GET_MERCHANT_LISTINGS_ALL_DATA` (возраст 1–6 ч для
   обнаружения приемлем), `searchListingsItems` — только для точечных чтений. Модели Amazon знают предел 1000 SKU на все страницы
   (шаг 106): прогон, опирающийся на поиск, честно видит неполноту. Предел — и в модели снимка (`numberOfResults`: «The maximum number
   of items (SKUs) that can be returned and paged through is 1000», сам `numberOfResults` — сколько найдено).

### Роли разработчика

**[док]** Role Mappings, сверено 2026-10-21:

| Что | Роль |
|---|---|
| `getListingsItem`, `searchListingsItems`, `patchListingsItem` | Product Listing или Inventory and Order Tracking |
| `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `GET_MERCHANTS_LISTINGS_FYP_REPORT` | Product Listing |
| `GET_MERCHANT_LISTINGS_INACTIVE_DATA` | Product Listing, Pricing или Inventory and Order Tracking |
| адресат уведомлений (`createDestination`) | роль не нужна |

В пакете анкеты разработчика четыре роли, Product Listing среди них — **покрыто, пятая роль не нужна**. Обоснования Pricing и
Product Listing в пакете переписаны под таблицу ролей (2026-10-21): запись цены идёт через Listings Items API (Product Listing), а не
через Pricing.

### Правило продукта (владелец, шаг 105) — не построено

1. **Симулятор Amazon** моделирует деактивацию так же, как Walmart — снятие с публикации неконкурентной ценой [Р-215]:
   - цена вне рамок SKU (заданных или оценённых) — листинг не buyable, `issues` с причиной;
   - на Offers — пилюля «Inactive (pricing error)» в «Issues from the channel»;
   - в журнале «Stop pricing» — событие канала с объяснением.

   Движок цену за это сам не чинит, как у Walmart: ответ — решение владельца.
2. **При живом подключении** консоль читает и показывает значения Min/Max price SKU (а не только факт, что они есть). Она
   предупреждает о конфликте с нашим полом и потолком на базе без доставки (выше). **Шаг 107:** показ и предупреждение построены
   (страница пола, пилюля Offers, окно распродажи) — на значениях, которые называет модель симулятора; живое чтение — с первым живым
   аккаунтом:
   - наш пол ниже их минимума или наш потолок выше их максимума — часть наших цен деактивирует листинг;
   - статус и проблемы листинга берутся из уведомлений `LISTINGS_ITEM_STATUS_CHANGE` / `LISTINGS_ITEM_ISSUES_CHANGE` (нужен путь
     через EventBridge), сверка — отчётом неактивных;
   - пока пути через EventBridge нет — статусом и `issues` обратного чтения после каждой нашей записи: оно их уже запрашивает.

   Писать эти поля по-прежнему нельзя [Р-114].

Не построено — строка «Amazon (price error protection)» в [deferred.md](../deferred.md).

## Страница продавца-конкурента [Р-232]

Имя продавца-конкурента в консоли — внешняя ссылка (новая вкладка) на его страницу на витрине: таблица конкурентов квитанции, страница
Competition, колонка держателя Buy Box на Offers и колонка `seller_url` выгрузки «Export competitors» (шаг 107).

- **[док]** Идентификатор продавца — `SellerId` предложения в уведомлении `ANY_OFFER_CHANGED` (схема снимка
  [`AnyOfferChangedNotification.json`](../../vendor/amazon/sp-api-models/2026-09-29/schemas/notifications/AnyOfferChangedNotification.json),
  пример «A3TH9S8BH6GOGM»); адаптер кладёт его в `sellerRef` предложения снимка (`packages/amazon-adapter/src/inbound.ts`).
- **[владелец]** Страница продавца — `https://www.amazon.<витрина>/sp?seller=<SellerId>`. Документации SP-API у этого адреса нет;
  публичные подтверждения: «One public `/sp?seller=...` … URL» с примером `https://www.amazon.com/sp?seller=A2L77EE7U53NWQ`
  ([Apify, Amazon Seller Profiles Scraper](https://apify.com/fetch_cat/amazon-seller-profiles-scraper.md)); «locate your ID within the
  same URL … next to where it says "seller="» ([Zentail](https://help.zentail.com/en/articles/3657843-how-to-find-your-amazon-seller-id-and-link-for-zentail-s-listing-checker)).
- **Правило ссылки** (`packages/console-model/src/seller-link.ts`): ссылка строится **только** из настоящего идентификатора, который
  назвал канал, и только для витрин, чей адрес записан (amazon.com, amazon.de). Нет идентификатора, он не формы SellerId (латинские
  заглавные и цифры), продавец синтетический (симулятор, демо), наша строка или неизвестный держатель — **текст**, мёртвой ссылки нет.
  Kaufland называет продавца псевдонимом, у Walmart адрес страницы продавца неизвестен, eBay конкурентов не даёт — текст.

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
- **Сейчас** у предложения с рамками продавца единица записи блокируется до человека, цена не отправляется:
  - рамки видны при обнаружении и сверке [Р-115, Р-120];
  - на Offers — пилюля «Channel price bounds set» в «Issues from the channel» (`CHANNEL_BOUNDS`) с советом убрать их в кабинете
    канала;
  - перед записью — отказ `CHANNEL_BOUNDS_PRESENT` без PATCH (`packages/amazon-adapter/src/readback.ts`).
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
   **Не построено:** сейчас любые рамки на SKU блокируют предложение (`CHANNEL_BOUNDS_PRESENT`), консоль советует их убрать; правка —
   отдельным шагом, строка «Amazon (рамки SKU продавца, Р-231)» в [deferred.md](../deferred.md).
4. **A-31:** при боевом подключении обнаружение каталога идёт через отчёт `GET_MERCHANT_LISTINGS_ALL_DATA` (возраст 1–6 ч для
   обнаружения приемлем), `searchListingsItems` — только для точечных чтений. Модель порта Amazon знает предел 1000 листингов на все
   страницы (шаг 106), чтобы прогон, опирающийся на поиск, честно показывал неполноту.

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
   предупреждает о конфликте с нашим полом и потолком на базе без доставки (выше):
   - наш пол ниже их минимума или наш потолок выше их максимума — часть наших цен деактивирует листинг;
   - статус и проблемы листинга берутся из уведомлений `LISTINGS_ITEM_STATUS_CHANGE` / `LISTINGS_ITEM_ISSUES_CHANGE` (нужен путь
     через EventBridge), сверка — отчётом неактивных;
   - пока пути через EventBridge нет — статусом и `issues` обратного чтения после каждой нашей записи: оно их уже запрашивает.

   Писать эти поля по-прежнему нельзя [Р-114].

Не построено — строка «Amazon (price error protection)» в [deferred.md](../deferred.md).

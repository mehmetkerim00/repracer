# Уведомления Amazon, часть Б — что нажать в AWS и в SP-API

Для звонка с Мерданом: живая привязка очереди к SP-API. План — полчаса, если выполнено «До звонка». Наша сторона готова — часть А,
шаг 114 ([evidence/step114-amazon-notifications.md](evidence/step114-amazon-notifications.md)): приёмник читает одну очередь с двумя
конвертами, журнал сырья, статус листинга, хаос-проверка. Факты — из снимка: [vendor/aws/SOURCE.md](../vendor/aws/SOURCE.md) (раздел
«Шаг 114») и модель `vendor/amazon/sp-api-models/2026-10-29/models/notifications-api-model/`. То, чего снимок не подтверждает, помечено
«(проверить)».

## Схема

```
SP-API ──(ANY_OFFER_CHANGED, PRICING_HEALTH: адресат SQS)────────────────────────────┐
                                                                                      ▼
SP-API ──(LISTINGS_ITEM_*: адресат EventBridge)──► источник партнёра ──► шина партнёра ──► правило ──► ОЧЕРЕДЬ SQS ──► приёмник
                                                                                      │
                                                                         очередь недоставленных (maxReceiveCount 5)
```

Одна очередь, одна очередь недоставленных, в политике очереди — два разрешения (решение владельца, шаг 114). Уведомления листингов
SP-API отдаёт только через EventBridge, ANY_OFFER_CHANGED и PRICING_HEALTH — только через SQS (notification-type-values, столбец
Workflow): поэтому у очереди два писателя.

## До звонка

- [ ] **Скоуп grantless.** `createDestination` и `getDestinations` не требуют авторизации продавца, но требуют токена LWA
  `client_credentials` со скоупом `sellingpartnerapi::notifications`. Проверка ключей 2026-11-05: LWA ответил `400 invalid_scope` — у
  приложения этого скоупа нет. **Без ответа поддержки шаги 4 и 6 не выполнить.** Это первое, что выяснить.
- [ ] **Доступ в консоль AWS** того аккаунта, который будет платить за очередь и шину; выбран регион AWS — в нём и очередь, и шина, и
  адресат EventBridge (`createDestination` получает регион и аккаунт).
- [ ] **Продавец авторизовал приложение** с ролями, которые нужны подпискам (шаг 6).
- [ ] **Файл секретов части Б** — `amazon-notifications.env` в каталоге секретов владельца вне репозитория (права 600, сейчас в нём заглушки шаблона
  `deploy/notification-receiver/part-b.env.example`). Значения вписывает владелец сам, в чат они не попадают.

## 1. Очереди SQS (консоль AWS → Amazon SQS)

1. **Очередь недоставленных:** Create queue → Standard → имя, например `tmprice-notifications-dlq`; срок хранения — 14 суток (максимум
   `MessageRetentionPeriod`).
2. **Основная очередь:** Create queue → **Standard** (FIFO SP-API не поддерживает) → имя, например `tmprice-notifications`:
   - Visibility timeout — **60 с** (на него рассчитан приёмник);
   - Message retention — **14 суток**;
   - Dead-letter queue — включить, очередь из п. 1, **Maximum receives = 5** (как `maxReceiveCount` приёмника);
   - **Шифрование.** Очередь, зашифрованную ключом AWS (AWS owned key), EventBridge целью не принимает. Варианты: без шифрования на
     стороне сервера или собственный ключ KMS с правами `kms:Decrypt` и `kms:GenerateDataKey` для `events.amazonaws.com`; нужны ли права
     на ключ принципалу SP-API — снимок не говорит (проверить). Для первой привязки предлагаю без шифрования на сервере, ключ KMS —
     отдельным шагом после того, как цепочка заработает. Решение — на звонке.
3. Записать в файл секретов: `REPRACER_AWS_REGION`, `REPRACER_AWS_ACCOUNT_ID`, `REPRACER_SQS_QUEUE_URL`, `REPRACER_SQS_QUEUE_ARN`,
   `REPRACER_SQS_DLQ_ARN`.

## 2. Политика доступа основной очереди (Queue → Access policy → Edit)

Два разрешения. Второе ссылается на ARN правила из шага 5 — его вписать, когда правило создано (до этого — только первое).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SellingPartnerApiSendsNotifications",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::437568002678:root" },
      "Action": ["sqs:SendMessage", "sqs:GetQueueAttributes"],
      "Resource": "<ARN основной очереди>"
    },
    {
      "Sid": "EventBridgeRuleSendsListingNotifications",
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "<ARN основной очереди>",
      "Condition": { "ArnEquals": { "aws:SourceArn": "<ARN правила из шага 5>" } }
    }
  ]
}
```

- Первое — аккаунт AWS SP-API `437568002678`, действия `sqs:SendMessage` и `sqs:GetQueueAttributes` (tutorial-grant-permission-to-sqs-queue).
  Вид принципала (`:root`) — по образцу страницы (проверить на звонке, что консоль приняла).
- Второе — по образцу страницы EventBridge «Amazon SQS permissions»: только наше правило, условием `aws:SourceArn`.

## 3. Ключи приёмника (IAM)

Пользователь или роль процесса приёмника с правами только на основную очередь: `sqs:ReceiveMessage`, `sqs:DeleteMessage`,
`sqs:ChangeMessageVisibility`. Ключи — в файл секретов (`REPRACER_AWS_ACCESS_KEY_ID`, `REPRACER_AWS_SECRET_ACCESS_KEY`), на сервере —
файлами `aws_access_key_id` и `aws_secret_access_key` ([deploy/notification-receiver/README.md](../deploy/notification-receiver/README.md)).

## 4. Адресаты SP-API (grantless; нужен скоуп из «До звонка»)

Токен: LWA `client_credentials`, скоуп `sellingpartnerapi::notifications`. Хост — эндпоинт SP-API региона приложения.

1. **Адресат SQS:** `POST /notifications/v1/destinations`, тело `{"name": "tmprice-sqs", "resourceSpecification": {"sqs": {"arn": "<ARN основной очереди>"}}}`.
   Из ответа — `destinationId` → `REPRACER_SPAPI_DESTINATION_ID_SQS`.
2. **Адресат EventBridge:** то же, тело `{"name": "tmprice-eventbridge", "resourceSpecification": {"eventBridge": {"region": "<регион AWS>", "accountId": "<аккаунт AWS>"}}}`.
   Из ответа — `destinationId` → `REPRACER_SPAPI_DESTINATION_ID_EVENTBRIDGE` и `resource.eventBridge.name` — имя источника партнёра →
   `REPRACER_EVENTBRIDGE_PARTNER_SOURCE`. Адресат EventBridge — один на аккаунт AWS.
3. **Успех:** `GET /notifications/v1/destinations` возвращает оба адресата: у SQS — ARN нашей очереди, у EventBridge — наши регион и аккаунт.

## 5. EventBridge (консоль AWS → Amazon EventBridge, тот же регион)

1. **Partner event sources** → источник `aws.partner/sellingpartnerapi.amazon.com/<аккаунт AWS>/<приложение>` → **Associate with event
   bus** → флажки пустые → Associate. Важно: события источника, не связанного с шиной, EventBridge отбрасывает сразу — связать ДО подписок
   шага 6. Состояние источника после связи — `ACTIVE`. ARN шины → `REPRACER_EVENTBRIDGE_BUS_ARN` (имя шины = имя источника).
2. **Rules → Create rule:** шина — шина партнёра из п. 1; Event source — AWS events or EventBridge partner events; шаблон:
   ```json
   {
     "source": [{ "prefix": "aws.partner/sellingpartnerapi.amazon.com" }],
     "detail-type": ["LISTINGS_ITEM_STATUS_CHANGE", "LISTINGS_ITEM_ISSUES_CHANGE"]
   }
   ```
   Цель — **SQS queue**, основная очередь из шага 1. Вход цели — событие целиком (**Matched event**), без преобразования: приёмник
   ждёт конверт события. Роль исполнения не нужна — разрешает политика очереди (шаг 2).
3. ARN правила → `REPRACER_EVENTBRIDGE_RULE_ARN` и во второе разрешение политики очереди (шаг 2).

## 6. Подписки (на продавца; нужна его авторизация и роль типа уведомления)

`POST /notifications/v1/subscriptions/{notificationType}`, тело `{"payloadVersion": "…", "destinationId": "…"}`:

| Тип | Версия | Адресат |
|---|---|---|
| `ANY_OFFER_CHANGED` | 1.0 | SQS |
| `PRICING_HEALTH` | 1.0 | SQS |
| `LISTINGS_ITEM_STATUS_CHANGE` | 1.0 | EventBridge |
| `LISTINGS_ITEM_ISSUES_CHANGE` | **2023-12-13** (1.0 — «deprecated soon», приёмник её отклоняет) | EventBridge |

Роли — «роль, связанная с типом уведомления» (страница role-mappings в снимке отсутствует; ожидаем Product Listing для листингов и
Pricing для цен — проверить). Успех: `GET /notifications/v1/subscriptions/{notificationType}` у каждого типа возвращает подписку с нужным
`destinationId`. Подписки в коде продукта пока не создаются — после звонка решить, заводит ли их кнопка «Connect Amazon».

## 7. Проверка конфигурации — «да/нет», без значений

```
node --experimental-strip-types services/notification-receiver/src/part-b.ts <файл секретов части Б>
```

Каждая строка — «пункт: да/нет»: заполнено ли каждое значение, один регион и один аккаунт AWS во всех адресах, адрес и ARN — одна
очередь, очередь недоставленных — другая, источник партнёра — наше приложение, правило — на шине партнёра. Код выхода 0 — всё «да».

## 8. Что считать успехом

- [ ] Пункты 4.3 и 6 — оба адресата и четыре подписки видны в ответах SP-API.
- [ ] **Форма события EventBridge (A-33).** SQS → очередь → Send and receive messages → Poll for messages: у сообщения уведомления листинга
  — `detail-type` равен типу, `source` начинается с `aws.partner/sellingpartnerapi.amazon.com`, в `detail` — `NotificationType`,
  `Payload`, `NotificationMetadata`. Сверяем только ИМЕНА ключей; тела в чат и в документы не копируем (данные продавца). Если форма
  другая — приёмник отклонит событие алертом `NOTIFICATION_UNPARSEABLE` с проблемой и списком ключей `detail`: по нему правится разбор.
- [ ] **Форма идентификатора приложения (A-34).** У боевого приложения идентификатор `amzn1.sp.solution.…`, а примеры снимка показывают
  `amzn1.sellerapps.app.…`. Сверить: имя источника партнёра (шаг 4.2) и `NotificationMetadata.ApplicationId` первого уведомления — та же
  строка, что в `REPRACER_AMAZON_APPLICATION_ID`. Сверяем равенство, значения в чат не копируем.
- [ ] Приёмник запущен с этой очередью: в первый час нет алертов `NOTIFICATION_UNPARSEABLE`, `NOTIFICATION_FOREIGN_APPLICATION`,
  `NOTIFICATION_UNKNOWN_SELLER`; очередь недоставленных пуста.
- [ ] Экран Channels у аккаунта Amazon: «Data source: Amazon notifications, the last one …» вместо «polling only».
- [ ] Проба статуса: у тестового предложения продавца в Seller Central количество 0, затем обратно. Ждём `LISTINGS_ITEM_STATUS_CHANGE` без
  `BUYABLE`, затем с ним: на Offers появляется и уходит пилюля «Not buyable on Amazon»; у включённого предложения — письмо CRITICAL.

## Если что-то не так

| Признак | Где смотреть | Что делать |
|---|---|---|
| `createDestination` — 400 или 403 | ответ SP-API | скоуп grantless (раздел «До звонка») |
| В очереди нет уведомлений листингов | EventBridge → источник партнёра | источник связан с шиной? правило на шине партнёра? цель — та очередь? второе разрешение политики? |
| `NOTIFICATION_FOREIGN_APPLICATION` на всех уведомлениях | алерт; `ApplicationId` первого сообщения | форма идентификатора другая (A-34): в `REPRACER_AMAZON_APPLICATION_ID` — та строка, что присылает Amazon |
| Сообщения уходят в очередь недоставленных | алерт `NOTIFICATION_GIVING_UP` | журнал приёмника по `messageId`; сбой базы или пути решения |
| `NOTIFICATION_UNPARSEABLE` с `EVENTBRIDGE_*` | алерт, поле `detailKeys` | форма `detail` не та, что в A-33: правка `packages/amazon-notifications/src/envelope.ts` со сценарием |

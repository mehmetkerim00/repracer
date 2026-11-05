# Amazon SQS и подпись AWS — страницы документации приёмника уведомлений (шаг 23)

Снимка спецификации нет: у SQS нет OpenAPI в репозитории моделей SP-API. Приёмник `packages/amazon-notifications` опирается только на
страницы ниже. Текст не копируется; для каждой страницы — канонический адрес, дата загрузки и SHA-256 загруженного HTML, чтобы изменение
страницы было видно при следующей сверке. Загружено 2026-09-17.

| Страница | Что взято | SHA-256 |
|---|---|---|
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-making-api-requests-json.html | протокол AWS JSON: `POST /`, `X-Amz-Target: AmazonSQS.<операция>`, `Content-Type: application/x-amz-json-1.0`, подпись SigV4 | `b7fdfecf921ec4683bfaf8f6602260b11d7010701920fcbd94af4d26fcb00cb7` |
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html | `MaxNumberOfMessages` 1–10, `WaitTimeSeconds` 0–20 (таймаут HTTP больше ожидания), `VisibilityTimeout`, `MessageSystemAttributeNames` (`SentTimestamp`, `ApproximateReceiveCount`, `SenderId`), `MD5OfBody` | `f2f663971c8c29f6038904d3253854115b28d430c37d5b2ca753f2b1d82a17ea` |
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessageBatch.html | не больше 10 записей; частичный отказ при HTTP 200 (`Successful` / `Failed`) | `aeaa05635e7cb17e38ccf1c8ab3c4c6da39bb17bcf59eb4ede8892e9506b211c` |
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html | `VisibilityTimeout` 0–43 200 с | `73d02d3cf35b31243c343c5927aa412b4c436d105ca3aa45686c7b3da546b7af` |
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html | `MessageRetentionPeriod` 60 с – 14 суток, по умолчанию 4 суток; `VisibilityTimeout` по умолчанию 30 с; `RedrivePolicy` | `8696841c093e5410f5de2ade4005e623bc3361b7b59c609cd3fc58342a943044` |
| https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html | очередь недоставленных по `maxReceiveCount` | `1bad70a471afec919ac98e29a9ddc5d52934d77e336966fbace91e7c06e57b6a` |
| https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html | алгоритм AWS4-HMAC-SHA256: канонический запрос, строка для подписи, производный ключ | `302dde356a9cf1f89a751591ef6dbc4dcffdbd4f727eaf9740b2a090648eb165` |

## Страницы SP-API (уведомления)

Markdown-версии (суффикс `.md`), поле `updatedAt` страницы и SHA-256 загруженного текста.

| Страница | updatedAt | Что взято | SHA-256 |
|---|---|---|---|
| https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs.md | 2026-09-09T22:50:16Z | FIFO-очереди не поддерживаются; порядок не гарантирован; уведомление может прийти больше одного раза, дубликат узнаётся по `NotificationId`; структура уведомления | `45e6a557d7ffdd6383a06a751b06ac2cad5c10d3851fc24ac260e0d986b847a3` |
| https://developer-docs.amazon/sp-api/docs/tutorial-grant-permission-to-sqs-queue.md | 2026-09-09T22:52:10Z | политика очереди: принципал SP-API — аккаунт AWS `437568002678`, действия `sqs:SendMessage`, `sqs:GetQueueAttributes` | `4174e595e4b185cd3db03313a2230b5a5f0959397c75df1b5509987e8ead70b8` |
| https://developer-docs.amazon/sp-api/docs/notification-type-values.md | 2026-09-09T23:56:30Z | `ANY_OFFER_CHANGED` и `PRICING_HEALTH` — только SQS (столбец Workflow); `ANY_OFFER_CHANGED` — изменение любого из первых 20 предложений по состоянию, `Offers` — первые 20 (полнота `TOP_N` n = 20 в описании канала); пример `PRICING_HEALTH` со строчными ключами. SHA-256 совпадает со снимком шага 20 | `339620f2875c16f1fbb2d4207abcd23e352ff5618bf760b92196f4a5492de6ff` |
| https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge.md | см. файл | EventBridge — для других типов уведомлений | `34d791aba8f94c7e9cc0e52b358f3820dac920049b32dc2734be970cb40a631d` |
| https://developer-docs.amazon/sp-api/docs/filter-notification-subscriptions.md | см. файл | фильтры подписки `marketplaceIds`, `aggregationSettings` | `6ccfa0741534b97f4581073b7f986e30ee82ba740a974c553e9db77504818567` |
| https://developer-docs.amazon/sp-api/docs/notifications-api.md | см. файл | назначения и подписки | `9a5a413d1538bc501d7e1348e18cc8b56e2fb85c4556d415ab8bf297cb4e4ccd` |

Схемы тел уведомлений — снимок `vendor/amazon/sp-api-models/2026-09-16/schemas/notifications/` (`AnyOfferChangedNotification.json`,
`PricingHealthNotification.json`).

Подпись SigV4 приёмника проверена на эталоне `packages/amazon-notifications/test/sigv4_reference.py` (стандартная библиотека Python по
алгоритму страницы IAM), а не на ответе AWS: доступа к аккаунту AWS нет.

## Шаг 114: EventBridge — уведомления листингов в ту же очередь (загружено 2026-11-05)

Уведомления листингов SP-API идут только через EventBridge; правило с целью-очередью кладёт событие EventBridge в ту же очередь, что
ANY_OFFER_CHANGED и PRICING_HEALTH (решение владельца — одна очередь). Что SP-API кладёт в `detail` события, страницы не говорят — A-33
(channel-capabilities.md): разбор строгий, проверка — на живой очереди части Б ([docs/amazon-notifications-part-b.md](../../docs/amazon-notifications-part-b.md)).

| Страница | updatedAt | Что взято | SHA-256 |
|---|---|---|---|
| https://docs.aws.amazon.com/eventbridge/latest/ref/overiew-event-structure.html | — | поля конверта события: `version`, `id`, `detail-type`, `source`, `account`, `time`, `region`, `resources`, `detail` | `a9cc9060a945e8971054f1c1705f7e9ca0326091312e2feafd41b1e9561895bd` |
| https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html | — | цель — очередь SQS (стандартная, fair, FIFO); очередь, зашифрованная ключом AWS (AWS owned key), целью быть не может; ключ KMS очереди — права `kms:Decrypt`, `kms:GenerateDataKey` для `events.amazonaws.com` | `3e603fb2abd5e230b441621abdaaf62fc879f6248ff0969de5683af9f593677a` |
| https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html | — | политика очереди для правила: `events.amazonaws.com`, `sqs:SendMessage`, условие `ArnEquals` `aws:SourceArn` = ARN правила `arn:aws:events:<регион>:<аккаунт>:rule/<шина>/<правило>`; без роли исполнения действует политика ресурса | `187764459859b76d001bbe507a49a10494a15971166477589c244f55fba46eab` |
| https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-saas.html | — | шина партнёра называется именем источника партнёра; события источника, не связанного с шиной, отбрасываются сразу; состояние источника — `ACTIVE` | `2cb9ee60db798a2af13f4cd2ca7d4d73bd3ff4122ad1706a29390b814b95d227` |
| https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge.md | 2026-09-09T22:50:03Z | только EventBridge: `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` и ещё четыре типа; один адресат EventBridge на аккаунт AWS; `createDestination` — без авторизации продавца (grantless); источник партнёра `aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}`; связать с шиной, флажки пустые; шаблон правила — `source` с префиксом `aws.partner/sellingpartnerapi.amazon.com`, по желанию `detail-type`; для проверки — очередь SQS целью | `a5cf5ef335f6de7f007dbfc079b5710a8c8ee593f3adaa243287e5dc5bcf0b59` |
| https://developer-docs.amazon/sp-api/docs/notification-type-values.md | 2026-10-28T19:09:44Z | `LISTINGS_ITEM_STATUS_CHANGE` 1.0: `SellerId`, `MarketplaceId`, `Asin`, `Sku`, `CreatedDate`, `Status` (BUYABLE, DISCOVERABLE, DELETED; отсутствие — «нет»); `LISTINGS_ITEM_ISSUES_CHANGE` 2023-12-13: `Severities` (ERROR, WARNING, NONE), `EnforcementActions` (LISTING_SUPPRESSED снимает возможность купить), версия 1.0 — «deprecated soon»; оба — Workflow EventBridge. Расхождение снимка: таблица пишет «SellerID», схема и пример — «SellerId»; схема `ListingsItemStatusChangeNotification.json` (модели 2026-10-29) перечисляет тип как `LISTINGS_ITEM_STATUS_CHANGED` | `c12d2f18e98351916797f45742e26a8b5f9cc1fca8f626f74189c7a4128f468d` |
| https://developer-docs.amazon/sp-api/docs/notifications-api.md | 2026-09-09T22:50:10Z | роли операций: `createDestination`, `getDestinations`, `deleteDestination` — grantless; `createSubscription` и `getSubscription` — роль, связанная с типом уведомления (страница role-mappings, в снимке её нет) | `876af86c488fb519f58fa510bd04d3474688e93c649ccfcf406b33b897295137` |
| https://developer-docs.amazon/sp-api/docs/terminology.md | 2026-09-09T23:47:54Z | термины: шина событий, источник событий партнёра | `98707510db42fccc26d587083805c8013d855b17b518b9eb0a8aadd3038d0f53` |

Тела запросов `createDestination` (`resourceSpecification.sqs.arn`, `resourceSpecification.eventBridge.{region, accountId}`) и
`createSubscription` (`payloadVersion`, `destinationId`, `processingDirective`) — по модели снимка
`vendor/amazon/sp-api-models/2026-10-29/models/notifications-api-model/`.

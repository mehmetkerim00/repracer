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

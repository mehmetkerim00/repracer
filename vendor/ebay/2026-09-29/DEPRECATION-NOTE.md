# eBay: устаревания API — заметка со слов руководителя (2026-09-29)

Страницы открылись у руководителя в браузере. У нас без браузера они отвечали 403 (шаг 52, сверка версий), поэтому текстов страниц в снимке нет — только факты, переданные руководителем. Сами страницы доснимаем в следующую живую браузер-сессию.

Источники:
- https://developer.ebay.com/develop/apis/api-deprecation-status
- https://developer.ebay.com/devzone/xml/docs/releasenotes.html (эта страница загрузилась и без браузера — [trading-release-notes.html](trading-release-notes.html))

Факты (2026-09-29):

| Что | Состояние | Замена |
|---|---|---|
| Trading API — уровень совместимости | Актуальный — 1477 (выпуск 2026-08-24). Нижняя поддерживаемая версия явно не публикуется, ориентир eBay — 18 месяцев | — |
| Trading `GeteBayDetails` | Устарел 2026-09-21, отключение 2027-03-15 | Metadata API |
| Trading `UploadSiteHostedPictures` | Отключается 2026-09-30 | — |
| Finding API, Shopping API | Отключены | Browse API |
| VeRO API v1 | Отключается 2026-09-30 | — |

Что из этого зовёт репозиторий — [docs/evidence/step53-ebay-trading.md](../../../docs/evidence/step53-ebay-trading.md).

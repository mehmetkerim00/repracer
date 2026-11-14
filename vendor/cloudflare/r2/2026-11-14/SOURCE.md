# Cloudflare R2 — страницы для выноса копий пилота (шаг 126)

Текст страниц не копируется — адрес Markdown-версии (`…/index.md`), `dateModified` страницы и SHA-256 загруженного текста. Загружено 2026-11-14.

| Страница | dateModified | SHA-256 |
|---|---|---|
| https://developers.cloudflare.com/r2/api/s3/api/index.md | 2026-11-10 | `93d2dad18c8768d2bf3cc5f1f895296b694de1c628535ee66dcb8bcba1231bc0` |
| https://developers.cloudflare.com/r2/api/s3/presigned-urls/index.md | 2026-11-12 | `87ec22657733980e7f7283cfce73d79c5552a43ae531555788cfe6ecc8eb9148` |
| https://developers.cloudflare.com/r2/api/tokens/index.md | 2026-10-01 | `80a22d05cdc014b799f987f5678707b0bfd137f586ae8a94ef11cb1d16e881cb` |
| https://developers.cloudflare.com/r2/pricing/index.md | 2026-10-30 | `99c1d53a90f368ffeefc89c1f01d33582ab7bf61e3ea24f49eaf74e206f506ca` |
| https://developers.cloudflare.com/r2/buckets/object-lifecycles/index.md | 2026-10-26 | `d53bd8575f419cd455c37ef5371a41d3848b2fbfb0b25d01e34e943d098f32e4` |

## Что взято (deploy/pilot/offsite-r2.ts, deploy/pilot/README.md)

- **Адрес S3 API** — `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; адрес бакета в примерах — `https://<бакет>.<ACCOUNT_ID>.r2.cloudflarestorage.com/<ключ>`
  (presigned-urls).
- **Регион подписи** — `auto` («When using the S3 API, the region for an R2 bucket is `auto`»).
- **Операции** — PutObject, HeadObject, ListObjectsV2 (`list-type`, `prefix`, `continuation-token`), DeleteObject — «✅» в таблице совместимости.
- **Ключи** — токен R2 с правом «Object Read & Write», можно ограничить бакетами; Access Key ID и Secret Access Key показываются один раз.
- **Бесплатный уровень** — 10 GB-month хранения, 1 млн операций класса A и 10 млн класса B в месяц, выход данных бесплатен; только Standard storage.
- **Правила жизненного цикла** удаляют объекты по возрасту — запасная страховка срока; срок держит сам процесс выноса.

## Чего страницы не говорят

- Нужен ли способ оплаты в аккаунте, чтобы включить R2 на бесплатном уровне, — проверить при включении. Если нужен — это решение владельца
  («ничего не покупаем»), и тогда цель выноса — машина оператора (`REPRACER_BACKUP_OFFSITE=pull`).
- Проверяет ли R2 подписанный хэш тела (`x-amz-content-sha256`) так же, как S3, — процесс выноса после каждой записи сверяет длину объекта
  (HeadObject), и только тогда считает копию вынесенной.

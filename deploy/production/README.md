# Профиль production: что нужно от владельца и какие команды выполнить

Р-158 (шаг 36) и Р-159 (шаг 37). Профиль поднимает обратный прокси с TLS, **консоль продавца** за ним и суточную
резервную копию PostgreSQL. Ни PostgreSQL, ни ClickHouse он не поднимает: их бэкап, обновления и доступы — свойство
хостинга, и притворяться, что compose это решает, значит врать себе.

**Ничего из описанного здесь на настоящем сервере не выполнялось ни разу**: VPS у проекта нет, а Docker в среде
разработки образы не тянет (OQ-114). Проверено в CI: профиль поднимается целиком, прокси отдаёт консоль, гость проходит
путь до экрана «почему эта цена» (`scripts/deploy-smoke.sh`). Первый запуск на живом сервере наверняка найдёт своё — так
было с тремя процессами на шаге 28, где не стартовал ни один.

## 1. Что нужно завести заранее

| Что | Зачем | Без него |
|---|---|---|
| **Домен** и запись A на адрес сервера | TLS-сертификат Let's Encrypt выдаётся на домен | Прокси не получит сертификат |
| **VPS** с Docker и Docker Compose v2 | всё разворачивается compose-файлами | — |
| **PostgreSQL 16** (управляемая или своя), доступная с VPS | база продукта | Ничего не работает |
| Пароли **ролей подключения** (`svc_app`, `svc_admin`, `svc_authenticator`, `svc_onboarding`, `svc_provisioning`, `svc_dispatcher`, `svc_stock`, `svc_scheduler`, `svc_exporter`, `svc_fx_loader`, `svc_bulk_worker`, `svc_alert_delivery`) | у консоли нет одной главной роли [Р-90] | Консоль не стартует и называет недостающую роль |
| **Ключ провайдера почты** и домен отправителя (OQ-224) | письма о событиях владельцу [Р-156] | Доставка идёт ВСУХУЮ: письма собираются, не отправляются, в базе отметка `DRY_RUN` |
| **Ключи проверок healthchecks.io** (OQ-188) | внешний контроль процессов [Р-127] | Отметка выключается явно (`*_HEARTBEAT=off`); остановку процесса никто не заметит |
| **Ключи каналов** (Kaufland, Amazon) | записи цен и остатков | Каналы в состоянии «ожидает доступа» [Р-150] |

## 2. Куда что положить

Секреты — **только файлами** в каталоге `REPRACER_SECRETS_DIR` (по умолчанию `/srv/repracer/secrets`), каждый файл
содержит одну строку без перевода строки в конце:

```
/srv/repracer/secrets/
  console_app_pg_url            postgres://svc_app:ПАРОЛЬ@db:5432/repracer_eu
  console_admin_pg_url          postgres://svc_admin:ПАРОЛЬ@db:5432/repracer_eu
  console_authenticator_pg_url  …  (и так по файлу на каждую роль из CONSOLE_ROLES)
  console_onboarding_pg_url
  console_provisioning_pg_url
  console_dispatcher_pg_url
  console_stock_pg_url
  console_scheduler_pg_url
  console_exporter_pg_url
  console_fx_loader_pg_url
  console_bulk_worker_pg_url
  console_heartbeat_url         https://hc-ping.com/<идентификатор проверки консоли>   (когда появится, OQ-188)
  operator_pg_url               postgres://svc_operator:ПАРОЛЬ@db:5432/repracer_eu     (панель оператора, Р-165)
  operator_heartbeat_url        https://hc-ping.com/<идентификатор проверки панели>     (когда появится, OQ-188)
  backup_pg_url                 postgres://ПОЛЬЗОВАТЕЛЬ:ПАРОЛЬ@db:5432/repracer_eu
  mail_api_key                  ключ провайдера почты                                  (когда появится, OQ-224)
  channels/secret-ref_kaufland-0001   {"clientKey":"…","secretKey":"…"}
```

Каталог должен быть доступен на чтение пользователю `1000:1000` — от него работают контейнеры.

Значения, которые не секреты, — в `deploy/production/production.env` (пример рядом,
[production.env.example](production.env.example)) и `deploy/console/console.env`
([пример](../console/console.env.example)).

## 3. Команды

```bash
# 1. Код и зависимости
git clone https://github.com/mehmetkerim00/repracer.git /srv/repracer/app && cd /srv/repracer/app
npm ci

# 2. Схема базы (один раз и при каждом обновлении миграций)
PGHOST=db PGUSER=postgres scripts/db/prepare.sh repracer_eu

# 3. Интерфейс: контейнер видит репозиторий только на чтение и собрать себя не может
npm run build -w apps/console

# 4. Профиль: прокси + консоль + суточная копия
docker compose -f deploy/production/compose.yaml --env-file deploy/production/production.env up -d

# 5. Процессы продукта — своими профилями
docker compose -f deploy/scheduler/compose.yaml --env-file deploy/scheduler/scheduler.env up -d
docker compose -f deploy/worker/compose.yaml --env-file deploy/worker/worker.env up -d
docker compose -f deploy/notification-receiver/compose.yaml --env-file deploy/notification-receiver/receiver.env up -d

# 6. Проверка: консоль отвечает, страница открывается по домену
curl -sf http://127.0.0.1:9467/healthz && echo "консоль жива"
curl -sI https://<домен>/ | head -1

# 7. Панель оператора [Р-165]: жива на своём порту и НЕ выставлена наружу
curl -sf http://127.0.0.1:9471/healthz && echo "панель жива"
ss -ltnp | grep -E ':(4327|9471)\s' | grep -v '127\.0\.0\.1' && echo "ОПАСНО: панель слушает не только loopback" || echo "панель слушает только loopback"
```

## 3а. Как оператор открывает панель

Домена и прокси у панели нет намеренно [Р-165]: наружу её не выставляет ничто. С машины оператора:

```bash
ssh -L 4327:127.0.0.1:4327 <пользователь>@<сервер>   # затем открыть http://127.0.0.1:4327
```

Проверка из пункта 7 — часть подъёма, а не необязательный совет: порт, открытый наружу (например пробросом на роутере),
делает панель платформы публичной, и сборка об этом не узнает (OQ-227).

## 4. Когда появятся ключи

- **Почта** (OQ-224): положить `mail_api_key` и задать в окружении планировщика `REPRACER_MAIL_API_URL`,
  `REPRACER_MAIL_FROM`, `REPRACER_OPERATOR_EMAIL`. Кода это не меняет: сухой режим выключается появлением значений.
- **Внешний контроль** (OQ-188): завести проверки на healthchecks.io (`scripts/setup-heartbeats.mjs` — одна команда
  после получения ключа), положить адреса файлами и **убрать** `*_HEARTBEAT=off` из окружений.
- **Каналы**: положить учётные данные в `channels/` и подключить аккаунт — пока из консоли это сделать нельзя (OQ-213).
- **Оператор платформы** [Р-165]: учётная запись оператора заводится строкой в `platform.platform_operator`
  (`issuer`, `subject` из токена поставщика identity, `display_name`, `active`) — панель операторов себе не создаёт.

## 5. Чего профиль не делает

- Не поднимает PostgreSQL и ClickHouse.
- Не заводит тенанта продавца САМ: регистрации «с улицы» нет (OQ-213). Пилота целиком заводит панель оператора
  [Р-167] — тенант и приглашение владельца письмом; публичное демо [Р-160] работает сразу.
- Не ограничивает доступ к панели на уровне сети: порт слушает loopback, а туннель и firewall — дело сервера (OQ-227).
- Не рассылает писем без провайдера — и говорит это в журнале при старте, а не молчит.
- Не следит за провалом резервной копии сам: провал оставляет строку `BACKUP_FAILED` в журнале и файл-маркер в каталоге
  копий, и подхватить их обязан внешний контроль [Р-127], которого пока нет (OQ-188).

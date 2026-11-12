# QA-A: демо-стенд для независимого тестирования

Шаг 121, план запуска — фаза 1. Что получится: `https://qa.tmprice.com` за Cloudflare Access (вход по почте, одноразовый код). За ним консоль
стенда: вход имитатором (Owner, Manager), три демо-пространства (Demo store, Blue Ridge Trading, Lakeside Home Goods) в тени, неделя тени
прожата. Каналы — симуляторы, ключей каналов на хосте нет никогда. Подвал каждой страницы называет сборку (`Build <sha> · <время>`) — её
пишут в отчёт об ошибке.

Состав (`compose.yaml`): PostgreSQL 16, стенд (`apps/console/server/stand-server.ts`: API, имитатор входа, собранный интерфейс), исполнитель
заданий (`apps/console/server/bulk-worker.ts`: импорты, выгрузки, массовые правки) и `cloudflared` (туннель). Наружу не открыто ничего, кроме
SSH: страницу выставляет туннель исходящим соединением.

Чего здесь нет (это QA-B): настоящего входа и второго фактора, планировщика, брокера, ClickHouse, почты, панели оператора, копий базы.

## 1. Сервер

Ubuntu 24.04, 4 vCPU и 8 ГБ, регион США. Вход — только по ключу SSH. Дальше — от пользователя выкладки `deploy` с sudo.

```sh
sudo adduser --disabled-password --gecos '' deploy && sudo usermod -aG sudo deploy
sudo -u deploy sh -c 'install -d -m 700 "$HOME/.ssh"'   # ключ Kerim — в .ssh/authorized_keys пользователя deploy
# Пароли SSH выключены
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload ssh
```

## 2. Межсетевой экран: снаружи — только SSH

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
```

Docker публикует порты мимо `ufw`. Здесь это не открывает ничего: стенд опубликован только на `127.0.0.1:4318` (проверка выкладки с хоста),
база и исполнитель не опубликованы вовсе. Правило репозитория не даёт опубликовать порт не на loopback (`scripts/test/repo-rules.test.ts`).

## 3. Docker и git

По `docs.docker.com/engine/install/ubuntu` (официальный репозиторий Docker; команды сверить со страницей при установке):

```sh
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy   # затем выйти и войти заново
```

Node на хосте не нужен: зависимости и интерфейс собирает `deploy.sh` тем же образом Node, что исполняет процессы.

## 4. Код и настройки

```sh
sudo install -d -o deploy -g deploy /srv/repracer && git clone https://github.com/mehmetkerim00/repracer.git /srv/repracer
cd /srv/repracer
cp deploy/qa/qa.env.example deploy/qa/qa.env            # каталог секретов и адрес QA; в репозиторий не попадает
sudo install -d -m 700 -o deploy -g deploy /srv/repracer-qa/secrets
```

## 5. Cloudflare: туннель и Access

В Zero Trust (`one.dash.cloudflare.com`) аккаунта, где зона `tmprice.com`:

1. **Туннель:** Networks → Tunnels → Create a tunnel → Cloudflared, имя `repracer-qa`. Токен установки положить в
   `/srv/repracer-qa/secrets/tunnel.env` (образец — `deploy/qa/tunnel.env.example`), права 600. Команду установки со страницы не выполнять:
   `cloudflared` поднимает compose.
2. **Публичный адрес туннеля:** Public Hostname → `qa.tmprice.com` → тип HTTP, адрес `stand:4318` (имя сервиса compose).
3. **Access** — до первого открытия адреса: Access → Applications → Add → Self-hosted, домен `qa.tmprice.com`, политика Allow → Emails:
   адреса Kerim и Merdan, вход — One-time PIN. Сессия Access — cookie. Пароль у прокси (Basic Auth) не годится: консоль ходит в API с
   `Authorization: Bearer`, а Basic Auth занимает тот же заголовок.

Вход стенда — имитатор: любой, кто дошёл до страницы, входит владельцем. Поэтому Access обязателен, и `smoke.sh` проверяет, что без входа
Access консоль не отдаётся.

## 6. Первая выкладка

```sh
deploy/qa/deploy.sh <тег-или-коммит> --first-time
```

Скрипт:

1. переключает рабочую копию на версию;
2. ставит зависимости и собирает интерфейс;
3. пишет версию сборки в `deploy/qa/build.env`;
4. создаёт базу `repracer_qa` (`scripts/qa-reset.sh`: миграции, роли, смоук-проверки схемы, регион US) и сразу закрывает её стражем P0-09;
5. поднимает стенд, исполнитель и туннель;
6. ждёт первых решений демо;
7. запускает `deploy/qa/smoke.sh`.

Около 3–5 минут, из них посев демо — около 2,5.

**Страж P0-09** (`deploy/production/README.md` §4б) ставит сброс сам: `ALTER DATABASE repracer_qa SET repracer.live_writes = 'forbidden'`.
Проверка вручную:

```sh
deploy/qa/compose.sh exec -T postgres psql -U postgres -d repracer_qa -Atc "SELECT security.live_writes_forbidden()"   # t
```

## 7. Проверка

`deploy/qa/smoke.sh` — красное с причиной. Проверяет:

- стенд отвечает той сборкой, что в `build.env` (`/healthz` и сессия страницы);
- отдаётся собранная страница;
- исполнитель заданий отвечает той же сборкой;
- база закрыта стражем;
- вход имитатором даёт три демо-пространства;
- снаружи `https://qa.tmprice.com` без входа уводит на страницу входа Access.

Затем — браузером не с машины Kerim: вход через Access → Owner → список пространств → Shadow mode → «Why this price» → одна выгрузка и
одна примерка импорта → сборка в подвале.

## 8. Каждый день

| Что | Команда |
|---|---|
| Новая версия | `deploy/qa/deploy.sh <тег>` — база заново (миграции новой версии), демо заново |
| Чистые данные | `deploy/qa/reset.sh` — около 3 минут |
| Журналы | `deploy/qa/compose.sh logs -f stand bulk-worker` |
| Что работает | `deploy/qa/compose.sh ps`; сборка — подвал страницы или `curl -s 127.0.0.1:4318/healthz` |

**Сброс отказывает базе без стража P0-09:** он пересоздаёт базу, и боевую базу (она стражем не закрыта никогда) так снести нельзя. Новую
базу создаёт только явный `--first-time`, и он отказывает базе, которая уже есть.

**Перезагрузка сервера:** контейнеры поднимаются сами (`restart: unless-stopped`). Стенд при подъёме сеет демо заново НОВЫМИ тенантами,
прежние остаются в базе мусором (OQ-225). Для чистого состояния — `deploy/qa/reset.sh`.

## 9. Доступ Мердана к журналам и сбросу

Ровно три команды, без оболочки (`deploy/qa/ssh-gate.sh`). Его открытый ключ — в `.ssh/authorized_keys` пользователя `deploy` одной строкой:

```
command="/srv/repracer/deploy/qa/ssh-gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… merdan
```

Вызов: `ssh deploy@<сервер> logs`, `ssh deploy@<сервер> reset`, `ssh deploy@<сервер> version`.

## 10. Что проверено и что нет

Проверено локально, без контейнеров: та же связка процессов с переменными этого compose (шаг 121, `docs/evidence/step121-qa-a.md`):

- сброс на базе без стража отказывает;
- `--first-time` создаёт базу и ставит страж;
- стенд на закрытой базе поднимает три демо;
- страница, сессия и оба `/healthz` называют одну сборку;
- задание выгрузки выполняет исполнитель;
- `docker compose config` разбирает этот файл.

Не проверено, проверить при первой выкладке:

- образы — Docker Hub на машине разработчика образы не отдаёт (OQ-114);
- туннель и Access;
- Linux вместо macOS;
- настоящий браузер снаружи.

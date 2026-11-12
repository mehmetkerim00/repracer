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

Ubuntu 24.04, регион США. Первая выкладка (2026-11-12) шла на 3 vCPU, 3,9 ГБ памяти и 2 ГБ swap: работающий стек занимает около 0,9 ГБ,
swap не используется. Шаги 1–4 (подготовка хоста) выполняются от root. Пароль root выдаёт провайдер, и первым делом вход переводится на ключ.

С машины Kerim положить ключ root. Пароль root вводится один раз, в запросе ssh:

```sh
ssh-copy-id -i <ключ выкладки>.pub root@<сервер>
```

Дальше на сервере вход остаётся только по ключу. Пароль закрывается своим файлом в `/etc/ssh/sshd_config.d`, правка `sshd_config` здесь не
поможет: в образах провайдеров `PasswordAuthentication yes` и `PermitRootLogin yes` бывают заданы в `sshd_config.d/*.conf` (у первого
сервера — в `50-cloud-init.conf` и `99-ctrl.conf`), а sshd берёт ПЕРВОЕ прочитанное значение. Файл `00-…` читается раньше остальных:

```sh
cat > /etc/ssh/sshd_config.d/00-tmprice-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin) '   # no / without-password
```

Затем по порядку:

1. Сменить пароль root на случайный (`chpasswd`). Значение не печатается и хранится вне сервера и репозитория: оно нужно только для консоли
   провайдера.
2. Выполнить `systemctl restart ssh`.
3. НЕ закрывая текущую сессию, войти по ключу из второго окна.

Без ключа сервер должен предлагать только `publickey`:

```sh
ssh -o PreferredAuthentications=none root@<сервер>   # Permission denied (publickey).
```

Пользователь выкладки `deploy` создаётся без пароля и без sudo. Команды с правами root выполняет root по ключу, а выкладку и всё ежедневное
(шаги 6–9) — `deploy`:

```sh
adduser --disabled-password --gecos '' deploy
install -d -m 700 -o deploy -g deploy ~deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys ~deploy/.ssh/authorized_keys   # ключ Kerim
```

## 2. Межсетевой экран: снаружи — только SSH

```sh
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
```

Docker публикует порты мимо `ufw`. Здесь это не открывает ничего: стенд опубликован только на `127.0.0.1:4318` (проверка выкладки с хоста),
база и исполнитель не опубликованы вовсе. Правило репозитория не даёт опубликовать порт не на loopback (`scripts/test/repo-rules.test.ts`).

## 3. Docker и git

По `docs.docker.com/engine/install/ubuntu` (официальный репозиторий Docker; команды сверить со страницей при установке). На 2026-11-12
источник на странице задаётся файлом `docker.sources` в формате deb822; первая выкладка поставила Docker 29.9 и Compose v5.7:

```sh
apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker deploy
```

Node на хосте не нужен: зависимости и интерфейс собирает `deploy.sh` тем же образом Node, что исполняет процессы.

## 4. Код и настройки

От root — каталоги, от `deploy` — код и настройки:

```sh
install -d -o deploy -g deploy /srv/repracer
install -d -m 700 -o deploy -g deploy /srv/repracer-qa /srv/repracer-qa/secrets
# дальше — от deploy
git clone https://github.com/mehmetkerim00/repracer.git /srv/repracer
cd /srv/repracer
cp deploy/qa/qa.env.example deploy/qa/qa.env            # каталог секретов и адрес QA; в репозиторий не попадает
```

## 5. Cloudflare: Access, туннель, DNS

Порядок: Access раньше DNS, иначе адрес хоть на минуту окажется открыт без защиты. Первая выкладка сделала всё через API Cloudflare (токен с
правами Cloudflare Tunnel Edit, Access: Apps and Policies Edit и DNS Edit). В Zero Trust (`one.dash.cloudflare.com`) аккаунта, где зона
`tmprice.com`, шаги те же:

1. **Способ входа One-time PIN включается в организации отдельно.** Новая организация Zero Trust пускает только по учётной записи Cloudflare,
   а One-time PIN сам больше не добавляется (документация Cloudflare, «One-time PIN login»). Путь: Integrations → Identity providers →
   Add new → One-time PIN. Через API для этого нужно право «Access: Organizations, Identity Providers, and Groups Edit». Токену QA его не
   дают, включает владелец в панели. Пока способа входа нет, войти не может никто: это отказ, а не открытый доступ.
2. **Access:** многоразовая политика «QA-A testers» — Allow → Emails: support@tmprice.com (пересылка владельцу) и адреса тестировщиков.
   Новый тестировщик — одна строка в этой политике. Приложение — Self-hosted, домен `qa.tmprice.com`, сессия 24 ч, политика «QA-A testers».
   Сессия Access хранится в cookie. Пароль у прокси (Basic Auth) не годится: консоль ходит в API с `Authorization: Bearer`, а Basic Auth
   занимает тот же заголовок.
3. **Туннель** `repracer-qa`, управляется из Cloudflare (`config_src: cloudflare`). Токен установки — в `/srv/repracer-qa/secrets/tunnel.env`
   (образец — `deploy/qa/tunnel.env.example`), права 600, на экран не выводится. Команду установки со страницы не выполнять: `cloudflared`
   поднимает compose.
4. **Маршрут туннеля:** `qa.tmprice.com` → `http://stand:4318` (имя сервиса compose), остальное — `http_status:404`. На маршруте включена
   проверка Access самим `cloudflared` («Protect with Access», `originRequest.access`: `required: true`, команда `tmprice`, аудитория
   приложения из шага 2). Запрос без действующего входа Access не дойдёт до стенда, даже если приложение Access когда-нибудь удалят.
5. **DNS:** CNAME `qa` → `<id туннеля>.cfargotunnel.com`, через прокси Cloudflare.

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

Первая выкладка на 3 vCPU заняла 392 с, из них 376 с — сброс: база с миграциями и смоук-проверками схемы и посев демо.

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

`/healthz` через туннель отвечает только после входа Access: без входа его закрывает Access, а `cloudflared` проверяет вход ещё раз. Сборку
по тому адресу, на который смотрит туннель, показывает `/healthz` стенда изнутри сети compose:

```sh
deploy/qa/compose.sh exec -T bulk-worker node -e "fetch('http://stand:4318/healthz').then(r => r.text()).then(console.log)"
```

Затем — браузером не с машины Kerim (нужен One-time PIN, шаг 5.1): вход через Access → Owner → список пространств → Shadow mode →
«Why this price» → одна выгрузка и одна примерка импорта → сборка в подвале → `https://qa.tmprice.com/healthz`.

## 8. Каждый день

| Что | Команда |
|---|---|
| Новая версия | `deploy/qa/deploy.sh <тег>` — база заново (миграции новой версии), демо заново |
| Чистые данные | `deploy/qa/reset.sh` — около 6 минут (376 с на первом сервере) |
| Журналы | `deploy/qa/compose.sh logs -f stand bulk-worker` |
| Что работает | `deploy/qa/compose.sh ps`; сборка — подвал страницы или `curl -s 127.0.0.1:4318/healthz` |

**Сброс отказывает базе без стража P0-09:** он пересоздаёт базу, и боевую базу (она стражем не закрыта никогда) так снести нельзя. Новую
базу создаёт только явный `--first-time`, и он отказывает базе, которая уже есть.

**Сброс переживает обрыв связи (шаг 121.3).**

- Сброс идёт в фоне под журналом `deploy/qa/state/reset.log`, одновременно только один (`deploy/qa/detach.sh`). Команда показывает журнал
  до конца и выходит кодом сброса.
- Обрыв SSH или Ctrl-C прерывает только показ. Повторный `reset` во время работы показывает тот же журнал с начала и ждёт конца, второй
  сброс не запускается.
- База QA не бывает без стража ни в какой момент. Новая база собирается как `repracer_qa_next`, страж ставится на неё до замены, и лишь
  потом она получает имя `repracer_qa`. Если сброс убит посреди сборки, прежняя база цела и закрыта. Если он убит между удалением и
  переименованием, повтор доводит замену.

**Перезагрузка сервера:** контейнеры поднимаются сами (`restart: unless-stopped`). Стенд при подъёме сеет демо заново НОВЫМИ тенантами,
прежние остаются в базе мусором (OQ-225). Для чистого состояния — `deploy/qa/reset.sh`.

## 9. Доступ Мердана к журналам и сбросу

Ровно три команды, без оболочки (`deploy/qa/ssh-gate.sh`). Его открытый ключ — в `.ssh/authorized_keys` пользователя `deploy` одной строкой:

```
command="/srv/repracer/deploy/qa/ssh-gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… merdan
```

Вызов: `ssh deploy@<сервер> logs`, `ssh deploy@<сервер> reset`, `ssh deploy@<сервер> version`.

Если связь оборвалась во время `reset`, сброс продолжается сам. `logs` в конце показывает, чем кончился последний сброс: «завершён, код N»
или «идёт», и хвост его журнала. Повторный `reset` во время работы показывает тот же сброс, а не запускает второй.

## 10. Что проверено и что нет

Проверено локально, без контейнеров: та же связка процессов с переменными этого compose (шаг 121, `docs/evidence/step121-qa-a.md`):

- сброс на базе без стража отказывает;
- `--first-time` создаёт базу и ставит страж;
- стенд на закрытой базе поднимает три демо;
- страница, сессия и оба `/healthz` называют одну сборку;
- задание выгрузки выполняет исполнитель;
- `docker compose config` разбирает этот файл.

Проверено первой выкладкой (2026-11-12, Ubuntu 24.04, шаг 121.1):

- образы скачаны, и стек поднят на Linux;
- `deploy.sh --first-time` прошёл, и `smoke.sh` зелёный;
- туннель `healthy`;
- снаружи без входа адрес уводит на Access;
- сброс на временной базе без стража отказал;
- три команды шлюза SSH работают, а проброс портов запрещён.

Не проверено, проверить после включения One-time PIN: вход настоящим браузером снаружи и `/healthz` через туннель с входом.

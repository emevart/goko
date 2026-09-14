# infra — развёртывание Гоко на одном VPS

Здесь всё, что поднимает прод в Docker Compose: Caddy (TLS, статика, прокси
`/api/*`), LiveKit (сигналинг и TURN), `game-server`, `go-engine` и
`voice-agent`. Этот файл — первичная настройка VPS; эксплуатация после неё
(чек-лист перед первым деплоем голоса, проверки, логи, откат) —
[`docs/runbooks/vps.md`](../docs/runbooks/vps.md).

Переменные — в `infra/.env.example`. На VPS файл лежит в `/opt/goko/.env`
(режим 600), в git не попадает.

## 1. Что делает founder руками (один раз)

- Создать сервер в Hetzner в отдельном проекте: **cx23** (2 vCPU, 4 ГБ),
  **Ubuntu 24.04**, локация **Хельсинки**; добавить свой SSH-ключ.
- Завести в `~/.ssh/config` алиас хоста `goko` (скрипты обращаются по нему).
- Прописать A-записи `WEB_HOST` и `LK_HOST` на адрес VPS.

## 2. Bootstrap

```bash
scp infra/scripts/bootstrap.sh goko:/root/ && ssh goko bash /root/bootstrap.sh
```

Скрипт идемпотентен: ставит Docker, открывает порты в ufw, создаёт
`/opt/goko/{web,src,data}` и пустой `/opt/goko/.env`.

## 3. Заполнить `/opt/goko/.env`

За образец взять `infra/.env.example`. Генерация ключей:

```bash
openssl rand -hex 8    # LIVEKIT_API_KEY
openssl rand -hex 32   # LIVEKIT_API_SECRET
openssl rand -hex 16   # APP_KEY, ENGINE_KEY
```

`API_UPSTREAM` в проде — контейнер game-server (`127.0.0.1:8787`), в
dev-режиме — адрес ПК в tailnet с портом 8787. `APP_KEY` — один и тот же в
`/opt/goko/.env` и в `.env` на ПК: он вшивается в бандл страницы. Значения
никуда не копировать и не печатать в логи.

`ACME_EMAIL` **обязан вписать founder**: это его почта, на неё Let's Encrypt
шлёт предупреждения об истечении сертификата. Пока строка пуста, compose
подставляет фиктивный `admin@WEB_HOST` — ящика не существует, письма уйдут в
никуда, и `deploy.sh` каждый раз печатает `[!]`.

## 4. Деплой

```bash
infra/scripts/deploy.sh --build-web          # сверить APP_KEY ПК и VPS, собрать web на ПК, выложить статику, compose up --build
infra/scripts/deploy.sh                      # только код, конфиги и образы, статику не трогать
```

Веб собирается на ПК (`npm run build:web` → `apps/web/dist`), не на VPS.
Перед сборкой `--build-web` сверяет sha256 `APP_KEY` из `.env` ПК и
`/opt/goko/.env`, значений и хешей не печатает и останавливается при
расхождении; вместе с `--web-dir` не указывается. Скрипт синхронизирует
репозиторий в `/opt/goko/src`, подставляет `LK_HOST` вместо `__TURN_DOMAIN__`
в `livekit.yaml`, создаёт `/opt/goko/data/games` (нужен ssh под root) и
поднимает compose со сборкой образов.

Синхронизация идёт через `rsync`. Если `rsync` не найден (Git Bash на
Windows), скрипт сам переключается на `tar` по ssh и печатает `[!]`: этот
путь работает, но не удаляет на VPS файлы, удалённые в репозитории. Чтобы
получить точную копию, поставь `rsync` или почисти `/opt/goko/src` вручную.

## 5. Проверка

```bash
curl -s  https://<LK_HOST>/     # ожидается OK
curl -sI https://<WEB_HOST>/    # 200 после deploy.sh --build-web; 404 — статика ещё не выкачена
ssh goko 'cd /opt/goko/src/infra && set -a && . /opt/goko/.env && set +a && docker compose --env-file /opt/goko/.env ps'
```

`404` на `<WEB_HOST>` — норма, пока статика не выкачена: TLS уже работает, но
отдавать нечего.

У всех сервисов есть `healthcheck`, поэтому `docker compose ps` показывает
`Up (healthy)`, а не просто `Up`; `go-engine` до 5 минут после старта в
`health: starting` (прогрев KataGo). Статус `unhealthy` или застрявший
`health: starting` — повод смотреть `docker compose logs`. Остальные
проверки — `docs/runbooks/vps.md`.

Первый запрос после деплоя может быть медленным: Caddy получает
сертификаты Let's Encrypt.

## 6. Порты

| Порт          | Кто            | Зачем                                   |
|---------------|----------------|-----------------------------------------|
| 22/tcp        | ssh            | доступ founder'а                        |
| 80/tcp        | Caddy          | ACME-челлендж и редирект на 443         |
| 443/tcp       | Caddy          | страница, `/api/*`, `wss://` в LiveKit  |
| 7881/tcp      | LiveKit        | ICE/TCP, когда UDP закрыт у клиента     |
| 3478/udp      | LiveKit TURN   | обход NAT телефона                      |
| 30000-40000/udp | LiveKit TURN | relay-аллокации TURN (`turn.relay_range_*`) |
| 50000-60000/udp | LiveKit      | медиа-потоки WebRTC                     |

Порт 7880 наружу не открыт: к нему ходит только Caddy с localhost.

## 7. Откат

```bash
ssh goko 'cd /opt/goko/src/infra && set -a && . /opt/goko/.env && set +a && docker compose --env-file /opt/goko/.env down'
```

Данные Caddy (сертификаты) лежат в томах и переживают `down`. Вернуться к
прежней версии — выкатить `deploy.sh` из нужного коммита.

## 8. Рескейл

cx23 → cx33 меняется в панели Hetzner без переезда: растут только CPU и
RAM, диск и адрес остаются. После рескейла — перезагрузка сервера,
контейнеры поднимутся сами (`restart: unless-stopped`).

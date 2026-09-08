# infra — развёртывание Гоко на одном VPS

Здесь всё, что поднимает прод: Caddy (TLS, статика, прокси `/api/*`) и
LiveKit (сигналинг и TURN) в Docker Compose. Приложения Node на стадии 0
живут на ПК; VPS отвечает за домены, TLS и медиа.

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

`API_UPSTREAM` в проде — контейнер game-server, на стадии 0 — адрес ПК в
tailnet с портом 8787. Значения никуда не копировать и не печатать в логи.

## 4. Деплой

```bash
infra/scripts/deploy.sh                      # только конфиги и compose
infra/scripts/deploy.sh --web-dir apps/web/dist   # плюс собранная статика
```

Скрипт синхронизирует репозиторий в `/opt/goko/src`, подставляет `LK_HOST`
вместо `__TURN_DOMAIN__` в `livekit.yaml` и поднимает compose.

## 5. Проверка

```bash
curl -s  https://<LK_HOST>/     # ожидается OK
curl -sI https://<WEB_HOST>/    # ожидается 200
```

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
| 50000-60000/udp | LiveKit      | медиа-потоки WebRTC                     |

Порт 7880 наружу не открыт: к нему ходит только Caddy с localhost.

## 7. Откат

```bash
ssh goko 'cd /opt/goko/src/infra && docker compose --env-file /opt/goko/.env down'
```

Данные Caddy (сертификаты) лежат в томах и переживают `down`. Вернуться к
прежней версии — выкатить `deploy.sh` из нужного коммита.

## 8. Рескейл

cx23 → cx33 меняется в панели Hetzner без переезда: растут только CPU и
RAM, диск и адрес остаются. После рескейла — перезагрузка сервера,
контейнеры поднимутся сами (`restart: unless-stopped`).

---
status: living
area: infra
updated: 2026-09-14
---

# Runbook: VPS Гоко

Эксплуатация после первичной настройки (`infra/README.md`). Команды на VPS
выполняются из `/opt/goko/src/infra`. Ниже `dc` — функция оболочки:

```bash
dc() { ( set -a; . /opt/goko/.env; set +a; docker compose --env-file /opt/goko/.env "$@" ); }
```

`.env` подгружается в подоболочку: парсер `--env-file` читает строку
`KEY=   # комментарий` как значение (шапка `infra/docker-compose.yml`), а в
родительской оболочке секреты не остаются. Значения переменных из `.env` не
печатать и не вставлять в доки и issue. В командах доков — только имена
переменных (`WEB_HOST`, `LK_HOST`, `ACME_EMAIL`); адресов и хостнеймов личной
инфраструктуры нет нигде, домены сервиса записаны только в `docs/NOW.md`.

## Состав

| Сервис | Что | Порт |
|---|---|---|
| `caddy` | TLS, статика `<WEB_HOST>` из `/opt/goko/web`, `/api/*` → `API_UPSTREAM`, `<LK_HOST>` → LiveKit | 80, 443 (host) |
| `livekit` | комнаты, TURN | 7881/tcp, 3478/udp, 30000–40000/udp, 50000–60000/udp (host); 7880 — только Caddy с localhost |
| `game-server` | сессии, партии, SSE, токены, комнаты LiveKit | `127.0.0.1:8787` |
| `go-engine` | KataGo: genmove / analyze / score | не публикуется; внутренняя сеть, `go-engine:8788` |
| `voice-agent` | воркер LiveKit Agents `goko` | не публикуется; health-сервер `8081` внутри контейнера |

Снапшоты партий — `/opt/goko/data/games` (bind-mount в `game-server`,
владелец uid 1000, каталог создаёт `deploy.sh`). Логи KataGo — том
`engine_logs` (`/app/analysis_logs` в `go-engine`), один файл на запуск.
Порты Docker обходят ufw: наружу не публиковать ничего, кроме того, что в
таблице.

Логи Docker у `caddy`, `livekit`, `game-server`, `go-engine`, `voice-agent` ротируются
(`json-file`, 10 МБ × 3): в логе воркера расшифровки реплик, бессрочно они не
хранятся.

Размеры образов (сборка на ПК, задача 10): `voice-agent` ~1,1 ГБ,
`go-engine` ~0,8 ГБ, `game-server` ~0,4 ГБ; на VPS нужно около 2,5 ГБ под
образы плюс кэш сборки.

## Перед первым деплоем голосового стека

Один раз, по явной просьбе founder'а (действия на VPS). Каждая строка
печатает только `[OK]`/`[X]`, имена переменных или число.

```bash
# 1. ssh идёт под root: deploy.sh создаёт /opt/goko/data/games через install -d -o 1000
ssh goko whoami                                        # root

# 2. AVX2 на VPS: сборка KataGo по умолчанию eigenavx2
ssh goko 'grep -c avx2 /proc/cpuinfo'                  # не 0; иначе в /opt/goko/.env KATAGO_ASSET=katago-v1.18.1-eigen-linux-x64.zip и KATAGO_SHA256 этой сборки

# 3. Обязательные переменные в /opt/goko/.env заданы (печатаются только имена)
ssh goko 'set -a; . /opt/goko/.env; set +a
  for v in WEB_HOST LK_HOST LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET OPENAI_API_KEY APP_KEY ENGINE_KEY; do
    [ -n "$(printenv "$v")" ] && echo "[OK] $v" || echo "[X] $v пуст"; done'

# 3а. Режим prod, а не остатки dev: API_UPSTREAM пуст или 127.0.0.1:8787 (иначе /api уйдёт на ПК — 502),
#     AGENT_NAME пуст или goko (иначе агент goko-dev не придёт в комнаты VPS). Значения не печатаются.
ssh goko 'set -a; . /opt/goko/.env; set +a
  case "${API_UPSTREAM:-}" in ""|127.0.0.1:8787) echo "[OK] API_UPSTREAM prod";; *) echo "[X] API_UPSTREAM не prod";; esac
  case "${AGENT_NAME:-}" in ""|goko) echo "[OK] AGENT_NAME prod";; *) echo "[X] AGENT_NAME не goko";; esac'

# 4. Из контейнера доступен свой публичный LiveKit (hairpin): game-server создаёт комнаты по LIVEKIT_URL,
#    voice-agent подключается туда же. Печатается статус или имя ошибки, без адреса.
ssh goko 'set -a; . /opt/goko/.env; set +a
  docker run --rm -e LK_HOST node:22-bookworm-slim node -e "fetch(\"https://\" + process.env.LK_HOST + \"/\").then((r) => console.log(r.status === 200 ? \"[OK] LiveKit из контейнера\" : \"[X] статус \" + r.status), (e) => console.log(\"[X] LiveKit из контейнера: \" + e.name))"'

# 5. compose разбирается без ошибок (на ПК с Docker, заготовка вместо секретов; -q ничего не печатает)
docker compose -f infra/docker-compose.yml --env-file infra/.env.example config -q && echo "[OK] compose"

# 6. Партии создаются только через сессию: ни агент, ни веб, ни chat.mjs не зовут POST /api/games (D-0012)
git grep -n "createGame\|'/api/games'" -- apps/voice-agent apps/web scripts/chat.mjs \
  && echo "[X] есть вызов партии вне сессии" || echo "[OK] партии создаются только через сессию"

# 7. Место под образы
ssh goko 'df -h /'
```

`APP_KEY` в `.env` на ПК и в `/opt/goko/.env` — один и тот же ключ: он
вшивается в бандл страницы. `deploy.sh --build-web` сам сверяет sha256 обоих
значений и останавливается при расхождении; ни ключи, ни хеши не печатаются.

## Деплой (с ПК, по явной просьбе founder'а)

```bash
infra/scripts/deploy.sh --build-web      # сверить APP_KEY ПК и VPS по хешу, собрать web на ПК, выложить статику, пересобрать образы
infra/scripts/deploy.sh                  # только код и образы, статику не трогать
```

Веб собирается на ПК (`npm run build:web` → `apps/web/dist`), не на VPS;
`--build-web` вместе с `--web-dir` не указывается. Порядок `--build-web`:
проверка `/opt/goko/.env` на VPS → сверка хешей `APP_KEY` → сборка →
синхронизация репозитория и статики → `install -d` каталога партий →
`docker compose up -d --build`. Первая сборка `go-engine` качает KataGo и две
сети (около 200 МБ) и занимает несколько минут; дальше слои кэшируются.

## Логи и состояние

```bash
dc ps
dc logs -f --tail=100 voice-agent      # реплики [user]/[goko]/[tool], режим, уход и возврат участника; без значений ключей
dc logs -f --tail=100 game-server
dc logs -f --tail=100 go-engine        # старт KataGo, очередь, перезапуски
dc logs -f --tail=100 livekit
```

Признаки здоровья:

```bash
curl -s http://127.0.0.1:8787/health                 # {"ok":true,"games":N,"sessions":M}
dc exec go-engine node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.text()).then(console.log)"
curl -sI https://<WEB_HOST>/ | head -1               # HTTP/2 200
curl -s https://<LK_HOST>/                          # OK
dc logs voice-agent | grep -c "registered worker"   # не 0 — воркер зарегистрирован (без --tail: после регистрации бывает много строк заданий)
dc ps --format '{{.Service}} {{.Status}}'           # все (healthy); go-engine до 5 мин после старта — (health: starting), идёт прогрев KataGo
```

`voice-agent` в `(healthy)`, пока воркер зарегистрирован в LiveKit и жив
процесс инференса (health-сервер `@livekit/agents`, порт 8081 внутри
контейнера). При перезапуске `livekit` воркер около 1,5 минуты `unhealthy` —
это ожидаемо, `restart` на health не смотрит. Вход задания в комнату
healthcheck не проверяет: его видно по строке
`[OK] voice-agent: комната goko-<id>, сессия <id>, речь realtime`.

`[!]` Логи `npm run dev` и воркера на ПК содержат имя компьютера (строки
`lk-rtc` и поле `hostname` pino), а при ошибке подключения библиотека пишет
адрес `LIVEKIT_URL`. Такие логи не вставлять в доки, issue и отчёты как есть —
только вырезанные строки `[OK]`/`[!]`/`[X]` без имён машин и адресов. В
контейнере на VPS `hostname` — id контейнера.

## Комната, агент и возврат телефона

`POST /api/sessions` создаёт комнату `goko-<id>` с диспетчеризацией агента
(D-0001). Сроки держатся связкой констант в коде:

| Ситуация | Что происходит | Где задано |
|---|---|---|
| Телефон не вошёл | комната с одним агентом закрывается по `emptyTimeout` 300 с; агент пишет `[!] voice-agent: участник не пришёл, комната закрыта`, Realtime не открывался | `ROOM_EMPTY_TIMEOUT_SECONDS`, `apps/game-server/src/livekit.ts` |
| Телефон ушёл (погас экран, перезагрузка, обрыв) | агенты комнату не держат: LiveKit держит её `departureTimeout` 900 с после ухода последнего не-агента; агент ждёт возврата того же identity 15 минут, лог `[!] voice-agent: участник ушёл, ждём возврата 900 с` | `ROOM_DEPARTURE_TIMEOUT_SECONDS = 900` (game-server) и `RETURN_GRACE_MS = 15 * 60_000` (`apps/voice-agent/src/departure.ts`) |
| Телефон вернулся за 15 минут | тот же сеанс, режим из атрибута перечитывается | лог `[OK] voice-agent: участник вернулся` |
| Не вернулся | job завершается, комната закрывается; страница показывает «Гоко вышел из комнаты», доска работает тапами, говорить — только в новой сессии (новая вкладка) | лог `[!] voice-agent: участник не вернулся за 900 с, завершаем работу` |

`ROOM_DEPARTURE_TIMEOUT_SECONDS` и `RETURN_GRACE_MS` менять только вместе:
если комната закроется раньше таймера агента, агент уйдёт раньше своего срока.
Повторно вызвать агента в ту же комнату сейчас нельзя (эндпоинт re-dispatch —
«вариант C» в `docs/NOW.md`). Токен телефона живёт фиксированный TTL от выдачи,
а срок сессии продлевается событиями её канала (D-0008).

## Режимы и лимиты

`ENGINE_MOVE_DELAY_MS` задаёт минимальное время от начала поиска до публикации
хода Гоко: по умолчанию 1500 мс, допустимо целое значение 0–5000. Если поиск
длится дольше, сервер не добавляет паузу. Изменение применяется командой
`dc up -d game-server`.

- Режим «Голос / Чат» (D-0011) — атрибут участника `goko.mode` = `voice` |
  `chat`, в логе воркера `[OK] voice-agent: режим chat`. Тапы по доске
  работают в любом режиме. В «Чате» Realtime всё равно генерирует аудио —
  платим и за него.
- Лимиты (D-0012): `MAX_SESSIONS` (по умолчанию 3) — общий на сервер;
  незавершённых партий — 20 на сервер и 3 на клиента (адрес за Caddy по
  `TRUST_PROXY=1`); `API_RATE` — 60 запросов в минуту на адрес, `CREATE_RATE` —
  10 созданий сессий и партий за 10 минут. Сверх лимита — 429
  (`rate_limited` с `Retry-After` или `too_many_games`). Партии без сессии и
  список партий в prod выключены (`bad_request`, `reason`
  `sessionless_disabled` и `list_disabled`).
- Закрытая вкладка не освобождает сессию: слот `MAX_SESSIONS` остаётся занят до
  её TTL. На время приёмки у доски поставить `MAX_SESSIONS=8` в
  `/opt/goko/.env` и применить `dc up -d game-server`; на телефоне страницу
  перезагружать, а не закрывать. Если никто не играет и нужно освободить все
  слоты сразу, выполнить `dc restart game-server`: текущие сессии и комнаты
  потеряются.

## Проверки после деплоя

Бесплатные (Realtime не открывается: телефон в комнату не входит, агент ждёт
участника), но это действия на VPS — только по явной просьбе founder'а.
Проверка 1 занимает один слот `MAX_SESSIONS` до истечения TTL сессии
(проверка 2 смотрит на ту же сессию, 3 и 4 сессий не создают); если слот
нужен сразу, а никто не играет, — `dc restart game-server`. Значения из
`.env` читаются в подоболочке и не печатаются; ответ `POST /api/sessions`
содержит токен LiveKit, поэтому из него вырезается только id сессии.

```bash
# 1. Сессия и поток SSE через Caddy: строки должны приходить по одной, со своими метками времени,
#    а не пачкой при закрытии (flush_interval -1 на /api/*). Выход — Ctrl+C.
( set -a; . /opt/goko/.env; set +a
  SID=$(curl -s -X POST -H "X-App-Key: $APP_KEY" -H 'content-type: application/json' -d '{}' "https://$WEB_HOST/api/sessions" \
    | grep -o '"id":"[0-9a-z]*"' | head -1 | cut -d'"' -f4)
  [ -n "$SID" ] && echo "[OK] сессия $SID, комната goko-$SID" || { echo "[X] сессия не создана"; exit 1; }
  curl -sN -H "X-App-Key: $APP_KEY" "https://$WEB_HOST/api/sessions/$SID/events" \
    | while IFS= read -r line; do echo "$(date +%T) $line"; done )
```

Ожидание: `[OK] сессия …`, затем тишина около 15 с — у только что созданной
сессии партии нет, начальных событий поток не шлёт. Первая строка `: ping`
примерно через 15 с после запуска, дальше каждые 15 с (`DEFAULT_HEARTBEAT_MS`),
у каждой своя метка времени с шагом 15 с. Если строк нет до Ctrl+C и потом они
приходят пачкой — буферизует прокси: проверить `infra/Caddyfile` на VPS и
`dc up -d caddy`.

```bash
# 2. D-0001: комната с одним агентом (телефон не вошёл) закрывается по empty_timeout 300 с.
#    SID задан в подоболочке проверки 1 и здесь пуст: взять id из её строки [OK]; засечь время создания сессии.
#    Две команды -f, каждая держит терминал до Ctrl+C: запускать в двух ssh-подключениях,
#    в каждом объявить dc и SID заново.
# терминал 1
SID=<id из строки [OK] проверки 1>
dc logs -f --since 10m livekit | grep --line-buffered "goko-$SID"
```

```bash
# терминал 2
dc() { ( set -a; . /opt/goko/.env; set +a; docker compose --env-file /opt/goko/.env "$@" ); }
SID=<id из строки [OK] проверки 1>
dc logs -f --since 10m voice-agent | grep --line-buffered "goko-$SID\|участник не пришёл"
```

Ожидание: в логе LiveKit — создание комнаты `goko-<SID>` и вход агента, затем
не позже чем через 5–6 минут после создания — закрытие комнаты; в логе
воркера — `[OK] voice-agent: комната goko-<SID> …`, затем
`[!] voice-agent: участник не пришёл, комната закрыта`. Если комната живёт
дольше 10 минут, агент удерживает её от `empty_timeout`: записать `[!]` в
`docs/NOW.md` с временем и строками лога (без значений `.env`) и вынести в
D-0001 на решение founder'а. `departureTimeout` 900 с здесь не участвует: он
отсчитывается от ухода не-агента, а телефон не входил.

```bash
# 3. D-0012: за Caddy лимит частоты считает адрес клиента, а не адрес Caddy (TRUST_PROXY=1).
#    На VPS: 61 запрос через публичный адрес — последний получает 429 (60 в минуту на адрес).
#    Не раньше чем через минуту после проверок 1–2 (их запросы с VPS тоже в счёте).
( set -a; . /opt/goko/.env; set +a
  for i in $(seq 61); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-App-Key: $APP_KEY" "https://$WEB_HOST/api/games"; done \
    | sort | uniq -c )
```

Ожидание: `60 400` и `1 429`. `400` — это `list_disabled`: список партий в
prod выключен (D-0012), но лимитер стоит раньше маршрута и считает каждый
запрос. Сразу после этого, в ту же минуту, с ПК (другая сеть; `.env` на ПК,
значение не печатается):

```bash
( set -a; . ./.env; set +a; read -r -p "WEB_HOST: " H
  curl -s -o /dev/null -w '%{http_code}\n' -H "X-App-Key: $APP_KEY" "https://$H/api/games" )
```

Ожидание: `400` — у ПК свой счёт. `429` значит, что game-server видит всех
клиентов одним адресом: проверить `TRUST_PROXY` у сервиса без печати значения
(`dc exec game-server node -e "console.log(process.env.TRUST_PROXY === '1')"` →
`true`). Страницу на телефоне для этой проверки не открывать: она создаёт
сессию, агент входит в Realtime, и это платный прогон. Телефон ходит через тот
же Caddy, что и ПК, поэтому ответ ПК подтверждает и адрес телефона.

```bash
# 4. D-0012: партия без сессии в prod выключена.
#    Не раньше чем через минуту после проверки 3: она исчерпала API_RATE адреса VPS в 60-секундном окне,
#    лимитер стоит раньше маршрута, и в ту же минуту ответ был бы 429 rate_limited, а не bad_request.
( set -a; . /opt/goko/.env; set +a
  curl -s -X POST -H "X-App-Key: $APP_KEY" -H 'content-type: application/json' \
    -d '{"black":{"controller":"human"},"white":{"controller":"human"}}' "https://$WEB_HOST/api/games" )
```

Ожидание: `{"error":{"code":"bad_request","message":"games are created only inside a session","details":{"reason":"sessionless_disabled"}}}`.
Токена в ответе нет, печатать можно. Партию в сессии проверяет прогон у доски.

Проверка 5 — «партии создаются только через сессию» по коду (`git grep`) —
та же, что пункт 6 чек-листа перед первым деплоем; повторять при каждом
деплое с правками `apps/voice-agent`, `apps/web` или `scripts/chat.mjs`.

## Текстовый прогон без телефона: `npm run chat`

`scripts/chat.mjs` на ПК создаёт сессию, входит в комнату в режиме «Чат»
(`goko.mode` = `chat`), шлёт строки stdin в `lk.chat` и печатает ответы Гоко и
события партии; `/board` — доска, Ctrl+C — выход. Агента диспетчеризует тот
game-server, в который смотрит `--api` (по умолчанию `API_BASE` из `.env`):
`npm run dev` на ПК — воркер `goko-dev`, `npm run chat -- --api https://<WEB_HOST>` —
контейнер `goko` на VPS. `[!]` Это платный прогон: агент открывает Realtime,
как только участник вошёл.

```bash
npm run chat                                          # интерактивно
printf '%s\n' 'давай партию' 'дэ четыре' 'кто впереди' /board | npm run chat   # сценарий
```

Переменные ожидания в мс, необязательные: `CHAT_QUIET_MS` (5000) — тишина
после ответа; `CHAT_MAX_WAIT_MS` (60000) — потолок одного ожидания ответа;
`CHAT_RUN_MAX_MS` (300000) — потолок всего сценария из пайпа, превышение —
код 1; `CHAT_AGENT_WAIT_MS` (15000) — потолок ожидания входа агента и
приветствия. Обрыв LiveKit — код 1.

## Брошенные незавершённые партии

Завершённые снапшоты `game-server` удаляет сам через 30 дней
(`FINISHED_RETENTION_MS`). Незавершённые не удаляет никогда. Брошенной
считается партия без хода дольше `SESSION_TTL_MS` (по умолчанию 2 часа,
`STALE_GAME_MS`) и партия, заменённая новой в своей сессии: у второй рядом со
снапшотом лежит пустой файл `<id>.abandoned` (D-0012). Брошенная в лимиты
(20 на сервер, 3 на клиента) не идёт, пока к ней не вернулись, но файлы
остаются и загружаются в память при каждом старте. Чистить руками, когда
`games` в `/health` заметно растёт, или раз в месяц.

```bash
# Список: незавершённые партии без активности дольше DAYS дней. Печатает только имя файла,
# время последнего хода и число ходов — ни ключей, ни окружения. go-engine не поднимается (--no-deps).
DAYS=7
dc run --rm --no-deps -T -e DAYS=$DAYS game-server node -e '
const fs = require("fs");
const dir = "/data/games";
const cutoff = Date.now() - Number(process.env.DAYS) * 86400000;
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  let g;
  try { g = JSON.parse(fs.readFileSync(dir + "/" + name, "utf8")); } catch { console.log("[!] не читается:", name); continue; }
  const last = Date.parse(g.moves.at(-1)?.at ?? g.createdAt);
  const mark = fs.existsSync(dir + "/" + name.slice(0, -".json".length) + ".abandoned") ? "отметка смены" : "";
  if (g.status === "playing" && last < cutoff) console.log(name, new Date(last).toISOString(), "ходов:", g.moves.length, mark);
}'
```

Удаление — только файлов из списка, просмотренного глазами, и при
остановленном `game-server`: работающий сервер держит партии в памяти и
перепишет удалённый файл следующим ходом.

```bash
dc stop game-server                     # до 30 с; сессии и комнаты теряются
cd /opt/goko/data/games && rm -i <id>.json <id>.abandoned   # имена из списка, отметку вместе со снапшотом (её может не быть); *.tmp — остатки оборванной записи, их тоже можно
cd /opt/goko/src/infra && dc start game-server
```

Логи KataGo в томе `engine_logs` растут на файл за запуск движка; место —
`docker system df -v`, очистка — `dc exec go-engine sh -c 'find /app/analysis_logs -type f -mtime +30 -delete'`.

## Перезапуск и обновление одного сервиса

```bash
dc restart voice-agent                  # без пересборки
dc up -d --build voice-agent            # пересобрать один сервис из уже синхронизированного /opt/goko/src
dc up -d --build go-engine              # то же для движка; партии в это время получат engine_unavailable
```

`game-server` при рестарте загружает снапшоты из `/opt/goko/data/games`;
сессии и комнаты LiveKit при этом теряются — телефон создаст новую сессию сам.
Остановка `game-server` и `go-engine` может занять до 30 с (`stop_grace_period`,
D-0010): сервис дожидается запросов и гасит KataGo, ждать без `docker kill`.
`voice-agent` останавливается до 60 с: drain 5 с, затем идущие сеансы
закрываются — разговор у доски при этом обрывается, деплой голоса — вне партии.
После рестарта `go-engine` до 5 минут в `(health: starting)` — прогрев KataGo;
ходы в это время получают `engine_unavailable` и повторяются сервером.

## Режимы API: prod и dev

В `/opt/goko/.env`:

- prod: `API_UPSTREAM=127.0.0.1:8787` — контейнер `game-server` на VPS, воркер `goko` в контейнере.
- dev: `API_UPSTREAM=http://<tailscale-ip-ПК>:8787` — game-server и воркер `goko-dev` на ПК (`npm run dev`), VPS даёт только TLS, LiveKit и статику.

Переключение:

```bash
dc up -d caddy                          # перечитать API_UPSTREAM
```

В dev-режиме контейнер `voice-agent` может оставаться запущенным: имя `goko`
в комнаты dev-сессий не диспетчеризуется (game-server на ПК создаёт комнаты с
диспетчеризацией `goko-dev`).

`[!]` `npm run dev` запускает game-server с `ALLOW_SESSIONLESS_GAMES=1` и без
`TRUST_PROXY`: пока Caddy смотрит на ПК, `POST /api/games` открыт всем, у кого
есть `APP_KEY` из бандла, а лимиты частоты и партий считают всех клиентов
одним адресом Caddy. Держать dev-режим только на время отладки и возвращать
prod тем же `dc up -d caddy`.

## Откат

Два разных действия, не последовательность: либо вернуть прежнюю версию,
либо остановить всё.

Вернуть прежнюю версию (на ПК, по явной просьбе founder'а):

```bash
git checkout <commit>
infra/scripts/deploy.sh --build-web
git checkout -        # вернуться на ветку в любом случае, даже если деплой упал
```

`--build-web` есть в `deploy.sh` начиная с задачи 10 плана голоса и веба.
Скрипт более раннего коммита выйдет с `unknown arg --build-web` и ничего не
выкатит: откат на такой коммит этим способом не делается.

Остановить всё, включая Caddy и LiveKit (на VPS; страница и `/api` перестают
отвечать):

```bash
dc down
```

Снапшоты партий при откате не трогаются; формат снапшота обратно совместим в
пределах стадии 1.

## Место и ресурсы

```bash
df -h /                                 # диск
docker system prune -f                  # старые слои образов после пересборок
dc stats --no-stream                    # CPU/RAM; go-engine ограничен ENGINE_CPUS
```

Если `analyze` регулярно упирается в таймауты (`engine_busy` в логах
game-server), поднять `ENGINE_CPUS` или сделать рескейл cx23 → cx33 в панели
Hetzner (только CPU/RAM, без переезда; по явной просьбе founder'а), затем
`dc up -d go-engine`.

## Секреты

`APP_KEY` попадает в клиентский бандл и не защищает от расходов OpenAI. До
первого разговора с телефона в OpenAI Project Settings открыть
`Limits` → `Spend` → `Edit spend limit`, задать месячный лимит без суммы в
репозитории, включить `Enforce a hard limit` и сохранить. Оповещения настроить
отдельно: они сообщают о расходах, но не останавливают их. Применение жёсткого
лимита не мгновенное, поэтому возможен небольшой перерасход. Факт настройки
проверить в аккаунте перед прогоном. Источник: [OpenAI Spend limits](https://developers.openai.com/api/docs/guides/spend-limits).

Ротация любого ключа: поправить `/opt/goko/.env` (и `.env` на ПК для
`APP_KEY`, `LIVEKIT_*`), затем `dc up -d` для затронутых сервисов;
`APP_KEY` требует ещё `deploy.sh --build-web` (он же сверит хеши ПК и VPS).
`dc config` без `-q` раскрывает значения — в терминал с историей и в доки не
выводить.

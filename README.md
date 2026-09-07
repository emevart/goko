# Гоко

Голосовой соперник по го для игры на физической доске 13×13.

Телефон лежит рядом с доской. Вы говорите «давай партию», ставите камни на
настоящую доску и называете ходы вслух: «дэ четыре». Гоко отвечает голосом,
называет свой ход, обсуждает позицию, принимает пас, сдачу и «отмени». На
экране — доска и лента диалога, чтобы перечитать, если что-то не расслышали.
Регистрации нет, истории партий нет.

Позицию, ходы и счёт ведёт KataGo с «человеческой» сетью (уровень задаётся
рангом, например 10 кю). Разговор — OpenAI Realtime через LiveKit Agents.
Телефон общается только с нашим сервером, VPN на телефоне не нужен.

Статус: `[WIP]` спека написана, код ещё не начат. Стадии и критерии — в спеке.

## Как это устроено

```
телефон ── WebRTC ──► LiveKit ◄── воркер voice-agent ──► OpenAI Realtime
   │                                    │
   └── HTTPS/SSE ──► game-server ◄──────┘  (операции и события)
                         │
                     go-engine (KataGo)
```

Ядро — `game-server` с операциями и событиями. Голос, веб и MCP-сервер
(стадия 2, для других агентов) — три фасада над одним протоколом. Подробно:
[спека](docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md).

## Репозиторий

| Путь | Что |
| --- | --- |
| `packages/protocol` | zod-схемы операций, ошибок, событий; HTTP-клиент |
| `packages/go-core` | правила доски, координаты `A–N` без `I`, счёт, SGF |
| `apps/game-server` | сессии, партии, SSE, вызов движка, токены LiveKit |
| `apps/go-engine` | обёртка над KataGo: genmove / analyze / score |
| `apps/voice-agent` | воркер LiveKit Agents: инструменты и промпт Гоко |
| `apps/web` | одна страница: доска, лента, микрофон |
| `apps/mcp-server` | стадия 2 |
| `infra/` | docker-compose, Caddy, LiveKit, скрипты VPS |
| `docs/` | [карта документации](docs/README.md), [текущий фокус](docs/NOW.md) |

Проект разрабатывается AI-first: код пишут агенты, правила для них — в
[CLAUDE.md](CLAUDE.md) и [AGENTS.md](AGENTS.md).

## Запуск `[WIP]`

Команды появятся на стадии 1: `npm run doctor`, `npm run dev`,
`npm run check`, `npm run smoke`. Для голоса нужен VPS с LiveKit
(`infra/`), ключ OpenAI и KataGo с сетями (`apps/go-engine/README.md`).

## Лицензия

`[TODO]` не выбрана. До выбора действуют права по умолчанию.

---

*Goko is a voice Go opponent for a physical 13×13 board: a phone next to the
board, moves spoken aloud in Russian, KataGo keeps the position, OpenAI
Realtime talks. Docs are in Russian.*

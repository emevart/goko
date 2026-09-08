# Спайки стадии 0

Одноразовые скрипты для проверки фактов перед стадией 1. В продакшен-код не
идут: стадия 1 переписывает проверенное в `apps/`.

- `katago-bench.mjs` — замер analysis engine KataGo на доске 13x13:
  `humanPolicy` (1 visit), genmove (10), analyze (50), score (400).

  ```bash
  node spike/katago-bench.mjs --bin <katago> --model <main> --human <human> [--config <cfg>]
  ```

  Без `--bin` берётся `KATAGO_BIN`, без `--config` —
  `apps/go-engine/config/analysis.cfg`. Сети и бинарь качаются по
  `apps/go-engine/models/README.md` и в git не попадают. Если в выводе
  `human=NO`, в `-human-model` подан не тот файл или KataGo старше 1.15.

## Голосовой спайк

- `agent.ts` — воркер LiveKit Agents с OpenAI Realtime: голос по-русски,
  инструмент `play_move` без движка (отвечает ходом из списка-заглушки),
  лог реплик и вызовов в `spike/log.jsonl` (в git не идёт).
- `token.mjs` — токен участника с диспетчеризацией агента `AGENT_NAME`;
  печатает URL страницы спайка с `#url=...&token=...`.
- `public/index.html` — одна страница без сборки: микрофон, лента
  расшифровок, отправка текста в `lk.chat`.
- `phrases.md` — 30 фраз с ожидаемыми координатами для проверки русского
  распознавания.

```bash
npm run agent -w spike   # регистрирует воркера, ждёт задания
npm run token -w spike   # печатает комнату и URL страницы
```

Обе команды читают `.env` в корне репозитория: `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `WEB_HOST`,
`AGENT_NAME`. Значения не коммитить и не печатать.

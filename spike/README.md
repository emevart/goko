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

---
status: living
area: product
updated: 2026-10-05
---

# Cloud: повтор хода и полировка Гоко

Итерация развивается из `0a634bc` ветки `codex/cloud-ux-voice`, поверх main
`af85481` и подготовленного Cloud-контура. Работа выполняется в опубликованном
приватном `goko`: координатор ведёт документы, единственный Sol xhigh пишет
код, Astra проверяет архитектуру и независимо ревьюит результат. Основание —
[бриф](../process/2026-10-05-cloud-continuation.md) и
[D-0017](../decisions/0017-cloud-repeat-and-ui.md).

## Поведение

`repeat_last_move` одним GET получает актуальную историю и повторяет последний
записанный ход engine-места. Undo/correct меняют источник повторения; пас только
произносится. Pending-ответ явно отделяется от уже записанного хода. Смена
партии/поколения и более новая наблюдённая ревизия отклоняют поздний результат.
Инструмент не меняет игру или служебные флаги, проходит общую очередь tools и
показывает состояние работы орба. Repeat услышанного и redo остаются разными
действиями.

Backend и GPT-Live просят уточнить отдельную неоднозначную «и»/I до мутации,
сохраняя союз «и» и букву «е»/Е. Это инструкции модели, без grammar whitelist
или изменения парсера координат. Unit-проверка текста промпта не доказывает
выбор модели на настоящей речи.

HTTP-регрессия использует настоящий router/service/protocol client и deferred
fake engine. Undo завершается до освобождения старого analyze; старый
expectedRevision получает 409 revision_conflict, актуальный запрос успешен.
Существующие серверные guards из main не переписаны.

Доска получила мягкую деревянную поверхность и рамку, камни — объём и контраст.
Статус партии виден вместе с полным отказом. Кнопки, focus/hover и панели
согласованы в двух темах; composer, redo, диагностика и hold-drag сохранены.
Reduced-motion использует CSS-орб без canvas; потеря WebGL-контекста освобождает
сцену и сохраняет подпись/mute. Обычный голосовой режим сохраняет живой 3D-орб.

## Проверки и воспроизведение

Финальные проверки замороженного source/test диффа в Codex Cloud:

| Проверка | Результат |
| --- | --- |
| `npm run check` | PASS: typecheck, 1599 passed / 13 skipped |
| `npm run smoke` | PASS: настоящий HTTP/SSE с fake engine |
| `npm run build:web` | PASS: production-сборка, mock-маркеры отсутствуют |
| `npm run test:browser` | PASS: 64/64, штатный pinned Chromium 153.0.8010.12, 1.7 мин |
| Независимое ревью Astra | OK, существенных замечаний нет; 283 целевых теста прошли независимо |
| Offline transport preflight | `blocked_proxy_transport`, networkCalls: 0 |

После каждого gate subreaper подтверждает отсутствие собственных живых или
завершённых потомков. После Chromium порты 4173/8787 свободны; собраны 19
сирот тестового дерева. Первая попытка check попала в test-first RED offline
script (два новых теста), после GREEN повторён полный check. Итоговые counts
относятся к последнему замороженному диффу, не к промежуточному прогону.
Тестовые fixture завершают только созданные ими игры, не ослабляя лимит 20
активных партий. Windows/Ubuntu CI прежней подготовки — отдельное evidence;
эти результаты получены в текущем Cloud, новый CI фиксируется в PR.

В текущем Cloud используются сохранённые команды с subreaper:

```bash
python3 /workspace/goko-cloud-subreaper.py npm run check
python3 /workspace/goko-cloud-subreaper.py npm run smoke
python3 /workspace/goko-cloud-subreaper.py npm run build:web
python3 /workspace/goko-cloud-subreaper.py npm run test:browser
```

На обычном Linux CI/Windows нужен стандартный npm CLI, отдельный subreaper —
особенность PID 1 текущего образа. Бесплатный preview использует настоящий
HTTP/SSE game-server, fake engine и e2e-only LiveKit. Он не наследует `.env`,
OpenAI/LiveKit/KataGo-секреты; production build сохраняет настоящий LiveKit.

CLI screenshot matrix: 360×640, 390×844, 1440×900 × light/dark × cold/game/
history/newgame/refusal/voice-fallback. Артефакты не входят в git:
`.agent-artifacts/cloud-product/{before,after}/`, включая manifest. Baseline
снят до UI-правок. Сняты 36 before и 36 after; координатор просмотрел игру в
обеих темах, отказ/историю/newgame и CSS voice fallback на телефонах, а также
desktop. Камни/last marker различимы, отказ целиком, composer остаётся виден.
Для повторения after сначала запустить свой бесплатный
preview в отдельном терминале, затем helper и остановить только свой preview:

```bash
python3 /workspace/goko-cloud-subreaper.py npm run preview
python3 /workspace/goko-cloud-subreaper.py node scripts/screenshot-matrix.mjs after
```

Матрица проверяет mock-медиа и интерфейс; она не доказывает STT или настоящий
разговор. На 360×640 открытый диалог уступает часть высоты доски; его можно
свернуть, composer и игровые действия остаются доступны.

## Настоящий голос: ограничение до подключения

Бюджет founder: максимум два provider-сеанса и 180 секунд суммарно. Использовано
**0 сеансов, 0 секунд**; длительностей сеансов нет, подключения не начинались.
Аудит сохранён вне git в `.agent-artifacts/cloud-product/voice-budget.json`.
Raw OpenAI-ключ не читался, не печатался и не копировался в `.env`.

Установленный workspace SDK `@livekit/agents-plugin-openai` 1.8.1 создаёт ws
без явного agent. `ws` 8.21.3 задаёт собственный createConnection, поэтому
Node 24 `--use-env-proxy` не направляет его через proxy-aware globalAgent.
Офлайн перехват всех net/tls/Socket/DNS вызовов подтверждает попытку direct
provider; явный agent выбирает фиктивный proxy. Ни один сокет не открывается.
Это ограничение stock SDK, а не результат настоящего CONNECT/Upgrade:
подстановка network secret и реальный голосовой endpoint не проверены.

Воспроизведение без credentials и сети:

```bash
node scripts/cloud-voice-preflight.mjs
```

Полный offline probe требует Node 24; Node 22 возвращает безопасный
`inconclusive/unsupported_node` до создания child. Несовпадение версии или
структуры SDK также даёт inconclusive. `--run` отсутствует и отклоняется.
Фактический JSON лежит в `.agent-artifacts/cloud-product/offline-transport.json`.

Не выполнялись direct обход, патч SDK/node_modules или новая транспортная
адаптация. Для будущего bounded runner нужны общий ledger до start, hard
deadline с finally close, maxRetry:0/maxSessionDuration:null и ранний guard
session.closed: сам maxRetry:0 не исключает штатный reconnect SDK.

Реальные voice D4, неоднозначная «и», повтор без redo и факты позиции остаются
непройденными. STT, произношение на слух, кашель/наложение речи и физический
телефон требуют отдельной приёмки. Большие платные eval-корпуса не запускались.

## Передача результата

Рабочий [draft PR #8](https://github.com/emevart/goko/pull/8) остаётся базой
проверяемого изменения. Стадии 2+ (MCP, аккаунты и история как подсистема)
требуют отдельной спеки/плана. Deploy, merge, VPS, DNS и tailnet не выполняются;
конфигурация опубликованной среды не изменяется и не перепубликуется.
Брифы/архитектура/execution/review reports сохранены вне git в
`.superpowers/sdd/2026-10-05-cloud-product/`. Перечень разрешённых доменов,
включая добавленный владельцем GitHub API, записан в
[cloud-codex.md](../process/cloud-codex.md). Штатный `attach_artifact` в этом
Cloud-чате не предоставлен; PR доступен через `gh`, снимки — как локальные
артефакты Cloud-ответа и воспроизводимая CLI-матрица.

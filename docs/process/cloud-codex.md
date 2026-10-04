---
status: living
area: process
updated: 2026-10-05
---

# Codex Cloud и браузерные проверки

Cloud-контур нужен для бесплатных проверок кода без production-секретов, VPS,
KataGo, GPU и сетевого медиа. Game-server в нём настоящий: браузер ходит к нему
по HTTP и SSE. Ходы движка случайные (`FAKE_ENGINE=1`), а LiveKit заменён только
в Vite mode `e2e`. Production-сборка эту подмену не получает.

## Актуальный Codex Cloud

Приватное окружение `goko` для `emevart/goko` создано и опубликовано 05.10.
Продолжение — [бриф текущей итерации](2026-10-05-cloud-continuation.md).
Для подготовленной ветки используются следующие настройки:

**Install script**

```bash
bash scripts/cloud-install.sh
```

Скрипт проверяет Node 22.18+, выполняет `npm ci` и ставит Chromium с системными
зависимостями. Для установки нужен доступ к npm registry, Debian/Ubuntu mirrors
и CDN браузеров Playwright. Бесплатные проверки не требуют переменных
окружения и Network secrets. Разрешены набор «Менеджеры пакетов»,
`cdn.playwright.dev`, `playwright.download.prss.microsoft.com` и `api.openai.com`.
С разрешения founder сохранён существующий `OPENAI_API_KEY` как Network secret
только для `api.openai.com`; окружение доступно только владельцу. Это не raw key
в checkout: облачный proxy подставляет значение на разрешённом HTTPS-запросе.

**Start skill**

```text
Работай из корня репозитория. Для автоматической проверки запускай npm run
test:browser: Playwright сам поднимет и корректно остановит бесплатный preview.
Для ручного осмотра из CLI запусти npm run preview, дождись строки [OK] preview
и используй http://127.0.0.1:4173; останови Ctrl+C. Preview не читает .env,
использует настоящий HTTP/SSE game-server, fake engine и mock LiveKit. Не
запускай KataGo, voice-agent, OpenAI, VPS или платные аудио-тесты. Основную
задачу выполняй на GPT-6.1 Sol с reasoning xhigh; Astra используй для сложного
ревью и независимой проверки.
```

Сохранение файлов в ветке само по себе не обновляет опубликованное окружение.
После изменения install/start его нужно повторно опубликовать и начать новую
задачу именно в `goko`: существующая задача не получает новый snapshot
автоматически. Если checkout ещё на main без browser harness, сначала получить
ветку `codex/cloud-ux-voice` и выполнить её `scripts/cloud-install.sh`.

По текущей документации Codex Cloud не предоставляет browser computer use.
Браузерные сценарии выполняются
через Playwright CLI; HTML-отчёт, trace, видео и скриншоты отказов лежат в
`.agent-artifacts/playwright/` и игнорируются git.

## Команды

```bash
npm run preview               # ручной preview: http://127.0.0.1:4173
npm run test:browser          # все сценарии Chromium
npm run test:browser -- --grep "текст"  # один сценарий
```

Preview использует loopback-порты 4173 и 8787. Он не загружает `.env`; временные
снапшоты партий удаляются при штатной остановке. В логах явно помечены fake
engine и mock LiveKit. В автоматическом Chromium Playwright подставляет fake
microphone. При ручном открытии preview обычный браузер запросит настоящий
микрофон только после явного нажатия кнопки голоса; такой осмотр не подтверждает
качество или production-маршрут голоса.

## CI

Workflow `.github/workflows/ci.yml` на Node 22.18 выполняет `npm ci`, ставит
Chromium, затем запускает `npm run check`, `npm run smoke`, `npm run build:web`
и `npm run test:browser`. Общий потолок job — 20 минут. При отказе Playwright
артефакты сохраняются на 7 дней.

Legacy Codex Cloud setup/maintenance для этого проекта не нужен. Используется
актуальная модель окружения с полями Install script и Start skill.
Источник: [официальная документация Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments).

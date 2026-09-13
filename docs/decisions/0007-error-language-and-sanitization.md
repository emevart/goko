---
status: living
area: architecture
updated: 2026-09-13
---

# D-0007: язык ошибок и санитизация

- Дата: 2026-09-13
- Решили: founder + агент (ревью задачи 12 и пакета правок 12b, стадия 1)
- Уточняет: спека, раздел 5; меняет протокол `packages/protocol`

## Контекст

Тексты ошибок были вперемешку: приложение по-русски, сервис и хранилище
по-английски. Сырой текст исключения (с путями сервера) уходил в событие
`error`. Клиенты — голос и веб — по плану показывали и озвучивали `message`
как есть.

## Решение

- `message` всех ошибок сервера — по-английски, для разработчика и логов, без
  путей, стеков и текста чужих исключений. Тексты ошибок программиста
  (конструкторы, проверки опций) — тоже по-английски.
- Русский текст для человека клиент строит по `code` и `details`:
  `humanText(code, details)` из `@goko/protocol` с таблицами `ERROR_TEXT` и
  `ILLEGAL_REASON_TEXT`. Неизвестный код — текст `internal`.
- Событие `error` для непредвиденного исключения несёт только код и
  нейтральный текст: `internal server error` или `engine is unavailable`.
- Граница движка: клиент go-engine отдаёт фиксированные `message`
  (`engine is unreachable`, `engine response does not match the protocol`,
  `engine responded with <status>`, `engine error: <code>`). Коды
  `engine_busy` и `engine_unavailable` go-engine проходят своим кодом, прочие
  (`unauthorized`, `bad_request`, `internal`) — как `internal` (500).
  `details` go-engine наружу не проходят; исходная ошибка лежит в `cause` и
  попадает в строку лога `[!] game-server: <METHOD> <path>: <текст>` после
  вычистки секретов.
- Тело больше 64 КБ — `400 bad_request` с `details.maxBytes` (кода 413 нет);
  ключ `X-App-Key` проверяется раньше размера. `ZodError` не из разбора тела —
  500 `internal`.

## Последствия

- Смена формулировки `message` не ломает клиентов: `npm run smoke` и тесты
  сверяют `code` и `details`, не текст.
- План голоса и веба переведён на `humanText`.

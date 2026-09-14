---
status: living
area: process
updated: 2026-09-15
---

# Единый разговор: ход реализации

Founder после отзыва о первой партии поручил продолжить самостоятельно и
разрешил новую партию для проверки. Основание — D-0014, спека и план 15.09.

- `[OK]` b021e83: redo через протокол/сервер/клиент, история в снапшоте,
  публичный canRedo; отменяемый темп движка. Typecheck,530tests,smoke прошли.
- `[OK]` b138109: по независимому ревью добавлена семантическая проверка
  загруженной redo-цепочки и монотонный таймер.216tests/typecheck; re-reviewPASS.
- `[OK]` fb1e894: cedar/far_field/semantic_vad, более содержательный prompt,
  расширенная оценка позиции, redo голосом, topic завершения ответа.
  Check1371passed/13skipped; после узкой финальной правки305passed/8skipped.
- `[OK]` 0f4e0f5: по reviewP1 ограничены очередь и зависшие отправки событий,
  время фиксируется в listener, cleanup прекращает новые отправки.9tests,
  typecheck, re-reviewPASS. Внутренние отчёты остаются вне tracked tree.
- `[OK]` HTTP-проверка локального сервера с fake engine:1525мс до ответа,
  точное восстановление coord/at, поздний ход после undo не применён.
- `[OK]` 7c0daae: единый веб-разговор, орб, toolbar/history и локальная запись.
  Web: 75 tests, typecheck/build прошли. Полный check:1394passed/13skipped,
  smoke прошёл.
- `[OK]` Бесплатный Chromium:1280×720, iframe360×640/390×844 без
  горизонтального переполнения; new game, undo/redo результата двух пасов,
  история и ввод текста. Реальный MediaRecorder сохранил две декодируемые
  дорожки по2.16с, оригинальные tracks продолжили работать.
- `[OK]` 08c881e: независимое web-ревью — SID lifetime текстовых stream, остановка
  записи при ended mic без Web Audio, ложный статус отсутствующего агента,
  stale mutation сбрасывает thinking новой партии. Исправлено,82webtests,
  typecheck/build прошли. В реальном Chromium штатный stop и inactive-before-stop
  сохранили обе дорожки по34969bytes/2.16с, originals остались live.
- `[OK]` e340538: expectedRevision для undo/redo в обоих каналах; via при
  создании партии; generation и observedRevision защищают AgentState от
  позднего результата инструмента. Последовательный tap undo → voice redo
  использует свежую ревизию.497scopedtests и1409passed/13skipped fullcheck.
  Smoke/build повторены успешно.
- `[OK]` 26c255e: startGame отвергает поздний ответ меньшей ревизии своей
  уже начавшейся партии; regression и rereview PASS.
- `[OK]` Один живой прогон: D4 → K10,1516мс, get_position/get_assessment,
  undo кнопкой → redo через агента → сдача. Запись128с, обе дорожки декодированы,
  шесть финальных текстов UI совпали с completion events.
- `[OK]` 0382dc5: обнаруженный в live user STT relay с identity телефона
  принимается как речь игрока; чужой sender отклоняется. Повтор той же
  контрольной фразы в той же сессии показал строку игрока в чате; новых партий нет.
  Review и финальный check1412passed/13skipped, build PASS.
- `[OK]` Свои локальные процессы и временные вкладки остановлены.
  Production deploy не выполнялся. [Полная приёмка](../research/2026-09-15-conversation-acceptance.md).

Read-only GET модели `gpt-live-1` вернул200; live endpoint и tools не
проверялись. Адаптер опубликован в LiveKit1.8.1, текущий путь остаётся на1.8.0
Realtime до отдельного сравнительного прототипа. Новых платных прогонов на
первый checkpoint не было; затем использована одна разрешённая живая партия.
Полный звук на телефоне и Safari проверяются отдельно от Chromium и unit-тестов.

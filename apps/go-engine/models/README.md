# Сети KataGo

Файлы в этой папке в git не попадают. Скачать в `apps/go-engine/models/`:

- Человеческая (обязательна): `b18c384nbt-humanv0.bin.gz`
  https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
- Основная, кандидат 1 (быстрая): `kata1-b10c128-s1141046784-d204142634.txt.gz`
  https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz
- Основная, кандидат 2 (сильнее): `kata1-b15c192-s1672170752-d466197061.txt.gz`
  https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b15c192-s1672170752-d466197061.txt.gz

Расширение `.txt.gz`, а не `.bin.gz`: по этому каталогу `.bin.gz` отдаёт 403
(проверено 08.09). KataGo читает оба формата.

Если ссылка на media.katagotraining.org отдаёт 404, взять файл с той же архитектурой
в разделе «older networks» на https://katagotraining.org/networks/ и записать имя сюда.

Бинарь на ПК: `katago-v1.18.1-opencl-windows-x64.zip` из
https://github.com/lightvector/KataGo/releases/tag/v1.18.1, распаковать в
`apps/go-engine/bin/` (в git не попадает), путь к `katago.exe` — в `KATAGO_BIN`.
Первый запуск OpenCL тюнит ядра 1–3 минуты; это нормально.

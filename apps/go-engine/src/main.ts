// Точка входа go-engine. Вся логика запуска — в start-engine.ts, который импортируют тесты;
// здесь только вызов. Стража «запущен ли файл напрямую» нет намеренно: сравнение путей
// ломается на symlink/junction, и сервис молча выходил бы с кодом 0.
import { startEngine } from './start-engine.ts';

await startEngine();

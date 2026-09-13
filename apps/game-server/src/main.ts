// Точка входа game-server. Вся логика запуска — в start-server.ts, который импортируют тесты;
// здесь только вызов. Стража «запущен ли файл напрямую» нет намеренно: сравнение путей
// ломается на symlink/junction, и сервер молча выходил бы с кодом 0.
import { startServer } from './start-server.ts';

await startServer();

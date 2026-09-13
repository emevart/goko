import { randomBytes } from 'node:crypto';

// Короткий идентификатор, сортируемый по времени: base36 времени + 6 hex случайных.
export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex');
}

// Предел длины идентификатора: newId() даёт 14 символов, запас на годы вперёд и на чужие id.
export const MAX_ID_LENGTH = 64;
// Только цифры и строчные латинские буквы, как у newId(): ни разделителей пути, ни точек.
const ID_PATTERN = /^[0-9a-z]+$/;
// Зарезервированные имена устройств Windows: `con.json` там не файл, а консоль, и снапшот ушёл бы
// в никуда. Регистр не важен для Windows, но заглавные уже отвергает ID_PATTERN, поэтому образец
// строчный. COM0 и LPT0 Windows тоже резервирует, хотя их нет в старых списках.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

// Годится ли идентификатор в имя файла снапшота на любой ОС. Проверяется до обращения к файловой
// системе: id вида '../escaped' иначе написал бы файл за пределами каталога снапшотов.
export function isSafeId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id) && !WINDOWS_RESERVED.test(id);
}

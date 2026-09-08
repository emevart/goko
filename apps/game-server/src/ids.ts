import { randomBytes } from 'node:crypto';

// Короткий идентификатор, сортируемый по времени: base36 времени + 6 hex случайных.
export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex');
}

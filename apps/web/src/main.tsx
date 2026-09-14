// Заглушка входа (задача 6): сборка проверяет пакеты workspace с exports на .ts. Задача 8 заменяет файл страницей.
import { formatCoord } from '@goko/go-core';
import { createClient } from '@goko/protocol';
import { describeError } from './text.ts';

const client = createClient({ baseUrl: import.meta.env.VITE_API_BASE || location.origin, appKey: import.meta.env.VITE_APP_KEY });
const root = document.getElementById('root');
if (root) {
  root.textContent = `Гоко: ${formatCoord({ col: 3, row: 3 })}`;
  client.listGames().catch((e: unknown) => {
    root.textContent = describeError(e);
  });
}

// Один клиент протокола на страницу. VITE_API_BASE пустой — тот же origin (Caddy на VPS или прокси Vite в dev).
import { createClient } from '@goko/protocol';

export const client = createClient({
  baseUrl: import.meta.env.VITE_API_BASE || window.location.origin,
  appKey: import.meta.env.VITE_APP_KEY,
});

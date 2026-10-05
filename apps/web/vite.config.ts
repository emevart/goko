// APP_KEY из корневого .env попадает в бандл как VITE_APP_KEY (телефон шлёт его в X-App-Key) — так задумано
// спекой; других переменных .env в бандле нет. В dev /api проксируется в game-server.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Бесплатный preview/e2e принципиально не читает .env: ключи ему не нужны, LiveKit заменён локальной заглушкой.
  const e2e = mode === 'e2e';
  const env = e2e ? {} : loadEnv(mode, root, '');
  return {
    plugins: [react()],
    envDir: e2e ? false : undefined,
    resolve: e2e
      ? { alias: { 'livekit-client': fileURLToPath(new URL('./src/e2e/livekit-client.ts', import.meta.url)) } }
      : undefined,
    define: {
      'import.meta.env.VITE_APP_KEY': JSON.stringify(e2e ? 'goko-preview' : env.APP_KEY ?? ''),
      'import.meta.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE ?? ''),
    },
    server: {
      proxy: { '/api': { target: `http://127.0.0.1:${env.PORT ?? '8787'}` } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});

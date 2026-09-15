// APP_KEY из корневого .env попадает в бандл как VITE_APP_KEY (телефон шлёт его в X-App-Key) — так задумано
// спекой; других переменных .env в бандле нет. В dev /api проксируется в game-server.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_KEY': JSON.stringify(env.APP_KEY ?? ''),
      'import.meta.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE ?? ''),
    },
    server: {
      proxy: { '/api': { target: `http://127.0.0.1:${env.PORT ?? '8787'}` } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});

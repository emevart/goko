#!/usr/bin/env node
// Бесплатный локальный game-server для preview/e2e: реальный HTTP/SSE, фейковый движок,
// временные данные и заглушка комнаты. process.env и .env намеренно не читаются.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../apps/game-server/src/start-server.ts';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const providedDataDir = arg('--data-dir');
const readyFile = arg('--ready-file');
const dataDir = providedDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'goko-preview-'));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (!providedDataDir) rmSync(dataDir, { recursive: true, force: true });
}

await startServer({
  env: {
    APP_KEY: 'goko-preview',
    LIVEKIT_URL: 'ws://127.0.0.1:65535',
    LIVEKIT_API_KEY: 'preview-key',
    LIVEKIT_API_SECRET: 'preview-secret',
    AGENT_NAME: 'goko-preview',
    FAKE_ENGINE: '1',
    DATA_DIR: dataDir,
    MAX_SESSIONS: '100',
    ENGINE_MOVE_DELAY_MS: '0',
    PORT: '8787',
    HOST: '127.0.0.1',
    TRUST_PROXY: '1',
  },
  createRooms: () => ({
    createRoom: async () => undefined,
    listDispatch: async () => [],
    deleteDispatch: async () => undefined,
    createDispatch: async () => undefined,
  }),
  exit: (code) => {
    cleanup();
    process.exit(code);
  },
});

if (readyFile) writeFileSync(readyFile, 'ready', { flag: 'wx' });

process.on('exit', cleanup);

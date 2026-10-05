import { allGroups, indexToCoord, play, replay, toAscii } from '@goko/go-core';
import { ApiError, type GameState } from '@goko/protocol';
import { createFakeClient, fakeGame } from './fake-client.ts';
import { newAgentState } from '../state.ts';

export type ProbeCase = { kind: 'free' | 'play' | 'repeat' | 'ambiguity' | 'facts'; text: string };
export const scenarios: Record<'first' | 'ambiguity' | 'facts' | 'repair', ProbeCase[]> = {
  first: [
    { kind: 'free', text: 'Ты больше любишь смелую игру или спокойную? Ответь коротко, как соперник за доской.' },
    { kind: 'play', text: 'Сыграй D4.' },
    { kind: 'repeat', text: 'Повтори свой последний ход — я его не расслышал.' },
  ],
  ambiguity: [
    { kind: 'ambiguity', text: 'Поставь на и четыре.' },
    { kind: 'facts', text: 'Какие камни сейчас стоят на доске? Следующий ход не советуй.' },
  ],
  facts: [{ kind: 'facts', text: 'Какие камни сейчас стоят на доске? Следующий ход не советуй.' }],
  repair: [{ kind: 'play', text: 'Мой ход чёрными D4.' }, { kind: 'repeat', text: 'Какой был твой последний ход? Только повтори его.' }],
};
export function createProbeGame(seeded = false) {
  const client = createFakeClient({ replies: ['K10'], analysis: { topMoves: [], groups: [], scoreLeadB: 0, winrateB: 0.5 } });
  client.game = fakeGame(seeded ? { moves: [
    { n: 1, color: 'B', coord: 'D4', captured: 0, at: '2026-10-05T00:00:00.000Z' },
    { n: 2, color: 'W', coord: 'K10', captured: 0, at: '2026-10-05T00:00:01.000Z' },
  ], revision: 2 } : {});
  const state = newAgentState('cloud-probe'); state.gameId = client.game.id;
  function sync() {
    if (!client.game) return;
    const g = client.game;
    const pos = replay(g.settings.boardSize, g.moves);
    g.board = pos.board; g.captures = pos.captures; g.ko = pos.ko === null ? null : indexToCoord(pos.ko, 13);
    g.toPlay = g.moves.at(-1)?.color === 'B' ? 'W' : 'B';
    g.consecutivePasses = [...g.moves].reverse().findIndex(m => m.coord !== 'pass');
    if (g.consecutivePasses === -1) g.consecutivePasses = g.moves.length;
    state.observedRevision = { gameId: g.id, revision: g.revision };
  }
  sync();
  // Общий fake-client намеренно без правил; этот wrapper переигрывает настоящий go-core.
  const methods = ['newGame','play','correct','pass','resign','undo','redo','getGame','ascii','analyze','setRank'] as const;
  for (const method of methods) {
    const original = client[method].bind(client) as (...args: unknown[]) => Promise<unknown>;
    const wrapped = async (...args: unknown[]) => {
      const game = client.game;
      if (game && (method === 'play' || method === 'correct')) {
        const coord = (args[1] as { coord: string }).coord;
        const moves = method === 'correct' ? game.moves.slice(0, -2) : game.moves;
        // Не даём fake-client принять occupied/ko/suicide, как это делает настоящий server.
        try { play(replay(13, moves), 'B', coord); }
        catch { throw new ApiError('illegal_move', 'Недопустимый ход в проверочной позиции'); }
      }
      const result = await original(...args);
      sync();
      if (method === 'ascii') return toAscii(replay(13, client.game!.moves), { lastMove: client.game!.moves.at(-1)?.coord });
      if (method === 'analyze') return {
        ...(result as Record<string, unknown>),
        groups: allGroups(replay(13, client.game!.moves)).map(g => ({ color: g.color, stones: g.stones.map(i => indexToCoord(i, 13)), liberties: g.liberties.length, ownershipAvg: 0, status: 'unsettled' })),
      };
      return result;
    };
    // Сигнатуры сохраняются; runtime dispatch общий для существующего testing fake.
    Object.assign(client, { [method]: wrapped });
  }
  return { client, state, snapshot: (): GameState => structuredClone(client.game!) };
}

export class PCMRecorder {
  private readonly chunks: Buffer[] = [];
  private readonly stamps: Array<{ atMs: number; samples: number }> = [];
  private readonly maxBytes: number;
  private bytes = 0;
  private truncated = false;
  constructor(maxBytes = 24_000 * 2 * 80) { this.maxBytes = maxBytes; }
  append(base64: string, atMs: number): void {
    const remaining = this.maxBytes - this.bytes;
    // Не декодируем неограниченный event payload ради ограниченного файла.
    if (base64.length > Math.ceil(24_000 * 2 / 3) * 4) { this.truncated = true; return; }
    const raw = Buffer.from(base64, 'base64');
    const length = Math.max(0, Math.min(raw.length, remaining)) & ~1;
    if (length < raw.length) this.truncated = true;
    if (!length) return;
    this.chunks.push(raw.subarray(0, length)); this.bytes += length;
    this.stamps.push({ atMs: Math.round(atMs), samples: length / 2 });
  }
  metadata() { return { sampleRate: 24_000, channels: 1, format: 'PCM16LE', samples: this.bytes / 2, truncated: this.truncated, chunks: [...this.stamps] }; }
  pcm() { return Buffer.concat(this.chunks, this.bytes); }
  wav(): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + this.bytes, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(this.bytes, 40);
    return Buffer.concat([header, this.pcm()]);
  }
}

import { expect, it } from 'vitest';
import { coordToIndex, replay } from '@goko/go-core';
import { createProbeGame, PCMRecorder, scenarios } from './cloud-live-fixtures.ts';
import { createTools } from '../tools.ts';
import { IntentLedger } from '../intent.ts';
it('production tools D4 and repeat use replay-consistent board/revision and one K10 reply',async()=>{
  const {client,state}=createProbeGame();const intent=new IntentLedger();
  const tools=createTools({client,state,intent});
  intent.add('Сыграй D4');
  await tools.play_move.execute({coord:'D4',user_utterance:'Сыграй D4'},{} as never);
  const before=structuredClone(client.game!);
  expect(before.board).toBe(replay(13,before.moves).board);
  expect(before.board[coordToIndex('D4',13)]).toBe('B');
  expect(before.board[coordToIndex('K10',13)]).toBe('W');
  expect(before.revision).toBe(2);expect(before.moves).toHaveLength(2);
  await tools.repeat_last_move.execute({},{} as never);
  expect(client.game).toEqual(before);expect(client.calls.map(c=>c.method).filter(m=>m==='play')).toHaveLength(1);
});
it('PCM output is bounded, has WAV header, timestamps and truncation marker',()=>{
  const pcm=new PCMRecorder(4);pcm.append(Buffer.from([1,2,3,4,5,6]).toString('base64'),12);
  expect(pcm.metadata()).toMatchObject({samples:2,truncated:true,chunks:[{atMs:12,samples:2}]});
  const wav=pcm.wav();expect(wav.subarray(0,4).toString()).toBe('RIFF');expect(wav.readUInt32LE(40)).toBe(4);expect(wav.readUInt32LE(24)).toBe(24000);
});
it('first parent-selected scenario begins with free talk then D4 then read-only repeat',()=>{
  expect(scenarios.first.map(c=>c.kind)).toEqual(['free','play','repeat']);
});
it('ambiguity scenario asks about board facts next and preserves the standalone facts scenario', () => {
  expect(scenarios.ambiguity).toEqual([
    { kind: 'ambiguity', text: 'Поставь на и четыре.' },
    { kind: 'facts', text: 'Какие камни сейчас стоят на доске? Следующий ход не советуй.' },
  ]);
  expect(scenarios.facts).toEqual([
    { kind: 'facts', text: 'Какие камни сейчас стоят на доске? Следующий ход не советуй.' },
  ]);
});
it('both ambiguity scenario cases read the same replay-consistent seeded D4/K10 position', async () => {
  const { client, state, snapshot } = createProbeGame(true);
  const intent = new IntentLedger();
  const tools = createTools({ client, state, intent });
  const seeded = snapshot();
  expect(seeded.moves.map(({ color, coord }) => ({ color, coord }))).toEqual([
    { color: 'B', coord: 'D4' },
    { color: 'W', coord: 'K10' },
  ]);
  expect(seeded.board).toBe(replay(13, seeded.moves).board);
  expect(seeded.board[coordToIndex('D4', 13)]).toBe('B');
  expect(seeded.board[coordToIndex('K10', 13)]).toBe('W');
  expect(seeded.revision).toBe(2);
  expect(seeded.toPlay).toBe('B');

  // Offline сверка fixture через read-only tool; выбор ответа модели проверит paid сеанс.
  for (const selected of scenarios.ambiguity) {
    intent.add(selected.text);
    expect(snapshot()).toEqual(seeded);
    const position = await tools.get_position.execute({}, {} as never);
    expect(position).toContain('rev 2');
    expect(position).toContain('"black":["D4"],"white":["K10"]');
    expect(snapshot()).toEqual(seeded);
    expect(state.observedRevision).toEqual({ gameId: seeded.id, revision: 2 });
  }
  expect(client.calls.map(({ method }) => method)).toEqual(['getGame', 'getGame']);
});

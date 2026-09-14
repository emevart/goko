// Проверка поведения модели с инструментами (раздел 12 спеки). Стоит денег: RUN_AGENT_EVALS=1 npx vitest run apps/voice-agent/src/agent.eval.test.ts
// Модель — текстовая (gpt-4.1-mini), не realtime: инструменты и промпт те же, проверяем выбор инструмента и аргументы.
// Один файл, один прогон на все сценарии: платных прогонов на весь план не больше 5 (Global Constraints).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { GokoAgent } from './agent.ts';
import { followMode } from './mode.ts';
import { newAgentState } from './state.ts';
import { createFakeClient } from './testing/fake-client.ts';
import { createTools } from './tools.ts';

const enabled = process.env.RUN_AGENT_EVALS === '1' && Boolean(process.env.OPENAI_API_KEY);
const MODEL = 'gpt-4.1-mini';

describe.skipIf(!enabled)('Гоко: выбор инструментов (платно)', () => {
  let session: voice.AgentSession | null = null;
  // Расход токенов прогона по метрикам LLM (агент и судья): печатается в конце, для счёта платных прогонов.
  const usage = { calls: 0, prompt: 0, cached: 0, completion: 0 };

  function tracked(model: openai.LLM): openai.LLM {
    model.on('metrics_collected', (m) => {
      usage.calls++;
      usage.prompt += m.promptTokens;
      usage.cached += m.promptCachedTokens;
      usage.completion += m.completionTokens;
    });
    return model;
  }

  // AgentSession пишет в логгер @livekit/agents: без initializeLogger конструктор бросает (в воркере его вызывает cli.runApp).
  beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));

  async function start(opts: { withGame?: boolean } = {}) {
    const client = createFakeClient({ replies: ['K10', 'D10', 'K4'] });
    const state = newAgentState('s1');
    const tools = createTools({ client, state });
    if (opts.withGame ?? true) {
      await client.newGame('s1', { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' } });
      state.gameId = 'g1';
      state.toolGames.add('g1');
    }
    session = new voice.AgentSession({ llm: tracked(new openai.LLM({ model: MODEL })) });
    await session.start({ agent: new GokoAgent(tools, { greet: false }) });
    return { session, client, state };
  }

  afterEach(async () => {
    await session?.close();
    session = null;
  });

  afterAll(() => {
    console.log(`[eval] модель ${MODEL}: вызовов LLM ${usage.calls}, токены: вход ${usage.prompt} (из кэша ${usage.cached}), выход ${usage.completion}`);
  });

  // session.run возвращает RunResult, а не промис (@livekit/agents 1.8): без wait() утверждения читают
  // незаконченный прогон, а следующий run бросает «nested runs are not supported».
  it('«дэ четыре» -> play_move D4', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
  }, 60_000);

  it('«нет, дэ пять» после хода -> correct_last_move D5', async () => {
    const { session } = await start();
    await session.run({ userInput: 'дэ четыре' }).wait();
    const result = session.run({ userInput: 'нет, дэ пять' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'correct_last_move', args: { coord: 'D5' } });
  }, 90_000);

  it('«пас» -> pass', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'пас' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'pass' });
  }, 60_000);

  it('«кто впереди» -> get_assessment, без лучшего хода в ответе (строка и LLM-судья)', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'кто впереди?' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'get_assessment' });
    const message = result.expect.at(-1).isMessage({ role: 'assistant' });
    const text = String(message.event().item.textContent ?? '');
    expect(text.length).toBeGreaterThan(0);
    // Строкой — только координаты bestMoves фейкового клиента; место слабой группы (C3, C4) называть можно.
    for (const best of ['K10', 'ка десять', 'D10', 'дэ десять']) expect(text.toLowerCase()).not.toContain(best.toLowerCase());
    // LLM-судья раздела 12 спеки — в этом же прогоне, отдельного платного прогона нет. Отказ судьи бросает ошибку.
    const judge = tracked(new openai.LLM({ model: MODEL }));
    await message.judge(judge, {
      intent: 'оценивает позицию: кто впереди и насколько; не подсказывает ход — не называет лучший ход и не советует, куда ходить (где слабые группы, сказать можно)',
    });
  }, 90_000);

  it('«давай партию, я белыми» -> start_game white', async () => {
    const { session } = await start({ withGame: false });
    const result = session.run({ userInput: 'давай партию, я белыми' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'start_game', args: { my_color: 'white' } });
  }, 60_000);

  it('D-0004: прямая просьба «сходи за меня на дэ четыре» -> play_move D4, ход назван в ответе', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'сходи за меня на дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
    const text = String(result.expect.at(-1).isMessage({ role: 'assistant' }).event().item.textContent ?? '');
    expect(text).toMatch(/д[эе][\s-]*четыре|d4/i);
  }, 60_000);

  it('D-0004: размышление «а не пойти ли мне на дэ четыре?» ходом не считается', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'хм, а не пойти ли мне на дэ четыре?' });
    await result.wait();
    const moved = result.events.some((e) => e.type === 'function_call' && ['play_move', 'correct_last_move'].includes(e.item.name));
    expect(moved).toBe(false);
  }, 60_000);

  it('режим «Чат» (D-0011): goko.mode=chat выключает звук сеанса, ответ на ход приходит текстом', async () => {
    const { session } = await start();
    const mode = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session });
    expect(mode.mode).toBe('chat');
    expect(session.output.audioEnabled).toBe(false);
    expect(session.input.audioEnabled).toBe(false);
    const result = session.run({ userInput: 'дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
    const text = String(result.expect.at(-1).isMessage({ role: 'assistant' }).event().item.textContent ?? '');
    expect(text.length).toBeGreaterThan(0);
    expect(session.output.audioEnabled).toBe(false);
  }, 60_000);
});

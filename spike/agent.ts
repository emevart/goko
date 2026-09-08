// Спайк: Гоко без движка. Проверяем голосовую петлю, русский, распознавание координат, текстовый канал.
// [!] Вывод этого воркера содержит адрес сервера: cli.runApp при регистрации логирует поле
// url, то есть значение LIVEKIT_URL. Скрыть это на стадии 0 нечем — логгер внутри
// @livekit/agents. Лог целиком не вставлять в доки, задачи и чат (см. spike/README.md).
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { z } from 'zod';

const LOG = new URL('./log.jsonl', import.meta.url);
function log(entry: Record<string, unknown>) {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

const INSTRUCTIONS = `Ты Гоко, соперник по го. Говоришь по-русски, коротко, как живой игрок за доской.
Когда человек называет ход (буква столбца и номер строки), сразу вызывай play_move с координатой латиницей, например "D4",
и повтори ход вслух. Столбцы произносятся: A «а», B «бэ», C «цэ», D «дэ», E «е», F «эф», G «гэ», H «аш», J «джей»,
K «ка», L «эль», M «эм», N «эн»; буквы I на доске нет. Реплики до двух предложений.
Свой ответный ход возьми из результата инструмента и назови его.`;

let counter = 0;
const REPLIES = ['K10', 'D10', 'K4', 'G7', 'C3', 'J9', 'E11'];

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    log({ event: 'job', room: ctx.room.name, metadata: ctx.job.metadata });

    const play_move = llm.tool({
      description: 'Применить ход человека. coord — латиницей, буква A–N без I и число 1–13, например D4.',
      parameters: z.object({ coord: z.string().describe('Например D4') }),
      execute: async ({ coord }) => {
        const reply = REPLIES[counter++ % REPLIES.length]!;
        log({ event: 'tool', name: 'play_move', coord, reply });
        return { ok: true, yourMove: coord, myMove: reply };
      },
    });

    const agent = new voice.Agent({ instructions: INSTRUCTIONS, tools: { play_move } });
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: 'gpt-realtime',
        voice: 'marin',
        turnDetection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        inputAudioTranscription: { model: 'gpt-live-transcribe', language: 'ru' },
      }),
    });

    // Имена событий берём из перечисления: строковые литералы тип не принимает.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) log({ event: 'user', text: ev.transcript });
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      // item бывает и передачей между агентами, у неё нет ни role, ни текста.
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        log({ event: 'agent', text: ev.item.textContent });
      }
    });

    await session.start({ agent, room: ctx.room });
    await session.generateReply({ instructions: 'Поздоровайся одной фразой и предложи назвать ход.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME ?? 'goko' }));

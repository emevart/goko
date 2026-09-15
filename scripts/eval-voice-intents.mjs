// Платный eval реальной backend-модели и production schemas. Игровые мутации
// не выполняются; результаты readonly tools заданы тестовым контекстом.
// node --env-file=.env scripts/eval-voice-intents.mjs --run --output=<ignored path>
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createTools } from '../apps/voice-agent/src/tools.ts';
import { newAgentState } from '../apps/voice-agent/src/state.ts';
import { IntentLedger } from '../apps/voice-agent/src/intent.ts';
import { GPT_LIVE_MODEL_OPTIONS } from '../apps/voice-agent/src/voice.ts';

if (!process.argv.includes('--run')) throw new Error('Платный eval запускается только с --run');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY отсутствует');
const cases = [
  ['А мой первый ход черными К4', 'play_move', 'K4'],
  ['Я решил занять К4', 'play_move', 'K4'],
  ['Пусть это будет К4', 'play_move', 'K4'],
  ['Не D4, а К4, так и играю', 'play_move', 'K4'],
  ['Дэ четыре, нет, ка четыре', 'play_move', 'K4'],
  ['Пожалуй, займу угол на D4', 'play_move', 'D4'],
  ['Я поставил на D4', 'play_move', 'D4'],
  ['Ну, Д четыре', 'play_move', 'D4'],
  ['Нет, исправь мой последний ход на D5', 'correct_last_move', 'D5'],
  ['Давай отменим последний ход и попробуем иначе', 'undo'],
  ['Верни, пожалуйста, то, что мы только что отменили', 'redo'],
  ['На этот раз пропущу ход, пас', 'pass'],
  ['Ладно, признаю поражение', 'resign'],
  ['Давай начнём ещё одну партию', 'start_game'],
  ['Хочу соперника на уровне пятого кю', 'set_rank', undefined, '5k'],
  ['а если я поставлю дэ четыре, то что будет', null],
  ['я вот думал про ка десять, но что-то передумал', null],
  ['в прошлый раз ты пошёл на цэ три, помнишь', null],
  ['эф девять вообще хороший ход', null],
  ['слушай, может мне сходить, например, там а один, как ты считаешь', null],
  ['не ставь D4', null],
  ['Д4 или Е5', null],
  ['давай обсудим D4', null],
  ['Не отменяй, всё правильно', null],
  ['Я не сдаюсь', null],
  ['Пас?', null],
  ['Ты сказал поставить E9', null],
  ['В прошлой партии я сыграл D4', null],
  ['[mouth noise] [clear throat]', null],
];
const tools = Object.entries(createTools({client:{}, state:newAgentState('eval')})).map(([name, tool]) => {
  const parameters = z.toJSONSchema(tool.parameters); delete parameters.$schema;
  return {type:'function', name, description:tool.description, parameters, strict:false};
});
const {model, instructions, reasoning, maxOutputTokens} = GPT_LIVE_MODEL_OPTIONS.responsesOptions;
const { parseRank } = await import('../apps/voice-agent/src/phrases.ts');
const results = [];
for (const [text, expected, coord, rank] of cases) {
  const input = [{role:'developer', content:'Тестовая партия уже идёт, человек чёрными, сейчас его ход, текущий уровень Гоко 10 кю, коми 7.5. Человек называет свои ходы у физической доски. Ранее были ходы C3 и K10; последний ход можно исправить, отменить или вернуть. D4, D5 и K4 свободны.'}, {role:'user', content:text}];
  let calls = [];
  for (let step=0; step<3; step++) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json'},
      body:JSON.stringify({model,instructions,reasoning,max_output_tokens:maxOutputTokens,tools,parallel_tool_calls:false,input,store:false}),
      signal:AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Responses HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== 'completed') throw new Error(`Responses status ${data.status}`);
    const functions = data.output.filter(item => item.type === 'function_call');
    calls = functions.filter(call => !['get_position','get_assessment'].includes(call.name));
    if (calls.length || !functions.length) break;
    input.push(...data.output);
    for (const call of functions) input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify({ok:true,gameId:'eval',revision:2,toPlay:'B',humanColor:'B',rank:'10k',komi:7.5,moves:[{color:'B',coord:'C3'},{color:'W',coord:'K10'}],note:'Нет данных движка для оценки; не выдумывай оценку.'})});
  }
  let pass = expected === null ? calls.length === 0 : calls.length === 1 && calls[0].name === expected;
  let args;
  if (calls.length) {
    args = JSON.parse(calls[0].arguments);
    if (coord) pass &&= args.coord === coord;
    if (rank) pass &&= parseRank(args.rank ?? '') === rank;
    if (expected === 'start_game') pass &&= !args.rank && args.komi == null;
    const ledger = new IntentLedger(); ledger.add(text);
    const permit = await ledger.consume(calls[0].name, args.user_utterance ?? '', args, 0);
    pass &&= permit.ok;
  }
  results.push({text,expected,actual:calls.map(call=>call.name),args,pass});
  console.log(`[${pass?'OK':'X'}] ${text}`);
}
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (output) writeFileSync(output, JSON.stringify({model,reasoning,results},null,2));
console.log(`${results.filter(r=>r.pass).length}/${results.length} PASS`);
process.exitCode = results.every(r=>r.pass) ? 0 : 1;

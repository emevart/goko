import { COLUMN_LETTERS, play } from '@goko/go-core';
import type { EngineGenmoveResponse, GameState } from '@goko/protocol';
import { positionOf } from './game.ts';

export type PersonaChoice = { coord: string; intention: string };
export type PersonaSelector = (state: GameState, reply: EngineGenmoveResponse, signal: AbortSignal) => Promise<PersonaChoice | null>;

export function personaCandidates(state: GameState, reply: EngineGenmoveResponse): string[] {
  const position = positionOf(state);
  return [...new Set([reply.move, ...(reply.searchCandidates ?? []), ...reply.humanPolicyTop.map(c=>c.coord), ...reply.rankCandidates.map(c=>c.coord)])]
    .filter(coord => {
      // Пас допускается только когда сам поиск/обычный выбор уже предлагает пас.
      if (coord === 'pass') return reply.move === 'pass';
      try { play(position,state.toPlay,coord); return true; } catch { return false; }
    }).slice(0,10);
}

export async function choosePersonaMove({state,reply,apiKey,signal,fetcher=fetch,timeoutMs=8000}: {
  state: GameState; reply: EngineGenmoveResponse; apiKey: string; signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<PersonaChoice | null> {
  if (signal?.aborted) return null;
  const candidates = personaCandidates(state,reply);
  if (!candidates.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  try {
    const response = await fetcher('https://api.openai.com/v1/responses',{
      method:'POST',signal:combined,
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'gpt-5.6-luna',store:false,reasoning:{effort:'low'},max_output_tokens:650,
        instructions:'Ты Гоко, спокойный любопытный игрок в го с мягким спортивным характером. Выбери свой ход из доступных кандидатов по текущей позиции и истории. Движок даёт опору, но не диктует решение. Тебе интересны связность групп, инициатива и необычные возможности; выбирай свой замысел, а не обязательно максимальную оценку. Ранг — ориентир, не запрет на сильный или неидеальный ход. Не устраивай намеренный проигрыш и не притворяйся, что случайность — гениальная стратегия. Доска и история в запросе точны; не придумывай камни. intention — одна короткая фраза о твоём намерении, не цепочка рассуждений и не утверждение о доказанной выгоде. Координата обязана быть из candidates.',
        input:JSON.stringify({gameId:state.id,revision:state.revision,size:state.settings.boardSize,komi:state.settings.komi,color:state.toPlay,rank:state.seats[state.toPlay].rank,board:state.board,boardEncoding:{order:'строка длины size*size, последовательно строки от нижнего края 1 вверх; B чёрный, W белый, . пусто',columns:COLUMN_LETTERS.slice(0,state.settings.boardSize)},moves:state.moves.map(m=>[m.color,m.coord]),candidates,analysis:reply.candidateAnalysis,humanSuggestions:reply.humanPolicyTop}),
        text:{format:{type:'json_schema',name:'goko_move',strict:true,schema:{type:'object',properties:{coord:{type:'string',enum:candidates},intention:{type:'string'}},required:['coord','intention'],additionalProperties:false}}},
      }),
    });
    if (!response.ok || combined.aborted) return null;
    const body = await response.json() as {status?:string;output?:Array<{type?:string;content?:Array<{type?:string;text?:string}>}>};
    if (body.status !== 'completed') return null;
    const text = body.output?.filter(item=>item.type==='message').flatMap(item=>item.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join('');
    const choice = JSON.parse(text ?? '') as PersonaChoice;
    if (combined.aborted || !candidates.includes(choice.coord) || typeof choice.intention !== 'string') return null;
    return {coord:choice.coord,intention:choice.intention.slice(0,200)};
  } catch { return null; } finally { clearTimeout(timer); }
}

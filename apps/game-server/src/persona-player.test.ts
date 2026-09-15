import { expect, it, vi } from 'vitest';
import { choosePersonaMove, personaCandidates } from './persona-player.ts';
import { newGame, applyMove } from './game.ts';

const makeState = () => newGame({id:'test',createdAt:'2026-09-15T00:00:00Z',settings:{boardSize:13,rules:'chinese',komi:7.5},seats:{B:{controller:'human'},W:{controller:'engine',rank:'10k'}}});
const reply = {move:'D4',humanPolicyTop:[{coord:'K4',prob:.3}],rankCandidates:[],candidateAnalysis:[],humanFallback:false,winrateB:.5,scoreLeadB:0,ms:1};
const response = (coord: string) => new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({coord,intention:'Хочу развиваться по краю'})}]}]}));
it('разрешает собственный выбор из кандидатов и отправляет свежую позицию', async () => {
  const fetcher=vi.fn(async()=>response('K4'));
  const state=makeState();
  await expect(choosePersonaMove({state,reply,apiKey:'test',fetcher})).resolves.toMatchObject({coord:'K4'});
  const init=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  const payload=JSON.parse(String(init[1].body));
  expect(JSON.parse(payload.input)).toMatchObject({gameId:'test',revision:0,board:state.board,candidates:['D4','K4']});
});
it('занятый пункт исключается по настоящим правилам доски', () => {
  const state=applyMove(makeState(),'B','D4','2026-09-15T00:00:01Z').state;
  expect(personaCandidates(state,reply)).toEqual(['K4']);
});
it('ошибка API и незавершённый ответ оставляют исходный выбор движка', async () => {
  for (const value of [new Response('',{status:429}),new Response(JSON.stringify({status:'incomplete',output:[]})),new Response('broken')]) {
    await expect(choosePersonaMove({state:makeState(),reply,apiKey:'test',fetcher:async()=>value})).resolves.toBeNull();
  }
});
it('отмена не запускает запрос, а таймаут прерывает ожидание', async () => {
  const controller=new AbortController();controller.abort();const fetcher=vi.fn();
  await expect(choosePersonaMove({state:makeState(),reply,apiKey:'test',signal:controller.signal,fetcher})).resolves.toBeNull();expect(fetcher).not.toHaveBeenCalled();
  await expect(choosePersonaMove({state:makeState(),reply,apiKey:'test',timeoutMs:5,fetcher:async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('abort'))))})).resolves.toBeNull();
});

it('выбор вне предложенного набора не применяется', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({coord:'N13',intention:'Укреплю край'})}]}]})));
  const state = newGame({id:'test',createdAt:'2026-09-15T00:00:00Z',settings:{boardSize:13,rules:'chinese',komi:7.5},seats:{B:{controller:'human'},W:{controller:'engine',rank:'10k'}}});
  const result=await choosePersonaMove({state,reply:{move:'D4',humanPolicyTop:[],rankCandidates:[],candidateAnalysis:[],humanFallback:false,winrateB:.5,scoreLeadB:0,ms:1},apiKey:'test',fetcher});
  expect(result).toBeNull();
});

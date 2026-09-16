import { expect, it, vi } from 'vitest';
import { BoardAwareness } from './board-awareness.ts';
import { newGame, applyMove } from '../../game-server/src/game.ts';
import type { Analysis, GameState } from '@goko/protocol';
const game = () => newGame({id:'a',createdAt:'2026-09-15',settings:{boardSize:13,rules:'chinese',komi:7.5},seats:{B:{controller:'human'},W:{controller:'engine',rank:'10k'}}});
const analysis = (g:GameState): Analysis => ({gameId:g.id,revision:g.revision,visits:50,winrateB:.5,scoreLeadB:0,topMoves:[],groups:[],ownership:[]});
it('поздний анализ после нового хода не попадает в контекст и кеш', async()=>{
 const emit=vi.fn();let release!:(a:Analysis)=>void;
 const g={...applyMove(game(),'B','D4','2026-09-15').state,pendingEngineMove:false};const board=new BoardAwareness({publish:emit,analyze:()=>new Promise(r=>{release=r}),delayMs:0});
 board.update(g);await vi.waitFor(()=>expect(release).toBeDefined());
 const next=applyMove(g,'W','K10','2026-09-15').state;
 board.update({...next,pendingEngineMove:true});release(analysis(g));
 await new Promise(r=>setTimeout(r,5));
 expect(board.cached(g)).toBeUndefined();expect(emit).toHaveBeenCalledTimes(2);board.close();
});
it('одна ревизия считается один раз; отмена очищает прежний замысел',async()=>{
 const g=applyMove(game(),'B','D4','2026-09-15').state;g.pendingEngineMove=false;
 const emit=vi.fn(), analyze=vi.fn(async()=>analysis(g));
 const board=new BoardAwareness({publish:emit,analyze,delayMs:0});
 board.update(g,{moveN:1,basedOnRevision:0,rankCandidates:[],candidateAnalysis:[],playerChoice:{coord:'D4',intention:'Занять угол'}});
 await vi.waitFor(()=>expect(board.cached(g)).toBeDefined());board.update(g);
 expect(analyze).toHaveBeenCalledTimes(1);
 expect(emit.mock.calls.at(-1)?.[0].compact).toContain('Занять угол');
 board.update({...game(),revision:2,pendingEngineMove:true});
 expect(emit.mock.calls.at(-1)?.[0].compact).not.toContain('Занять угол');board.close();
});
it('смена партии немедленно сбрасывает контекст и блокирует старую публикацию',()=>{
 const emit=vi.fn();const board=new BoardAwareness({publish:emit,analyze:vi.fn()});
 board.update(game());const previous=emit.mock.calls[0]![0];board.clear('b');
 expect(previous.current()).toBe(false);expect(emit.mock.calls.at(-1)?.[0].compact).toContain('нет');board.close();
});
it('снимок старой партии после session.game не возвращает старую доску',()=>{
 const emit=vi.fn();const board=new BoardAwareness({publish:emit,analyze:vi.fn()});
 board.update(game());board.clear('b');board.update(game());expect(emit).toHaveBeenCalledTimes(2);board.close();
});
it('фоновая сводка содержит полный список камней текущей ревизии',()=>{
 const emit=vi.fn();const g=applyMove(game(),'B','D4','2026-09-15').state;
 const next=applyMove(g,'W','K12','2026-09-15').state;
 const board=new BoardAwareness({publish:emit,analyze:vi.fn()});
 board.update(next);
 expect(emit.mock.calls.at(-1)?.[0].compact).toContain('"stones":{"black":["D4"],"white":["K12"]}');
 expect(emit.mock.calls.at(-1)?.[0].compact).toContain('"stonesSpoken":{"black":["дэ четыре"],"white":["ка двенадцать"]}');
 board.close();
});

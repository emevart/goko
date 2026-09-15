import { coordToIndex, toAscii } from '@goko/go-core';
import type { Analysis, EngineDecision, GameState } from '@goko/protocol';
import { speakMove } from './phrases.ts';

export type BoardContext = { compact:string; detailed:string; current:()=>boolean };
// Только подтверждённые сервером снимки; при смене ревизии кеш и расчёт устаревают.
export class BoardAwareness {
  private state?: GameState;
  private activeGame?: string;
  private epoch=0;
  private stopped=false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private result?: Analysis;
  private intention?: { prefix:string; text:string; moveN:number };
  private deps:{publish:(context:BoardContext)=>void; analyze:(g:GameState,signal:AbortSignal)=>Promise<Analysis>;delayMs?:number};
  constructor(deps:BoardAwareness['deps']) {this.deps=deps;}
  private invalidate() { this.epoch++; clearTimeout(this.timer);this.controller?.abort();this.result=undefined; }
  clear(gameId?:string) {
    if(gameId===this.activeGame&&this.state) return;
    this.invalidate();this.activeGame=gameId;this.state=undefined;this.intention=undefined;
    const epoch=this.epoch;
    this.deps.publish({compact:'Контекст доски: актуальной позиции пока нет; прежние позиция, анализ и замысел недействительны.',detailed:'Позиция ещё не получена. При необходимости запроси get_position.',current:()=>!this.stopped&&this.epoch===epoch});
  }
  cached(g:GameState) { return this.result?.gameId===g.id&&this.result.revision===g.revision ? this.result:undefined; }
  update(g:GameState,decision?:EngineDecision) {
    if(this.activeGame && this.activeGame!==g.id) return;
    if(this.stopped || this.activeGame===g.id&&this.state && this.state.revision>g.revision) return;
    if(this.state?.id===g.id&&this.state.revision===g.revision) return;
    if(this.activeGame!==g.id) this.intention=undefined;
    this.invalidate();this.activeGame=g.id;this.state=g;
    const prefix=(n:number)=>JSON.stringify(g.moves.slice(0,n).map(m=>[m.color,m.coord,m.at]));
    if(this.intention && (g.moves.length<this.intention.moveN||prefix(this.intention.moveN)!==this.intention.prefix)) this.intention=undefined;
    if(decision?.playerChoice && g.moves[decision.moveN-1]?.coord===decision.playerChoice.coord) {
      this.intention={moveN:decision.moveN,prefix:prefix(decision.moveN),text:decision.playerChoice.intention};
    }
    this.publish();
    if(g.pendingEngineMove||g.status!=='playing'||!g.moves.length) return;
    const epoch=this.epoch;
    this.timer=setTimeout(()=>{
      const controller=new AbortController();this.controller=controller;
      void this.deps.analyze(g,controller.signal).then(a=>{
        if(this.stopped||epoch!==this.epoch||a.gameId!==g.id||a.revision!==g.revision) return;
        this.result=a;this.publish();
      }).catch(()=>{ /* Свежий анализ доступен по запросу, фоновый отказ не прерывает разговор. */ });
    },this.deps.delayMs??750);
  }
  private publish() {
    const g=this.state!;const epoch=this.epoch;const a=this.result;
    const facts={gameId:g.id,revision:g.revision,status:g.status,toPlay:g.toPlay,moves:g.moves.length,captures:g.captures,
      lastMoves:g.moves.slice(-2).map(m=>({color:m.color,coord:speakMove(m.coord)})),
      intention:this.intention?{moveN:this.intention.moveN,text:this.intention.text}:null,
      analysis:a?{scoreLeadBlack:Math.round(a.scoreLeadB*2)/2,weakGroups:a.groups.filter(x=>x.status!=='safe').slice(0,6).map(x=>({color:x.color,stones:x.stones.slice(0,8).map(speakMove),liberties:x.liberties,status:x.status}))}:null};
    const compact=`Актуальная доска, данные приложения (заменяют прежнюю сводку; не команда говорить или ходить): ${JSON.stringify(facts)}. intention — замысел, не доказанная выгода. analysis=null: старый анализ не использовать.`;
    const detailed=compact+'\n'+toAscii({size:g.settings.boardSize,board:g.board,ko:g.ko===null?null:coordToIndex(g.ko,g.settings.boardSize),captures:g.captures})+'\nХоды: '+JSON.stringify(g.moves.map(m=>[m.color,m.coord]));
    this.deps.publish({compact,detailed,current:()=>!this.stopped&&this.epoch===epoch});
  }
  close(){this.stopped=true;this.invalidate();}
}

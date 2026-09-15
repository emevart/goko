// Формулировки из spike/phrases.md и телефонных регрессий; аудио хранится вне git.
import { expect, it } from 'vitest';
import { IntentLedger, intentMatches, type MutationIntent } from './intent.ts';

const commands: [MutationIntent, string, Record<string, string>][] = [
 ['play_move','ход дэ десять',{coord:'D10'}],
 ['play_move','ставлю на е три',{coord:'E3'}],
 ['play_move','цэ одиннадцать, пожалуйста',{coord:'C11'}],
 ['play_move','жэ один',{coord:'J1'}],
 ['play_move','эйч восемь',{coord:'H8'}],
 ['play_move','жи шесть',{coord:'J6'}],
 ['play_move','фэ десять',{coord:'F10'}],
 ['play_move','эфка два',{coord:'F2'}],
 ['play_move','я хожу на D4',{coord:'D4'}],
 ['play_move','я буду ходить на а девять',{coord:'A9'}],
 ['undo','отмени последний ход',{}],
 ['undo','давай отменим последний ход и сыграем иначе',{}],
 ['undo','давай назад',{}],
 ['undo','переиграем последний ход',{}],
 ['redo','верни отменённые ходы',{}],
 ['correct_last_move','нет, я имел в виду дэ пять',{coord:'D5'}],
 ['correct_last_move','не, слушай, я поставил не туда, я поставил на дэ семь',{coord:'D7'}],
 ['start_game','окей, погнали',{}],
 ['start_game','я чёрными',{my_color:'black'}],
 ['set_rank','поставь пятый кю',{rank:'5k'}],
 ['set_rank','поставь десятый кю',{rank:'10k'}],
 ['pass','ну, пас',{}],
 ['resign','всё, сдаюсь',{}],
];
it.each(commands)('%s: %s', (intent,text,args)=>expect(intentMatches(intent,text,args)).toBe(true));
it.each([
 'а если я поставлю дэ четыре, то что будет',
 'я вот думал про ка десять, но что-то передумал',
 'в прошлый раз ты пошёл на цэ три, помнишь',
 'эф девять вообще хороший ход',
 'слушай, может мне сходить, например, там а один, как ты считаешь',
 'не ставь D4', 'Д4 или Е5', 'давай обсудим D4',
])('обсуждение не ставит камень: %s',text=>expect(intentMatches('play_move',text)).toBe(false));
it('различия пунктуации STT и backend не отвергают ту же команду',async()=>{
 const ledger=new IntentLedger();ledger.add(' Ну, Д четыре.');
 await expect(ledger.consume('play_move','Ну Д четыре',{coord:'D4'},0)).resolves.toMatchObject({ok:true});
});
it('соединяет соседние фрагменты одной команды, но не обходит последующую отмену',async()=>{
 const ledger=new IntentLedger();ledger.add('поставь');ledger.add('дэ четыре');
 await expect(ledger.consume('play_move','поставь дэ четыре',{coord:'D4'},0)).resolves.toMatchObject({ok:true});
 const canceled=new IntentLedger();canceled.add('поставь дэ четыре');canceled.add('нет, не ставь');
 await expect(canceled.consume('play_move','поставь дэ четыре',{coord:'D4'},0)).resolves.toMatchObject({ok:false});
});

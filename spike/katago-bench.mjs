#!/usr/bin/env node
// Замер KataGo analysis engine на 13x13: humanPolicy (1 visit), genmove (10), analyze (50), score (400).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((p) => p.length));
const bin = args.bin ?? process.env.KATAGO_BIN;
const model = args.model;
const human = args.human;
const config = args.config ?? 'apps/go-engine/config/analysis.cfg';
if (!bin || !model || !human) {
  console.error('usage: node spike/katago-bench.mjs --bin <katago> --model <main.bin.gz> --human <human.bin.gz> [--config cfg]');
  process.exit(2);
}

const proc = spawn(bin, ['analysis', '-config', config, '-model', model, '-human-model', human], { stdio: ['pipe', 'pipe', 'inherit'] });
let finished = false;
proc.on('error', (e) => {
  console.error(`[X] не удалось запустить ${bin}: ${e.message}`);
  process.exit(1);
});
proc.on('exit', (code, signal) => {
  if (finished) return;
  console.error(`[X] KataGo завершился раньше времени: код ${code ?? '-'}, сигнал ${signal ?? '-'}`);
  process.exit(1);
});
const rl = readline.createInterface({ input: proc.stdout });
const waiting = new Map();
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const w = waiting.get(msg.id);
  if (w && msg.isDuringSearch !== true) { waiting.delete(msg.id); w(msg); }
});

let n = 0;
function query(q) {
  const id = `q${++n}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, ...q }) + '\n');
  });
}

const moves = [['B', 'D4'], ['W', 'K10'], ['B', 'K4'], ['W', 'D10'], ['B', 'G7'], ['W', 'C3'], ['B', 'D3'], ['W', 'C4'], ['B', 'C5'], ['W', 'B5']];
const base = { rules: 'chinese', komi: 7.5, boardXSize: 13, boardYSize: 13, moves };

async function timed(label, q) {
  const t0 = performance.now();
  const r = await query(q);
  const ms = Math.round(performance.now() - t0);
  if (r.error) {
    console.error(`[X] ${label}: ${r.error}${r.field ? ` (поле ${r.field})` : ''}`);
    finished = true;
    proc.kill();
    process.exit(1);
  }
  const root = r.rootInfo ?? {};
  console.log(`${label.padEnd(22)} ${String(ms).padStart(6)} ms  visits=${root.visits ?? '-'} winrateB=${root.winrate?.toFixed(3) ?? '-'} lead=${root.scoreLead?.toFixed(1) ?? '-'} human=${Array.isArray(r.humanPolicy) ? 'yes' : 'NO'}`);
  return r;
}

console.log('warmup...');
await timed('warmup', { ...base, maxVisits: 2 });
for (const rank of ['rank_20k', 'rank_10k', 'rank_1d']) {
  const r = await timed(`humanPolicy ${rank}`, { ...base, maxVisits: 1, includePolicy: true, overrideSettings: { humanSLProfile: rank } });
  const hp = r.humanPolicy ?? [];
  const top = hp.map((p, i) => [p, i]).filter(([p]) => p > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([p, i]) => `${i}:${p.toFixed(3)}`);
  console.log(`   top humanPolicy idx: ${top.join(' ')} (pass idx=${hp.length - 1})`);
}
await timed('genmove 10 visits', { ...base, maxVisits: 10, includePolicy: true, overrideSettings: { humanSLProfile: 'rank_10k' } });
await timed('analyze 50 visits', { ...base, maxVisits: 50, includeOwnership: true });
await timed('score 400 visits', { ...base, maxVisits: 400, includeOwnership: true });
finished = true;
proc.stdin.end();
proc.kill();
console.log('[OK] замер завершён');
process.exit(0);

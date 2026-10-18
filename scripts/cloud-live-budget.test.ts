import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initializeBudget, reserveBudget, claimBudget } from './cloud-live-budget.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dirs: string[] = [];
function file() { const dir = mkdtempSync(join(tmpdir(), 'cloud-budget-')); dirs.push(dir); return join(dir, 'ledger.json'); }
const audit = { schema:'cloud-product-audit-v1', limits:{providerSessions:2,connectionSeconds:180}, used:{providerSessions:0,connectionSeconds:0}, attempts:[], status:'blocked_before_connection', paidRunEnabled:false };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
it('run never creates/resets missing/corrupt/used audit; explicit zero migration only', () => {
  const path=file(); expect(()=>reserveBudget(path,'first')).toThrow('CLOUD_LEDGER_MISSING');
  expect(()=>initializeBudget(path)).toThrow('CLOUD_LEDGER_MISSING');
  writeFileSync(path,'invalid'); expect(()=>reserveBudget(path,'first')).toThrow('CLOUD_LEDGER_CORRUPT');
  writeFileSync(path,JSON.stringify({...audit,used:{providerSessions:1,connectionSeconds:5}}));
  expect(()=>initializeBudget(path)).toThrow('CLOUD_AUDIT_NOT_ZERO');
  writeFileSync(path,JSON.stringify(audit)); initializeBudget(path);
  expect(()=>initializeBudget(path)).toThrow('CLOUD_AUDIT_NOT_ZERO');
});
it('exclusive lock, two attempts, failed-connect spends slot, no reset across runs', () => {
  const path=file(); writeFileSync(path,JSON.stringify(audit)); initializeBudget(path);
  const a=reserveBudget(path,'first'); expect(()=>reserveBudget(path,'first')).toThrow('CLOUD_BUDGET_LOCKED');
  a.finish({wallMs:1000,cleanClose:true,outcome:'failed_connect'});
  const b=reserveBudget(path,'ambiguity'); b.finish({wallMs:2000,cleanClose:true,outcome:'closed'});
  const ledger=JSON.parse(readFileSync(path,'utf8')); expect(ledger.used).toEqual({providerSessions:2,wallMs:3000});
  expect(()=>reserveBudget(path,'facts')).toThrow('CLOUD_BUDGET_EXHAUSTED');
});
it('lost child/hanging close conservatively retain 90 seconds and block more work', () => {
  const path=file(); writeFileSync(path,JSON.stringify(audit)); initializeBudget(path);
  reserveBudget(path,'first').finish({wallMs:20,cleanClose:false,outcome:'child_lost'});
  const ledger=JSON.parse(readFileSync(path,'utf8')); expect(ledger.used.wallMs).toBe(90000);
  expect(()=>reserveBudget(path,'first')).toThrow('CLOUD_ATTEMPT_IN_PROGRESS');
});
it('tampered limits/accounting and orphaned in-progress ledger fail closed', () => {
  const path=file(); writeFileSync(path,JSON.stringify(audit)); initializeBudget(path);
  const a=reserveBudget(path,'first'); a.finish({wallMs:90000,cleanClose:true,outcome:'closed'});
  let ledger=JSON.parse(readFileSync(path,'utf8')); ledger.limits.wallMs=200000;
  writeFileSync(path,JSON.stringify(ledger)); expect(()=>reserveBudget(path,'first')).toThrow('CLOUD_LEDGER_CORRUPT');
});
it('live-parent IPC grant + actual child exclusive claim admits one; duplicate/stale fork cannot reuse slot',()=>{
  const path=file();writeFileSync(path,JSON.stringify(audit));initializeBudget(path);
  const reservation=reserveBudget(path,'first');
  const module=pathToFileURL(join(process.cwd(),'scripts/cloud-live-budget.mjs')).href;
  const source=`import {claimBudget} from ${JSON.stringify(module)};try{claimBudget(${JSON.stringify(path)},${JSON.stringify(reservation.id)},'first',${JSON.stringify(reservation.grant)});console.log('claimed');}catch(e){console.log(e.code);process.exitCode=2;}`;
  const first=spawnSync(process.execPath,['--input-type=module','-'],{input:source,env:{},encoding:'utf8',timeout:5000});
  expect(first.stderr).toBe('');expect(first.status).toBe(0);expect(first.stdout.trim()).toBe('claimed');
  const second=spawnSync(process.execPath,['--input-type=module','-'],{input:source,env:{},encoding:'utf8',timeout:5000});
  expect(second.stderr).toBe('');expect(second.status).toBe(2);expect(second.stdout.trim()).toBe('CLOUD_CHILD_ALREADY_CLAIMED');
  expect(()=>claimBudget(path,reservation.id,'first',{...reservation.grant,nonce:'wrong'})).toThrow('CLOUD_CHILD_GRANT_INVALID');
  reservation.finish({wallMs:20,cleanClose:false,outcome:'child_lost'});
  const stale=spawnSync(process.execPath,['--input-type=module','-'],{input:source,env:{},encoding:'utf8',timeout:5000});
  expect(stale.status).toBe(2);expect(stale.stdout.trim()).toBe('CLOUD_CHILD_GRANT_INVALID');
});

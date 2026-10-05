import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { expect, it } from 'vitest';
it('default dry path has no provider/SDK or ledger mutation and omits injected secrets',()=>{
  const isolated=mkdtempSync(join(tmpdir(),'cloud-dry-'));
  try {
    mkdirSync(join(isolated,'scripts'));
    mkdirSync(join(isolated,'apps/voice-agent/src'),{recursive:true});
    symlinkSync(join(process.cwd(),'apps/voice-agent/node_modules'),join(isolated,'apps/voice-agent/node_modules'),'dir');
    for(const name of ['cloud-live-probe','cloud-live-budget','cloud-live-transport','cloud-live-managed-child']) copyFileSync(join(process.cwd(),`scripts/${name}.mjs`),join(isolated,`scripts/${name}.mjs`));
    const ledger=join(isolated,'.agent-artifacts/cloud-product/voice-budget.json');mkdirSync(join(isolated,'.agent-artifacts/cloud-product'),{recursive:true});
    const before='own corrupt fixture — dry must not read or rewrite it';writeFileSync(ledger,before);
    const result=spawnSync(process.execPath,[join(isolated,'scripts/cloud-live-probe.mjs'),'--dry'],{encoding:'utf8',env:{OPENAI_API_KEY:'PRIVATE_SENTINEL',HTTPS_PROXY:'https://PRIVATE_PROXY.test:99'},timeout:8000});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({status:'offline_dry',providerAttempts:0,networkCalls:0});
    expect(result.stdout).not.toContain('PRIVATE');expect(readFileSync(ledger,'utf8')).toBe(before);
  } finally {rmSync(isolated,{recursive:true,force:true});}
});
it('unsupported argument and unauthorised workspace child fail before provider creation',()=>{
  for(const args of [['scripts/cloud-live-probe.mjs','--run'],['apps/voice-agent/src/testing/cloud-live-probe.ts']]) {
    const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{},timeout:8000});
    expect(result.status).toBe(2);expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({status:'inconclusive'});
  }
});
it.skipIf(Number(process.versions.node.split('.')[0])!==24).each(['disconnect','stop'])('actual child latches early %s before grant/SDK, without a ledger/provider',async kind=>{
  const child=spawn(process.execPath,['apps/voice-agent/src/testing/cloud-live-probe.ts','--child','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','first'],{env:{},stdio:['ignore','pipe','pipe','ipc']});
  let output='';let stderr='';let sawRequest=false;
  child.stdout!.on('data',chunk=>{output+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
  child.on('message',message=>{
    if((message as {type?:string}).type==='request_grant') {sawRequest=true;if(kind==='disconnect')child.disconnect();else child.send({type:'stop'});}
  });
  const hard=setTimeout(()=>child.kill('SIGKILL'),3000);
  try {
    // После parent.disconnect Node24 не всегда даёт ChildProcess.close; exit + оба EOF доказуемы.
    const [[code]]=await Promise.all([once(child,'exit'),once(child.stdout!,'end'),once(child.stderr!,'end')]);
    expect(sawRequest).toBe(true);expect(code).toBe(2);expect(stderr).toBe('');
    expect(JSON.parse(output)).toMatchObject({status:'inconclusive',providerAttempts:0});
  } finally {clearTimeout(hard);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

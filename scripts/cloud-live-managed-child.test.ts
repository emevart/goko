import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { runManagedChild } from './cloud-live-managed-child.mjs';

it('watchdog is installed before spawn; normal cleanup measures actual wall through exit',async()=>{
  const result=await runManagedChild({hardMs:500,workMs:400, spawnChild:()=>{
    const child=spawn(process.execPath,['-e',"process.send({type:'closed',cleanClose:true,outcome:'closed'});process.disconnect();"],{detached:true,env:{},stdio:['ignore','ignore','ignore','ipc']});
    return child;
  }});
  expect(result.cleanClose).toBe(true);expect(result.wallMs).toBeGreaterThan(0);expect(result.wallMs).toBeLessThan(500);
});
it.each(['hanging-start','hanging-close','death'])('own child %s retains reservation when closure is unproven',async kind=>{
  const result=await runManagedChild({hardMs:120,workMs:50,spawnChild:()=>spawn(process.execPath,['-e', kind==='death'?'process.exit(1)':"process.on('message',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},100);"],{detached:true,env:{},stdio:['ignore','ignore','ignore','ipc']})});
  expect(result.cleanClose).toBe(false);expect(result.wallMs).toBeLessThan(1000);
});
it('spawn failure is charged and safely classified',async()=>{
  const result=await runManagedChild({hardMs:100,workMs:50,spawnChild:()=>{throw new Error('private message');}});
  expect(result).toMatchObject({cleanClose:true,outcome:'failed_connect'});
});
it('one IPC grant only to own matching child, duplicate/wrong pid requests are ignored',async()=>{
  const grant={id:'offline',scenario:'first',parentPid:process.pid,nonce:'offline'};
  const script=`let n=0;process.on('message',m=>{if(m.type==='grant'){n++;process.send({type:'request_grant',id:'offline',scenario:'first',pid:process.pid});setTimeout(()=>{process.send({type:'closed',cleanClose:n===1,outcome:'closed'});process.disconnect();},20);}});process.send({type:'request_grant',id:'offline',scenario:'first',pid:process.pid+1});process.send({type:'request_grant',id:'offline',scenario:'first',pid:process.pid});`;
  const result=await runManagedChild({grant,hardMs:500,workMs:400,spawnChild:()=>spawn(process.execPath,['-e',script],{detached:true,env:{},stdio:['ignore','ignore','ignore','ipc']})});
  expect(result.cleanClose).toBe(true);
});

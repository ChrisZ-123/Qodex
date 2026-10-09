import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {WavesSupervisor,optionalEnvironment,readWavesConfig} from './windows/waves-supervisor.mjs';

// Test the public supervisor module with owned fake children, never ops or production.
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'Qodex Waves 测试 空格 '));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({enabled=true,installed=true,remote=false,occupied=[],initialized=true,killFails=false}={}){
  const root=fs.mkdtempSync(path.join(fixture,'case-'));
  const state=path.join(root,'state'),wavesRoot=path.join(state,'waves');
  fs.mkdirSync(path.join(wavesRoot,'venv','Scripts'),{recursive:true});
  fs.mkdirSync(path.join(wavesRoot,'tools'),{recursive:true});
  fs.mkdirSync(path.join(root,'integrations','waves','adapter'),{recursive:true});
  fs.writeFileSync(path.join(root,'integrations','waves','adapter','service.py'),'');
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({waves:{remoteLoginEnabled:remote}}));
  fs.writeFileSync(path.join(state,'waves-settings.json'),JSON.stringify({enabled}));
  if(installed){fs.writeFileSync(path.join(wavesRoot,'installation.json'),JSON.stringify({version:1,complete:true}));fs.writeFileSync(path.join(wavesRoot,'venv','Scripts','python.exe'),'');}
  fs.writeFileSync(path.join(wavesRoot,'tools','cloudflared.exe'),'');fs.writeFileSync(path.join(wavesRoot,'tools','LICENSE'),'Apache License');
  const spawned=[],killed=[],posts=[];let pid=1000,statusHook=null;
  const spawnChild=(exe,args,options)=>{
    const p=new EventEmitter();Object.assign(p,{pid:pid++,exitCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
    p.finish=code=>{p.exitCode=code;p.emit('exit',code);};spawned.push({exe,args,options,p});
    if(exe==='taskkill.exe'){killed.push(Number(args[1]));queueMicrotask(()=>{if(!killFails)spawned.find(x=>x.p.pid===Number(args[1]))?.p.finish(1);p.finish(killFails?1:0);});}
    return p;
  };
  const supervisor=new WavesSupervisor({root,basePorts:[4001,4002,4003,4004,4005],token:'fixture-waves',spawnChild,log:()=>{},timeoutMs:150,pollMs:10,
    env:{PATH:process.env.PATH,QBOT_WAVES_TOKEN:'inherited',QBOT_CONTROL_TOKEN:'control',QBOT_CONSOLE_TOKEN:'console',OPENAI_API_KEY:'secret',SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD:'password',PYTHONHOME:'foreign'},
    isOpen:async port=>occupied.includes(port)||(port===8789&&supervisor.children.has('waves')),
    fetchRpc:async(url,options)=>{assert.equal(options.headers.authorization,'Bearer fixture-waves');if(url.endsWith('/v1/status')){await statusHook?.();return {ok:true,json:async()=>({ready:initialized,publicLoginReady:posts.length>0&&JSON.parse(posts.at(-1).options.body).url!==null})};}posts.push({url,options});return {ok:true,json:async()=>({changed:true})};}
  });
  return {supervisor,spawned,killed,posts,root,onStatus(fn){statusHook=fn;},settings(value){fs.writeFileSync(path.join(state,'waves-settings.json'),JSON.stringify(value));}};
}
try{
  assert.deepEqual(readWavesConfig({}),{rpcPort:8788,loginPort:8789,tunnelMetricsPort:8790,remoteLoginEnabled:false});
  assert.throws(()=>readWavesConfig({waves:{rpcPort:8789}}),/distinct/);
  assert.throws(()=>readWavesConfig({waves:{rpcPort:4001}},[4001]),/distinct/);
  assert.throws(()=>readWavesConfig({waves:{remoteLoginEnabled:'true'}}),/boolean/);
  assert.deepEqual(optionalEnvironment({QBOT_CONTROL_TOKEN:'x',API_KEY:'x',SECRET:'x',PYTHONHOME:'x',PATH:'path'}),{PATH:'path'});
  {
    const h=harness({enabled:false,installed:false});const status=await h.supervisor.sync();assert.equal(status.enabled,false);assert.equal(h.spawned.length,0);assert.equal(status.error,null);
  }
  {
    const h=harness({installed:false});const status=await h.supervisor.sync();assert.match(status.error,/dependencies missing/);assert.equal(h.spawned.length,0);
  }
  {
    const h=harness({remote:true});fs.rmSync(path.join(h.supervisor.wavesRoot,'tools','LICENSE'));assert.match((await h.supervisor.sync()).error,/remote login dependency missing/);assert.equal(h.spawned.length,0);
  }
  for(const port of [8788,8789,8790]){
    const h=harness({remote:true,occupied:[port]});assert.match((await h.supervisor.sync()).error,/occupied/);assert.equal(h.spawned.length,0);
  }
  {
    const h=harness();await Promise.all([h.supervisor.sync(),h.supervisor.sync()]);assert.equal(h.spawned.length,1);assert.equal(h.supervisor.status().ready,true);
    const python=h.spawned[0];assert.deepEqual(python.args,['-m','adapter.service']);assert.equal(python.options.cwd,h.supervisor.wavesRoot);assert.equal(python.options.env.QBOT_WAVES_TOKEN,'fixture-waves');assert(!('OPENAI_API_KEY'in python.options.env));assert(!('QBOT_CONTROL_TOKEN'in python.options.env));assert(!('PYTHONHOME'in python.options.env));
    await h.supervisor.stopChild('waves',{pid:9999,exitCode:null});assert.equal(h.killed.length,0);
    h.settings({enabled:false});await h.supervisor.sync();assert.deepEqual(h.killed,[python.p.pid]);assert.equal(h.supervisor.children.size,0);
  }
  {
    const h=harness({remote:true});await h.supervisor.sync();const python=h.spawned[0].p,tunnel=h.spawned[1];assert(tunnel.args.includes('http://127.0.0.1:8789'));assert(tunnel.args.includes('127.0.0.1:8790'));assert(!('QBOT_WAVES_TOKEN'in tunnel.options.env));
    tunnel.p.stdout.write('https://fixture.trycloudflare.com\n');await tick();assert.equal(h.posts.length,1);assert.equal(h.supervisor.remoteReady,true);
    python.finish(1);await tick();assert.deepEqual(h.killed,[tunnel.p.pid]);assert.equal(h.supervisor.children.size,0);assert.match(h.supervisor.error,/exited/);
    tunnel.p.stdout.write('https://late.trycloudflare.com\n');await tick();assert.equal(h.posts.length,1);
  }
  {
    const h=harness({remote:true});let release;h.onStatus(()=>new Promise(resolve=>{release=resolve;}));const operation=h.supervisor.sync();while(!release)await tick();h.spawned[0].p.finish(1);release();await operation;assert.equal(h.spawned.length,1);assert.equal(h.killed.length,0);
  }
  {
    const h=harness({initialized:false});const status=await h.supervisor.sync();assert.match(status.error,/timed out/);assert.equal(h.supervisor.children.size,0);assert.equal(h.spawned.filter(x=>x.exe.endsWith('python.exe')).length,1);
  }
  {
    const h=harness({initialized:false});const operation=h.supervisor.sync();while(!h.spawned.length)await tick();await h.supervisor.close();await operation;assert.equal(h.supervisor.children.size,0);assert.equal(h.spawned.filter(x=>x.exe.endsWith('python.exe')).length,1);
  }
  {
    const h=harness({remote:true});await h.supervisor.sync();const tunnel=h.spawned[1].p;tunnel.finish(2);await h.supervisor.publicPending;assert.equal(h.supervisor.ready,true);assert.equal(h.supervisor.remoteReady,false);assert.match(h.supervisor.error,/tunnel exited/);assert.equal(JSON.parse(h.posts.at(-1).options.body).url,null);await h.supervisor.close();
  }
  {
    const h=harness({killFails:true});await h.supervisor.sync();h.settings({enabled:false});assert.match((await h.supervisor.sync()).error,/could not be stopped/);assert.equal(h.supervisor.children.size,1,'Failed stop must retain the owned child handle');
    h.settings({enabled:true});assert.match((await h.supervisor.sync()).error,/not restarted/);assert.equal(h.spawned.filter(x=>x.exe.endsWith('python.exe')).length,1,'Failed stop must not create a second owned service');
    h.spawned[0].p.finish(0);
  }
  console.log('PASS Windows Waves optional defaults, disabled/missing dependencies, port collisions, isolated environment, idempotence, owned cleanup, readiness timeout, unexpected exits and late tunnel output.');
}finally{fs.rmSync(fixture,{recursive:true,force:true});}

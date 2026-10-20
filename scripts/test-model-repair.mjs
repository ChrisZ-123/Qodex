import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import readline from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';

// Run the portable supervisor, replacing only OS/process/network dependencies.
// No real services, ports, credentials, process termination or files are touched.
const raw=fs.readFileSync(new URL('./windows/supervisor.mjs',import.meta.url),'utf8');
const source=raw.slice(0,raw.indexOf('if(await isOpen(controlPort))')).replace(/^import[^\n]*\n/gm,'').replace(/const root=.*;/,'const root="F:/fixture portable 中文 space";')+'\nglobalThis.fixture={repairModel,children:state.children,start:(name,args,cwd)=>startChild(name,"fixture-node",args,cwd),stop};';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({exitBlocked=false,portBlocked=false,modelReady=true,foreignPort=false,inventoryMissing=false,inventoryError=false}={}){
 const spawned=[],killed=[],posts=[],timers=new Map();let nextPid=1000,handler,now=0,gracefulHook=null,statusHook=null,externalOwner=foreignPort?9876:null,tcpReachable=true;
 class Clock extends Date{static now(){return now;}}
 const activeBridge=()=>spawned.filter(x=>x.args[0]?.replaceAll('\\','/').endsWith('/src/bridge.js')&&x.p.exitCode===null&&x.p.signalCode===null).at(-1);
 const portOwner=()=>externalOwner??(portBlocked?9999:activeBridge()?.p.pid);
 const spawn=(exe,args,options)=>{
  const p=new EventEmitter();Object.assign(p,{pid:nextPid++,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  p.finish=code=>{if(p.exitCode!==null)return;p.exitCode=code;p.emit('exit',code);p.emit('close',code);};spawned.push({exe,args,options,p});
  if(exe==='netstat.exe')queueMicrotask(()=>{const owner=portOwner();if(owner&&!inventoryMissing)p.stdout.write(`  TCP    127.0.0.1:43100    0.0.0.0:0    LISTENING    ${owner}\r\n`);p.stdout.write('  TCP    [::]:43101    [::]:0    LISTENING    8765\r\n');p.finish(inventoryError?1:0);});
  if(exe==='taskkill.exe'){killed.push(Number(args[1]));queueMicrotask(()=>{if(!exitBlocked)spawned.find(x=>x.p.pid===Number(args[1]))?.p.finish(1);p.finish(0);});}
  return p;
 };
 const ctx=vm.createContext({
  fs:{existsSync:()=>false,appendFileSync:()=>{},mkdirSync(){},readFileSync:()=>JSON.stringify({backend:'codex',codex:{conversationMode:'model'},consolePort:43100,controlPort:43110,snowluma:{wsUrl:'ws://127.0.0.1:43001',httpUrl:'http://127.0.0.1:43000',webUiUrl:'http://127.0.0.1:45099'}})},path,crypto,readline,spawn,Buffer,URL,AbortSignal,Date:Clock,
  WavesSupervisor:class{read(){} status(){return {}} async close(){}},
  process:{execPath:'fixture-node',on(){},env:{...Object.fromEntries(['QBOT_ONEBOT_TOKEN','QBOT_CONSOLE_TOKEN','QBOT_CONTROL_TOKEN','SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD'].map(k=>[k,'fixture-secret'])),QBOT_CODEX_EXE:'fixture-codex.exe',HTTP_PROXY:'http://old.invalid:1',HTTPS_PROXY:'http://old.invalid:1',http_proxy:'http://old.invalid:1',https_proxy:'http://old.invalid:1',Http_Proxy:'http://mixed.invalid:1',No_Proxy:'*',ALL_PROXY:'socks://old.invalid:1',all_proxy:'socks://old.invalid:1'},exit:()=>{}},
  http:{createServer:fn=>{handler=fn;return {once(){},on(){},listen(){},close(fn){fn?.();}} ;}},
  net:{connect:({port})=>{const s=new EventEmitter();s.setTimeout=()=>{};s.destroy=()=>{};queueMicrotask(()=>s.emit(port===43100&&tcpReachable&&portOwner()?'connect':'error'));return s;}},
  fetch:async(url,options)=>{posts.push({url,options});if(url.endsWith('/api/backend/stop')){await gracefulHook?.();return {ok:true};}if(url.endsWith('/api/status')){await statusHook?.();return {ok:true,json:async()=>({dshReady:modelReady})};}return {ok:false};},
  setTimeout:(fn,ms)=>{const timer={fn,at:now+ms,unref(){return this;}};timers.set(timer,timer);return timer;},clearTimeout:timer=>timers.delete(timer),
 });
 vm.runInContext(source,ctx);
 const fixture=ctx.fixture;
 function startBridge(){return fixture.start('bridge',['F:/fixture portable 中文 space/src/bridge.js'],'fixture');}
 function request({method='POST',url='/repair-model',authorization='Bearer fixture-secret',body='{"proxyUrl":null}'}={}){
  const req=new EventEmitter();Object.assign(req,{method,url,headers:{authorization},resume(){}});
  let resolve;const done=new Promise(r=>resolve=r),res={status:200,body:'',setHeader(){},writeHead(status){this.status=status;return this;},end(body=''){this.body=body;resolve(this);return this;}};
  void handler(req,res);if(body!==null){for(const chunk of Array.isArray(body)?body:[body])req.emit('data',Buffer.from(chunk));req.emit('end');}return done;
 }
 async function expire(){now+=45001;for(const timer of [...timers.values()])if(timer.at<=now){timers.delete(timer);timer.fn();}await tick();}
 return {ctx,fixture,spawned,killed,posts,timers,startBridge,request,expire,onGraceful(fn){gracefulHook=fn;},onStatus(fn){statusHook=fn;},setForeignOwner(pid){externalOwner=pid;},setTcpReachable(value){tcpReachable=value;},setPortBlocked(){portBlocked=true;},get bridgeSpawns(){return spawned.filter(x=>x.args[0]?.replaceAll('\\','/').endsWith('/src/bridge.js'));}};
}
async function until(predicate){for(let n=0;n<100&&!predicate();n++)await tick();assert(predicate(),'Expected asynchronous fixture state');}
function plain(value){return JSON.parse(JSON.stringify(value));}

{
 const h=harness(),old=h.startBridge(),others=['snowluma','waves','waves-tunnel','webot'].map(name=>[name,h.fixture.start(name,[name],'fixture')]);
 let release;h.onGraceful(()=>new Promise(resolve=>{release=resolve;}));
 const first=h.fixture.repairModel('http://127.0.0.1:7890'),second=h.fixture.repairModel('http://127.0.0.1:7890');assert.equal(first,second,'Concurrent repair calls share one operation');
 await until(()=>release);assert.equal(h.killed.length,0,'Graceful model stop precedes tree termination');release();
 assert.equal((await first).ok,true,JSON.stringify(await first));assert.equal((await second).repaired,true);assert.deepEqual(h.killed,[old.pid]);assert.equal(h.bridgeSpawns.length,2,'Exactly one bridge restart');
 const fresh=h.bridgeSpawns[1];assert.equal(fresh.options.env.HTTP_PROXY,'http://127.0.0.1:7890');assert.equal(fresh.options.env.HTTPS_PROXY,'http://127.0.0.1:7890');assert.equal(fresh.options.env.NO_PROXY,'localhost,127.0.0.1,::1');assert.equal(fresh.options.env.QBOT_CODEX_EXE,'fixture-codex.exe');
 for(const key of ['http_proxy','https_proxy','ALL_PROXY','all_proxy','Http_Proxy','No_Proxy'])assert(!(key in fresh.options.env));
 for(const [name,p] of others){assert.equal(h.fixture.children.get(name),p);assert.equal(p.exitCode,null);assert.equal(h.spawned.find(x=>x.p===p).options.env.HTTP_PROXY,'http://old.invalid:1');}
 assert(h.spawned.every(x=>x.options.windowsHide),'Every new process stays hidden');
 assert(h.posts.every(x=>x.url.endsWith('/api/backend/stop')||x.url.endsWith('/api/status')),'No login, message replay or unrelated service calls');
 assert.equal(h.ctx.process.env.HTTP_PROXY,'http://old.invalid:1','Supervisor environment is unchanged');
 h.onGraceful(null);const secondRun=await h.request();assert.equal(secondRun.status,200,'An already ready model can still be explicitly repaired');assert.equal(h.bridgeSpawns.length,3);
 const direct=h.bridgeSpawns[2].options.env;for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','Http_Proxy','No_Proxy'])assert(!(key in direct),'Null removes inherited proxy settings');
 assert.deepEqual(Object.keys(JSON.parse(secondRun.body)).sort(),['message','ok','repaired']);
}
{
 const h=harness({foreignPort:true});h.startBridge();const r=await h.request();assert.equal(r.status,200,'Valid repair results preserve actionable JSON for the launcher');assert.equal(JSON.parse(r.body).code,'UNMANAGED_PORT');assert.equal(h.killed.length,0);assert.equal(h.posts.length,0,'Unmanaged listener must not receive graceful stop');assert.equal(h.bridgeSpawns.length,1);
}
{
 const h=harness({foreignPort:true});const r=await h.request();assert.equal(JSON.parse(r.body).code,'UNMANAGED_PORT');assert.equal(h.bridgeSpawns.length,0,'Unowned bridge cannot be replaced');
}
{
 for(const [options,code] of [[{inventoryMissing:true},'UNVERIFIED_PORT'],[{inventoryError:true},'OWNERSHIP_UNAVAILABLE']]){const h=harness(options);h.startBridge();const result=await h.fixture.repairModel(null);assert.equal(result.code,code);assert.equal(h.killed.length,0);assert.equal(h.posts.length,0,'Unverified port must not receive graceful stop');}
}
{
 const h=harness({exitBlocked:true});h.startBridge();const repair=h.fixture.repairModel(null);await until(()=>h.killed.length);await h.expire();const result=await repair;assert.equal(result.stage,'exit');assert.equal(result.code,'CHILD_EXIT_TIMEOUT');assert.equal(h.bridgeSpawns.length,1,'Taskkill exit alone does not prove old child exited');
}
{
 const h=harness(),old=h.startBridge();h.onGraceful(()=>h.setPortBlocked());const repair=h.fixture.repairModel(null);await until(()=>h.killed.length&&old.exitCode!==null);await h.expire();const result=await repair;assert.equal(result.stage,'port');assert.equal(h.bridgeSpawns.length,1,'Old child exit does not prove port release');
}
{
 const h=harness();h.startBridge();h.onGraceful(()=>{h.setForeignOwner(7654);h.setTcpReachable(false);});const result=await h.fixture.repairModel(null);assert.equal(result.code,'PORT_STILL_OWNED');assert.equal(h.bridgeSpawns.length,1,'A listener invisible to IPv4 probing still prevents replacement');
}
{
 const h=harness();h.startBridge();let release;h.onGraceful(()=>new Promise(resolve=>{release=resolve;}));const repair=h.fixture.repairModel(null);await until(()=>release);h.onGraceful(null);const stop=h.fixture.stop();release();await stop;assert.equal((await repair).stage,'stopping');assert.equal(h.bridgeSpawns.length,1,'Service stop cannot be followed by a late repaired child');
}
{
 const h=harness();h.startBridge();let release;h.onStatus(()=>new Promise(resolve=>{release=resolve;}));const repair=h.fixture.repairModel(null);await until(()=>release);await h.fixture.stop();release();assert.equal((await repair).stage,'stopping','Readiness after stop must not report successful repair');assert.equal(h.bridgeSpawns.length,2);assert.equal(h.fixture.children.size,0);
}
{
 const h=harness();h.startBridge();h.onStatus(()=>h.setForeignOwner(8765));const result=await h.fixture.repairModel(null);assert.equal(result.code,'UNMANAGED_PORT','Successful HTTP readiness alone cannot prove the replacement owns the configured port');assert.equal(h.killed.length,1,'No foreign process is terminated');
}
{
 const h=harness({modelReady:false});h.startBridge();h.onStatus(()=>{throw new Error('fixture-secret raw network error');});const repair=h.fixture.repairModel(null);await until(()=>h.bridgeSpawns.length===2&&h.timers.size>0);await h.expire();const result=plain(await repair);assert.equal(result.ok,false);assert.equal(result.stage,'ready');assert.equal(result.code,'MODEL_NOT_READY');assert.deepEqual(Object.keys(result).sort(),['code','message','ok','stage']);assert(result.message.includes('独立 Codex'));assert(!JSON.stringify(result).includes('fixture-secret'));assert(!JSON.stringify(result).includes('raw network error'));assert.equal(h.bridgeSpawns.length,2,'Unready repair does not restart a second time');
}
{
 const h=harness();for(const body of ['{}','null','[]','{"proxyUrl":true}','{"proxyUrl":1}','{"proxyUrl":null,"target":"waves"}','{"proxyUrl":"http://127.0.0.1:0"}','{"proxyUrl":"http://127.0.0.1:65536"}','{"proxyUrl":"http://127.0.0.1:07890"}','{"proxyUrl":"http://localhost:7890"}','{"proxyUrl":"https://127.0.0.1:7890"}','{"proxyUrl":"http://127.0.0.1:7890/"}','{"proxyUrl":"http://127.0.0.1:7890?token=fixture-secret"}','{"proxyUrl":"http://user:pass@127.0.0.1:7890"}','{"proxyUrl":"http://192.168.1.1:7890"}','{"proxyUrl":null}'+' '.repeat(4096),['{"proxyUrl":null}',' '.repeat(2048),' '.repeat(2048)],'{broken']){
  const r=await h.request({body});assert.equal(r.status,400,body.slice(0,100));assert.equal(JSON.parse(r.body).code,'INVALID_REPAIR_REQUEST');assert(!r.body.includes('fixture-secret'));
 }
 for(const method of ['GET','PUT','DELETE','OPTIONS'])assert.equal((await h.request({method})).status,405);
 assert.equal((await h.request({authorization:'Bearer wrong'})).status,401);
 assert.equal((await h.request({url:'/repair-model?target=waves'})).status,404);
 assert.equal(h.spawned.length,0,'Rejected inputs cannot inspect or mutate processes');
}
{
 for(const proxyUrl of [null,'http://127.0.0.1:1','http://127.0.0.1:65535']){const h=harness();const r=await h.request({body:JSON.stringify({proxyUrl})});assert.equal(r.status,200);assert.equal(h.bridgeSpawns.length,1,'A missing owned bridge starts once when the port is free');}
 const h=harness(),body='{"proxyUrl":null}';assert.equal((await h.request({body:body+' '.repeat(4096-Buffer.byteLength(body))})).status,200,'4096 byte body is accepted');
}
{
 const h=harness(),pending=h.request({body:null});await h.expire();const result=await pending;assert.equal(result.status,400,'A stalled authenticated request body is bounded');assert.equal(h.spawned.length,0);
}
console.log('PASS portable supervisor repair: shared operation, owned bridge-only restart, graceful stop, exit and port gates, stop race, proxy whitelist/environment, method/Bearer protection, safe failures and readiness deadline');

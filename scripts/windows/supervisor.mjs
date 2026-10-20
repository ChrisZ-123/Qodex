import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WavesSupervisor} from './waves-supervisor.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const state={children:new Map(),startupError:null,stopping:false};
const expectedExits=new WeakSet();
let repairPromise=null;
const secrets={onebot:process.env.QBOT_ONEBOT_TOKEN??'',console:process.env.QBOT_CONSOLE_TOKEN??'',control:process.env.QBOT_CONTROL_TOKEN??'',waves:process.env.QBOT_WAVES_TOKEN??''};
const logPath=path.join(root,'logs','windows-supervisor.log');
fs.mkdirSync(path.dirname(logPath),{recursive:true});
function log(kind,value){
  let line=String(value).replace(/([?&]token=)[^\s&]+/gi,'$1[REDACTED]');
  for(const secret of Object.values(secrets))if(secret)line=line.split(secret).join('[REDACTED]');
  fs.appendFileSync(logPath,`${new Date().toISOString()} [${kind}] ${line}\n`);
}
function fail(message,service=null){state.startupError=message;state.startupErrorService=service;log('startup',message);}
function loopbackUrl(value,protocols,name){
  let url;try{url=new URL(value);}catch{throw new Error(`${name} URL is invalid`);}
  const explicitPort=String(value).match(/^[a-z]+:\/\/127\.0\.0\.1:([0-9]+)(?:\/|$)/);
  if(!protocols.includes(url.protocol)||url.hostname!=='127.0.0.1'||!explicitPort||Number(explicitPort[1])<1024||Number(explicitPort[1])>65535||url.username||url.password||url.search||url.hash)throw new Error(`${name} must use 127.0.0.1 with an explicit port and no credentials`);
  url.qodexPort=Number(explicitPort[1]);
  return url;
}
function port(value,name){if(!Number.isInteger(value)||value<1024||value>65535)throw new Error(`${name} must be a port from 1024 to 65535`);return value;}
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
if(config.backend!=='codex'||config.codex?.conversationMode!=='model'||!secrets.console||!secrets.control||!process.env.QBOT_CODEX_EXE)throw new Error('Qodex must be started through Control.ps1 after setup');
const consolePort=port(config.consolePort,'consolePort');
const controlPort=port(config.controlPort,'controlPort');
const ws=loopbackUrl(config.snowluma.wsUrl,['ws:','wss:'],'OneBot WebSocket');
const httpUrl=loopbackUrl(config.snowluma.httpUrl,['http:','https:'],'OneBot HTTP');
const webUi=loopbackUrl(config.snowluma.webUiUrl,['http:','https:'],'SnowLuma WebUI');
if(new Set([consolePort,controlPort,ws.qodexPort,httpUrl.qodexPort,webUi.qodexPort]).size!==5)throw new Error('Qodex and SnowLuma ports must be distinct');
function isOpen(targetPort){return new Promise(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port:targetPort});let finished=false;
  const done=value=>{if(finished)return;finished=true;socket.destroy();resolve(value);};
  socket.setTimeout(500);socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));
});}
const waves=new WavesSupervisor({root,basePorts:[consolePort,controlPort,ws.qodexPort,httpUrl.qodexPort,webUi.qodexPort],token:secrets.waves,isOpen,log});
try{waves.read();}catch{waves.error='Waves settings or port configuration is invalid';}
function startChild(name,command,args,cwd,verbatim=false,extra={}){
  const env={...process.env};
  if(Object.hasOwn(extra,'HTTP_PROXY'))for(const key of Object.keys(env))if(/^(?:https?_proxy|all_proxy|no_proxy)$/i.test(key))delete env[key];
  for(const [key,value] of Object.entries(extra)){if(value===undefined)delete env[key];else env[key]=value;}
  const child=spawn(command,args,{cwd,env,windowsHide:true,windowsVerbatimArguments:verbatim,stdio:['ignore','pipe','pipe']});
  state.children.set(name,child);
  for(const stream of [child.stdout,child.stderr])readline.createInterface({input:stream}).on('line',line=>log(name,line));
  child.once('error',error=>{if(state.children.get(name)===child)state.children.delete(name);fail(`${name} could not start: ${error.code??'unknown error'}`,name);});
  child.once('exit',code=>{if(state.children.get(name)===child)state.children.delete(name);if(!state.stopping&&!expectedExits.has(child)){fail(`${name} exited during startup or operation (${code})`,name);}});
  return child;
}
async function bridgeStatus(){
  const response=await fetch(`http://127.0.0.1:${consolePort}/api/status`,{headers:{'x-console-token':secrets.console},signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('Bridge status unavailable');
  return response.json();
}
async function qqStatus(){
  try{
    const url=new URL('/get_login_info',httpUrl);
    const headers=secrets.onebot?{authorization:`Bearer ${secrets.onebot}`}:{},response=await fetch(url,{headers,signal:AbortSignal.timeout(2000)});
    if(!response.ok)return false;
    const data=await response.json();
    return Boolean(data?.data?.user_id);
  }catch{return false;}
}
async function status(verify=false){
  let bridge;try{bridge=await bridgeStatus();}catch{}
  const services=Object.fromEntries([...state.children].map(([name,child])=>[name,{running:child.exitCode===null,pid:child.pid}]));
  const result={running:!state.stopping,backend:'codex',model:bridge?.model??config.codex.model,reasoningEffort:bridge?.reasoningEffort??config.codex.reasoningEffort,serviceTier:bridge?.serviceTier??config.codex.serviceTier,modelReady:bridge?.dshReady===true,bridgeReady:!!bridge,services,startupError:state.startupError,ports:{console:consolePort,control:controlPort},waves:waves.status()};
  if(verify){result.qqOnline=await qqStatus();result.mode=bridge?.mode??'model';result.groupCount=config.allow?.groups?.length??0;result.privateCount=config.allow?.private?.length??0;}
  return result;
}
function authorized(req){
  const supplied=req.headers.authorization??'';
  const expected=`Bearer ${secrets.control}`;
  const left=Buffer.from(supplied),right=Buffer.from(expected);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}
async function killOwned(name,child=state.children.get(name)){
  if(!child||state.children.get(name)!==child||!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>{
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('error',resolve);killer.once('exit',resolve);
  });
}
const repairMessages={
 input:'修复参数无效；请检查本机 HTTP 代理后重试。',
 ownership:'无法确认本安装控制台端口属于本监督进程；请查看本机状态并手动处理其他实例。',
 stopping:'服务正在停止；请完成停止后重新启动并查看状态。',
 exit:'旧模型服务尚未退出；请查看本机状态后重试。',
 port:'本安装控制台端口尚未释放；请查看本机状态并处理占用后重试。',
 ready:'模型尚未就绪；请检查网络和代理，在独立 Codex 中完成登录后查看状态。',
 success:'模型服务已重启并就绪；历史记录已保留，旧消息不会重新发送。',
};
function repairFailure(stage,code,message=repairMessages[stage]){return {ok:false,stage,code,message};}
function repairInput(req){return new Promise((resolve,reject)=>{
 let size=0,parts=[],done=false;
 let timer;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',fail);req.off('aborted',fail);error?reject(error):resolve(value);};
 const fail=()=>finish(new Error('Invalid request'));
 const data=chunk=>{size+=Buffer.byteLength(chunk);if(size>4096){finish(new Error('Request too large'));req.resume();}else parts.push(chunk);};
 const end=()=>{try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==1||!Object.hasOwn(value,'proxyUrl'))throw new Error('Invalid request');const proxy=value.proxyUrl;if(proxy!==null&&(typeof proxy!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(proxy)||Number(proxy.slice(proxy.lastIndexOf(':')+1))>65535))throw new Error('Invalid proxy');finish(null,proxy);}catch{fail();}};
 timer=setTimeout(fail,5000);req.on('data',data);req.on('end',end);req.on('error',fail);req.on('aborted',fail);
});}
function waitForChild(p,ms){return new Promise(resolve=>{
 const finish=()=>{clearTimeout(timer);p.off('exit',finish);p.off('error',finish);resolve();};
 const timer=setTimeout(finish,ms);p.once('exit',finish);p.once('error',finish);
});}
function childExited(p){return !p||p.exitCode!==null||p.signalCode!==null;}
function bounded(promise,deadline){return new Promise((resolve,reject)=>{const ms=deadline-Date.now();if(ms<=0){reject(new Error('Deadline'));return;}const timer=setTimeout(()=>reject(new Error('Deadline')),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);reject(new Error('Unavailable'));});});}
function bridgePortOwners(deadline){return bounded(new Promise((resolve,reject)=>{
 const p=spawn('netstat.exe',['-ano','-p','tcp'],{windowsHide:true,stdio:['ignore','pipe','ignore']});let output='',complete=false;
 const finish=(error,value)=>{if(complete)return;complete=true;error?reject(error):resolve(value);};
 p.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>1024*1024)finish(new Error('Invalid port inventory'));});
 p.on('error',()=>finish(new Error('Port inventory unavailable')));p.on('close',code=>{if(code!==0){finish(new Error('Port inventory unavailable'));return;}const owners=[];for(const line of output.split(/\r?\n/)){const fields=line.trim().split(/\s+/);if(fields[0]==='TCP'&&Number((fields[1]??'').slice((fields[1]??'').lastIndexOf(':')+1))===consolePort&&fields[3]==='LISTENING'){if(!/^\d+$/.test(fields[4]??'')){finish(new Error('Invalid owner'));return;}owners.push(Number(fields[4]));}}finish(null,owners);});
 }),deadline);}
async function runModelRepair(proxyUrl){
 const deadline=Date.now()+45000,old=state.children.get('bridge');let stage='ownership';
 try{
  if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');
  const owners=await bridgePortOwners(deadline);
  if(owners.some(pid=>!old||childExited(old)||pid!==old.pid))return repairFailure('ownership','UNMANAGED_PORT');
  if(await bounded(isOpen(consolePort),deadline)&&!owners.length)return repairFailure('ownership','UNVERIFIED_PORT');
  if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');
  // Only a verified owned listener may receive the graceful-stop request.
  if(owners.length){try{await bounded(fetch(`http://127.0.0.1:${consolePort}/api/backend/stop`,{method:'POST',headers:{'x-console-token':secrets.console,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(Math.min(8000,Math.max(1,deadline-Date.now())))}),deadline);}catch{}}
  if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');
  stage='exit';if(old)expectedExits.add(old);await bounded(killOwned('bridge',old),deadline);
  while(!childExited(old)){if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');await bounded(waitForChild(old,100),deadline);}
  stage='port';while(await bounded(isOpen(consolePort),deadline)){if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');await bounded(new Promise(resolve=>setTimeout(resolve,100)),deadline);}
  if((await bridgePortOwners(deadline)).length)return repairFailure('port','PORT_STILL_OWNED');
  if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');
  if(state.children.has('bridge'))return repairFailure('ownership','OWNERSHIP_CHANGED');
  if(Date.now()>=deadline)return repairFailure('port','PORT_RELEASE_TIMEOUT');
  const bridge=startChild('bridge',process.execPath,[path.join(root,'src','bridge.js')],root,false,{HTTP_PROXY:proxyUrl??undefined,HTTPS_PROXY:proxyUrl??undefined,http_proxy:undefined,https_proxy:undefined,ALL_PROXY:undefined,all_proxy:undefined,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:undefined});
  stage='ready';
  while(!state.stopping&&state.children.get('bridge')===bridge&&!childExited(bridge)){
   try{const status=await bounded(bridgeStatus(),deadline);if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');if(state.children.get('bridge')===bridge&&!childExited(bridge)&&status.dshReady===true){const owners=await bridgePortOwners(deadline);if(state.stopping)return repairFailure('stopping','SERVICE_STOPPING');if(!owners.length||owners.some(pid=>pid!==bridge.pid))return repairFailure('ownership','UNMANAGED_PORT');if(state.startupErrorService==='bridge'){state.startupError=null;state.startupErrorService=null;}return {ok:true,repaired:true,message:repairMessages.success};}}catch{if(Date.now()>=deadline)break;}
   await bounded(waitForChild(bridge,250),deadline);
  }
  return state.stopping?repairFailure('stopping','SERVICE_STOPPING'):repairFailure('ready','MODEL_NOT_READY');
 }catch{return state.stopping?repairFailure('stopping','SERVICE_STOPPING'):repairFailure(stage,stage==='exit'?'CHILD_EXIT_TIMEOUT':stage==='port'?'PORT_RELEASE_TIMEOUT':stage==='ready'?'MODEL_NOT_READY':'OWNERSHIP_UNAVAILABLE');}
}
function repairModel(proxyUrl){if(!repairPromise)repairPromise=runModelRepair(proxyUrl).finally(()=>{repairPromise=null;});return repairPromise;}

let server;
async function stop(){
  if(state.stopping)return;
  state.stopping=true;
  await waves.close();
  try{
    await fetch(`http://127.0.0.1:${consolePort}/api/backend/stop`,{method:'POST',headers:{'x-console-token':secrets.console,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});
  }catch{log('stop','Bridge graceful cancellation was unavailable');}
  await killOwned('bridge');
  await killOwned('snowluma');
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),2000).unref();
}
server=http.createServer(async(req,res)=>{
  if(!authorized(req)){res.writeHead(401).end();return;}
  res.setHeader('content-type','application/json; charset=utf-8');
  try{
    if(req.url==='/repair-model'){if(req.method!=='POST'){res.writeHead(405).end(JSON.stringify({error:'Method not allowed'}));return;}let proxyUrl;try{proxyUrl=await repairInput(req);}catch{res.writeHead(400).end(JSON.stringify(repairFailure('input','INVALID_REPAIR_REQUEST')));return;}res.end(JSON.stringify(await repairModel(proxyUrl)));return;}
    if(req.url==='/status'&&req.method==='GET'){res.end(JSON.stringify(await status()));return;}
    if(req.url==='/verify'&&req.method==='GET'){res.end(JSON.stringify(await status(true)));return;}
    if(req.url==='/waves/sync'&&req.method==='POST'){if(state.stopping){res.writeHead(409).end(JSON.stringify({error:'Stopping'}));return;}res.end(JSON.stringify(await waves.sync()));return;}
    if(req.url==='/stop'&&req.method==='POST'){res.end(JSON.stringify({stopping:true}));void stop();return;}
    res.writeHead(404).end(JSON.stringify({error:'Unknown action'}));
  }catch{res.writeHead(503).end(JSON.stringify({error:'Local service unavailable'}));}
});
server.once('error',error=>{log('startup',`Control server failed: ${error.code??'unknown error'}`);process.exit(1);});
async function launch(){
  if(state.stopping||repairPromise)return;
  if(await isOpen(consolePort)){fail(`Console port ${consolePort} is occupied; bridge was not started`,'bridge');return;}
  const launcher=config.snowluma.launcherPath;
  if(!(await isOpen(ws.qodexPort))&&launcher){
    if(!path.isAbsolute(launcher)||!fs.existsSync(launcher)){
      fail('Configured SnowLuma launcher is missing');return;
    }
    const extension=path.extname(launcher).toLowerCase();
    if(!['.exe','.cmd','.bat'].includes(extension)){fail('SnowLuma launcher must be .exe, .cmd or .bat');return;}
    const isBatch=extension!=='.exe';
    if(state.stopping||repairPromise)return;
    startChild('snowluma',isBatch?(process.env.ComSpec??'cmd.exe'):launcher,isBatch?['/d','/s','/c',`""${launcher}""`]:[],path.dirname(launcher),isBatch);
  }
  if(state.stopping||repairPromise||state.children.has('bridge'))return;
  startChild('bridge',process.execPath,[path.join(root,'src','bridge.js')],root);
  void waves.sync().catch(()=>{waves.error='Waves optional startup failed';});
}
if(await isOpen(controlPort)){log('startup',`Control port ${controlPort} is occupied`);process.exit(1);}
server.listen(controlPort,'127.0.0.1',()=>{void launch().catch(error=>fail(error.message));});
process.on('SIGINT',()=>{void stop();});
process.on('SIGTERM',()=>{void stop();});

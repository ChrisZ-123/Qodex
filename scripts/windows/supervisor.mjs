import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const state={children:new Map(),startupError:null,stopping:false};
const secrets={onebot:process.env.QBOT_ONEBOT_TOKEN??'',console:process.env.QBOT_CONSOLE_TOKEN??'',control:process.env.QBOT_CONTROL_TOKEN??''};
const logPath=path.join(root,'logs','windows-supervisor.log');
fs.mkdirSync(path.dirname(logPath),{recursive:true});
function log(kind,value){
  let line=String(value).replace(/([?&]token=)[^\s&]+/gi,'$1[REDACTED]');
  for(const secret of Object.values(secrets))if(secret)line=line.split(secret).join('[REDACTED]');
  fs.appendFileSync(logPath,`${new Date().toISOString()} [${kind}] ${line}\n`);
}
function fail(message){state.startupError=message;log('startup',message);}
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
function startChild(name,command,args,cwd,verbatim=false){
  const child=spawn(command,args,{cwd,env:process.env,windowsHide:true,windowsVerbatimArguments:verbatim,stdio:['ignore','pipe','pipe']});
  state.children.set(name,child);
  for(const stream of [child.stdout,child.stderr])readline.createInterface({input:stream}).on('line',line=>log(name,line));
  child.once('error',error=>{state.children.delete(name);fail(`${name} could not start: ${error.code??'unknown error'}`);});
  child.once('exit',code=>{state.children.delete(name);if(!state.stopping){fail(`${name} exited during startup or operation (${code})`);}});
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
  const result={running:!state.stopping,backend:'codex',model:bridge?.model??config.codex.model,reasoningEffort:bridge?.reasoningEffort??config.codex.reasoningEffort,serviceTier:bridge?.serviceTier??config.codex.serviceTier,modelReady:bridge?.dshReady===true,bridgeReady:!!bridge,services,startupError:state.startupError,ports:{console:consolePort,control:controlPort}};
  if(verify){result.qqOnline=await qqStatus();result.mode=bridge?.mode??'model';result.groupCount=config.allow?.groups?.length??0;result.privateCount=config.allow?.private?.length??0;}
  return result;
}
function authorized(req){
  const supplied=req.headers.authorization??'';
  const expected=`Bearer ${secrets.control}`;
  const left=Buffer.from(supplied),right=Buffer.from(expected);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}
async function killOwned(name){
  const child=state.children.get(name);
  if(!child||!child.pid||child.exitCode!==null)return;
  await new Promise(resolve=>{
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('error',resolve);killer.once('exit',resolve);
  });
}
let server;
async function stop(){
  if(state.stopping)return;
  state.stopping=true;
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
    if(req.url==='/status'&&req.method==='GET'){res.end(JSON.stringify(await status()));return;}
    if(req.url==='/verify'&&req.method==='GET'){res.end(JSON.stringify(await status(true)));return;}
    if(req.url==='/stop'&&req.method==='POST'){res.end(JSON.stringify({stopping:true}));void stop();return;}
    res.writeHead(404).end(JSON.stringify({error:'Unknown action'}));
  }catch{res.writeHead(503).end(JSON.stringify({error:'Local service unavailable'}));}
});
server.once('error',error=>{log('startup',`Control server failed: ${error.code??'unknown error'}`);process.exit(1);});
async function launch(){
  if(await isOpen(consolePort)){fail(`Console port ${consolePort} is occupied; bridge was not started`);return;}
  const launcher=config.snowluma.launcherPath;
  if(!(await isOpen(ws.qodexPort))&&launcher){
    if(!path.isAbsolute(launcher)||!fs.existsSync(launcher)){
      fail('Configured SnowLuma launcher is missing');return;
    }
    const extension=path.extname(launcher).toLowerCase();
    if(!['.exe','.cmd','.bat'].includes(extension)){fail('SnowLuma launcher must be .exe, .cmd or .bat');return;}
    const isBatch=extension!=='.exe';
    startChild('snowluma',isBatch?(process.env.ComSpec??'cmd.exe'):launcher,isBatch?['/d','/s','/c',`""${launcher}""`]:[],path.dirname(launcher),isBatch);
  }
  startChild('bridge',process.execPath,[path.join(root,'src','bridge.js')],root);
}
if(await isOpen(controlPort)){log('startup',`Control port ${controlPort} is occupied`);process.exit(1);}
server.listen(controlPort,'127.0.0.1',()=>{void launch().catch(error=>fail(error.message));});
process.on('SIGINT',()=>{void stop();});
process.on('SIGTERM',()=>{void stop();});

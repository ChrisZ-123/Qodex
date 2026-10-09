import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

export const wavesDefaults={rpcPort:8788,loginPort:8789,tunnelMetricsPort:8790,remoteLoginEnabled:false};
export function readWavesConfig(config,basePorts=[]){
  const raw=config.waves??{};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('waves configuration must be an object');
  const value={...wavesDefaults,...raw};
  for(const name of ['rpcPort','loginPort','tunnelMetricsPort'])if(!Number.isInteger(value[name])||value[name]<1024||value[name]>65535)throw new Error(`waves.${name} must be a port from 1024 to 65535`);
  if(typeof value.remoteLoginEnabled!=='boolean')throw new Error('waves.remoteLoginEnabled must be boolean');
  const ports=[...basePorts,value.rpcPort,value.loginPort,value.tunnelMetricsPort];
  if(new Set(ports).size!==ports.length)throw new Error('Waves and base service ports must be distinct');
  return value;
}
export function optionalEnvironment(source,extra={}){
  const result={...source};
  for(const key of Object.keys(result))if(/TOKEN|PASSWORD|SECRET|API[_-]?KEY|CREDENTIAL/i.test(key)||key.startsWith('QBOT_')||key==='PYTHONPATH'||key==='PYTHONHOME')delete result[key];
  return {...result,...extra};
}
export class WavesSupervisor{
  constructor({root,basePorts,token,isOpen,log,spawnChild=spawn,fetchRpc=fetch,env=process.env,timeoutMs=30000,pollMs=200}){
    Object.assign(this,{root,basePorts,token,isOpen,log,spawnChild,fetchRpc,env,timeoutMs,pollMs});
    this.children=new Map();this.expected=new WeakSet();this.pending=Promise.resolve();this.publicPending=Promise.resolve();this.error=null;this.ready=false;this.remoteReady=false;this.enabled=false;this.installed=false;this.config={...wavesDefaults};this.activeConfig=null;this.stopping=false;this.closing=false;
    this.wavesRoot=path.join(root,'state','waves');
  }
  read(){
    this.config=readWavesConfig(JSON.parse(fs.readFileSync(path.join(this.root,'config.json'),'utf8').replace(/^\uFEFF/,'')),this.basePorts);
    const settingsPath=path.join(this.root,'state','waves-settings.json');
    const settings=fs.existsSync(settingsPath)?JSON.parse(fs.readFileSync(settingsPath,'utf8').replace(/^\uFEFF/,'')):{enabled:false};
    if(typeof settings.enabled!=='boolean')throw new Error('waves-settings.json.enabled must be boolean');
    this.enabled=settings.enabled;
    try{const marker=JSON.parse(fs.readFileSync(path.join(this.wavesRoot,'installation.json'),'utf8'));this.installed=marker.version===1&&marker.complete===true;}catch{this.installed=false;}
  }
  status(){return {installed:this.installed,enabled:this.enabled,ready:this.ready,remoteLoginEnabled:this.config.remoteLoginEnabled,remoteReady:this.remoteReady,error:this.error};}
  child(name,command,args,env){
    const child=this.spawnChild(command,args,{cwd:this.wavesRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.children.set(name,child);
    for(const stream of [child.stdout,child.stderr])if(stream)readline.createInterface({input:stream}).on('line',line=>{
      this.log(name,line);
      if(name==='waves-tunnel'&&this.children.get(name)===child&&this.ready&&!this.remoteReady){
        const url=String(line).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=\s|[|]|$)/i)?.[0];
        if(url)void this.registerPublicUrl(url,child);
      }
    });
    const ended=message=>{
      if(this.children.get(name)!==child)return;
      this.children.delete(name);
      if(!this.expected.has(child)&&!this.stopping){this.error=message;this.log(name,message);}
      if(name==='waves'){this.ready=false;this.remoteReady=false;void this.stopChild('waves-tunnel');}
      if(name==='waves-tunnel'){this.remoteReady=false;void this.clearPublicUrl();}
    };
    if(name==='waves-tunnel'){
      const timer=setTimeout(()=>{if(this.children.get(name)===child&&!this.remoteReady){this.error='Waves tunnel readiness timed out';void this.stopChild(name);}},this.timeoutMs);
      timer.unref?.();child.once('exit',()=>clearTimeout(timer));child.once('error',()=>clearTimeout(timer));
    }
    child.once('error',error=>ended(`${name} could not start: ${error.code??'unknown error'}`));
    child.once('exit',code=>ended(`${name} exited (${code})`));
    return child;
  }
  async stopChild(name,expectedChild=this.children.get(name)){
    const child=this.children.get(name);
    if(!child||child!==expectedChild)return;
    this.expected.add(child);
    if(child.exitCode!==null||!child.pid){this.children.delete(name);return;}
    const killed=await new Promise(resolve=>{
      const killer=this.spawnChild('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.once('error',()=>resolve(false));killer.once('exit',code=>resolve(code===0));
    });
    if(!killed&&child.exitCode===null){this.error=`${name} owned process could not be stopped`;this.log(name,this.error);return;}
    if(this.children.get(name)===child)this.children.delete(name);
  }
  async stop(){this.stopping=true;await this.stopChild('waves-tunnel');await this.publicPending;await this.stopChild('waves');this.ready=false;this.remoteReady=false;this.activeConfig=null;this.stopping=false;}
  async close(){this.closing=true;await this.stop();await this.pending;}
  async rpc(route,body){
    const response=await this.fetchRpc(`http://127.0.0.1:${this.config.rpcPort}${route}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${this.token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2000)});
    if(!response.ok)throw new Error('Waves RPC unavailable');
    return response.json();
  }
  registerPublicUrl(url,child){
    this.publicPending=this.publicPending.then(async()=>{
      if(this.children.get('waves-tunnel')!==child||!this.ready)return;
      try{await this.rpc('/v1/public-url',{url});const health=await this.rpc('/v1/status');if(this.children.get('waves-tunnel')===child&&this.ready)this.remoteReady=health.publicLoginReady===true;}
      catch{if(this.children.get('waves-tunnel')===child){this.error='Waves public login URL registration failed';this.log('waves',this.error);}}
    });
    return this.publicPending;
  }
  clearPublicUrl(){
    this.publicPending=this.publicPending.then(async()=>{
      if(!this.children.has('waves'))return;
      try{await this.rpc('/v1/public-url',{url:null});}catch{this.error='Waves public login URL cleanup failed';this.log('waves',this.error);}
    });
    return this.publicPending;
  }
  sync(){const operation=this.pending.then(()=>this.reconcile());this.pending=operation.catch(()=>{});return operation;}
  async reconcile(){
    if(this.closing)return this.status();
    try{this.read();}catch{await this.stop();this.error='Waves settings or port configuration is invalid';return this.status();}
    if(!this.enabled){await this.stop();if(!this.children.size)this.error=null;return this.status();}
    const key=JSON.stringify(this.config);
    if(this.children.has('waves')&&this.activeConfig===key)return this.status();
    await this.stop();this.error=null;
    if(this.children.size){this.error='Waves owned process could not be stopped; optional services were not restarted';return this.status();}
    const python=path.join(this.wavesRoot,'venv','Scripts','python.exe');
    if(!this.installed||!fs.existsSync(python)||!fs.existsSync(path.join(this.root,'integrations','waves','adapter','service.py'))){this.error='Waves dependencies missing; run Install-Waves.ps1';return this.status();}
    if(!this.token){this.error='Waves DPAPI secret missing; run Install-Waves.ps1';return this.status();}
    const executable=path.join(this.wavesRoot,'tools','cloudflared.exe');
    if(this.config.remoteLoginEnabled&&(!fs.existsSync(executable)||!fs.existsSync(path.join(this.wavesRoot,'tools','LICENSE')))){this.error='Waves remote login dependency missing; run Install-Waves.ps1 -RemoteLogin';return this.status();}
    const required=[this.config.rpcPort,this.config.loginPort,...(this.config.remoteLoginEnabled?[this.config.tunnelMetricsPort]:[])];
    for(const target of required)if(await this.isOpen(target)){this.error=`Waves port ${target} is occupied; optional services were not started`;return this.status();}
    if(this.closing)return this.status();
    this.activeConfig=key;
    const pythonEnv=optionalEnvironment(this.env,{QBOT_WAVES_TOKEN:this.token,QBOT_WAVES_ROOT:this.wavesRoot,QBOT_WAVES_RPC_PORT:String(this.config.rpcPort),QBOT_WAVES_LOGIN_PORT:String(this.config.loginPort),PYTHONPATH:[path.join(this.root,'integrations','waves'),path.join(this.wavesRoot,'core')].join(path.delimiter)});
    const child=this.child('waves',python,['-m','adapter.service'],pythonEnv);
    const deadline=Date.now()+this.timeoutMs;
    while(this.children.get('waves')===child&&Date.now()<deadline){
      try{const health=await this.rpc('/v1/status');if(health.ready===true&&await this.isOpen(this.config.loginPort)&&this.children.get('waves')===child){this.ready=true;break;}}catch{}
      await new Promise(resolve=>{const timer=setTimeout(done,this.pollMs);function done(){clearTimeout(timer);child.removeListener('exit',done);child.removeListener('error',done);resolve();}child.once('exit',done);child.once('error',done);});
    }
    if(!this.ready){if(!this.error)this.error='Waves readiness timed out';await this.stop();return this.status();}
    if(this.config.remoteLoginEnabled)this.child('waves-tunnel',executable,['tunnel','--url',`http://127.0.0.1:${this.config.loginPort}`,'--metrics',`127.0.0.1:${this.config.tunnelMetricsPort}`,'--no-autoupdate'],optionalEnvironment(this.env));
    return this.status();
  }
}

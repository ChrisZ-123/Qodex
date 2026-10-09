import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const keyOK=k=>/^(group|private):[1-9]\d*$/.test(k);
const qqOK=q=>/^[1-9]\d*$/.test(String(q));
const atomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);};
const empty=()=>({version:1,revision:0,enabled:false,conversations:{}});
export function validateWavesSettings(value){
  if(!value||value.version!==1||typeof value.enabled!=='boolean'||!value.conversations||typeof value.conversations!=='object'||Array.isArray(value.conversations)||Object.keys(value.conversations).length>1000)throw Error('鸣潮设置格式无效');
  const conversations={};
  for(const [key,enabled]of Object.entries(value.conversations)){if(!keyOK(key)||!(enabled===null||typeof enabled==='boolean'))throw Error('鸣潮会话设置无效');conversations[key]=enabled;}
  return {version:1,enabled:value.enabled,conversations};
}
export class WavesSettings{
  constructor(file){this.file=file;this.reload();}
  reload(){this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8').replace(/^\uFEFF/,'')):empty();validateWavesSettings(this.data);}
  read(){return structuredClone(this.data);}
  enabled(key){return this.data.enabled&&(this.data.conversations[key]??true);}
  update({key=null,enabled,revision}){if(revision!==this.data.revision)throw Object.assign(Error('鸣潮设置已变化，请重新载入'),{statusCode:409});const data=this.read();if(key){if(!keyOK(key)||!(enabled===null||typeof enabled==='boolean'))throw Error('会话开关无效');data.conversations[key]=enabled;}else{if(typeof enabled!=='boolean')throw Error('全局开关无效');data.enabled=enabled;}data.revision++;atomic(this.file,data);this.data=data;return this.read();}
  export(){return validateWavesSettings(this.data);}
  restore(data){const clean=validateWavesSettings(data);this.data={...clean,revision:this.data.revision+1};atomic(this.file,this.data);}
}
export function imageMime(bytes){
  if(bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw Error('鸣潮图片格式不支持');
}
export function loadWavesAsset(root,asset){
  if(!asset||typeof asset.path!=='string')throw Error('鸣潮图片不存在');
  const base=fs.realpathSync(path.join(root,'results')),file=fs.realpathSync(asset.path);
  if(!file.toLowerCase().startsWith(base.toLowerCase()+path.sep))throw Error('鸣潮图片越界');
  if(asset.taskId&&(!/^[\w-]{1,100}$/.test(asset.taskId)||!file.toLowerCase().startsWith(path.join(base,asset.taskId).toLowerCase()+path.sep)))throw Error('鸣潮图片不属于本轮游戏任务');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size<9||stat.size>15_000_000)throw Error('鸣潮图片大小无效');
  const bytes=fs.readFileSync(file);return {bytes,mimeType:imageMime(bytes)};
}
export class WavesClient{
  constructor({root,token=process.env.QBOT_WAVES_TOKEN,base='http://127.0.0.1:8788',fetchImpl=fetch}){Object.assign(this,{root,token,base,fetchImpl});const u=new URL(base);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('鸣潮服务必须位于本机');}
  async call(route,body){
    if(!this.token)throw Error('鸣潮服务凭据尚未就绪，请通过启动页启动');
    const r=await this.fetchImpl(this.base+route,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(`鸣潮接口失败（${r.status}）：${safeGameText(data.error||'未返回可读原因')}`);return data;
  }
  async execute(scope,command,{isCurrent=()=>true,onStatus=()=>{},images=[]}={}){
    if(!keyOK(scope.key)||!qqOK(scope.senderQQ)||!scope.messageId||!scope.requestId||!isCurrent())throw Error('鸣潮调用来源无效或已取消');
    const requestId=crypto.randomUUID();scope.gameRequestIds??=new Set();scope.gameRequestIds.add(requestId);
    try{
      await this.call('/v1/execute',{requestId,key:scope.key,senderQQ:String(scope.senderQQ),messageId:String(scope.messageId),command,images});
      return await this.waitTask(scope,requestId,{isCurrent,onStatus});
    }finally{scope.gameRequestIds.delete(requestId);}
  }
  async waitTask(scope,requestId,{isCurrent=()=>true,onStatus=()=>{}}={}){
    if(typeof requestId!=='string'||!/^[\w-]{1,100}$/.test(requestId))throw Error('鸣潮任务标识无效');
    scope.gameRequestIds??=new Set();scope.gameRequestIds.add(requestId);const started=Date.now();
    try{for(;;){
        if(!isCurrent()){await this.cancel(requestId);throw Error('鸣潮请求已取消');}
        const task=await this.call('/v1/tasks/'+encodeURIComponent(requestId));
        if(task.requestId!==requestId)throw Error('鸣潮结果不属于本轮');
        onStatus(task.status,Date.now()-started);
        if(task.status==='completed')return {requestId,elapsedMs:Date.now()-started,outputs:Array.isArray(task.outputs)?task.outputs:[]};
        if(task.status==='failed'||task.status==='cancelled')throw Error(task.status==='cancelled'?'鸣潮请求已取消':safeGameText(task.error||'鸣潮请求失败'));
        if(Date.now()-started>300000){await this.cancel(requestId);throw Error('鸣潮请求超过五分钟，已请求取消；未自动重试');}
        await new Promise(resolve=>setTimeout(resolve,400));
      }
    }finally{scope.gameRequestIds.delete(requestId);}
  }
  cancel(requestId){return this.call('/v1/cancel',{requestId});}
  saveInputs(scope,images){
    if(!images?.length)return [];
    const dir=path.join(this.root,'inputs',crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
    return images.filter(x=>x.type==='image').slice(0,5).map((x,i)=>{
      const data=x.data??x.source?.data;if(typeof data!=='string')throw Error('鸣潮截图数据无效');
      const bytes=Buffer.from(data,'base64');if(bytes.length>4*1024*1024)throw Error('鸣潮截图超过 4 MiB');const mime=imageMime(bytes),file=path.join(dir,i+(mime==='image/png'?'.png':mime==='image/jpeg'?'.jpg':'.webp'));fs.writeFileSync(file,bytes);return {path:file};
    });
  }
}
// Neither plugin text nor errors may smuggle a login ticket/credential into history.
export function safeGameText(value){return String(value??'').replace(/https?:\/\/[^\s]*trycloudflare\.com[^\s]*/gi,'[登录入口仅私发本人]').replace(/\b1[3-9]\d{9}\b/g,'[手机号已隐藏]').replace(/((?:cookie|token|authorization|password|验证码|手机号|凭据)\s*[:=：]\s*)\S+/gi,'$1[已隐藏]').slice(0,20000);}
const mutation=command=>{
  const s=command.replace(/^ww\s*/i,'').trim();
  if(/^(登录|登陆|绑定账号)$/.test(s))return {type:'login',label:'创建三分钟网页登录入口，链接仅私发你本人'};
  if(/^(解绑|删除绑定|注销账号)$/.test(s))return {type:'unbind',label:'删除你自己的鸣潮账号绑定及自动任务'};
  if(s==='签到')return {type:'sign',label:'使用你自己的国服鸣潮账号执行本次库街区签到'};
  const sign=s.match(/^(开启|关闭)(自动签到|签到)$/);if(sign)return {type:'subscribe',patch:{signEnabled:sign[1]==='开启'},label:sign[1]+'当前会话的自动签到'};
  const reminder=s.match(/^(开启|关闭)体力提醒(?:\s*(\d+))?$/);if(reminder)return {type:'subscribe',patch:{reminderEnabled:reminder[1]==='开启',...(reminder[2]?{threshold:Number(reminder[2])}:{})},label:reminder[1]+'当前会话的体力提醒'+(reminder[2]?'，阈值 '+reminder[2]:'，默认阈值 180')};
  return null;
};
export class WavesController{
  constructor({root,settings,client,allowed,paused,keys,sendPrivate,sendNotice,redact=s=>s}){Object.assign(this,{root,settings,client,allowed,paused,keys,sendPrivate,sendNotice,redact});this.pending=new Map();this.bindings=new Map();this.sourceEpochs=new Map();this.runFile=path.join(root,'data','qodex-runs.json');this.runs=fs.existsSync(this.runFile)?JSON.parse(fs.readFileSync(this.runFile,'utf8')):[];this.policyPromise=null;this.healthFile=path.join(root,'data','qodex-health.json');this.health=fs.existsSync(this.healthFile)?JSON.parse(fs.readFileSync(this.healthFile,'utf8')):{errors:[]};this.noticeFile=path.join(root,'data','qodex-notices.json');this.noticeAttempts=fs.existsSync(this.noticeFile)?JSON.parse(fs.readFileSync(this.noticeFile,'utf8')):[];}
  operationalFailure(phase,error,key=null){const item={phase,key,at:new Date().toISOString(),detail:this.redact(safeGameText(error.message??error)).slice(0,500)};this.health.errors.push(item);this.health.errors=this.health.errors.slice(-80);atomic(this.healthFile,this.health);}
  valid(scope){return keyOK(scope.key)&&qqOK(scope.senderQQ)&&this.allowed(scope.key)&&!this.paused(scope.key)&&this.settings.enabled(scope.key);}
  sourceEpoch(key){return this.sourceEpochs.get(key)??0;}
  retainedOriginCurrent(p){return p.sourceEpoch===this.sourceEpoch(p.key)&&this.valid(p);}
  retainedCurrent(p){return p.expiresAt>Date.now()&&this.retainedOriginCurrent(p);}
  async syncPolicy(){
    // Recompute when this queued write executes, so a stale caller cannot
    // restore permissions after a later pause/disable. Failures keep the queue usable.
    const task=(this.policyPromise??Promise.resolve()).catch(()=>{}).then(async()=>{
      const keys=this.keys().filter(k=>this.allowed(k)&&this.settings.enabled(k));
      const policy={allowedKeys:keys,pausedKeys:keys.filter(k=>this.paused(k)),globalPaused:false};
      try{await this.client.call('/v1/policy',policy);this.health.policy={synced:true,at:new Date().toISOString()};}
      catch(error){this.health.policy={synced:false,at:new Date().toISOString(),error:this.redact(safeGameText(error.message))};this.operationalFailure('policy',error);throw error;}
      finally{atomic(this.healthFile,this.health);}
    });
    this.policyPromise=task;
    try{await task;}finally{if(this.policyPromise===task)this.policyPromise=null;}
  }
  scopeCurrent(scope){return this.valid(scope)&&(scope.isCurrent?.()??true);}
  async status(){
    let installation;try{installation=JSON.parse(fs.readFileSync(path.join(this.root,'installation.json'),'utf8'));}catch{}
    let service={installed:installation?.complete===true,enabled:this.settings.data.enabled,ready:false,publicLoginReady:false,capabilities:[]};
    if(service.enabled&&service.installed){try{service={...service,...await this.client.call('/v1/status')};}catch(error){service.error=safeGameText(error.message);}}
    else if(service.enabled)service.error='鸣潮模块尚未安装完成，请运行 scripts/windows/Install-Waves.ps1';
    this.serviceStatus=service;return {settings:this.settings.read(),service,runs:this.runs.slice(-80).reverse(),operational:structuredClone(this.health)};
  }
  record(scope,patch){let r=this.runs.find(x=>x.id===scope.requestId);if(!r){r={id:scope.requestId,key:scope.key,senderQQ:scope.senderQQ,at:new Date().toISOString(),command:scope.command,status:'running'};this.runs.push(r);this.runs=this.runs.slice(-100);}Object.assign(r,patch);atomic(this.runFile,this.runs);}
  async query(scope,command){
    if(!this.scopeCurrent(scope))throw Error('鸣潮已关闭、暂停或来源未授权');
    if(typeof command!=='string'||command.length>500||!/^ww[^\r\n]*$/i.test(command))throw Error('请使用单条 ww 指令');
    if(/(?:cookie|token|验证码|密码|手机号|导出|获取ck|获取cookie|授权码|设置ck|添加ck)/i.test(command)||/\b1[3-9]\d{9}\b/.test(command)||/^ww\s*(core|管理|安装|重启|更新插件|下载全部资源)/i.test(command))throw Error('凭据及维护操作只能通过本机管理或网页登录');
    const sourceEpoch=this.sourceEpoch(scope.key);scope.command=command;this.record(scope,{});
    const change=mutation(command);
    try{
      await this.syncPolicy();
      if(sourceEpoch!==this.sourceEpoch(scope.key)||!this.scopeCurrent(scope))throw Error('鸣潮请求已取消或会话权限已变化');
      if(change){const id=crypto.randomUUID(),p={...change,id,key:scope.key,senderQQ:String(scope.senderQQ),sourceEpoch,expiresAt:Date.now()+180000};
        if(['sign','unbind'].includes(p.type)){const r=await this.client.call('/v1/mutations/prepare',{senderQQ:p.senderQQ,key:p.key,messageId:scope.messageId,action:p.type});p.serverRequestId=r.requestId;}
        if(!this.retainedCurrent(p)||!this.scopeCurrent(scope))throw Error('鸣潮请求已取消或会话权限已变化');
        this.pending.set(id,p);this.record(scope,{status:'confirmation'});
        if(p.type==='login'&&scope.nativeCommand)return {outputs:await this.confirmation(scope,id),requestId:scope.requestId};
        return {outputs:[{type:'text',text:change.label+'。如确认，请本人发送“ww确认 '+id+'”；三分钟内有效。'}],requestId:scope.requestId,assets:[]};
      }
      const result=await this.client.execute(scope,command,{isCurrent:()=>this.scopeCurrent(scope),images:this.client.saveInputs(scope,scope.images??[]),onStatus:(status,elapsedMs)=>{this.record(scope,{status,elapsedMs});scope.onStatus?.(status,elapsedMs);}});
      if(!this.scopeCurrent(scope))throw Error('鸣潮结果已取消或会话权限已变化');
      const outputs=this.resultOutputs(scope,result);
      this.record(scope,{status:'completed',elapsedMs:result.elapsedMs});return {...result,outputs};
    }catch(error){this.record(scope,{status:'failed',error:this.redact(safeGameText(error.message))});throw error;}
  }
  resultOutputs(scope,result){
      if(!this.scopeCurrent(scope))throw Error('鸣潮结果已取消或会话权限已变化');
      const outputs=[];
      for(const item of result.outputs){
        if(item.type==='text')outputs.push({type:'text',text:this.redact(safeGameText(item.text))});
        else if(item.type==='image'&&typeof item.id==='string'&&item.id.length<150){if(!result.requestId)throw Error('鸣潮图片缺少任务归属');const id=crypto.randomUUID(),asset={id,key:scope.key,runId:scope.requestId,taskId:result.requestId,path:item.path,createdAt:new Date().toISOString()};loadWavesAsset(this.root,asset);scope.gameAssets??=new Map();scope.gameAssets.set(id,asset);outputs.push({type:'image',id});}
      }
      return outputs;
  }
  async confirmation(scope,id){
    const p=this.pending.get(id),login=this.bindings.get(String(scope.senderQQ));
    if(!p){
      if(!login||login.requestId!==id||!this.retainedCurrent(login))throw Error('确认已过期或不属于你');
      let accepted=false;const current=()=>this.retainedOriginCurrent(login)&&(accepted||login.expiresAt>Date.now())&&(scope.isCurrent?.()??true);scope.gameOriginCurrent=current;
      if(!current())throw Error('确认已取消或会话权限已变化');
      const r=await this.client.call('/v1/login/confirm',{senderQQ:String(scope.senderQQ),requestId:id,accept:true});
      accepted=true;
      if(!current()||this.bindings.get(String(scope.senderQQ))!==login)throw Error('确认已取消或登录请求已变化');
      this.bindings.delete(String(scope.senderQQ));return [{type:'text',text:'已绑定你的鸣潮账号：'+safeGameText(r.account?.nickname||r.nickname||r.uid||'成功')}];
    }
    let accepted=false;const current=()=>this.retainedOriginCurrent(p)&&(accepted||p.expiresAt>Date.now())&&(scope.isCurrent?.()??true);scope.gameOriginCurrent=current;
    if(p.senderQQ!==String(scope.senderQQ)||!current())throw Error('确认已过期、会话已暂停或不属于你');
    this.pending.delete(id);await this.syncPolicy();
    if(!current())throw Error('确认已取消或会话权限已变化');
    if(p.type==='login'){
      const r=await this.client.call('/v1/login/create',{key:p.key,senderQQ:p.senderQQ,messageId:scope.messageId});
      accepted=true;
      let u;try{u=new URL(r.url);}catch{throw Error('登录服务未返回有效入口');}if(u.protocol!=='https:'||!u.hostname.endsWith('.trycloudflare.com'))throw Error('登录入口来源无效');
      const expiresAt=Date.parse(r.expiresAt);if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw Error('登录入口有效期无效');
      const binding={requestId:r.requestId,key:p.key,senderQQ:p.senderQQ,sourceEpoch:p.sourceEpoch,expiresAt};
      const originCurrent=current;
      if(!originCurrent())throw Error('登录请求已取消或会话权限已变化');
      this.bindings.set(p.senderQQ,binding);
      const deliveryCurrent=()=>this.bindings.get(p.senderQQ)===binding&&this.retainedCurrent(binding)&&originCurrent();
      try{await this.sendPrivate(p.senderQQ,'鸣潮账号登录（仅你本人，三分钟有效）：\n'+r.url+'\n完成后等待账号概要，并由你确认绑定。',deliveryCurrent);}
      catch{if(this.bindings.get(p.senderQQ)===binding)this.bindings.delete(p.senderQQ);throw Error('无法私发登录入口，请先添加机器人为好友，再发 ww登录');}
      return [{type:'text',text:'登录入口已私发你本人，三分钟有效；登录后需你确认账号概要。'}];
    }
    if(['sign','unbind'].includes(p.type)){
      const started=await this.client.call('/v1/mutations/confirm',{senderQQ:p.senderQQ,requestId:p.serverRequestId,accept:true});
      accepted=true;
      if(!current())throw Error('确认已取消或会话权限已变化');
      if(p.type==='unbind')return [{type:'text',text:safeGameText(started.text||'已解除你自己的鸣潮绑定与自动任务。')}];
      const result=await this.client.waitTask(scope,started.requestId,{isCurrent:current,onStatus:(status,elapsedMs)=>{this.record(scope,{status,elapsedMs});scope.onStatus?.(status,elapsedMs);}});
      if(!current())throw Error('确认已取消或会话权限已变化');
      const outputs=this.resultOutputs(scope,result);this.record(scope,{status:'completed',elapsedMs:result.elapsedMs});
      return outputs.length?outputs:[{type:'text',text:'签到任务已结束，上游未返回结果，请核对签到状态。'}];
    }
    await this.client.call('/v1/subscriptions',{senderQQ:p.senderQQ,key:p.key,...p.patch});accepted=true;if(!current())throw Error('确认已取消或会话权限已变化');return [{type:'text',text:'已'+p.label+'。暂停或移出白名单后停止执行，不补发积压提醒。'}];
  }
  async command(scope,command){const match=command.match(/^ww\s*确认\s+([\w-]+)\s*$/i);if(match){scope.command=command;try{return {outputs:await this.confirmation(scope,match[1]),requestId:scope.requestId};}catch(error){this.record(scope,{status:'failed',error:this.redact(safeGameText(error.message))});throw error;}}return this.query(scope,command);}
  async privateAuth(scope,command){
    const match=command.match(/^ww\s*确认\s+([\w-]+)\s*$/i);if(!match)return false;
    const pending=this.pending.get(match[1]);if(pending&&pending.type!=='login')return false;
    const p=pending??this.bindings.get(String(scope.senderQQ));if(!p||p.senderQQ&&p.senderQQ!==String(scope.senderQQ))return false;
    if(!this.retainedCurrent(p))return true;
    let confirmed=false;const current=()=>(scope.gameOriginCurrent?.()??this.retainedCurrent(p))&&Boolean(pending||confirmed||this.bindings.get(String(scope.senderQQ))===p);
    try{const result=await this.confirmation(scope,match[1]);confirmed=true;if(current())await this.sendPrivate(String(scope.senderQQ),result.map(x=>x.text).join('\n'),current);}catch(error){if(current())await this.sendPrivate(String(scope.senderQQ),safeGameText(error.message),current);}return true;
  }
  async cancel(scope){
    if(scope?.key){this.sourceEpochs.set(scope.key,this.sourceEpoch(scope.key)+1);for(const [id,p]of this.pending)if(p.key===scope.key)this.pending.delete(id);for(const [qq,l]of this.bindings)if(l.key===scope.key)this.bindings.delete(qq);}
    for(const id of scope?.gameRequestIds??[])await this.client.cancel(id);
  }
  async tool(scope,args){
    if(!scope||!args||Object.keys(args).some(k=>!['command','sourceMessageId'].includes(k)))throw Error('鸣潮工具来源无效');
    const m=scope.batch.find(m=>String(m.messageId)===String(args.sourceMessageId));if(!m||!qqOK(m.senderQQ)||String(m.senderQQ)!==String(scope.senderQQ))throw Error('鸣潮调用只能引用本批真实发送者的消息');
    if(/^ww\s*确认/i.test(args.command))throw Error('确认操作必须由玩家在 QQ 直接发送，模型不能代替确认');
    scope.gameUsed=true;
    if(scope.record)scope.record.gameUsed=true;
    scope.gameAssets??=new Map();scope.gameRequestIds??=new Set();
    const request={...scope,key:scope.key,senderQQ:String(m.senderQQ),messageId:String(m.messageId),images:[...(m.images??[]),...(m.quotedImages??[])]};
    const result=await this.command(request,args.command);const content=[];
    for(const o of result.outputs){if(o.type==='text')content.push({type:'text',text:o.text});else{const asset=request.gameAssets.get(o.id),{bytes,mimeType}=loadWavesAsset(this.root,asset);content.push({type:'text',text:'游戏真实结果图片，发送可选 wavesResultIds='+o.id},{type:'image',data:bytes.toString('base64'),mimeType});}}
    return {content:content.length?content:[{type:'text',text:'鸣潮任务已完成，没有返回可展示内容。'}]};
  }
  toolDefinition(resolveScope){return {name:'waves_game',description:'调用当前 QQ 会话发送者自己的国服鸣潮功能。command 使用单条原版 ww 指令，优先使用 conversation_context.waves.commands 中已核验的用法；ww帮助 返回原版帮助图。sourceMessageId 必须是本批实际发言的消息 ID。只能读自己的绑定；登录、解绑、签到/自动签到/体力提醒更改必须由本人确认。图片结果使用 wavesResultIds 选择发送。不接受凭据、管理员身份、目标群或文件路径。',inputSchema:{type:'object',properties:{command:{type:'string',maxLength:500},sourceMessageId:{type:'string'}},required:['command','sourceMessageId'],additionalProperties:false},execute:async({threadId,requestId,arguments:args})=>{try{return await this.tool(resolveScope(threadId,requestId),args);}catch(error){return {isError:true,content:[{type:'text',text:this.redact(safeGameText(error.message))+'；未自动重试。'}]};}}};}
  async poll(){
    await this.syncPolicy();
    this.serviceStatus=await this.client.call('/v1/status');
    for(const [qq,l]of this.bindings){
      if(!this.retainedCurrent(l)){this.bindings.delete(qq);continue;}
      try{const r=await this.client.call('/v1/login/pending?senderQQ='+qq);
        const current=()=>this.bindings.get(qq)===l&&this.retainedCurrent(l);
        if(r.status==='awaiting_confirmation'&&r.requestId===l.requestId&&!l.notified&&current()){const a=r.account??{};l.notified=true;await this.sendPrivate(qq,'请核对鸣潮账号：'+safeGameText(a.nickname||'')+' / UID '+safeGameText(a.uid||'未知')+'\n如正确，请发送“ww确认 '+l.requestId+'”。',current);}
      }catch(error){this.operationalFailure('login-summary',error,l.key);}
    }
    const result=await this.client.call('/v1/notices');
    for(const n of Array.isArray(result.notices)?result.notices:[]){
      if(!n.id||!keyOK(n.key)||!qqOK(n.senderQQ))continue;
      let attempt=this.noticeAttempts.find(x=>x.id===n.id);
      if(!attempt){attempt={id:n.id,key:n.key,status:'attempted',at:new Date().toISOString()};this.noticeAttempts.push(attempt);this.noticeAttempts=this.noticeAttempts.slice(-1000);atomic(this.noticeFile,this.noticeAttempts);
        try{attempt.status=this.valid({key:n.key,senderQQ:n.senderQQ})&&await this.sendNotice(n.key,String(n.senderQQ),this.redact(safeGameText(n.text)))?'sent':'suppressed';}
        catch(error){attempt.status='failed';this.operationalFailure('notice-send',error,n.key);}
        atomic(this.noticeFile,this.noticeAttempts);
      }
      try{await this.client.call('/v1/notices/ack',{id:n.id,sent:attempt.status==='sent'});}catch(error){this.operationalFailure('notice-ack',error,n.key);}
    }
  }
}

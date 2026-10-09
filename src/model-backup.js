import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateWavesSettings} from './waves-client.js';
const sections=['settings','roles','conversations','memory','feedback','stickers','images','history','waves'];
const keyOK=k=>/^(group|private):[1-9]\d*$/.test(k);
const roleOK=s=>typeof s==='string'&&s.length>0&&s.length<=80&&!/[\\/:*?"<>|\x00-\x1f]/.test(s)&&!/[. ]$/.test(s)&&!s.startsWith('.')&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s);
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const string=(x,max=30000)=>{if(typeof x!=='string'||x.length>max)throw new Error('备份文本格式无效');return x;};
const compactLimit=x=>{if(x==null)return null;if(!Number.isSafeInteger(x)||x<8000||x>1000000)throw new Error('压缩阈值无效');return x;};
const bool=x=>{if(typeof x!=='boolean')throw new Error('备份开关无效');return x;};
const ids=x=>{if(!Array.isArray(x)||x.length>1000||!x.every(y=>/^[1-9]\d*$/.test(String(y))))throw new Error('QQ 白名单格式无效');return [...new Set(x.map(String))];};
const stickerIds=x=>{if(!Array.isArray(x)||x.length>500||!x.every(y=>typeof y==='string'&&/^[\w:.-]{1,160}$/.test(y)))throw new Error('表情 ID 无效');return [...new Set(x)];};
const voiceRecords=x=>{if(!Array.isArray(x)||x.length>10)throw new Error('语音转写备份无效');return x.map(v=>{if(!obj(v)||!['message','quote'].includes(v.source)||!['ok','empty','failed','timeout','limit'].includes(v.status)||!v.sourceMessageId||!v.outerMessageId||!/^-?[1-9]\d*$/.test(String(v.sourceMessageId))||!/^-?[1-9]\d*$/.test(String(v.outerMessageId)))throw new Error('语音转写来源无效');return {source:v.source,sourceMessageId:string(String(v.sourceMessageId),100),outerMessageId:string(String(v.outerMessageId),100),sender:string(v.sender??'',120),time:string(v.time??'',50),status:v.status,text:string(v.text??'',10000),...(v.note?{note:string(v.note,160)}:{}),...(v.cached?{cached:bool(v.cached)}:{}),...(v.truncated?{truncated:bool(v.truncated)}:{})};});};
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
const atomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',typeof value==='string'?value:JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);};

export class ModelBackup {
  constructor({root,chat,preferences,getConfig,getExpression,reload,getStickers,setStickers,wavesSettings=null,redact=s=>s}){Object.assign(this,{root,chat,preferences,getConfig,getExpression,reload,getStickers,setStickers,wavesSettings,redact});this.previews=new Map();}
  clean(value){
    if(typeof value==='string')return this.redact(value).replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[凭据已移除]').replace(/((?:api[_ -]?key|access[_ -]?token|authorization|password|密码|访问令牌)\s*[:=：]\s*)\S+/gi,'$1[已移除]').replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g,'$1');
    if(Array.isArray(value))return value.map(x=>this.clean(x));if(obj(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.clean(v)]));return value;
  }
  export(includeHistory=false){
    const cfg=this.getConfig(),p=this.preferences.read(),state=path.join(this.root,'state');
    const roles={};for(const f of fs.readdirSync(path.join(this.root,'roles'))){if(f.endsWith('.md')&&roleOK(f.slice(0,-3)))roles[f.slice(0,-3)]=fs.readFileSync(path.join(this.root,'roles',f),'utf8');}
    const conversations={},feedback={},memory={},images={},history={};
    const keys=new Set([...this.chat.entries.keys(),...Object.keys(p.conversations)]);
    for(const dir of fs.readdirSync(this.chat.memory.root))if(/^(group|private)-[1-9]\d+$/.test(dir))keys.add(dir.replace('-',':'));
    for(const key of keys){const c=this.preferences.conversation(key);const {feedback:fb,...override}=c;conversations[key]=override;feedback[key]=fb;const m=this.chat.memory.read(key);delete m.content;memory[key]=m;images[key]=(this.chat.entries.get(key)?.images??[]).map(({imageId,runId,mimeType,extension,bytes,createdAt,status,sentMessageId})=>({imageId,runId,mimeType,extension,bytes,createdAt,status,sentMessageId}));if(includeHistory)history[key]=(this.chat.entries.get(key)?.messages??[]).map(({id,kind,sender,text,time,messageId,stickerId,imageId,voice})=>({id,kind,sender,text,time,messageId,stickerId,imageId,...(voice?.length?{voice:voiceRecords(voice)}:{})}));}
    const pendingNotes=read(path.join(state,'restored-sticker-notes.json'),{});
    const combinedStickers=[...this.getStickers(),...Object.values(pendingNotes).filter(n=>!this.getStickers().some(e=>e.id===n.id))];
    const result={format:'qq-codex-backup',version:1,createdAt:new Date().toISOString(),sections:{
      settings:{ownerQQ:String(cfg.ownerQQ??''),allow:{groups:cfg.allow?.groups??[],private:cfg.allow?.private??[]},deny:{groups:cfg.deny?.groups??[],private:cfg.deny?.private??[]},model:{model:cfg.codex.model,reasoningEffort:cfg.codex.reasoningEffort,serviceTier:cfg.codex.serviceTier??null,autoCompactTokenLimit:cfg.codex.autoCompactTokenLimit??null},expression:this.getExpression(),role:read(path.join(state,'current-role.json'),{role:null}).role??null,paused:p.paused},
      roles,conversations,memory,feedback,images,stickers:{globalDisabled:p.globalDisabledStickers,items:combinedStickers.map(({id,localNote,noteSource,tags,usage})=>({id,localNote:localNote??'',noteSource:noteSource??'manual',tags:tags??[],usage:usage??''}))},...(this.wavesSettings?{waves:this.wavesSettings.export()}:{}),...(includeHistory?{history}:{})}};
    return this.clean(result);
  }
  validate(data,models){
    if(!obj(data)||data.format!=='qq-codex-backup'||data.version!==1||!obj(data.sections)||Object.keys(data.sections).some(k=>!sections.includes(k)))throw new Error('备份格式或版本不支持');
    const out={},s=data.sections;
    if(s.waves){if(!this.wavesSettings)throw Error('当前部署不支持鸣潮设置恢复');out.waves=validateWavesSettings(s.waves);}
    const model=m=>{if(!obj(m)||!models.some(x=>x.model===m.model&&x.efforts.includes(m.reasoningEffort)))throw new Error('备份含不可用的模型/推理强度');return {model:m.model,reasoningEffort:m.reasoningEffort};};
    const role=r=>{if(r!==null&&r!==false&&!roleOK(r))throw new Error('角色名无效');return r;};
    const byKey=(input,fn)=>{if(!obj(input)||Object.keys(input).length>1000)throw new Error('会话备份无效');return Object.fromEntries(Object.entries(input).map(([k,v])=>{if(!keyOK(k))throw new Error('会话 key 无效');return [k,fn(v,k)];}));};
    if(s.settings){const x=s.settings,e=x.expression;if(!obj(e))throw new Error('表达设置无效');out.settings={ownerQQ:ids([x.ownerQQ])[0],allow:{groups:ids(x.allow?.groups),private:ids(x.allow?.private)},deny:{groups:ids(x.deny?.groups),private:ids(x.deny?.private)},model:{...model(x.model),autoCompactTokenLimit:compactLimit(x.model.autoCompactTokenLimit),serviceTier:x.model.serviceTier==='priority'?'priority':x.model.serviceTier===null||x.model.serviceTier==='default'?null:(()=>{throw new Error('加速设置无效');})()},expression:{style:string(e.style,4000),voiceEnabled:e.voiceEnabled===undefined?false:bool(e.voiceEnabled),stickersEnabled:bool(e.stickersEnabled),autoLearnStickers:bool(e.autoLearnStickers),autoCollectStickers:bool(e.autoCollectStickers),imageMode:['off','requested','auto'].includes(e.imageMode)?e.imageMode:e.imageMode===undefined?'requested':(()=>{throw new Error('图片生成模式无效');})(),stickerStyle:['natural','lively'].includes(e.stickerStyle)?e.stickerStyle:e.stickerStyle===undefined?'natural':(()=>{throw new Error('表情倾向无效');})()},role:role(x.role),paused:bool(x.paused)};}
    if(s.roles){if(!obj(s.roles))throw new Error('人格备份无效');out.roles={};for(const [name,text] of Object.entries(s.roles)){if(!roleOK(name))throw new Error('角色路径无效');out.roles[name]=string(text,100000);}}
    if(s.conversations)out.conversations=byKey(s.conversations,c=>({role:role(c.role),style:c.style===null?null:string(c.style,4000),model:c.model===null?null:model(c.model),imageMode:c.imageMode==null?null:['off','requested','auto'].includes(c.imageMode)?c.imageMode:(()=>{throw new Error('会话图片模式无效');})(),stickerStyle:c.stickerStyle==null?null:['natural','lively'].includes(c.stickerStyle)?c.stickerStyle:(()=>{throw new Error('会话表情倾向无效');})(),voiceEnabled:c.voiceEnabled==null?null:bool(c.voiceEnabled),paused:bool(c.paused),disabledStickers:stickerIds(c.disabledStickers)}));
    if(s.memory)out.memory=byKey(s.memory,(m,key)=>this.chat.memory.validate(key,m));
    if(s.feedback)out.feedback=byKey(s.feedback,list=>{if(!Array.isArray(list)||list.length>10000)throw new Error('反馈备份无效');return list.map(f=>{if(!['redundant','long','good'].includes(f.rating))throw new Error('反馈类型无效');return {id:string(f.id,100),messageId:string(f.messageId,100),rating:f.rating,note:string(f.note,500),active:bool(f.active),at:string(f.at,50),...(f.undoneAt?{undoneAt:string(f.undoneAt,50)}:{})};});});
    if(s.stickers){if(!Array.isArray(s.stickers.items)||s.stickers.items.length>500)throw new Error('表情备注备份无效');out.stickers={globalDisabled:stickerIds(s.stickers.globalDisabled),items:s.stickers.items.map(e=>({id:stickerIds([e.id])[0],localNote:string(e.localNote,200),noteSource:['model','manual'].includes(e.noteSource)?e.noteSource:'manual',tags:Array.isArray(e.tags)?e.tags.map(x=>string(x,100)).slice(0,20):[],usage:string(e.usage,200)}))};}
    if(s.images)out.images=byKey(s.images,list=>{if(!Array.isArray(list)||list.length>10000)throw new Error('图片元数据备份无效');return list.map(m=>{if(!uuid(m.imageId)||!uuid(m.runId)||!['image/png','image/jpeg','image/webp'].includes(m.mimeType)||!['png','jpg','webp'].includes(m.extension)||!Number.isSafeInteger(m.bytes)||m.bytes<16||m.bytes>15_000_000||!['ready','sent','failed'].includes(m.status))throw new Error('图片元数据无效');return {imageId:m.imageId,runId:m.runId,mimeType:m.mimeType,extension:m.extension,bytes:m.bytes,createdAt:string(m.createdAt,50),status:m.status,sentMessageId:m.sentMessageId==null?null:string(String(m.sentMessageId),100)};});});
    if(s.history)out.history=byKey(s.history,list=>{if(!Array.isArray(list)||list.length>100000)throw new Error('聊天历史无效');return list.map(m=>{if(!['user','assistant','event','error'].includes(m.kind))throw new Error('历史消息类型无效');if(m.imageId!=null&&!uuid(m.imageId))throw new Error('历史图片编号无效');return {id:m.id?string(m.id,100):crypto.randomUUID(),kind:m.kind,sender:string(m.sender??'',200),text:string(m.text,100000),time:string(m.time,100),...(m.messageId?{messageId:string(String(m.messageId),100)}:{}),...(m.stickerId?{stickerId:stickerIds([m.stickerId])[0]}:{}),...(m.imageId?{imageId:m.imageId}:{}),...(m.voice?{voice:voiceRecords(m.voice)}:{})};});});
    return {format:data.format,version:1,createdAt:data.createdAt,sections:out};
  }
  preview(data,models){
    if(this.chat.restoring)throw Object.assign(new Error('正在恢复备份，请稍候'),{statusCode:409});
    const normalized=this.validate(data,models),current=this.export(Boolean(normalized.sections.history)),comparable=this.validate(current,models);
    const diff=Object.entries(normalized.sections).map(([section,value])=>{const before=comparable.sections[section];let after=value;
      if(['roles','conversations','memory','feedback','images','history'].includes(section))after={...before,...value};
      if(section==='stickers'){const notes=new Map([...before.items,...value.items].map(x=>[x.id,x]));after={globalDisabled:value.globalDisabled,items:[...notes.values()]};}
      return {section,changed:JSON.stringify(before)!==JSON.stringify(after),before,after};});
    const id=crypto.randomUUID();for(const [k,v] of this.previews)if(Date.now()-v.at>600000)this.previews.delete(k);
    if(this.previews.size>=10)this.previews.delete(this.previews.keys().next().value);
    this.previews.set(id,{data:normalized,at:Date.now(),baseline:JSON.stringify(current.sections),includeHistory:Boolean(normalized.sections.history)});return {id,diff,expiresInSeconds:600};
  }
  async restore(id,selected){
    if(this.chat.restoring)throw Object.assign(new Error('正在恢复备份，请稍候'),{statusCode:409});
    const p=this.previews.get(id);if(!p||Date.now()-p.at>600000)throw new Error('恢复预览已过期');
    if(!Array.isArray(selected)||!selected.length||selected.some(k=>!Object.hasOwn(p.data.sections,k)))throw new Error('请选择备份内的项目');
    if(JSON.stringify(this.export(p.includeHistory).sections)!==p.baseline)throw Object.assign(new Error('数据在预览后已变化，请重新预览'),{statusCode:409});
    const roleNames=new Set(fs.readdirSync(path.join(this.root,'roles')).filter(f=>f.endsWith('.md')).map(f=>f.slice(0,-3)));
    if(selected.includes('roles'))for(const name of Object.keys(p.data.sections.roles))roleNames.add(name);
    for(const role of [...(selected.includes('settings')?[p.data.sections.settings.role]:[]),...(selected.includes('conversations')?Object.values(p.data.sections.conversations).map(c=>c.role):[])])if(role&&!roleNames.has(role))throw new Error('恢复引用了不存在的人格，请同时选择对应人格');
    this.chat.restoring=true;let originalEntries=structuredClone([...this.chat.entries]);const originalPrefs=this.preferences.read(),originalStickers=structuredClone(this.getStickers()),originalWaves=this.wavesSettings?.read();
    const files=new Map(),remember=file=>{if(!files.has(file))files.set(file,fs.existsSync(file)?fs.readFileSync(file):null);};
    const write=(file,value)=>{remember(file);atomic(file,value);};
    let snapshot;
    try{
      for(const key of [...this.chat.running.keys()])await this.chat.reset(key);
      this.chat.pending.clear();
      originalEntries=structuredClone([...this.chat.entries]);
      snapshot=path.join(this.root,'state','restore-snapshots',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+'.json');
      const before=this.export(true);atomic(snapshot,before);
      const s=p.data.sections,state=path.join(this.root,'state'),next=this.preferences.read();
      const affected=new Set();
      if(selected.includes('settings')&&!isDeepStrictEqual(s.settings,before.sections.settings))for(const key of this.chat.entries.keys())affected.add(key);
      if(selected.includes('roles')){
        const changedRoles=new Set(Object.entries(s.roles).filter(([name,text])=>before.sections.roles[name]!==text).map(([name])=>name));
        const globalRole=read(path.join(state,'current-role.json'),{}).role??null;
        for(const key of this.chat.entries.keys()){
          const scopedRole=this.preferences.conversation(key).role;
          if(changedRoles.has(scopedRole===null?globalRole:scopedRole))affected.add(key);
        }
      }
      if(selected.includes('conversations'))for(const [key,c] of Object.entries(s.conversations)){
        const current=this.preferences.conversation(key);
        if(!isDeepStrictEqual([current.role,current.style,current.model,current.imageMode,current.stickerStyle,current.voiceEnabled,current.paused,current.disabledStickers],[c.role,c.style,c.model,c.imageMode,c.stickerStyle,c.voiceEnabled,c.paused,c.disabledStickers]))affected.add(key);
      }
      if(selected.includes('memory'))for(const [key,m] of Object.entries(s.memory)){
        const current=this.chat.memory.read(key);
        if(!isDeepStrictEqual([current.enabled,current.entries],[m.enabled,m.entries]))affected.add(key);
      }
      if(selected.includes('history'))for(const [key,messages] of Object.entries(s.history)){
        if(!this.chat.entries.has(key)||!isDeepStrictEqual(this.chat.entries.get(key).messages,messages))affected.add(key);
      }
      if(selected.includes('settings')){const x=s.settings,cfg=read(path.join(this.root,'config.json'),{});cfg.ownerQQ=x.ownerQQ;cfg.allow={...cfg.allow,...x.allow};cfg.allowAllWhenEmpty=false;cfg.deny={...cfg.deny,...x.deny};cfg.codex={...cfg.codex,...x.model};write(path.join(this.root,'config.json'),cfg);write(path.join(state,'chat-expression.json'),x.expression);write(path.join(state,'current-role.json'),{...read(path.join(state,'current-role.json'),{}),role:x.role||null});next.paused=x.paused;}
      if(selected.includes('roles'))for(const [name,text] of Object.entries(s.roles))write(path.join(this.root,'roles',name+'.md'),text);
      if(selected.includes('conversations'))for(const [key,c] of Object.entries(s.conversations))next.conversations[key]={...this.preferences.conversation(key),...c};
      if(selected.includes('feedback'))for(const [key,feedback] of Object.entries(s.feedback))next.conversations[key]={...this.preferences.conversation(key),...next.conversations[key],feedback};
      if(selected.includes('stickers')){next.globalDisabledStickers=s.stickers.globalDisabled;const notes=new Map(s.stickers.items.map(x=>[x.id,x]));const entries=this.getStickers().map(e=>({...e,...notes.get(e.id)}));remember(path.join(state,'stickers.json'));this.setStickers(entries);const pending=read(path.join(state,'restored-sticker-notes.json'),{});for(const note of s.stickers.items){if(entries.some(e=>e.id===note.id))delete pending[note.id];else Object.defineProperty(pending,note.id,{value:note,writable:true,enumerable:true,configurable:true});}write(path.join(state,'restored-sticker-notes.json'),pending);}
      if(selected.includes('waves')){remember(this.wavesSettings.file);this.wavesSettings.restore(s.waves);}
      remember(this.preferences.file);this.preferences.write(next,this.preferences.data.revision);
      if(selected.includes('memory'))for(const [key,m] of Object.entries(s.memory))if(affected.has(key)){remember(this.chat.memory.file(key));this.chat.memory.replace(key,m);}
      if(selected.includes('images'))for(const [key,items] of Object.entries(s.images)){const e=this.chat.entry(key);remember(path.join(this.chat.dir,e.key.replace(':','-')+'.json'));e.images=items;this.chat.save(e);}
      if(selected.includes('history'))for(const [key,messages] of Object.entries(s.history))if(affected.has(key)){const e=this.chat.entry(key);e.messages=messages;e.runs=[];}
      for(const key of affected){
        if(!this.chat.entries.has(key))continue;
        const e=this.chat.entry(key);remember(path.join(this.chat.dir,e.key.replace(':','-')+'.json'));
        e.sessionId=null;delete e.modelSignature;e.contextStart=e.messages.length;this.chat.save(e);
      }
      this.reload();this.chat.paused=this.preferences.data.paused;this.previews.delete(id);return {ok:true,snapshot:path.basename(snapshot),restored:selected};
    }catch(error){
      for(const [file,bytes] of [...files].reverse()){if(bytes===null){if(fs.existsSync(file))fs.unlinkSync(file);}else{fs.writeFileSync(file+'.rollback',bytes);fs.renameSync(file+'.rollback',file);}}
      if(originalWaves)this.wavesSettings.data=originalWaves;
      this.preferences.data=originalPrefs;this.setStickers(originalStickers,false);this.chat.entries=new Map(originalEntries);for(const e of this.chat.entries.values())this.chat.save(e);this.reload();this.chat.paused=originalPrefs.paused;
      throw new Error('恢复失败，已回滚：'+this.redact(String(error.message)).slice(0,200));
    }finally{this.chat.restoring=false;}
  }
}

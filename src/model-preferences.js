import fs from 'node:fs';
import path from 'node:path';

const validKey=key=>/^(group|private):[1-9]\d*$/.test(key);
const validSticker=id=>typeof id==='string'&&/^[\w:.-]{1,160}$/.test(id);
const clone=value=>structuredClone(value);
const empty=()=>({schemaVersion:1,revision:0,paused:false,globalDisabledStickers:[],conversations:{}});
const blank=()=>({role:null,style:null,model:null,paused:false,disabledStickers:[],feedback:[]});
const conflict=()=>Object.assign(new Error('设置已被其他操作更新，请刷新后重试'),{statusCode:409});

export class ModelPreferences {
  constructor(file){this.file=path.resolve(file);fs.mkdirSync(path.dirname(this.file),{recursive:true});this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):empty();}
  read(){return clone(this.data);}
  conversation(key){if(!validKey(key))throw new Error('无效会话');return clone({...blank(),...this.data.conversations[key]});}
  write(next,revision){
    if(revision!==this.data.revision)throw conflict();
    next.schemaVersion=1;next.revision=revision+1;
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(next,null,2));fs.renameSync(this.file+'.tmp',this.file);this.data=next;return this.read();
  }
  updateConversation(key,patch,revision,{roles,models}={}){
    if(!validKey(key)||!patch||typeof patch!=='object')throw new Error('无效会话或设置');
    const next=this.read(),current={...blank(),...next.conversations[key]};
    if(Object.hasOwn(patch,'role')){
      if(patch.role!==null&&patch.role!==false&&!(typeof patch.role==='string'&&roles?.includes(patch.role)))throw new Error('角色不存在');
      current.role=patch.role;
    }
    if(Object.hasOwn(patch,'style')){
      if(patch.style!==null&&!(typeof patch.style==='string'&&patch.style.length<=4000))throw new Error('口吻最多 4000 字符');
      current.style=patch.style;
    }
    if(Object.hasOwn(patch,'model')){
      const m=patch.model;
      if(m!==null&&!(m&&typeof m==='object'&&models?.some(x=>x.model===m.model&&x.efforts.includes(m.reasoningEffort))))throw new Error('请选择账户可用的模型及推理强度');
      current.model=m===null?null:{model:m.model,reasoningEffort:m.reasoningEffort};
    }
    if(Object.hasOwn(patch,'paused')){
      if(typeof patch.paused!=='boolean')throw new Error('暂停状态无效');current.paused=patch.paused;
    }
    if(Object.hasOwn(patch,'disabledStickers')){
      if(!Array.isArray(patch.disabledStickers)||patch.disabledStickers.length>500||!patch.disabledStickers.every(validSticker))throw new Error('表情禁用列表无效');
      current.disabledStickers=[...new Set(patch.disabledStickers)];
    }
    next.conversations[key]=current;return this.write(next,revision);
  }
  setGlobalPaused(paused,revision){if(typeof paused!=='boolean')throw new Error('暂停状态无效');const next=this.read();next.paused=paused;return this.write(next,revision);}
  setStickerDisabled(id,disabled,key,revision){
    if(!validSticker(id)||typeof disabled!=='boolean')throw new Error('表情设置无效');
    const next=this.read();const list=key?(next.conversations[key]={...blank(),...next.conversations[key]}).disabledStickers:next.globalDisabledStickers;
    if(key&&!validKey(key))throw new Error('无效会话');
    const updated=disabled?[...new Set([...list,id])]:list.filter(x=>x!==id);
    if(key)next.conversations[key].disabledStickers=updated;else next.globalDisabledStickers=updated;
    return this.write(next,revision);
  }
  stickerAllowed(key,id){return !this.data.globalDisabledStickers.includes(id)&&!this.conversation(key).disabledStickers.includes(id);}
  isPaused(key){return this.data.paused||this.conversation(key).paused;}
  effective(key,{model,reasoningEffort,role,style,serviceTier=null,autoCompactTokenLimit=null}){
    const c=this.conversation(key);
    return {model:c.model?.model??model,reasoningEffort:c.model?.reasoningEffort??reasoningEffort,role:c.role===null?role:c.role,style:c.style??style,serviceTier,autoCompactTokenLimit,paused:this.isPaused(key),feedback:this.feedbackHint(key)};
  }
  feedbackHint(key){
    const items=this.conversation(key).feedback.filter(x=>x.active);
    if(!items.length)return '';
    const counts={redundant:0,long:0,good:0};for(const item of items)counts[item.rating]++;
    const notes=items.filter(x=>x.note).slice(-6).map(x=>x.note);
    return `本会话收到的表达反馈：多余 ${counts.redundant} 次、太长 ${counts.long} 次、合适 ${counts.good} 次。把反馈作为柔性的表达参考，仍由你判断是否接话与回答所需长度。${notes.length?'具体说明：'+notes.join('；'):''}`;
  }
  addFeedback(key,{messageId,rating,note='',revision}){
    if(!validKey(key)||typeof messageId!=='string'||!['redundant','long','good'].includes(rating)||typeof note!=='string'||note.length>500)throw new Error('反馈内容无效');
    const next=this.read(),c={...blank(),...next.conversations[key]};
    c.feedback.push({id:`fb-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,messageId,rating,note,active:true,at:new Date().toISOString()});
    next.conversations[key]=c;this.write(next,revision);return this.conversation(key).feedback.at(-1);
  }
  undoFeedback(key,id,revision){
    if(!validKey(key))throw new Error('无效会话');const next=this.read(),c={...blank(),...next.conversations[key]};const item=c.feedback.find(x=>x.id===id);
    if(!item||!item.active)throw new Error('反馈不存在或已撤销');item.active=false;item.undoneAt=new Date().toISOString();next.conversations[key]=c;this.write(next,revision);return item;
  }
}

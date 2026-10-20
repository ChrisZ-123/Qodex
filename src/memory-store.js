import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const stamp=()=>new Date().toISOString();
const conflict=()=>Object.assign(new Error('记忆已被更新，请重新加载后再保存'),{statusCode:409});
const checkText=text=>{if(typeof text!=='string'||!text.trim()||text.length>30000)throw new Error('记忆文本须为 1–30000 字符');if(/\bsk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|access[_ -]?token|authorization|password|密码|访问令牌)\s*[:=：]\s*\S{6,}/i.test(text))throw new Error('记忆中疑似含有凭据');};
const total=entries=>content(entries).length;
const content=entries=>entries.filter(e=>e.enabled).map(e=>e.text).join('\n\n');
const qq=value=>typeof value==='string'&&/^[1-9]\d*$/.test(value);
const metadata=value=>({kind:value.kind??'fact',participantQQs:value.participantQQs??[],topicState:value.topicState??null,evidence:value.evidence??[]});
const checkMetadata=value=>{
  const m=metadata(value);
  if(!['fact','person','episode','topic'].includes(m.kind)||!Array.isArray(m.participantQQs)||m.participantQQs.some(id=>!qq(id))||new Set(m.participantQQs).size!==m.participantQQs.length||!['open','closed',null].includes(m.topicState)||(m.kind!=='topic'&&m.topicState!==null)||!Array.isArray(m.evidence)||m.evidence.length>4)throw new Error('记忆分类或参与者无效');
  return structuredClone(m);
};
const version=e=>({version:e.version,text:e.text,pinned:e.pinned,enabled:e.enabled,source:e.source,...metadata(e),editor:e.updatedBy,at:e.updatedAt});
const create=(text,source,editor,meta={})=>{const e={id:crypto.randomUUID(),text,pinned:false,enabled:true,version:1,source,...checkMetadata(meta),updatedBy:editor,updatedAt:stamp(),versions:[]};e.versions.push(version(e));return e;};
const split=text=>text.split(/\r?\n\s*\r?\n|\r?\n(?=\s*(?:[-*+]\s|\d+[.)]\s))/).map(x=>x.trim()).filter(Boolean);
const tokens=text=>[...new Intl.Segmenter('zh',{granularity:'word'}).segment(String(text).toLowerCase())].filter(x=>x.isWordLike).map(x=>x.segment);
const normalized=e=>({...e,...metadata(e),versions:e.versions.map(v=>({...v,...metadata(v)}))});
const sourceMetadata=(id,msg)=>({type:'message',messageId:id,sender:msg.sender??'',...(qq(msg.senderQQ)?{senderQQ:msg.senderQQ}:{}),time:msg.time??null,kind:msg.kind??'user',...(msg.kind==='assistant'?{confirmed:true}:{})});
const editMetadata=(e,op)=>checkMetadata({...metadata(e),...Object.fromEntries(['kind','participantQQs','topicState'].filter(k=>Object.hasOwn(op,k)).map(k=>[k,op[k]]))});

export class ItemMemory {
  constructor(root){this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true});}
  file(key){if(!/^(group|private):[1-9]\d*$/.test(key))throw new Error('无效会话');return path.join(this.root,key.replace(':','-'),'memory.json');}
  read(key){
    const file=this.file(key);if(!fs.existsSync(file))return {schemaVersion:2,key,enabled:true,revision:0,entries:[],content:'',updatedAt:null,source:null};
    let r=JSON.parse(fs.readFileSync(file,'utf8'));
    if(r.schemaVersion!==2){
      if(r.key!==key||typeof r.content!=='string'||typeof r.enabled!=='boolean')throw new Error('旧记忆格式无效');
      const backup=file+'.legacy-v1.json';if(!fs.existsSync(backup))fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
      r={schemaVersion:2,key,enabled:r.enabled,revision:r.revision??0,updatedAt:r.updatedAt,source:'migration',entries:split(r.content).map(text=>create(text,{type:'migration',label:'迁移来源，原消息未知',messageId:null,time:r.updatedAt},'migration'))};this.write(r);
    }
    const entries=r.entries.map(normalized);return {...r,entries,content:content(entries)};
  }
  ensure(key){const r=this.read(key);if(!fs.existsSync(this.file(key)))this.write(r);return r;}
  write(record){const file=this.file(record.key),r={...record};delete r.content;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(r,null,2));fs.renameSync(file+'.tmp',file);}
  commit(old,entries,source='admin',enabled=old.enabled){if(total(entries)>30000)throw new Error('有效记忆最多 30000 字符');const next={...old,entries,enabled,revision:old.revision+1,updatedAt:stamp(),source};this.write(next);return this.read(old.key);}
  update(key,{content:text,enabled,revision},source='admin'){
    const old=this.ensure(key);if(old.revision!==revision)throw conflict();if(typeof enabled!=='boolean'||typeof text!=='string'||text.length>30000)throw new Error('记忆格式无效');if(text)checkText(text);
    if(source==='model')throw new Error('模型须使用逐条记忆操作');
    if(text===old.content)return enabled===old.enabled?old:this.commit(old,old.entries,source,enabled);
    const entries=structuredClone(old.entries);for(const e of entries)if(e.enabled){e.enabled=false;e.version++;e.updatedBy='admin';e.updatedAt=stamp();e.versions.push(version(e));}
    entries.push(...split(text).map(t=>create(t,{type:'admin',label:'管理员全文编辑',time:stamp()},'admin')));return this.commit(old,entries,source,enabled);
  }
  mutate(key,op){
    const old=this.ensure(key);if(old.revision!==op.revision)throw conflict();
    if(op.action==='toggle'){if(typeof op.enabled!=='boolean')throw new Error('开关无效');return this.commit(old,old.entries,'admin',op.enabled);}
    const entries=structuredClone(old.entries);
    if(op.action==='add'){checkText(op.text);const e=create(op.text,{type:'admin',label:'管理员手动添加',time:stamp()},'admin',editMetadata({},op));e.pinned=op.pinned===true;e.enabled=op.enabled!==false;e.versions[0]=version(e);entries.push(e);}
    else{
      const e=entries.find(x=>x.id===op.id);if(!e)throw new Error('条目不存在');if(e.version!==op.version)throw conflict();
      if(op.action==='restore'){const v=e.versions.find(x=>x.version===op.restoreVersion);if(!v)throw new Error('历史版本不存在');Object.assign(e,{text:v.text,pinned:v.pinned,enabled:v.enabled,source:v.source,...metadata(v)});}
      else if(op.action==='edit'){checkText(op.text);e.text=op.text;Object.assign(e,editMetadata(e,op));if(typeof op.pinned==='boolean')e.pinned=op.pinned;if(typeof op.enabled==='boolean')e.enabled=op.enabled;}
      else throw new Error('操作无效');
      e.version++;e.updatedBy='admin';e.updatedAt=stamp();e.versions.push(version(e));
    }
    return this.commit(old,entries);
  }
  retrieve(key,query,{budget=6000,limit=12,participantQQs=[]}={}){
    const r=this.ensure(key);if(!r.enabled)return {enabled:false,entries:[],content:'',revision:r.revision};
    const participants=new Set(participantQQs),pinned=r.entries.filter(e=>e.enabled&&e.pinned),docs=r.entries.filter(e=>e.enabled&&!e.pinned&&!(e.kind==='topic'&&e.topicState==='closed')).map(e=>({e,words:tokens(e.text)}));
    const selected=[...pinned];let used=total(pinned);const warning=used>budget?'置顶内容超过 6000 字符，本轮完整携带置顶，未追加普通记忆':'';
    if(!warning&&docs.length){
      const q=new Set(tokens(query)),df=new Map(),avg=docs.reduce((s,d)=>s+d.words.length,0)/docs.length;
      for(const d of docs)for(const w of new Set(d.words))df.set(w,(df.get(w)??0)+1);
      const ranked=docs.map(d=>{const tf=new Map();for(const w of d.words)tf.set(w,(tf.get(w)??0)+1);let score=0;for(const w of q){const f=tf.get(w)??0;if(f)score+=Math.log(1+(docs.length-df.get(w)+.5)/(df.get(w)+.5))*f*2.2/(f+1.2*(.25+.75*d.words.length/(avg||1)));}return {e:d.e,score,person:d.e.kind==='person'&&d.e.participantQQs.some(id=>participants.has(id))};}).filter(x=>x.person||x.score>0).sort((a,b)=>Number(b.person)-Number(a.person)||b.score-a.score);
      for(const {e} of ranked){if(selected.length-pinned.length>=limit)break;const cost=e.text.length+(selected.length?2:0);if(used+cost>budget)continue;used+=cost;selected.push(e);}
    }
    return {enabled:true,revision:r.revision,warning,entries:selected.map(({id,text,version,pinned,source,kind,participantQQs,topicState,evidence})=>({id,text,version,pinned,source,kind,participantQQs,topicState,evidence})),content:content(selected)};
  }
  applyModelOps(key,ops,{visibleIds,sourceMessages}){
    if(!Array.isArray(ops)||ops.length>8)throw new Error('增量记忆格式无效');const old=this.ensure(key);if(!old.enabled)return {applied:0,rejected:[]};
    let entries=structuredClone(old.entries),applied=0;const rejected=[],visible=new Set(visibleIds),sources=new Map(),ambiguous=new Set();
    const inScope=m=>(m.key===undefined||m.key===key)&&(m.scopeKey===undefined||m.scopeKey===key);
    for(const m of sourceMessages){if(!m.messageId)continue;const id=String(m.messageId);if(sources.has(id))ambiguous.add(id);sources.set(id,m);}
    const participants=new Set(sourceMessages.filter(m=>inScope(m)&&(m.kind??'user')==='user'&&qq(m.senderQQ)).map(m=>m.senderQQ));
    const resolve=(id,primary=false)=>{const m=typeof id==='string'&&!ambiguous.has(id)?sources.get(id):null;if(!m||!inScope(m))throw new Error('来源消息未在本轮提供或不属于本会话');const kind=m.kind??'user';if(primary&&kind!=='user')throw new Error('主来源必须是群友实际发言');if(!['user','assistant'].includes(kind)||(kind==='assistant'&&m.confirmed!==true))throw new Error('机器人证据须为已确认送达的历史消息');return sourceMetadata(id,m);};
    for(const op of ops){try{
      const candidate=structuredClone(entries),source=resolve(op.sourceMessageId,true);
      const ids=op.evidenceMessageIds??[];if(!Array.isArray(ids)||ids.length>4||new Set(ids).size!==ids.length||ids.includes(op.sourceMessageId))throw new Error('补充证据最多四条且不得重复');
      const evidence=ids.map(id=>resolve(id));
      const applyMetadata=e=>{const m=editMetadata(e,op);if(m.participantQQs.some(id=>!participants.has(id)))throw new Error('参与者必须来自本轮实际群友 QQ');if(m.kind==='person'&&(!qq(source.senderQQ)||m.participantQQs.length!==1||m.participantQQs[0]!==source.senderQQ))throw new Error('人物笔记只能记录主来源发言人的 QQ');if(Object.hasOwn(op,'evidenceMessageIds')||op.action==='add')m.evidence=evidence;return m;};
      if(op.action==='add'){checkText(op.text);candidate.push(create(op.text,source,'model',applyMetadata({})));}
      else if(['revise','disable'].includes(op.action)){
        const e=candidate.find(x=>x.id===op.id);if(!e||!visible.has(e.id))throw new Error('条目未在本轮检索中');if(e.pinned)throw new Error('置顶记忆受保护');if(e.version!==op.version)throw new Error('版本冲突，保留管理员修改');
        const meta=applyMetadata(e);if(e.kind==='person'&&e.participantQQs.length&&(!e.participantQQs.includes(source.senderQQ)||meta.kind==='person'&&meta.participantQQs.some(id=>!e.participantQQs.includes(id))))throw new Error('人物笔记不能改归其他 QQ');if(op.action==='revise'){checkText(op.text);e.text=op.text;}else e.enabled=false;
        Object.assign(e,meta);e.version++;e.source=source;e.updatedBy='model';e.updatedAt=stamp();e.versions.push(version(e));
      }else throw new Error('记忆动作无效');
      if(total(candidate)>30000)throw new Error('有效记忆超过 30000 字符');entries=candidate;applied++;
    }catch(error){rejected.push(error.message);}}
    if(applied)this.commit(old,entries,'model');return {applied,rejected};
  }
  validate(key,data){
    this.file(key);if(!data||data.schemaVersion!==2||data.key!==key||typeof data.enabled!=='boolean'||!Array.isArray(data.entries)||data.entries.length>5000)throw new Error('记忆备份无效');
    const source=(s,evidence=false)=>{if(!s||!['admin','migration','message'].includes(s.type))throw new Error('记忆来源无效');const result={type:s.type,label:String(s.label??''),messageId:s.messageId??null,sender:String(s.sender??''),time:s.time??null};if(s.senderQQ!==undefined){if(!qq(s.senderQQ))throw new Error('来源 QQ 无效');result.senderQQ=s.senderQQ;}if(s.kind!==undefined){if(!['user','assistant'].includes(s.kind)||s.type!=='message'||(!evidence&&s.kind==='assistant')||(s.kind==='assistant'&&(s.confirmed!==true||typeof s.messageId!=='string'||!s.messageId)))throw new Error('来源身份或送达记录无效');result.kind=s.kind;if(s.kind==='assistant')result.confirmed=true;}if(evidence&&(s.type!=='message'||typeof s.messageId!=='string'||!s.messageId))throw new Error('补充证据来源无效');return result;};
    const meta=value=>{const m=checkMetadata(value);m.evidence=m.evidence.map(s=>source(s,true));return m;};
    const ids=new Set();const entries=data.entries.map(e=>{
      checkText(e.text);if(typeof e.id!=='string'||ids.has(e.id)||typeof e.pinned!=='boolean'||typeof e.enabled!=='boolean'||!Number.isSafeInteger(e.version)||e.version<1||!Array.isArray(e.versions)||!e.versions.length)throw new Error('记忆条目版本无效');ids.add(e.id);
      const versions=e.versions.map(v=>{checkText(v.text);if(!Number.isSafeInteger(v.version)||typeof v.pinned!=='boolean'||typeof v.enabled!=='boolean')throw new Error('记忆修订无效');return {version:v.version,text:v.text,pinned:v.pinned,enabled:v.enabled,source:source(v.source),...meta(v),editor:String(v.editor??''),at:String(v.at??'')};});
      return {id:e.id,text:e.text,pinned:e.pinned,enabled:e.enabled,version:e.version,source:source(e.source),...meta(e),updatedBy:String(e.updatedBy??''),updatedAt:String(e.updatedAt??''),versions};
    });if(total(entries)>30000)throw new Error('有效记忆超过 30000 字符');return {schemaVersion:2,key,enabled:data.enabled,revision:data.revision??0,entries,source:String(data.source??''),updatedAt:data.updatedAt??null};
  }
  replace(key,data){const next=this.validate(key,data);next.revision=this.ensure(key).revision+1;next.updatedAt=stamp();next.source='restore';this.write(next);return this.read(key);}
}

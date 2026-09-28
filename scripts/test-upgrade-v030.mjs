import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatMemory} from '../src/chat-memory.js';
import {ModelChat} from '../src/model-chat.js';
import {ModelPreferences} from '../src/model-preferences.js';

// Frozen constructor/file/read contract from qodex-v0.2.0:src/chat-memory.js.
// This stays in the test so a clean CI checkout does not need Git tags.
class ChatMemoryV020 {
  constructor(root){this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true});}
  file(key){if(!/^(group|private):[1-9]\d*$/.test(key))throw new Error('无效会话');return path.join(this.root,key.replace(':','-'),'memory.json');}
  read(key){const file=this.file(key);if(!fs.existsSync(file))return{key,content:'',enabled:true,revision:0,updatedAt:null,source:null};return JSON.parse(fs.readFileSync(file,'utf8'));}
}

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'Qodex 升级 回退 '));
const original=path.join(temp,'v0.2.0 原始部署');
const snapshot=path.join(temp,'升级前完整备份');
const restored=path.join(temp,'回退后的部署');
const separate=path.join(temp,'另一实例');
const customDirectory=path.join('state','自定义 记忆');
const group='group:10001',privateChat='private:90001';
const raw=(file)=>fs.readFileSync(file);
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2),'utf8');};
const files=(root,part='')=>fs.readdirSync(path.join(root,part),{withFileTypes:true}).flatMap(entry=>{
  const name=path.join(part,entry.name);
  return entry.isDirectory()?files(root,name):[name];
}).sort();

try{
  fs.mkdirSync(original,{recursive:true});
  const config={backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'default'},chatMemory:{directory:customDirectory},allow:{groups:['10001'],private:['90001']}};
  write(path.join(original,'config.json'),config);
  const oldMemory=new ChatMemoryV020(path.resolve(original,customDirectory));
  const oldGroup={key:group,content:'- 小林喜欢咖啡\n\n- 群约定：周日讨论电影',enabled:true,revision:4,updatedAt:'2026-09-20T10:00:00.000Z',source:'admin'};
  const oldPrivate={key:privateChat,content:'只在私聊中使用的笔记',enabled:false,revision:2,updatedAt:'2026-09-21T10:00:00.000Z',source:'admin'};
  write(oldMemory.file(group),oldGroup);
  write(oldMemory.file(privateChat),oldPrivate);
  const oldHistory={key:group,sessionId:null,contextStart:0,messages:[{kind:'user',sender:'小林',text:'早上好',time:'2026-09-20T10:00:00.000Z'},{kind:'assistant',sender:'Qodex',text:'早上好！',time:'2026-09-20T10:00:01.000Z'}]};
  write(path.join(original,'state','model-chat','group-10001.json'),oldHistory);
  write(path.join(original,'state','sessions.json'),{sessions:{[group]:'legacy-session'}});
  fs.cpSync(original,snapshot,{recursive:true});
  const originalFiles=files(snapshot);
  assert.deepEqual(oldMemory.read(group),oldGroup);

  const installedConfig=JSON.parse(raw(path.join(original,'config.json')));
  const memory=new ChatMemory(path.resolve(original,installedConfig.chatMemory.directory));
  const preferences=new ModelPreferences(path.join(original,'state','model-preferences.json'));
  const createChat=()=>new ModelChat({dir:path.join(original,'state','model-chat'),api:{},allowed:()=>true,send:async()=>{},persona:()=>({}),preferences,
    settings:key=>preferences.effective(key,{...installedConfig.codex,role:false,style:'自然'}),memory});
  const chat=createChat();
  const migratedGroup=memory.read(group),migratedPrivate=memory.read(privateChat);
  assert.equal(memory.root,path.resolve(original,customDirectory));
  assert.equal(fs.existsSync(path.join(original,'state','chat-memory')),false);
  assert.equal(migratedGroup.schemaVersion,2);
  assert.equal(migratedGroup.revision,oldGroup.revision);
  assert.equal(migratedGroup.enabled,oldGroup.enabled);
  assert.equal(migratedGroup.content,oldGroup.content);
  assert.equal(migratedGroup.entries.length,2);
  assert(migratedGroup.entries.every(item=>item.source.type==='migration'));
  assert.equal(migratedPrivate.schemaVersion,2);
  assert.equal(migratedPrivate.revision,oldPrivate.revision);
  assert.equal(migratedPrivate.enabled,false);
  assert.equal(migratedPrivate.content,oldPrivate.content);
  assert.equal(memory.retrieve(privateChat,'笔记').content,'');
  for(const key of [group,privateChat]){
    const relative=path.relative(original,memory.file(key));
    assert.deepEqual(raw(memory.file(key)+'.legacy-v1.json'),raw(path.join(snapshot,relative)));
  }
  assert.deepEqual(raw(path.join(original,'config.json')),raw(path.join(snapshot,'config.json')));
  assert.deepEqual(chat.history(group).messages.map(message=>message.text),oldHistory.messages.map(message=>message.text));
  assert(chat.history(group).messages.every(message=>message.id));
  assert.equal(chat.effective(group).model,'gpt-6-luna');
  assert.equal(chat.effective(group).reasoningEffort,'max');

  const migratedBytes=raw(memory.file(group));
  const legacyBytes=raw(memory.file(group)+'.legacy-v1.json');
  const stableTime=new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(memory.file(group),stableTime,stableTime);
  createChat();
  assert.deepEqual(raw(memory.file(group)),migratedBytes);
  assert.deepEqual(raw(memory.file(group)+'.legacy-v1.json'),legacyBytes);
  assert.equal(fs.statSync(memory.file(group)).mtimeMs,stableTime.getTime());

  const other=new ChatMemory(path.join(separate,'state','chat-memory'));
  assert.equal(other.read(group).content,'');
  assert.equal(other.read(privateChat).content,'');
  assert.equal(fs.existsSync(path.join(separate,'state','自定义 记忆')),false);

  // Restore the full pre-upgrade snapshot into a new installation directory.
  // The old reader must see exactly the original v0.2.0 records again.
  fs.cpSync(snapshot,restored,{recursive:true});
  assert.deepEqual(files(restored),originalFiles);
  for(const relative of originalFiles)assert.deepEqual(raw(path.join(restored,relative)),raw(path.join(snapshot,relative)));
  const rolledBack=new ChatMemoryV020(path.resolve(restored,customDirectory));
  assert.deepEqual(rolledBack.read(group),oldGroup);
  assert.deepEqual(rolledBack.read(privateChat),oldPrivate);
  assert.deepEqual(JSON.parse(raw(path.join(restored,'state','model-chat','group-10001.json'))),oldHistory);
  assert.deepEqual(JSON.parse(raw(path.join(restored,'config.json'))),config);
  assert.equal(other.read(group).content,'');
  console.log('PASS v0.2.0 to v0.3.0 upgrade, exact legacy copies, idempotence, custom Chinese/space path, full rollback and deployment isolation');
}finally{
  const tempRoot=fs.realpathSync(os.tmpdir());
  const cleanupTarget=fs.realpathSync(temp);
  if(path.dirname(cleanupTarget)!==tempRoot||!path.basename(cleanupTarget).startsWith('Qodex 升级 回退 '))throw new Error('拒绝清理非本测试临时目录');
  fs.rmSync(cleanupTarget,{recursive:true,force:true});
}

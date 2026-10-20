import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ItemMemory} from '../src/memory-store.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-social-memory-'));
try{
 const memory=new ItemMemory(root),key='group:101';
 const sourceMessages=[
  {messageId:'u1',kind:'user',senderQQ:'111',sender:'小明',text:'我不吃香菜',time:'2026-10-01T10:00:00Z'},
  {messageId:'u2',kind:'user',senderQQ:'111',sender:'新昵称',text:'周六登山',time:'2026-10-02T10:00:00Z'},
  {messageId:'u3',kind:'user',senderQQ:'222',sender:'小明',text:'我喜欢跑步',time:'2026-10-02T11:00:00Z'},
  {messageId:'a1',kind:'assistant',confirmed:true,sender:'机器人',text:'周六见',time:'2026-10-02T12:00:00Z'},
  {messageId:'a2',kind:'assistant',confirmed:false,sender:'机器人',text:'未发送猜测',time:'2026-10-02T13:00:00Z'},
  {messageId:'other',kind:'user',key:'group:999',senderQQ:'333',sender:'外群',text:'另一会话',time:'2026-10-02T13:00:00Z'}
 ];
 const apply=(ops,visibleIds=[])=>memory.applyModelOps(key,ops,{sourceMessages,visibleIds});
 const add=(text,kind,participantQQs,sourceMessageId='u1',extra={})=>({action:'add',text,kind,participantQQs,topicState:kind==='topic'?'open':null,sourceMessageId,...extra});
 assert.equal(apply([add('小明不吃香菜','person',['111']),add('同名小明喜欢跑步','person',['222'],'u3')]).applied,2);
 let record=memory.read(key),person=record.entries[0],namesake=record.entries[1];
 assert.deepEqual(person.participantQQs,['111']);assert.equal(person.source.senderQQ,'111');
 assert.equal(apply([{action:'revise',id:person.id,version:1,text:'新昵称不吃香菜',sourceMessageId:'u2',kind:'person',participantQQs:['111'],topicState:null,evidenceMessageIds:['u1','a1']}],[person.id]).applied,1);
 person=memory.read(key).entries[0];assert.equal(person.id,record.entries[0].id);assert.equal(person.source.sender,'新昵称');assert.equal(person.source.senderQQ,'111');assert.equal(person.evidence[0].senderQQ,'111');assert.equal(person.evidence[1].kind,'assistant');assert.equal(person.evidence[1].confirmed,true);assert(!Object.hasOwn(person.evidence[0],'text'));
 assert.deepEqual(memory.retrieve(key,'完全无关',{participantQQs:['111']}).entries.map(e=>e.id),[person.id]);
 assert.deepEqual(memory.retrieve(key,'完全无关',{participantQQs:['222']}).entries.map(e=>e.id),[namesake.id]);
 assert.equal(memory.retrieve(key,'完全无关',{participantQQs:['333']}).entries.length,0);
 const bad=[
  add('伪造人物','person',['222']),add('不存在参与者','episode',['999']),add('外群参与者','episode',['333']),
  add('伪造证据','fact',[],'u1',{evidenceMessageIds:['missing']}),
  add('未送达证据','episode',['111'],'u1',{evidenceMessageIds:['a2']}),
  add('机器人主来源','fact',[],'a1'),add('外群主来源','fact',[],'other'),
  add('外群证据','fact',[],'u1',{evidenceMessageIds:['other']})
 ];
 const rejected=apply(bad);assert.equal(rejected.applied,0);assert.equal(rejected.rejected.length,8);
 assert.equal(apply([add('过多证据','fact',[],'u1',{evidenceMessageIds:['u2','u3','a1','a2','other']})]).applied,0);
 assert.equal(apply([add('重复证据','fact',[],'u1',{evidenceMessageIds:['a1','a1']})]).applied,0);
 assert.equal(apply([{action:'revise',id:person.id,version:person.version,text:'同名成员的偏好',sourceMessageId:'u3',kind:'person',participantQQs:['222'],topicState:null}],[person.id]).applied,0);
 assert.deepEqual(memory.read(key).entries.find(e=>e.id===person.id).participantQQs,['111']);
 assert.equal(apply([add('周六登山安排','topic',['111'],'u2'),add('一起观看流星的旧事','episode',['111'],'u2'),add('登山装备清单','fact',[])]).applied,3);
 record=memory.read(key);const topic=record.entries.find(e=>e.kind==='topic'),episode=record.entries.find(e=>e.kind==='episode');
 assert.deepEqual(memory.retrieve(key,'登山',{limit:1,participantQQs:['111']}).entries.map(e=>e.id),[person.id]);
 assert(!memory.retrieve(key,'完全无关',{participantQQs:['111']}).entries.some(e=>e.id===episode.id));
 assert.equal(apply([{action:'revise',id:topic.id,version:topic.version,text:'周六登山已结束',sourceMessageId:'u2',kind:'topic',participantQQs:['111'],topicState:'closed'}],[topic.id]).applied,1);
 assert(!memory.retrieve(key,'登山').entries.some(e=>e.id===topic.id));
 record=memory.read(key);memory.mutate(key,{action:'edit',id:topic.id,version:2,revision:record.revision,text:'周六登山已结束',pinned:true});
 assert(memory.retrieve(key,'完全无关').entries.some(e=>e.id===topic.id));
 record=memory.read(key);const before=structuredClone(record.entries.find(e=>e.id===topic.id));
 assert.equal(apply([{action:'revise',id:topic.id,version:3,text:'模型改写',kind:'fact',participantQQs:[],topicState:null,sourceMessageId:'u2'}],[topic.id]).applied,0);
 assert.deepEqual(memory.read(key).entries.find(e=>e.id===topic.id),before);
 record=memory.read(key);person=record.entries.find(e=>e.id===person.id);
 memory.mutate(key,{action:'edit',id:person.id,version:person.version,revision:record.revision,text:'人工纠正',kind:'fact',participantQQs:['111'],topicState:null});
 assert.equal(apply([{action:'revise',id:person.id,version:person.version,text:'旧模型改写',sourceMessageId:'u2'}],[person.id]).applied,0);
 record=memory.read(key);const current=record.entries.find(e=>e.id===person.id);memory.mutate(key,{action:'restore',id:person.id,version:current.version,revision:record.revision,restoreVersion:2});
 person=memory.read(key).entries.find(e=>e.id===person.id);assert.equal(person.kind,'person');assert.equal(person.text,'新昵称不吃香菜');assert.deepEqual(person.evidence[1].messageId,'a1');assert.equal(person.versions[0].source.sender,'小明');
 const backup=JSON.parse(JSON.stringify(memory.read(key)));backup.entries[0].untrusted='discard';backup.entries[0].versions[0].untrusted='discard';backup.entries[0].evidence[0].text='discard whole message';
 const restored=memory.replace(key,backup);assert(!Object.hasOwn(restored.entries[0],'untrusted'));assert(!Object.hasOwn(restored.entries[0].versions[0],'untrusted'));assert(!Object.hasOwn(restored.entries[0].evidence[0],'text'));assert.deepEqual(restored.entries[0].evidence[1].confirmed,true);
 const invalid=structuredClone(backup);invalid.entries[0].evidence[1].confirmed=false;assert.throws(()=>memory.validate(key,invalid),/送达/);
 const legacyKey='private:123',oldSource={type:'message',messageId:'old',sender:'旧名',time:'2026-09-01'},oldEntry={id:'preserved-id',text:'旧记录',pinned:false,enabled:true,version:2,source:oldSource,updatedBy:'admin',updatedAt:'2026-09-02',versions:[{version:1,text:'最早内容',pinned:false,enabled:true,source:oldSource,editor:'model',at:'2026-09-01'},{version:2,text:'旧记录',pinned:false,enabled:true,source:oldSource,editor:'admin',at:'2026-09-02'}]};
 const oldData={schemaVersion:2,key:legacyKey,enabled:true,revision:7,entries:[oldEntry]};fs.mkdirSync(path.dirname(memory.file(legacyKey)),{recursive:true});fs.writeFileSync(memory.file(legacyKey),JSON.stringify(oldData));
 const oldRead=memory.read(legacyKey);assert.equal(oldRead.entries[0].id,'preserved-id');assert.equal(oldRead.entries[0].version,2);assert.equal(oldRead.entries[0].versions[0].text,'最早内容');assert.deepEqual(oldRead.entries[0].participantQQs,[]);assert.equal(oldRead.entries[0].kind,'fact');assert.equal(oldRead.entries[0].versions[0].kind,'fact');assert.deepEqual(JSON.parse(fs.readFileSync(memory.file(legacyKey))),oldData);
 memory.mutate(legacyKey,{action:'restore',id:'preserved-id',version:2,restoreVersion:1,revision:7});assert.equal(memory.read(legacyKey).entries[0].text,'最早内容');assert.equal(memory.read(legacyKey).entries[0].versions.length,3);
 assert.equal(memory.validate(legacyKey,oldData).entries[0].versions.length,2);
 console.log('PASS stable QQ identities, verified evidence, participant-first retrieval, closed topics, pin/conflict protection, metadata history/restore and legacy backups');
}finally{fs.rmSync(root,{recursive:true,force:true});}

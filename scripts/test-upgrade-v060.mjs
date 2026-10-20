import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {modelOutput} from './model-output-fixture.mjs';

const key='group:456';
const h=await bridgeHarness({config:{backend:'codex',ownerQQ:'10001',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'default'}}});
try{
 fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});
 // The HTTP bridge fixture runs in a VM; persisted JSON has ordinary prototypes.
 // Compare the same persisted representation used by a real single-realm bridge.
 for(const getter of ['getConfig','getExpression']){
  const read=h.chatBackup[getter];h.chatBackup[getter]=()=>JSON.parse(JSON.stringify(read()));
 }
 const file=h.modelChat.memory.file(key);fs.mkdirSync(path.dirname(file),{recursive:true});
 const source={type:'admin',label:'旧版管理员笔记',messageId:null,sender:'',time:null};
 const oldEntry={id:'v050-entry',text:'这个演示群讨论简单菜谱。',pinned:false,enabled:true,version:1,source,updatedBy:'admin',updatedAt:'2026-10-09T00:00:00Z',versions:[{version:1,text:'这个演示群讨论简单菜谱。',pinned:false,enabled:true,source,editor:'admin',at:'2026-10-09T00:00:00Z'}]};
 fs.writeFileSync(file,JSON.stringify({schemaVersion:2,key,enabled:true,revision:7,entries:[oldEntry],source:'manual',updatedAt:'2026-10-09T00:00:00Z'}));
 const oldBytes=fs.readFileSync(file),snapshot=path.join(h.temp,'v050-memory-snapshot.json');fs.writeFileSync(snapshot,oldBytes);
 for(let i=0;i<2;i++){
  const memory=h.modelChat.memory.read(key);assert.equal(memory.entries[0].kind,'fact');assert.deepEqual(memory.entries[0].participantQQs,[]);assert.equal(memory.entries[0].topicState,null);assert.deepEqual(memory.entries[0].evidence,[]);
  assert(fs.readFileSync(file).equals(oldBytes),'Reading old item memory must not rewrite its original bytes');
 }
 const entry=h.modelChat.entry(key);entry.sessionId='preserved-v050-native';entry.modelSignature=JSON.stringify(['gpt-6-luna','max']);h.modelChat.save(entry);
 assert.equal(h.modelChat.effective(key).replyMode,'natural');assert.equal(h.modelChat.effective(key).voiceEnabled,false);assert.equal(h.modelChat.effective(key).imageMode,'requested');assert.equal(h.wavesSettings.data.enabled,false);
 await h.modelChat.receive(key,{sender:'示例群友',senderQQ:'30001',text:'接着聊刚才的菜谱',messageId:'100'});
 assert.equal(h.calls.created.length,0,'Ordinary upgrade retains the existing native binding');
 const run=h.modelChat.running.get(key);assert.equal(h.calls.prompts.at(-1).outputSchema.properties.protocolVersion.enum[0],2);
 run.text=JSON.stringify(modelOutput({reply:'沿用已有对话，继续讨论菜谱。'}));
 await h.modelChat.consume(run.sessionId,{type:'turn/end',data:{requestId:run.id,reason:{kind:'completed'}}});
 assert.equal(h.modelChat.entry(key).runs.at(-1).actions[0].status,'sent');
 const oldBackup=h.chatBackup.export(true);delete oldBackup.sections.settings.expression.replyMode;oldBackup.sections.settings.model.serviceTier='default';
 for(const c of Object.values(oldBackup.sections.conversations))delete c.replyMode;
 for(const m of Object.values(oldBackup.sections.memory))for(const e of m.entries)for(const v of [e,...e.versions])for(const field of ['kind','participantQQs','topicState','evidence'])delete v[field];
 const models=await h.api.listModels(),normalized=h.chatBackup.validate(oldBackup,models);
 assert.equal(normalized.version,1);assert.equal(normalized.sections.settings.expression.replyMode,'natural');assert.equal(normalized.sections.settings.expression.voiceEnabled,false);assert.equal(normalized.sections.memory[key].entries[0].kind,'fact');
 const preview=h.chatBackup.preview(oldBackup,models);await h.chatBackup.restore(preview.id,['settings','conversations','memory']);
 assert.equal(entry.sessionId,'preserved-v050-native','No-op old backup restore keeps an unaffected native binding');
 const preferences=h.modelChat.preferences;
 preferences.updateConversation(key,{replyMode:'single'},preferences.data.revision);
 assert.equal(h.modelChat.effective(key).replyMode,'single');
 const current=h.modelChat.memory.read(key);
 h.modelChat.memory.mutate(key,{action:'add',text:'示例群友喜欢番茄面。',kind:'person',participantQQs:['30001'],revision:current.revision});
 const exported=h.chatBackup.export(true);assert.equal(exported.sections.conversations[key].replyMode,'single');assert.equal(exported.sections.memory[key].entries.at(-1).kind,'person');
 assert(exported.sections.history[key].some(m=>m.actionType==='text'&&m.actionIndex===0));
 for(const field of ['authorization','accounts','credentials','subscriptions'])assert(!Object.hasOwn(exported.sections,field));
 fs.copyFileSync(snapshot,file);assert(fs.readFileSync(file).equals(oldBytes));assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).entries[0].kind,undefined);
 console.log('PASS v0.5 item/default/JSON compatibility, no-op binding preservation, protocol2, scoped reply mode, social metadata/history export and exact original-memory rollback');
}finally{await h.close();}

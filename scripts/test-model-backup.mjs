import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'}}});
try{
 fs.mkdirSync(path.join(h.temp,'roles'));fs.writeFileSync(path.join(h.temp,'roles','猫娘.md'),'可爱喵');
 const runId=crypto.randomUUID();
 h.modelChat.append('group:456',{kind:'user',senderQQ:'998',text:'图片 https://example.com/a.png?signature=private-value',messageId:'-1',voice:[{source:'message',sourceMessageId:'-1',outerMessageId:'-1',sender:'群友',time:'2026-09-29T00:00:00.000Z',status:'ok',text:'今晚一起开黑'}]});
 h.modelChat.append('group:456',{kind:'assistant',text:'好呀',runId,actionIndex:0,actionType:'text',contextExcluded:false,sessionId:'must-not-export',modelSignature:'must-not-export',binding:'must-not-export'});
 h.chatPreferences.updateConversation('group:456',{replyMode:'single'},h.chatPreferences.data.revision);
 const learned=h.modelChat.memory.applyModelOps('group:456',[{action:'add',text:'喜欢咖啡',kind:'person',participantQQs:['998'],topicState:null,sourceMessageId:'-1',evidenceMessageIds:['2']}],{visibleIds:[],sourceMessages:[{kind:'user',senderQQ:'998',messageId:'-1'},{kind:'assistant',messageId:'2',confirmed:true}]});assert.equal(learned.applied,1);
 const image={imageId:crypto.randomUUID(),runId:crypto.randomUUID(),mimeType:'image/png',extension:'png',bytes:1024,createdAt:new Date().toISOString(),status:'sent',sentMessageId:'2'};
 h.modelChat.entry('group:456').images=[image];h.modelChat.save(h.modelChat.entry('group:456'));
 const b=h.chatBackup.export();assert.equal(b.sections.history,undefined);const encoded=JSON.stringify(b);assert(!encoded.includes('fixture-console-token'));assert(!encoded.includes('sessionId'));assert(!encoded.includes('authToken'));
 assert.deepEqual(b.sections.images['group:456'],[image]);assert(!encoded.includes('savedPath'));assert(!encoded.includes('base64://'));
 const full=h.chatBackup.export(true);assert(!JSON.stringify(full).includes('private-value'));assert(!JSON.stringify(full).includes('must-not-export'));assert.equal(full.sections.history['group:456'][0].voice[0].text,'今晚一起开黑');assert.equal(full.sections.settings.expression.replyMode,'natural');assert.equal(full.sections.conversations['group:456'].replyMode,'single');
 assert.equal(full.sections.history['group:456'][0].senderQQ,'998');assert.deepEqual(Object.fromEntries(['runId','actionIndex','actionType','contextExcluded'].map(k=>[k,full.sections.history['group:456'][1][k]])),{runId,actionIndex:0,actionType:'text',contextExcluded:false});
 const models=await h.api.listModels(),changed=structuredClone(b);changed.sections.memory['group:456'].entries[0].text='喜欢茶';changed.sections.memory['group:456'].entries[0].versions[0].text='喜欢茶';
 const normalized=h.chatBackup.validate(full,models);assert.equal(normalized.sections.memory['group:456'].entries[0].kind,'person');assert.deepEqual(normalized.sections.memory['group:456'].entries[0].participantQQs,['998']);assert.equal(normalized.sections.memory['group:456'].entries[0].evidence[0].confirmed,true);assert.equal(normalized.sections.memory['group:456'].entries[0].versions[0].evidence[0].messageId,'2');assert.equal(normalized.sections.history['group:456'][1].actionIndex,0);
 const legacy=structuredClone(full);delete legacy.sections.settings.expression.replyMode;delete legacy.sections.conversations['group:456'].replyMode;for(const m of legacy.sections.history['group:456'])for(const field of ['senderQQ','runId','actionIndex','actionType','contextExcluded'])delete m[field];for(const m of legacy.sections.memory['group:456'].entries){for(const field of ['kind','participantQQs','topicState','evidence']){delete m[field];for(const v of m.versions)delete v[field];}}
 const old=h.chatBackup.validate(legacy,models);assert.equal(old.sections.settings.expression.replyMode,'natural');assert.equal(old.sections.conversations['group:456'].replyMode,null);assert.equal(old.sections.memory['group:456'].entries[0].kind,'fact');
 for(const badMode of ['other',false,null]){const invalid=structuredClone(full);invalid.sections.settings.expression.replyMode=badMode;assert.throws(()=>h.chatBackup.validate(invalid,models),/回复方式/);}
 for(const [field,value] of [['senderQQ','../escape'],['runId','session-binding'],['actionIndex',-1],['actionType','command'],['contextExcluded','yes']]){const invalid=structuredClone(full);invalid.sections.history['group:456'][1][field]=value;assert.throws(()=>h.chatBackup.validate(invalid,models),/历史|开关/);}
 let p=h.chatBackup.preview(changed,models);assert(p.diff.some(x=>x.section==='memory'&&x.changed));await h.chatBackup.restore(p.id,['memory']);assert.equal(h.modelChat.memory.read('group:456').content,'喜欢茶');assert.equal(h.modelChat.entry('group:456').sessionId,null);assert.equal(h.modelChat.list()[0].allowed,true);
 assert(fs.readdirSync(path.join(h.temp,'state','restore-snapshots')).length);
 const rollbackData=structuredClone(b);rollbackData.sections.settings.expression.replyMode='single';rollbackData.sections.conversations['group:456'].replyMode='natural';p=h.chatBackup.preview(rollbackData,models);const before=fs.readFileSync(h.modelChat.memory.file('group:456'),'utf8');
 const rename=fs.renameSync;let thrown=false;fs.renameSync=(from,to)=>{if(!thrown&&String(to)===h.modelChat.memory.file('group:456')){thrown=true;throw Error('injected disk failure');}return rename(from,to);};
 try{await assert.rejects(h.chatBackup.restore(p.id,['settings','conversations','memory']),/已回滚/);}finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(h.modelChat.memory.file('group:456'),'utf8'),before);assert.equal(h.modelChat.restoring,false);
 assert.equal(h.chatPreferences.conversation('group:456').replyMode,'single');assert.equal(h.chatBackup.export().sections.settings.expression.replyMode,'natural');
 p=h.chatBackup.preview(full,models);await h.chatBackup.restore(p.id,['conversations','history']);assert.equal(h.chatPreferences.conversation('group:456').replyMode,'single');assert.equal(h.modelChat.entry('group:456').messages[1].runId,runId);assert.equal(h.modelChat.entry('group:456').messages[0].senderQQ,'998');
 p=h.chatBackup.preview(legacy,models);await h.chatBackup.restore(p.id,['conversations','history']);assert.equal(h.chatPreferences.conversation('group:456').replyMode,null);assert.equal(h.modelChat.entry('group:456').messages[1].actionIndex,undefined);
 const traversal=structuredClone(b);traversal.sections.roles={'../escape':'bad'};assert.throws(()=>h.chatBackup.preview(traversal,models),/角色路径/);
 const bad=structuredClone(b);bad.sections.settings.model.model='unavailable';assert.throws(()=>h.chatBackup.preview(bad,models),/不可用/);
 const badImage=structuredClone(b);badImage.sections.images['group:456'][0].imageId='../other-group';assert.throws(()=>h.chatBackup.preview(badImage,models),/图片元数据/);
 const badVoice=structuredClone(full);badVoice.sections.history['group:456'][0].voice[0].sourceMessageId='../other-group';assert.throws(()=>h.chatBackup.preview(badVoice,models),/语音转写来源/);
 p=h.chatBackup.preview(b,models);h.chatPreferences.setGlobalPaused(true,h.chatPreferences.data.revision);await assert.rejects(h.chatBackup.restore(p.id,['memory']),/预览后已变化/);
 console.log('PASS credential/signed-URL exclusion, image metadata without files, optional history, diff preview, selected restore, pre-restore snapshot, injected failure rollback, traversal/model rejection and stale preview');
}finally{await h.close();}

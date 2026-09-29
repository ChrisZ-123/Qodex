import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'}}});
try{
 fs.mkdirSync(path.join(h.temp,'roles'));fs.writeFileSync(path.join(h.temp,'roles','猫娘.md'),'可爱喵');
 h.modelChat.append('group:456',{kind:'user',text:'图片 https://example.com/a.png?signature=private-value',messageId:'1'});
 h.modelChat.memory.mutate('group:456',{action:'add',text:'喜欢咖啡',revision:0});
 const group=h.modelChat.entry('group:456'),privateChat=h.modelChat.entry('private:123');
 group.sessionId='group-session';privateChat.sessionId='private-session';h.modelChat.save(group);h.modelChat.save(privateChat);
 const b=h.chatBackup.export();assert.equal(b.sections.history,undefined);const encoded=JSON.stringify(b);assert(!encoded.includes('fixture-console-token'));assert(!encoded.includes('sessionId'));assert(!encoded.includes('authToken'));
 assert(!JSON.stringify(h.chatBackup.export(true)).includes('private-value'));
 let p=h.chatBackup.preview(b,await h.api.listModels());await h.chatBackup.restore(p.id,['stickers']);
 assert.equal(h.modelChat.entry('group:456').sessionId,'group-session');assert.equal(h.modelChat.entry('private:123').sessionId,'private-session');
 const models=await h.api.listModels(),changed=structuredClone(b);changed.sections.memory['group:456'].entries[0].text='喜欢茶';changed.sections.memory['group:456'].entries[0].versions[0].text='喜欢茶';
 p=h.chatBackup.preview(changed,models);assert(p.diff.some(x=>x.section==='memory'&&x.changed));await h.chatBackup.restore(p.id,['memory']);assert.equal(h.modelChat.memory.read('group:456').content,'喜欢茶');assert.equal(h.modelChat.entry('group:456').sessionId,null);assert.equal(h.modelChat.entry('private:123').sessionId,'private-session');assert.equal(h.modelChat.list()[0].allowed,true);
 assert(fs.readdirSync(path.join(h.temp,'state','restore-snapshots')).length);
 p=h.chatBackup.preview(b,models);const before=fs.readFileSync(h.modelChat.memory.file('group:456'),'utf8');
 const rename=fs.renameSync;let thrown=false;fs.renameSync=(from,to)=>{if(!thrown&&String(to)===h.modelChat.memory.file('group:456')){thrown=true;throw Error('injected disk failure');}return rename(from,to);};
 try{await assert.rejects(h.chatBackup.restore(p.id,['settings','memory']),/已回滚/);}finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(h.modelChat.memory.file('group:456'),'utf8'),before);assert.equal(h.modelChat.restoring,false);
 assert.equal(h.modelChat.entry('private:123').sessionId,'private-session');
 const traversal=structuredClone(b);traversal.sections.roles={'../escape':'bad'};assert.throws(()=>h.chatBackup.preview(traversal,models),/角色路径/);
 const bad=structuredClone(b);bad.sections.settings.model.model='unavailable';assert.throws(()=>h.chatBackup.preview(bad,models),/不可用/);
 p=h.chatBackup.preview(b,models);h.chatPreferences.setGlobalPaused(true,h.chatPreferences.data.revision);await assert.rejects(h.chatBackup.restore(p.id,['memory']),/预览后已变化/);
 p=h.chatBackup.preview(h.chatBackup.export(),models);
 let releaseReset;const waiting=new Promise(resolve=>{releaseReset=resolve;});
 h.modelChat.running.set('group:456',{});const reset=h.modelChat.reset.bind(h.modelChat);
 h.modelChat.reset=async key=>{await waiting;h.modelChat.running.delete(key);await reset(key);};
 const firstRestore=h.chatBackup.restore(p.id,['stickers']);
 assert.equal(h.modelChat.restoring,true);
 await assert.rejects(h.chatBackup.restore(p.id,['stickers']),error=>error.statusCode===409);
 releaseReset();await firstRestore;
 console.log('PASS credential/signed-URL exclusion, optional history, scoped restore, diff preview, pre-restore snapshot, injected failure rollback, traversal/model rejection, stale preview and concurrent restore guard');
}finally{await h.close();}

const custom=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},chatMemory:{directory:'isolated data/聊天记忆'}}});
try{
 fs.mkdirSync(path.join(custom.temp,'roles'),{recursive:true});
 const memory=custom.modelChat.memory;
 assert.equal(memory.root,path.join(custom.temp,'isolated data','聊天记忆'));
 memory.mutate('group:456',{action:'add',text:'自定义目录笔记',revision:0});
 const backup=custom.chatBackup.export();
 assert.equal(backup.sections.memory['group:456'].entries[0].text,'自定义目录笔记');
 memory.mutate('group:456',{action:'edit',id:memory.read('group:456').entries[0].id,version:1,text:'已修改',revision:1});
 const preview=custom.chatBackup.preview(backup,await custom.api.listModels());
 await custom.chatBackup.restore(preview.id,['memory']);
 assert.equal(memory.read('group:456').content,'自定义目录笔记');
 assert.equal(fs.existsSync(path.join(custom.temp,'state','chat-memory')),false);
 console.log('PASS backup restore follows custom memory directory with Chinese and spaces');
}finally{await custom.close();}

const images=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'}}});
try{
 fs.mkdirSync(path.join(images.temp,'roles'),{recursive:true});
 const key='group:456',entry=images.modelChat.entry(key),imageId=crypto.randomUUID(),runId=crypto.randomUUID();
 entry.sessionId='kept-context';entry.images=[{imageId,runId,mimeType:'image/png',extension:'png',bytes:64,createdAt:'2026-09-29T00:00:00Z',status:'sent',sentMessageId:'77'}];
 images.modelChat.append(key,{kind:'assistant',sender:'机器人',text:'[生成图片]',imageId});
 images.modelChat.save(entry);
 const exported=images.chatBackup.export(true);
 assert.equal(exported.sections.images[key][0].imageId,imageId);
 assert.equal(exported.sections.history[key].at(-1).imageId,imageId);
 assert(!JSON.stringify(exported).includes('data:image/png;base64,'));
 const old=structuredClone(exported);delete old.sections.images;
 delete old.sections.settings.expression.imageMode;delete old.sections.settings.expression.stickerStyle;
 for(const override of Object.values(old.sections.conversations)){delete override.imageMode;delete override.stickerStyle;}
 const models=await images.api.listModels();
 const normalized=images.chatBackup.validate(old,models);
 assert.equal(normalized.sections.settings.expression.imageMode,'requested');
 assert.equal(normalized.sections.settings.expression.stickerStyle,'natural');
 assert.equal(normalized.sections.conversations[key].imageMode,null);
 assert.equal(normalized.sections.conversations[key].stickerStyle,null);
 const preview=images.chatBackup.preview(exported,models);
 await images.chatBackup.restore(preview.id,['images']);
 assert.equal(images.modelChat.entry(key).images[0].imageId,imageId);
 assert.equal(images.modelChat.entry(key).sessionId,'kept-context');
 console.log('PASS v0.3 backup defaults and v0.4 image metadata restore without resetting context');
}finally{await images.close();}

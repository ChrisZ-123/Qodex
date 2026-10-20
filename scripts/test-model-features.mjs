import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelPreferences} from '../src/model-preferences.js';
import {ModelChat} from '../src/model-chat.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-features-'));
try{
 const prefs=new ModelPreferences(path.join(dir,'preferences.json')),models=[{model:'one',efforts:['max']},{model:'two',efforts:['low']}];
 const global={model:'one',reasoningEffort:'max',role:'猫娘',style:'自然'};
 prefs.updateConversation('group:1',{role:false,style:'简洁',model:{model:'two',reasoningEffort:'low'}},0,{roles:['猫娘'],models});
 assert.equal(prefs.effective('group:1',global).role,false);assert.equal(prefs.effective('group:2',global).role,'猫娘');
 assert.throws(()=>prefs.updateConversation('group:2',{model:{model:'two',reasoningEffort:'max'}},1,{models}));
 assert.throws(()=>prefs.updateConversation('group:2',{style:'stale'},0),/更新/);
 let n=0;const creates=[],prompts=[],sent=[],cancelled=[];
 const api={sessions:{create:async p=>{creates.push(p);return {result:{ok:true,value:{sessionId:'s'+(++n)}}};},prompt:async p=>{prompts.push(p);return {result:{ok:true}};}},stopSessionWork:async id=>cancelled.push(id)};
 const chat=new ModelChat({dir:path.join(dir,'chat'),api,preferences:prefs,settings:k=>prefs.effective(k,global),allowed:()=>true,send:async(k,text)=>sent.push([k,text]),persona:()=>({})});
 const msg=text=>({text,sender:'甲',messageId:String(++n)});
 await chat.receive('group:1',{...msg('第一群'),addressing:{mentionedBot:true,repliedToBot:false}});await chat.receive('group:2',msg('第二群'));
 assert.equal(JSON.parse(prompts[0].content[0].text).messages[0].addressing.mentionedBot,true);assert.equal(chat.entry('group:1').messages[0].addressing.mentionedBot,true);assert(prompts[0].context.addressingGuide.includes('群名片'));
 assert.equal(creates[0].model,'two');assert.equal(creates[1].model,'one');
 global.model='two';global.reasoningEffort='low';assert.equal(chat.running.get('group:2').settings.model,'one');
 await chat.receive('group:1',msg('排队消息'));const sid=chat.entry('group:1').sessionId;
 await chat.cancel('group:1');assert.equal(chat.pending.get('group:1').length,1);assert.equal(chat.running.get('group:1').status,'cancelling');
 await chat.consume(sid,{type:'assistant/message',data:{message:{content:[{type:'text',text:'迟到回复'}]}}});await chat.consume(sid,{type:'turn/end',data:{reason:{kind:'aborted'}}});
 await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);assert.equal(prompts.length,3);assert.equal(chat.entry('group:1').runs[0].result,'cancelled');
 await chat.pause(true,'group:2');await chat.receive('group:2',msg('暂停期间消息'));assert.equal(chat.pending.has('group:2'),false);assert(new ModelPreferences(prefs.file).isPaused('group:2'));
 const fb=prefs.addFeedback('group:1',{messageId:'response',rating:'long',note:'少复述',revision:prefs.data.revision});assert(prefs.feedbackHint('group:1').includes('少复述'));assert.equal(prefs.feedbackHint('group:2'),'');prefs.undoFeedback('group:1',fb.id,prefs.data.revision);assert.equal(prefs.feedbackHint('group:1'),'');
 prefs.setStickerDisabled('face',true,null,prefs.data.revision);assert.equal(prefs.stickerAllowed('group:1','face'),false);prefs.setStickerDisabled('face',false,'group:1',prefs.data.revision);assert.equal(prefs.stickerAllowed('group:1','face'),false);
 console.log('PASS per-group inheritance/explicit none, concurrent model isolation, next-turn snapshot, cancellation keeps queue, persistent scoped pause, feedback undo and global sticker priority');
}finally{fs.rmSync(dir,{recursive:true,force:true});}

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'}}});const server=h.startConsoleServer();
try{
 if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const req=(route,body,headers={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token',...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 h.modelChat.entry('group:456');
 fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});
 assert.equal((await req('/api/roles/create',{name:'自然·群友',content:'自然说话'})).status,200);
 assert.equal((await req('/api/role',{role:'自然·群友'})).status,200);
 assert.equal((await(await req('/api/roles')).json()).current,'自然·群友');
 assert.equal((await(await req('/api/roles/content?name='+encodeURIComponent('自然·群友'))).json()).content,'自然说话\n');
 const initialModels=await(await req('/api/chat/models')).json();
 assert.equal((await req('/api/chat/models',{...initialModels.current,revision:initialModels.revision,autoCompactTokenLimit:64000,serviceTier:null})).status,200);
 const changedModels=await(await req('/api/chat/models')).json();assert.equal(changedModels.current.serviceTier,null);assert.equal(changedModels.current.autoCompactTokenLimit,64000);
 assert.equal(h.chatBackup.export().sections.settings.model.autoCompactTokenLimit,64000);assert.equal(h.chatBackup.export().sections.settings.model.serviceTier,null);
 assert.equal((await req('/api/chat/models',{...changedModels.current,revision:changedModels.revision,autoCompactTokenLimit:1})).status,400);
 assert.equal((await req('/api/chat/models',{...changedModels.current,revision:changedModels.revision,serviceTier:'unknown'})).status,400);
 const s=await(await req('/api/chat/settings?key=group:456')).json();assert.equal(s.override.model,null);
 assert.equal((await req('/api/chat/settings',{key:'group:456',revision:s.revision,patch:{role:false,model:{model:'fixture-model',reasoningEffort:'low'}}})).status,200);
 assert.equal((await req('/api/chat/settings',{key:'group:456',revision:s.revision,patch:{role:null}})).status,409);
 assert.equal((await req('/api/chat/runs?key=../config')).status,400);
 assert.equal((await req('/api/chat/settings?key=group:456',null,{'x-agent-token':'model'})).status,403);
 const reply=h.modelChat.append('group:456',{kind:'assistant',text:'fixture'}),f=await(await req('/api/chat/feedback?key=group:456')).json();
 assert.equal((await req('/api/chat/feedback',{key:'group:456',messageId:reply.id,rating:'good',note:'自然',revision:f.revision})).status,200);
 assert.equal((await req('/api/chat/feedback',{key:'group:456',messageId:'fake',rating:'long',revision:f.revision})).status,400);
 console.log('PASS authenticated scoped settings, optimistic write conflict, agent denial, run key validation and per-reply feedback provenance');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();}

let releaseImage,requested,transportCalls=0;const imageRequested=new Promise(r=>requested=r);
const race=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'}},globals:{safeFetchBuffer:()=>{requested();return new Promise(r=>releaseImage=r);},fetch:async()=>{transportCalls++;return {ok:true,json:async()=>({status:'ok',retcode:0,data:{message_id:1}})};}}});
try{
 const sending=race.modelChat.sendSticker('group:456','fixture-sticker',()=>true,{replyTo:null});
 await imageRequested;race.chatPreferences.setStickerDisabled('fixture-sticker',true,'group:456',race.chatPreferences.data.revision);releaseImage({buffer:Buffer.from('89504e470d0a1a0a00000000','hex')});
 await assert.rejects(sending,/取消|权限/);assert.equal(transportCalls,0);
 console.log('PASS sticker disabled during download is blocked immediately before QQ transport');
}finally{await race.close();}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {WavesSettings,WavesClient,WavesController,loadWavesAsset,validateWavesSettings} from '../src/waves-client.js';
import {ModelChat} from '../src/model-chat.js';
import {CodexApiClient} from '../src/codex-client.js';
import {ChatMemory} from '../src/chat-memory.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qodex-waves-test-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const tick=()=>new Promise(r=>setTimeout(r,20));
try{
 const settings=new WavesSettings(path.join(root,'settings.json'));
 assert.equal(settings.enabled('group:1'),false);settings.restore({version:1,enabled:true,conversations:{}});
 assert(settings.enabled('group:1'));settings.update({key:'group:1',enabled:false,revision:1});assert(!settings.enabled('group:1'));assert(settings.enabled('group:2'));
 assert.throws(()=>settings.update({enabled:true,revision:0}),/已变化/);settings.update({key:'group:1',enabled:null,revision:2});assert(settings.enabled('group:1'));
 assert.throws(()=>validateWavesSettings({version:1,enabled:true,conversations:{'../private':true}}),/无效/);
 const requests=[];let reads=0;
 const client=new WavesClient({root,token:'fixture',fetchImpl:async(url,options)=>{requests.push({url,options});let result={};if(url.includes('/tasks/'))result={requestId:JSON.parse(requests.find(x=>x.url.endsWith('/execute')).options.body).requestId,status:++reads===1?'running':'completed',outputs:reads===1?[{type:'text',text:'处理中'}]:[{type:'text',text:'真实最终结果'}]};return {ok:true,json:async()=>result};}});
 const scope={key:'group:1',senderQQ:'111',messageId:'100',requestId:crypto.randomUUID()};
 const result=await client.execute(scope,'ww帮助');assert.deepEqual(result.outputs,[{type:'text',text:'真实最终结果'}]);assert.equal(reads,2);assert.equal(scope.gameRequestIds.size,0);
 let current=true,cancels=0;
 const cancelled=new WavesClient({root,token:'fixture',fetchImpl:async(url,options)=>{if(url.endsWith('/cancel'))cancels++;if(url.includes('/tasks/'))current=false;return {ok:true,json:async()=>url.includes('/tasks/')?{requestId:JSON.parse(requests[0].options.body).requestId,status:'running'}:{}};}});
 // Use a fixed returned request ID from this client's actual execute call.
 let cancelledId;cancelled.fetchImpl=async(url,opts)=>{if(url.endsWith('/execute'))cancelledId=JSON.parse(opts.body).requestId;if(url.endsWith('/cancel'))cancels++;if(url.includes('/tasks/'))current=false;return {ok:true,json:async()=>url.includes('/tasks/')?{requestId:cancelledId,status:'running'}:{}};};
 await assert.rejects(cancelled.execute({...scope},'ww帮助',{isCurrent:()=>current}),/取消/);assert.equal(cancels,1);
 fs.mkdirSync(path.join(root,'results'));fs.writeFileSync(path.join(root,'results','good.png'),png);fs.writeFileSync(path.join(root,'outside.png'),png);
 assert.equal(loadWavesAsset(root,{path:path.join(root,'results','good.png')}).mimeType,'image/png');assert.throws(()=>loadWavesAsset(root,{path:path.join(root,'outside.png')}),/越界/);
 let paused=false;const calls=[],privateSent=[];
 fs.mkdirSync(path.join(root,'results','fixture-task'));fs.writeFileSync(path.join(root,'results','fixture-task','good.png'),png);
 const fake={root,call:async(route,body)=>{calls.push([route,body]);if(route==='/v1/login/create')return {requestId:'login-fixture',url:'https://example.trycloudflare.com/l/fixture',expiresAt:new Date(Date.now()+180000).toISOString()};if(route==='/v1/mutations/prepare')return {requestId:'mutation-fixture'};return {};},saveInputs:()=>[],execute:async(s)=>({requestId:'fixture-task',outputs:[{type:'text',text:'面板结果'},{type:'image',id:'native-image',path:path.join(root,'results','fixture-task','good.png')}]}),cancel:async()=>{}};
 const controller=new WavesController({root,settings,client:fake,allowed:k=>['group:1','group:2'].includes(k),paused:()=>paused,keys:()=>['group:1','group:2'],sendPrivate:async(q,text)=>privateSent.push([q,text]),sendNotice:async()=>true});
 const run={...scope,batch:[{senderQQ:'111',messageId:'100',text:'帮我看鸣潮面板'}],gameAssets:new Map(),gameRequestIds:new Set()};
 const tool=await controller.tool(run,{command:'ww面板',sourceMessageId:'100'});assert(tool.content.some(x=>x.type==='image'));assert.equal(run.gameAssets.size,1);
 await assert.rejects(controller.tool(run,{command:'ww面板',sourceMessageId:'foreign'}),/真实发送者/);
 await assert.rejects(controller.tool(run,{command:'ww面板',sourceMessageId:'100',senderQQ:'222'}),/来源无效/);
 await assert.rejects(controller.tool(run,{command:'ww确认 something',sourceMessageId:'100'}),/代替确认/);
 await assert.rejects(controller.query(run,'ww添加ck secret-token'),/凭据/);
 paused=true;await assert.rejects(controller.tool(run,{command:'ww面板',sourceMessageId:'100'}),/暂停/);paused=false;
 const subscribe=await controller.query(run,'ww开启体力提醒 180');const pending=[...controller.pending.values()].at(-1);assert(subscribe.outputs[0].text.includes('本人'));assert(!calls.some(x=>x[0]==='/v1/subscriptions'));
 await assert.rejects(controller.confirmation({...scope,senderQQ:'222'},pending.id),/不属于你/);
 await controller.confirmation(scope,pending.id);assert.deepEqual(calls.find(x=>x[0]==='/v1/subscriptions')[1],{senderQQ:'111',key:'group:1',reminderEnabled:true,threshold:180});
 await controller.query({...run,nativeCommand:true},'ww登录');assert.equal(privateSent[0][0],'111');assert(privateSent[0][1].includes('/l/'));assert(!JSON.stringify(controller.runs).includes('/l/'));
 assert(!JSON.stringify(settings.export()).includes('fixture'));

 // The real conversation queue gives a ww job exclusive routing, with later text kept.
 const sent=[],prompts=[],jobs=[];let release;
 let threadCount=0;
 const api={toolGeneration:'waves-v1',sessions:{create:async()=>({result:{ok:true,value:{sessionId:'new-thread-'+(++threadCount)}}}),prompt:async p=>{prompts.push(p);return {result:{ok:true}};}},stopSessionWork:async()=>{}};
 const game={settings:{enabled:()=>true},command:async(r,c)=>{jobs.push(c);await new Promise(resolve=>release=resolve);return {outputs:[{type:'text',text:'原版帮助'}]};},cancel:async()=>release?.()};
 const chat=new ModelChat({dir:path.join(root,'chat'),api,allowed:k=>k!=='group:3',settings:()=>({model:'gpt-6-luna',reasoningEffort:'max'}),persona:()=>({}),waves:game,send:async(k,text,current,options)=>{if(!current())throw Error('cancelled');sent.push([k,text]);options?.onSent?.(text,'200');}});
 const native=chat.receive('group:1',{sender:'玩家',senderQQ:'111',text:'ww帮助',messageId:'101',wavesCommand:'ww帮助'});await tick();
 await chat.receive('group:1',{sender:'玩家',senderQQ:'111',text:'然后问普通问题',messageId:'102'});await chat.receive('group:2',{sender:'另一群',senderQQ:'222',text:'普通聊天',messageId:'201'});assert.equal(prompts.length,1);assert.equal(prompts[0].context.conversation,'group:2');assert.equal(jobs.length,1);
 release();await native;await tick();assert.equal(prompts.length,2);assert.deepEqual(sent[0],['group:1','原版帮助']);
 await chat.reset('group:1');const late=chat.receive('group:1',{sender:'玩家',senderQQ:'111',text:'ww查询',messageId:'103',wavesCommand:'ww查询'});await tick();await chat.cancel('group:1');await late;assert.equal(sent.length,1);
 // User explicitly selected last 100 eligible messages plus retrieved memory.
 // The retained local history and prior binding remain complete and recoverable.
 const e=chat.entry('group:4');e.sessionId='old-tools';e.modelSignature=JSON.stringify(['gpt-6-luna','max']);
 chat.append('group:4',{kind:'user',text:'before-reset-0'});chat.append('group:4',{kind:'assistant',text:'before-reset-1'});e.contextStart=2;
 const metadata={source:'waves',messageId:'eligible-124',senderQQ:'111',addressing:{repliedToBot:true},quotedImageMessageId:'quoted-fixture',forward:[{status:'ok',nodes:[{sender:'quoted player',text:'quoted fixture'}]}],voice:[{status:'ok',source:'quote',text:'voice fixture',sourceMessageId:'voice-fixture'}]};
 for(let i=0;i<125;i++)chat.append('group:4',{kind:i%2?'assistant':'user',text:'eligible-'+i,...(i===124?metadata:{})});
 chat.append('group:4',{kind:'user',text:'excluded-fixture',contextExcluded:true});chat.append('group:4',{kind:'event',text:'non-message-fixture'});chat.save(e);
 chat.memory=new ChatMemory(path.join(root,'memory'));const migrationNote=chat.memory.mutate('group:4',{action:'add',text:'migration fixture preference',pinned:true,revision:0});
 await chat.receive('group:4',{sender:'玩家',senderQQ:'111',text:'自然查询',messageId:'400'});
 const migratedContext=prompts.at(-1).context;assert.equal(e.previousBindings[0].sessionId,'old-tools');assert.equal(e.previousBindings[0].modelSignature,JSON.stringify(['gpt-6-luna','max']));assert.notEqual(e.sessionId,'old-tools');
 assert.equal(migratedContext.earlierMessages.length,100);assert.equal(migratedContext.earlierMessages[0].text,'eligible-25');assert.equal(migratedContext.earlierMessages.at(-1).text,'eligible-124');
 for(const field of Object.keys(metadata))assert.deepEqual(migratedContext.earlierMessages.at(-1)[field],metadata[field]);
 assert.equal(migratedContext.longTermMemory.entries[0].id,migrationNote.entries[0].id);assert.equal(chat.memory.read('group:4').entries[0].text,'migration fixture preference');
 assert.equal(e.messages.length,130,'All local history survives migration');assert(e.messages.some(m=>m.text==='before-reset-0'));assert(e.messages.some(m=>m.contextExcluded));
 await chat.reset('group:4');chat.memory=new ChatMemory(path.join(root,'memory'));await chat.receive('group:4',{sender:'玩家',senderQQ:'111',text:'图片查询',messageId:'401'});const imageRun=chat.running.get('group:4'),assetId=crypto.randomUUID();imageRun.gameAssets.set(assetId,{id:assetId,key:'group:4',runId:imageRun.id,path:path.join(root,'results','good.png')});let imagesSent=0;chat.sendGameImage=async()=>{imagesSent++;return {messageId:'402'};};
 imageRun.text=JSON.stringify({reply:'',memoryOps:[],wavesResultIds:[assetId],stickerIds:[],stickerNotes:[],imagePrompt:'',replyTo:null});await chat.consume(imageRun.sessionId,{type:'turn/end',data:{requestId:imageRun.id,reason:{kind:'completed'}}});assert.equal(imagesSent,1);assert(chat.history('group:4').messages.some(m=>m.wavesImageId===assetId));
 const codex=Object.create(CodexApiClient.prototype);Object.assign(codex,{config:{conversationMode:'model'},records:{own:{toolGeneration:'waves-v1'}},active:new Map([['own','new-turn']]),tools:new Map(),cancelled:new Set(),pendingRequestIds:new Map([['own','request']]),frames:[]});let bound;
 codex.installApplicationTools([{name:'waves_game',execute:async p=>{bound=p;return {content:[{type:'text',text:'ok'}]};}}],'waves-v1');await codex.toolCall('item/tool/call',{threadId:'own',turnId:'new-turn',tool:'waves_game',arguments:{command:'ww帮助',sourceMessageId:'9'}});assert.equal(bound.requestId,'request');await assert.rejects(codex.toolCall('item/tool/call',{threadId:'own',turnId:'old-turn',tool:'waves_game'}),/obsolete/);

 const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},sendDelayMs:0}});try{
  h.wavesSettings.restore({version:1,enabled:true,conversations:{}});
  h.waves.command=async()=>({outputs:[{type:'text',text:'帮助结果'}]});await h.handleIncoming('group',456,{user_id:998,message_id:'900',self_id:111,sender:{nickname:'玩家'},message:[{type:'text',data:{text:'ww帮助'}}]},h.cfg);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,1);
  await h.handleIncoming('group',456,{user_id:998,message_id:'901',self_id:111,message:[{type:'text',data:{text:'ww添加cookie password=fixture-secret'}}]},h.cfg);assert(!JSON.stringify(h.modelChat.history('group:456')).includes('fixture-secret'));
  fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});const backup=h.chatBackup.export();assert.deepEqual(backup.sections.waves,{version:1,enabled:true,conversations:{}});assert(!JSON.stringify(backup).includes('fixture-secret'));
  backup.sections.waves.conversations['group:456']=false;const preview=h.chatBackup.preview(backup,await h.api.listModels());assert(preview.diff.find(d=>d.section==='waves').changed);await h.chatBackup.restore(preview.id,['waves']);assert.equal(h.wavesSettings.enabled('group:456'),false);
  const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  try{const request=(route,body,headers={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token',...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
   assert.equal((await fetch(base+'/api/waves/status')).status,401);assert.equal((await request('/api/waves/status',null,{'x-agent-token':'forged'})).status,403);
   const config=(await(await request('/api/waves/status?key=group%3A456')).json()).settings;
   assert.equal((await request('/api/waves/settings',{key:'group:456',enabled:true,revision:config.revision},{origin:'https://other.invalid'})).status,403);
   assert.equal((await request('/api/waves/settings',{key:'group:456',enabled:true,revision:config.revision-1})).status,409);
   assert.equal((await request('/api/waves/settings',{key:'group:456',enabled:null,revision:config.revision})).status,200);
   assert.equal((await request('/api/waves/image-preview?key=group%3A456&id=foreign')).status,404);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }finally{await h.close();}
 console.log('PASS Waves scope/inheritance, true task completion, native exclusivity, multi-group queues, cancellation, model tool ownership, mutation confirmation, private login, asset boundary/empty-text images, migration rollback bindings and secret-free backup');
}finally{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'qodex-waves-test-'));fs.rmSync(root,{recursive:true,force:true});}

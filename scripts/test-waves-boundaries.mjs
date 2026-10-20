import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {WavesClient,WavesController,WavesSettings} from '../src/waves-client.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {modelOutput} from './model-output-fixture.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'waves-boundaries-'));
const tick=()=>new Promise(r=>setTimeout(r,10));
const settings=new WavesSettings(path.join(root,'settings.json'));
settings.update({enabled:true,revision:0});
let paused=false,current=true,release;
const privateSent=[],groupSent=[],calls=[];let mode='normal',noticeSends=0;
const scope=()=>({key:'group:1',senderQQ:'111',messageId:'10',requestId:crypto.randomUUID(),nativeCommand:true,isCurrent:()=>current});
const client=new WavesClient({root,token:'fixture',fetchImpl:async(url,options)=>{
 const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push({route,body});
 let value={};
 if(route==='/v1/login/create'){if(mode==='delayed-create')await new Promise(r=>release=r);value={requestId:'login-fixture',url:'https://fixture.trycloudflare.com/l/test-only',expiresAt:new Date(Date.now()+180000).toISOString()};}
 if(route==='/v1/login/pending'){if(mode==='delayed-summary')await new Promise(r=>release=r);value={requestId:'login-fixture',status:'awaiting_confirmation',account:{uid:'100000001',nickname:'fixture'}};}
 if(route==='/v1/mutations/prepare')value={requestId:'sign-task'};
 if(route==='/v1/mutations/confirm')value={requestId:'sign-task',status:'running'};
 if(route==='/v1/tasks/sign-task'){await new Promise(r=>release=r);value={requestId:'sign-task',status:'completed',outputs:[{type:'text',text:'upstream final 1'},{type:'text',text:'upstream final 2'}]};}
 if(route==='/v1/notices')value={notices:mode==='notice'?[{id:'notice-1',key:'group:1',senderQQ:'111',text:'fixture reminder'}]:[]};
 if(route==='/v1/notices/ack')throw Error('Fixture ACK connection failed');
 return {ok:true,json:async()=>value};
}});
const options={root,settings,client,allowed:k=>k==='group:1',paused:()=>paused,keys:()=>['group:1'],sendPrivate:async(q,text,guard)=>{assert.equal(typeof guard,'function');if(guard())privateSent.push([q,text]);},sendNotice:async(k,q,text,delivery)=>{if(delivery){assert.equal(typeof delivery.isCurrent,'function');if(!delivery.isCurrent())return false;groupSent.push([k,q,text]);}else noticeSends++;return true;}};
const waves=new WavesController(options);
await waves.query(scope(),'ww开启自动签到');assert(calls.some(x=>x.route==='/v1/subscriptions'));assert.equal(waves.pending.size,0);
const subscribe={id:'legacy-subscribe',type:'subscribe',key:'group:1',senderQQ:'111',sourceEpoch:0,expiresAt:Date.now()+180000,patch:{signEnabled:true},label:'开启自动签到'};waves.pending.set(subscribe.id,subscribe);
assert.equal(await waves.privateAuth({...scope(),key:'private:111'},'ww确认 '+subscribe.id),false);
assert.equal(calls.filter(x=>x.route==='/v1/subscriptions').length,1);

let completed=false;
const result=waves.command(scope(),'ww签到').then(x=>{completed=true;return x;});
while(!release)await tick();assert.equal(completed,false);assert.equal(calls.filter(x=>x.route==='/v1/execute').length,0);
release();release=null;assert.deepEqual((await result).outputs.map(x=>x.text),['upstream final 1','upstream final 2']);

// Legacy prepared requests retain their deadline and origin guards.
// An accepted operation may finish after its input window.
for(const type of ['sign','unbind','subscribe','login']){
 let pending,polled=false,linkDelivered=false;const acceptedScope=scope();
 const deadlineClient={call:async(route)=>{
  if(route==='/v1/policy')return {};
  if(route==='/v1/login/cancel')return {status:'cancelled'};
  assert(pending.expiresAt>Date.now(),'Confirmation reaches the service within its deadline');
  pending.expiresAt=Date.now()-1; // Accepted RPC finishes after the input window.
  if(route==='/v1/login/create')return {requestId:'accepted-login',url:'https://fixture.trycloudflare.com/l/accepted',expiresAt:new Date(Date.now()+180000).toISOString()};
  if(route==='/v1/mutations/confirm')return {requestId:'accepted-sign',text:'accepted unbind'};
  assert.equal(route,'/v1/subscriptions');return {};
 },waitTask:async(s,id,{isCurrent})=>{polled=true;assert(isCurrent());return {requestId:id,outputs:[{type:'text',text:'accepted final sign'}]};}};
 const accepted=new WavesController({...options,root:path.join(root,'accepted-'+type),client:deadlineClient,sendNotice:async(k,q,text,delivery)=>{assert(delivery.isCurrent());linkDelivered=true;return true;}});
 pending={id:'accepted-'+type,type,key:'group:1',senderQQ:'111',sourceEpoch:accepted.sourceEpoch('group:1'),expiresAt:Date.now()+180000,serverRequestId:'prepared',patch:{signEnabled:true},label:'开启自动签到'};
 accepted.pending.set(pending.id,pending);const outputs=await accepted.confirmation(acceptedScope,pending.id);
 assert(outputs.length);assert(acceptedScope.gameOriginCurrent(),'Accepted action may deliver after its input deadline');
 assert.equal(polled,type==='sign');assert.equal(linkDelivered,type==='login');
 if(type==='login'){const binding=accepted.bindings.get('111');assert(accepted.retainedCurrent(binding),'A fresh login link uses its own deadline');binding.expiresAt=Date.now()-1;assert.equal(accepted.retainedCurrent(binding),false);}
 await accepted.cancel({key:'group:1'});assert.equal(acceptedScope.gameOriginCurrent(),false,'Accepted action still checks origin reset/cancel');
}
{
 let binding,confirmed=false;const accepted=new WavesController({...options,root:path.join(root,'accepted-binding'),client:{call:async(route)=>{assert.equal(route,'/v1/login/confirm');assert(binding.expiresAt>Date.now());binding.expiresAt=Date.now()-1;confirmed=true;return {account:{nickname:'fixture'}};}}});
 binding={requestId:'accepted-binding',key:'group:1',senderQQ:'111',sourceEpoch:0,expiresAt:Date.now()+180000};accepted.bindings.set('111',binding);
 assert.equal(await accepted.privateAuth({key:'private:111',senderQQ:'111'},'ww确认 accepted-binding'),false);assert.equal(confirmed,false,'Group-origin login cannot be confirmed in private');
 const acceptedScope=scope();const outputs=await accepted.confirmation(acceptedScope,binding.requestId);assert(confirmed);assert(outputs[0].text.includes('已绑定'));assert(acceptedScope.gameOriginCurrent(),'Accepted login commit may finish after its input deadline');
 assert.equal(accepted.bindings.size,0);
}

mode='delayed-create';const create=waves.query({...scope(),nativeCommand:true},'ww登录');while(!release)await tick();current=false;release();release=null;
await assert.rejects(create,/取消|权限/);assert.equal(groupSent.length,0);current=true;
assert(calls.some(x=>x.route==='/v1/login/cancel'&&x.body.requestId==='login-fixture'),'A create completing after cancellation must invalidate its server ticket');
mode='normal';await waves.query({...scope(),nativeCommand:true},'ww登录');assert.equal(groupSent.length,1);assert.equal(privateSent.length,0);
// The delivery may wait on the shared QQ chain: stale links and cleanup must
// not affect a newer binding belonging to the same QQ.
let deliveryRelease,deliveryGuard;
const queued=new WavesController({...options,sendNotice:async(k,q,text,{isCurrent:guard})=>{deliveryGuard=guard;await new Promise(r=>deliveryRelease=r);if(!guard())throw Error('stale queued link');return true;}});
const expired=queued.query({...scope(),nativeCommand:true},'ww登录');while(!deliveryRelease)await tick();
queued.bindings.get('111').expiresAt=Date.now()-1;assert.equal(deliveryGuard(),false);deliveryRelease();deliveryRelease=null;await assert.rejects(expired,/发送失败|取消/);
assert.equal(queued.bindings.size,0);
const replaced=queued.query({...scope(),nativeCommand:true},'ww登录');while(!deliveryRelease)await tick();
const newer={requestId:'new-login',key:'group:1',expiresAt:Date.now()+180000};queued.bindings.set('111',newer);assert.equal(deliveryGuard(),false);deliveryRelease();deliveryRelease=null;await assert.rejects(replaced,/发送失败|取消/);
assert.equal(queued.bindings.get('111'),newer,'Failed old delivery must keep the newer ticket');
mode='delayed-summary';const polling=waves.poll();while(!release)await tick();paused=true;release();release=null;await polling;assert.equal(groupSent.length,1);paused=false;
waves.bindings.clear();mode='notice';await waves.poll();assert.equal(noticeSends,1);assert(waves.health.errors.some(x=>x.phase==='notice-ack'));
const restarted=new WavesController(options);await restarted.poll();assert.equal(noticeSends,1,'A failed ACK or restart must not resend an attempted QQ notice');

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},sendDelayMs:200}});
try{
 h.wavesSettings.update({enabled:true,revision:0});
 h.waves.command=async()=>({outputs:[{type:'text',text:'first game text'},{type:'text',text:'second game text'}]});
 const incoming=h.handleIncoming('group',456,{user_id:998,message_id:'900',self_id:111,message:[{type:'text',data:{text:'ww帮助'}}]},h.cfg);
 for(let i=0;i<100&&!h.calls.sent.length;i++)await tick();assert.equal(h.calls.sent.length,1);
 h.wavesSettings.update({enabled:false,revision:h.wavesSettings.read().revision});await incoming;
 assert.equal(h.calls.sent.length,1,'Disabling game while a text waits on sendChain must suppress it');
 assert.equal(h.calls.prompts.length,0);
}finally{await h.close();}
const modelHarness=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},sendDelayMs:0}});
try{
 modelHarness.wavesSettings.update({enabled:true,revision:0});
 const incoming=id=>modelHarness.handleIncoming('group',456,{user_id:998,message_id:id,self_id:111,message:[{type:'text',data:{text:'看看鸣潮功能'}}]},modelHarness.cfg);
 const finish=run=>{run.text=JSON.stringify(modelOutput({reply:'正常聊天回复'}));return modelHarness.modelChat.consume(run.sessionId,{type:'turn/end',data:{requestId:run.id,reason:{kind:'completed'}}});};
 await incoming('910');const gameRun=modelHarness.modelChat.running.get('group:456');
 modelHarness.waves.command=async()=>({outputs:[{type:'text',text:'游戏真实结果'}]});
 await modelHarness.waves.tool(gameRun,{command:'ww帮助',sourceMessageId:'910'});
 modelHarness.wavesSettings.update({enabled:false,revision:modelHarness.wavesSettings.read().revision});await finish(gameRun);
 assert.equal(modelHarness.calls.sent.length,0,'Model text derived from a game tool must honor final game disable');
 await incoming('911');await finish(modelHarness.modelChat.running.get('group:456'));
 assert.equal(modelHarness.calls.sent.length,1,'Ordinary GPT chat remains usable with game disabled');
}finally{await modelHarness.close();}
// Retained login outlives a normally completed native run, but not explicit
// origin reset/cancel, including while a confirmation or queued send awaits.
const retained=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},allow:{groups:['456','789'],private:['123']},sendDelayMs:0}});
try{
 retained.wavesSettings.update({enabled:true,revision:0});
 let loginId=0,summaryRelease,delaySummary=false,subscriptionRelease,delaySubscription=false;const rpc=[];
 retained.wavesClient.call=async(route,body)=>{
  rpc.push({route,body});
  if(route==='/v1/login/create')return {requestId:'retained-login-'+(++loginId),url:'https://fixture.trycloudflare.com/l/fixture',expiresAt:new Date(Date.now()+180000).toISOString()};
  if(route.startsWith('/v1/login/pending')){const value={requestId:'retained-login-'+loginId,status:'awaiting_confirmation',account:{uid:'100000001',nickname:'fixture'}};if(delaySummary)await new Promise(r=>summaryRelease=r);return value;}
  if(route==='/v1/subscriptions'&&delaySubscription)await new Promise(r=>subscriptionRelease=r);
  if(route==='/v1/notices')return {notices:[]};return {};
 };
 const incoming=(group,command)=>retained.handleIncoming('group',group,{user_id:998,message_id:'retained-'+crypto.randomUUID(),self_id:111,message:[{type:'text',data:{text:command}}]},retained.cfg);
 const loginMessages=()=>retained.calls.sent.filter(x=>x.kind==='group'&&Array.isArray(x.text)&&x.text.some(segment=>segment.type==='text'&&(/https:\/\/fixture.trycloudflare.com\/l\/|请核对鸣潮账号/).test(segment.data.text))).length;
 await incoming(456,'ww登录');assert.equal(retained.modelChat.running.size,0);assert.equal(loginMessages(),1);await retained.waves.poll();assert.equal(loginMessages(),2,'Normal completed run must keep its three-minute login summary alive');
 await incoming(456,'ww登录');await retained.modelChat.reset('group:456');await retained.waves.poll();assert.equal(loginMessages(),3,'Idle source reset must suppress retained summary');assert.equal(retained.waves.bindings.size,0);
 await incoming(456,'ww登录');const cancelledId=retained.waves.bindings.get('998').requestId;await retained.modelChat.cancel('group:456');await retained.waves.poll();assert.equal(loginMessages(),4);assert.equal(await retained.waves.privateAuth({key:'private:998',senderQQ:'998'},'ww确认 '+cancelledId),false);
 await incoming(456,'ww登录');delaySummary=true;const polling=retained.waves.poll();while(!summaryRelease)await tick();await retained.modelChat.reset('group:456');summaryRelease();await polling;delaySummary=false;assert.equal(loginMessages(),5,'Reset while summary RPC awaits must suppress its result');
 await incoming(456,'ww登录');delaySummary=true;const completion=retained.waves.poll();while(!summaryRelease)await tick();await retained.modelChat.reset('group:456');summaryRelease();summaryRelease=null;await completion;assert.equal(loginMessages(),6,'Reset during completed-login poll suppresses success');
 assert.equal(retained.calls.sent.filter(x=>x.kind==='private').length,0,'Group login flow must not send private messages');
 await incoming(456,'ww登录');const replacing=retained.waves.poll();while(!summaryRelease)await tick();await incoming(789,'ww登录');const replacement=retained.waves.bindings.get('998');summaryRelease();summaryRelease=null;await replacing;assert.equal(retained.waves.bindings.get('998'),replacement,'Old login completion must preserve newer other-group binding');delaySummary=false;
 const beforeExpired=rpc.filter(x=>x.route==='/v1/login/confirm').length;replacement.expiresAt=Date.now()-1;await retained.waves.privateAuth({key:'private:998',senderQQ:'998'},'ww确认 '+replacement.requestId);assert.equal(rpc.filter(x=>x.route==='/v1/login/confirm').length,beforeExpired,'Expired private confirmation cannot call login confirm');
 // Requests emitted by the previous version still obey ownership and reset.
 const legacySubscription=()=>{const pending={id:crypto.randomUUID(),type:'subscribe',key:'group:456',senderQQ:'998',sourceEpoch:retained.waves.sourceEpoch('group:456'),expiresAt:Date.now()+180000,patch:{signEnabled:true},label:'开启自动签到'};retained.waves.pending.set(pending.id,pending);return pending;};
 const pending=legacySubscription();await retained.modelChat.reset('group:456');await assert.rejects(retained.waves.confirmation({key:'group:789',senderQQ:'998'},pending.id),/过期/);assert(!rpc.some(x=>x.route==='/v1/subscriptions'));
 const expiring=legacySubscription();expiring.expiresAt=Date.now()-1;await assert.rejects(retained.waves.confirmation({key:'group:789',senderQQ:'998'},expiring.id),/过期/);
 const racing=legacySubscription();delaySubscription=true;const mutation=retained.waves.command({key:'group:456',senderQQ:'998',requestId:crypto.randomUUID(),isCurrent:()=>true},'ww确认 '+racing.id);while(!subscriptionRelease)await tick();await retained.modelChat.reset('group:456');subscriptionRelease();await assert.rejects(mutation,/取消/);
 // Completion already passed RPC checks; revalidate its origin when queued.
 delaySubscription=false;await incoming(456,'ww登录');retained.cfg.sendDelayMs=100;
 const successBefore=loginMessages(),blocker=retained.sendToQQ('group:789','queue blocker'),queuedSuccess=retained.waves.poll();await tick();await retained.modelChat.reset('group:456');await blocker;await queuedSuccess;assert.equal(loginMessages(),successBefore,'Queued automatic-login success must retain its origin epoch');
 const queuedMutation=legacySubscription(),beforeMutation=retained.calls.sent.length;
 const mutationBlock=retained.sendToQQ('group:789','mutation queue blocker'),queuedMutationResult=incoming(456,'ww确认 '+queuedMutation.id);
 while(retained.modelChat.running.get('group:456')?.status!=='sending')await tick();await retained.modelChat.reset('group:456');await mutationBlock;await queuedMutationResult;
 assert.equal(retained.calls.sent.length,beforeMutation+1,'Native confirmation result must recheck its origin reset when queued');
}finally{await retained.close();}

const ordered=[],noticeStarted=[],waiters=[];
class QueuedBot{
 async getMessage(){return null;}
 async request(){return {status:'ok',retcode:0,data:[]};}
 async sendPrivateMessage(id,text){ordered.push({id,text,at:Date.now()});}
 async sendGroupMessage(id,text){ordered.push({id,text,at:Date.now()});if(typeof text==='string'&&text==='hold')await new Promise(r=>waiters.push(r));else if(Array.isArray(text)&&text.some(x=>x.data?.text?.includes('timeout notice')))await new Promise(()=>{});else noticeStarted.push(Date.now());}
}
const notices=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},sendDelayMs:70},globals:{SnowLumaWebSocketClient:QueuedBot,setTimeout:(fn,ms)=>setTimeout(fn,ms===15000?25:ms),clearTimeout}});
try{
 notices.wavesSettings.update({enabled:true,revision:0});
 const first=notices.sendToQQ('group:456','hold');while(!waiters.length)await tick();const notice=notices.waves.sendNotice('group:456','998','ordered notice');await tick();assert.equal(ordered.length,1,'Notice cannot overtake/overlap a held QQ send');const releasedAt=Date.now();waiters.shift()();await first;assert.equal(await notice,true);assert(noticeStarted[0]-releasedAt>=55,'Notice must honor configured pacing');
 const pausedBlock=notices.sendToQQ('group:456','hold');while(!waiters.length)await tick();const pausedNotice=notices.waves.sendNotice('group:456','998','paused notice');notices.modelChat.paused=true;waiters.shift()();await pausedBlock;assert.equal(await pausedNotice,false);notices.modelChat.paused=false;
 const revokedBlock=notices.sendToQQ('group:456','hold');while(!waiters.length)await tick();const revokedNotice=notices.waves.sendNotice('group:456','998','revoked notice');notices.cfg.allow.groups=[];waiters.shift()();await revokedBlock;assert.equal(await revokedNotice,false);
 assert.equal(notices.modelChat.history('group:456').messages.filter(x=>x.source==='waves-notice').length,1,'Only actual sent notice enters history');
 notices.cfg.allow.groups=['456'];notices.wavesClient.call=async(route)=>route==='/v1/notices'?{notices:[{id:'timeout-notice',key:'group:456',senderQQ:'998',text:'timeout notice'}]}:{};
 const beforeTimeout=ordered.length;await notices.waves.poll();assert.equal(notices.waves.noticeAttempts.at(-1).status,'failed');assert(notices.waves.health.errors.some(x=>x.phase==='notice-send'&&x.detail.includes('超时')));await notices.waves.poll();assert.equal(ordered.length,beforeTimeout+1,'Timed-out attempted notice is durably not resent');
 assert.equal(await notices.waves.sendNotice('group:456','998','queue still usable'),true,'Notice timeout must not poison the shared chain');
}finally{await notices.close();}
console.log('PASS Waves reviewed boundaries: retained login epochs/expiry/identity, reset during RPC and queued sends, actual notice ordering/pacing/revocation, binding-only private exception, true sign completion/all outputs, durable no-resend and final game guards');

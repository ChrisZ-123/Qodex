import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WavesController,WavesSettings} from '../src/waves-client.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'waves-direct-actions-'));
const settings=new WavesSettings(path.join(root,'settings.json'));
assert.equal(settings.enabled('private:111'),false,'The optional module starts disabled');
settings.update({enabled:true,revision:0});
const calls=[],deliveries=[];
let paused=false,current=true,release,delayRoute=null,sequence=0;
const scope=(key='private:111')=>({key,senderQQ:'111',messageId:'actual-message',requestId:'run-'+(++sequence),nativeCommand:true,isCurrent:()=>current});
const client={
 call:async(route,body)=>{
  calls.push({route,body});
  if(route===delayRoute)await new Promise(resolve=>release=resolve);
  if(route==='/v1/mutations/prepare')return {requestId:'mutation-'+sequence};
  if(route==='/v1/mutations/confirm')return {requestId:body.requestId,status:'running',text:'已解除你自己的鸣潮绑定与自动任务。'};
  if(route==='/v1/login/create')return {requestId:'login-'+sequence,url:'https://fixture.trycloudflare.com/l/fixture',expiresAt:new Date(Date.now()+180000).toISOString()};
  return {};
 },
 waitTask:async(s,id,{isCurrent})=>{assert(isCurrent());return {requestId:id,outputs:[{type:'text',text:'签到成功'}]};},
 cancel:async()=>{},
};
const controller=new WavesController({root,settings,client,allowed:key=>['private:111','group:1'].includes(key),paused:()=>paused,keys:()=>['private:111','group:1'],sendPrivate:async(qq,text,guard)=>{assert(guard());deliveries.push({key:'private:'+qq,text});},sendNotice:async(key,qq,text,{isCurrent})=>{assert(isCurrent());deliveries.push({key,qq,text});return true;}});
for(const key of ['private:111','group:1']){
 for(const [command,route,patch] of [
  ['ww开启自动签到','/v1/subscriptions',{signEnabled:true}],
  ['ww关闭自动签到','/v1/subscriptions',{signEnabled:false}],
  ['ww开启签到','/v1/subscriptions',{signEnabled:true}],
  ['ww关闭签到','/v1/subscriptions',{signEnabled:false}],
  ['ww开启体力提醒 200','/v1/subscriptions',{reminderEnabled:true,threshold:200}],
  ['ww关闭体力提醒','/v1/subscriptions',{reminderEnabled:false}],
  ['ww签到','/v1/mutations/confirm'],
  ['ww解绑','/v1/mutations/confirm'],
  ['ww删除绑定','/v1/mutations/confirm'],
  ['ww注销账号','/v1/mutations/confirm'],
  ['ww登录','/v1/login/create'],
  ['ww登陆','/v1/login/create'],
  ['ww绑定账号','/v1/login/create'],
 ]){
  const before=calls.length,run=scope(key);
  const result=await controller.command(run,command);
  const action=calls.slice(before).find(call=>call.route===route);
  assert(action,command+' must execute on the first message');
  assert.equal(action.body.senderQQ,'111');
  if(patch)assert.deepEqual(action.body,{senderQQ:'111',key,...patch});
  assert(!JSON.stringify(result).includes('ww确认'));
  assert.equal(controller.pending.size,0,'No user confirmation may remain pending');
  assert.equal(controller.runs.at(-1).status,route==='/v1/login/create'?'login_pending':'completed');
 }
}
assert(deliveries.some(item=>item.key==='group:1'));
assert(deliveries.some(item=>item.key==='private:111'));
const before=calls.length;
paused=true;await assert.rejects(controller.command(scope(),'ww开启自动签到'),/暂停/);paused=false;
await assert.rejects(controller.command(scope('group:2'),'ww解绑'),/未授权/);
await assert.rejects(controller.tool({...scope(),senderQQ:'222',batch:[{senderQQ:'111',messageId:'actual-message'}]},{command:'ww解绑',sourceMessageId:'actual-message'}),/真实发送者/);
assert.equal(calls.length,before,'Rejected sources must not call the service');
const run={...scope(),batch:[{senderQQ:'111',messageId:'actual-message',text:'开启鸣潮自动签到'}]};
const modelBefore=calls.filter(call=>call.route==='/v1/subscriptions').length;
const modelResult=await controller.tool(run,{command:'ww开启自动签到',sourceMessageId:'actual-message'});
assert(modelResult.content[0].text.includes('ww确认'),'Model requests require the player confirmation even when the parent scope is native');
assert.equal(calls.filter(call=>call.route==='/v1/subscriptions').length,modelBefore);
const [pendingId]=controller.pending.keys();
await assert.rejects(controller.tool(run,{command:'ww确认 '+pendingId,sourceMessageId:'actual-message'}),/模型不能代替确认/);
await controller.command(scope(),'ww确认 '+pendingId);
assert.equal(calls.filter(call=>call.route==='/v1/subscriptions').length,modelBefore+1);
await assert.rejects(controller.command(scope(),'ww确认 '+pendingId),/过期/);
await assert.rejects(controller.tool(run,{command:'ww解绑',sourceMessageId:'foreign-message'}),/真实发送者/);
for(const command of ['ww登录','ww签到','ww解绑','ww开启体力提醒 200']){
 const before=calls.length,pendingBefore=controller.pending.size;
 const response=await controller.tool({...scope(),batch:run.batch},{command,sourceMessageId:'actual-message'});
 assert(response.content[0].text.includes('ww确认'),command+' requested by a model must wait for the player');
 assert.equal(controller.pending.size,pendingBefore+1);
 assert(!calls.slice(before).some(call=>['/v1/login/create','/v1/mutations/confirm','/v1/subscriptions'].includes(call.route)),'Model tool cannot inherit native execution authority');
 const id=[...controller.pending.keys()].at(-1);
 await assert.rejects(controller.command({...scope(),senderQQ:'222'},'ww确认 '+id),/不属于你/);
 await assert.rejects(controller.command(scope('group:1'),'ww确认 '+id),/不属于你/);
 assert(controller.pending.has(id),'Rejected sender or origin does not consume the request');
}

delayRoute='/v1/mutations/prepare';
const racing=controller.command(scope(),'ww解绑');
while(!release)await new Promise(resolve=>setTimeout(resolve,5));
current=false;const acceptedBefore=calls.filter(call=>call.route==='/v1/mutations/confirm').length;release();
await assert.rejects(racing,/取消|权限/);
assert.equal(calls.filter(call=>call.route==='/v1/mutations/confirm').length,acceptedBefore,'Cancellation during prepare must prevent the operation');
current=true;release=null;delayRoute='/v1/subscriptions';
const stale=controller.command(scope(),'ww开启体力提醒');
while(!release)await new Promise(resolve=>setTimeout(resolve,5));
await controller.cancel({key:'private:111'});release();
await assert.rejects(stale,/取消|权限/);
assert(!JSON.stringify(controller.runs).includes('/l/'));
console.log('PASS native ww mutations execute once; model changes require same-origin player confirmation, model cannot confirm, cancellation and login delivery remain enforced');

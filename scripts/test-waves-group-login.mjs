import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},allow:{groups:['456','789'],private:['123']},sendDelayMs:0}});
h.wavesSettings.update({enabled:true,revision:0});
const rpc=[],tickets=new Map();
let sequence=0;
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const flattened=message=>typeof message==='string'?message:message.filter(x=>x.type==='text').map(x=>x.data.text).join('');
const links=()=>h.calls.sent.filter(x=>flattened(x.text).includes('https://fixture.trycloudflare.com/l/'));
const privateCount=()=>h.calls.sent.filter(x=>x.kind==='private').length;
const incoming=(kind,id,qq,command)=>h.handleIncoming(kind,id,{user_id:qq,message_id:crypto.randomUUID(),self_id:111,message:[{type:'text',data:{text:command}}]},h.cfg);
h.wavesClient.call=async(route,body)=>{
  rpc.push({route,body});
  if(route==='/v1/login/create'){
    const value={requestId:'login-'+(++sequence),url:'https://fixture.trycloudflare.com/l/ticket-'+sequence,expiresAt:new Date(Date.now()+180000).toISOString()};
    tickets.set(body.senderQQ,{...value,status:'sms_sent'});return value;
  }
  if(route.startsWith('/v1/login/pending?')){
    const ticket=tickets.get(new URL('http://fixture'+route).searchParams.get('senderQQ'));
    return ticket?{requestId:ticket.requestId,status:ticket.status,account:{nickname:'测试玩家',uid:'100000001'}}:{status:'none'};
  }
  if(route==='/v1/login/cancel'){
    const ticket=tickets.get(body.senderQQ);if(ticket?.requestId===body.requestId)ticket.status='cancelled';return {status:'cancelled'};
  }
  if(route==='/v1/login/confirm'){
    const ticket=tickets.get(body.senderQQ);
    if(ticket?.requestId!==body.requestId||ticket.status!=='awaiting_confirmation')throw Error('登录尚未等待本人确认');
    ticket.status='confirmed';return {account:{nickname:'测试玩家'}};
  }
  if(route==='/v1/notices')return {notices:[]};
  return {};
};
try{
  await incoming('group',456,998,'ww登录');
  assert.equal(links().length,1,'A group ww登录 sends one actual login link');
  assert.equal(links()[0].kind,'group','The login link must go to the originating group');
  assert.equal(links()[0].id,456);
  assert(links()[0].text.some(x=>x.type==='at'&&x.data.qq==='998'));
  assert.equal(privateCount(),0,'Group login must not depend on robot private messages');
  const binding=h.waves.bindings.get('998');
  await h.waves.poll();
  assert(!h.calls.sent.some(x=>flattened(x.text).includes('鸣潮登录成功')),'No success notice before a committed server result');
  const confirmations=()=>rpc.filter(x=>x.route==='/v1/login/confirm').length;
  const countBefore=confirmations();
  await incoming('group',456,999,'ww确认 '+binding.requestId);
  assert.equal(confirmations(),countBefore,'Another group member cannot bind the published login');
  assert.equal(h.waves.bindings.get('998'),binding);
  await incoming('group',789,998,'ww确认 '+binding.requestId);
  await incoming('private',998,998,'ww确认 '+binding.requestId);
  assert.equal(confirmations(),countBefore,'Another origin cannot confirm a published group link');
  assert.equal(h.waves.bindings.get('998'),binding);
  tickets.get('998').status='awaiting_confirmation';await h.waves.poll();
  const summary=h.calls.sent.find(x=>flattened(x.text).includes('请核对鸣潮账号'));
  assert.equal(summary.kind,'group');assert.equal(summary.id,456);
  assert(summary.text.some(x=>x.type==='at'&&x.data.qq==='998'));
  assert.equal(confirmations(),countBefore,'SMS completion and polling never commit a shared group login');
  assert.equal(h.waves.bindings.get('998'),binding);
  await h.waves.poll();assert.equal(h.calls.sent.filter(x=>flattened(x.text).includes('请核对鸣潮账号')).length,1,'The account summary is sent once');
  await incoming('group',456,998,'ww确认 '+binding.requestId);
  assert.equal(confirmations(),countBefore+1,'Only the original player in the original group commits login');
  assert.equal(tickets.get('998').status,'confirmed');
  assert(!h.waves.bindings.has('998'));
  await incoming('group',456,998,'ww确认 '+binding.requestId);
  assert.equal(confirmations(),countBefore+1,'A consumed confirmation cannot commit again');
  assert.equal(privateCount(),0);
  assert.equal(h.calls.prompts.length,0,'Native game login never invokes GPT');

  await Promise.all([incoming('group',456,998,'ww登录'),incoming('group',789,999,'ww登陆')]);
  const groupLinks=links().slice(-2);
  assert.deepEqual(new Set(groupLinks.map(x=>x.id)),new Set([456,789]));
  for(const item of groupLinks)assert(item.text.some(x=>x.type==='at'&&x.data.qq===(item.id===456?'998':'999')));
  tickets.get('998').status=tickets.get('999').status='awaiting_confirmation';await h.waves.poll();
  const firstId=h.waves.bindings.get('998').requestId,secondId=h.waves.bindings.get('999').requestId;
  await incoming('group',789,998,'ww确认 '+firstId);assert(h.waves.bindings.has('998'),'Other group remains unauthorized for the same QQ');
  await incoming('group',456,998,'ww确认 '+firstId);await incoming('group',789,999,'ww确认 '+secondId);assert.equal(privateCount(),0);

  // Private users still receive the flow in their own originating conversation.
  await incoming('private',123,123,'ww登录');
  assert.equal(links().at(-1).kind,'private');assert.equal(links().at(-1).id,123);
  tickets.get('123').status='awaiting_confirmation';await h.waves.poll();
  const privateId=h.waves.bindings.get('123').requestId;await incoming('private',123,123,'ww确认 '+privateId);
  assert(!h.waves.bindings.has('123'));assert.equal(tickets.get('123').status,'confirmed');assert.equal(privateCount(),4);

  // A login waiting on the real shared QQ send queue must honor origin reset.
  h.cfg.sendDelayMs=100;
  const before=links().length,previousId=h.waves.bindings.get('998')?.requestId,blocker=h.sendToQQ('group:789','queue blocker');
  const queued=incoming('group',456,998,'ww登录');
  for(let attempts=0;h.waves.bindings.get('998')?.requestId===previousId||!h.waves.bindings.get('998');attempts++){
    assert(attempts<200,'The queued login must reach link delivery');await tick();
  }
  await h.modelChat.reset('group:456');await blocker;await queued;
  assert.equal(links().length,before,'Origin reset suppresses a queued group login link');
  assert.equal(tickets.get('998').status,'cancelled','Reset must also revoke the public login ticket at the server');
  h.cfg.sendDelayMs=0;

  // Reading a copied or quoted group link must not feed its ticket back to GPT.
  const exposed='https://fixture.trycloudflare.com/l/ticket-copy';
  h.modelChat.paused=true;
  await incoming('group',456,998,'刚才的登录链接 '+exposed);
  h.setMessage('50',{group_id:456,user_id:111,sender:{nickname:'机器人',user_id:111},message:[{type:'text',data:{text:'鸣潮登录 '+exposed}}]});
  await h.handleIncoming('group',456,{user_id:998,group_id:456,message_id:'51',self_id:111,message:[{type:'reply',data:{id:'50'}},{type:'text',data:{text:'这个链接过期了吗'}}]},h.cfg);
  h.modelChat.paused=false;
  await incoming('group',456,998,'再看看链接 '+exposed);
  assert(h.calls.prompts.length);
  assert(!JSON.stringify(h.calls.prompts).includes('/l/ticket-'),'Current and quoted login tickets must not reach GPT');

  for(const key of ['group:456','group:789','private:123']){
    assert(!JSON.stringify(h.modelChat.history(key)).includes('/l/ticket-'),'Local history must not retain login tickets');
  }
  assert(!JSON.stringify(h.waves.runs).includes('/l/ticket-'));
  assert(!JSON.stringify(h.waves.health).includes('/l/ticket-'));
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
  for(const file of walk(h.temp).filter(file=>file.endsWith('.json')||file.endsWith('.jsonl'))){
    assert(!fs.readFileSync(file,'utf8').includes('/l/ticket-'),'Persisted login tickets are forbidden: '+path.relative(h.temp,file));
  }
  console.log('PASS group login delivery/mention, SMS summary without automatic binding, original QQ/origin confirmation, one-time commit, two-group isolation, private origin compatibility, queued reset, no GPT or persisted tickets');
}finally{await h.close();}

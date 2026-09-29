import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ModelChat} from '../src/model-chat.js';
import {ChatMemory} from '../src/chat-memory.js';
import {CodexApiClient} from '../src/codex-client.js';
import {GENERATED_ROOT,loadGeneratedImage,readNativeImage} from '../src/generated-images.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Zp8AAAAASUVORK5CYII=','base64');
const native={result:png.toString('base64')};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-image-test-'));
const created=[];
const output=(reply='',imagePrompt='',imageSourceMessageId=null)=>({reply,memoryOps:[],stickerIds:[],stickerNotes:[],replyTo:null,imagePrompt,imageSourceMessageId});
try{
  let nextSession=0,generate,generatedRequests=[];
  const sentText=[],sentImages=[],promptCalls=[];
  const api={sessions:{create:async()=>({result:{ok:true,value:{sessionId:'session-'+(++nextSession)}}}),prompt:async p=>{promptCalls.push(p);return {result:{ok:true}};}},stopSessionWork:async()=>{},cancelImage:async()=>{},generateImage:async p=>{generatedRequests.push(p);return generate(p);}};
  const chat=new ModelChat({dir:path.join(temp,'chat'),api,memory:new ChatMemory(path.join(temp,'memory')),allowed:()=>true,settings:()=>({model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority',imageMode:'auto',stickerStyle:'lively',style:'自然'}),persona:()=>({}),expression:()=>({style:'自然',imageMode:'auto',stickerStyle:'lively',stickers:[]}),send:async(k,t,guard)=>{assert(guard());sentText.push([k,t]);},sendImage:async(k,m,guard)=>{assert(guard());assert.equal(loadGeneratedImage(k,m).mimeType,'image/png');sentImages.push([k,m]);return {messageId:77};}});
  const receive=(key,id,extra={})=>chat.receive(key,{sender:'群友',messageId:id,text:'普通消息',...extra});
  const finish=async(session,value)=>{await chat.consume(session,{type:'assistant/message',data:{message:{content:[{type:'text',text:JSON.stringify(value)}]}}});await chat.consume(session,{type:'turn/end',data:{reason:{kind:'completed'}}});};

  let release;generate=()=>new Promise(resolve=>release=resolve);
  await receive('group:111','11',{text:'画一只猫'});
  const drawing=finish('session-1',output('','一只坐在窗边的猫'));
  await new Promise(setImmediate);
  assert.equal(generatedRequests.length,1);
  await receive('group:222','21',{text:'我有个问题'});
  await finish('session-2',output('第二群正常聊天'));
  assert.deepEqual(sentText,[['group:222','第二群正常聊天']]);
  release(native);await drawing;
  assert.equal(sentImages.length,1);assert.equal(sentImages[0][0],'group:111');
  const first=sentImages[0][1];created.push(['group:111',first]);
  assert.equal(chat.entry('group:111').images[0].status,'sent');
  assert.equal(chat.entry('group:111').messages.at(-1).imageId,first.imageId);
  assert.throws(()=>loadGeneratedImage('group:222',first));
  assert.throws(()=>loadGeneratedImage('group:111',{...first,runId:'../foreign'}),/归属|编号/);
  assert.throws(()=>readNativeImage({savedPath:path.join(temp,'foreign.png')}));

  generate=async()=>native;
  const source={type:'image',mediaType:'image/png',data:png.toString('base64')};
  await receive('group:111','12',{text:'引用刚才这张改成绿色',quotedImageMessageId:'10',quotedImages:[source]});
  assert(promptCalls.at(-1).context.imageSources.some(x=>x.messageId==='10'));
  await finish('session-1',output('','改成绿色','10'));
  assert.equal(generatedRequests.at(-1).sourceImages[0].data,source.data);
  created.push(['group:111',sentImages.at(-1)[1]]);
  const beforeCalls=generatedRequests.length;
  await receive('group:111','13',{text:'修改另一个群的图片'});
  await finish('session-1',output('','修改外群图片','999'));
  assert.equal(generatedRequests.length,beforeCalls);
  assert.equal(chat.entry('group:111').runs.at(-1).status,'sent');
  assert.match(sentText.at(-1)[1],/没能读取你引用的图片/);

  generate=()=>new Promise(resolve=>release=resolve);
  await receive('group:111','14',{text:'再画一张'});
  const cancelled=finish('session-1',output('','新图片'));
  await new Promise(setImmediate);await chat.cancel('group:111');release(native);await cancelled;
  assert.equal(sentImages.length,2);assert.equal(chat.entry('group:111').runs.at(-1).status,'cancelled');
  await receive('group:111','15',{text:'暂停前画一张'});
  const paused=finish('session-1',output('','新图片'));
  await new Promise(setImmediate);await chat.pause(true);release(native);await paused;
  assert.equal(sentImages.length,2);await chat.pause(false);

  generate=async()=>native;chat.sendImage=async()=>{throw new Error('QQ offline');};
  await receive('group:111','16',{text:'测试 QQ 发送'});await finish('session-1',output('','一朵花'));
  assert.equal(chat.entry('group:111').runs.at(-1).status,'failed');
  assert.equal(chat.entry('group:111').images.at(-1).status,'failed');created.push(['group:111',chat.entry('group:111').images.at(-1)]);
  console.log('PASS empty-text native image, reference ownership, safe files, two-group isolation, cancel/pause and QQ send failure');

  const c=Object.create(CodexApiClient.prototype);let imageNo=0;const calls=[];
  Object.assign(c,{root:temp,config:{model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority',conversationMode:'model'},records:{owned:{preset:'qq-chat-v2'}},live:new Set(['owned']),active:new Map(),queues:new Map(),frames:[],cancelled:new Set(),tools:new Map(),imageQueue:[],imageActive:null,imageJobs:new Map(),ready:Promise.resolve()});
  c.rpc={request:async(method,params)=>{calls.push([method,params]);if(method==='thread/start')return {thread:{id:'image-'+(++imageNo)}};if(method==='turn/start')return {turn:{id:'turn-'+imageNo}};return {};}};
  const one=c.generateImage({requestId:'r1',prompt:'蓝色圆形',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'});
  const two=c.generateImage({requestId:'r2',prompt:'绿色圆形',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'});
  await new Promise(setImmediate);assert.equal(imageNo,1);
  await c.prompt({sessionId:'owned',content:[{type:'text',text:'正常聊天'}]});
  assert(calls.some(([m,p])=>m==='turn/start'&&p.threadId==='owned'));
  c.notify('item/completed',{threadId:'image-1',turnId:'turn-1',item:{type:'imageGeneration',status:'completed',result:native.result}});
  c.notify('item/completed',{threadId:'image-1',turnId:'turn-1',item:{type:'imageGeneration',status:'completed',result:'second native variant'}});
  c.notify('turn/completed',{threadId:'image-1',turn:{id:'turn-1',status:'completed'}});
  assert.equal((await one).result,native.result);await new Promise(setImmediate);assert.equal(imageNo,2);
  c.notify('item/completed',{threadId:'image-2',turnId:'turn-2',item:{type:'imageGeneration',status:'completed',result:native.result}});
  c.notify('turn/completed',{threadId:'image-2',turn:{id:'turn-2',status:'completed'}});
  assert.equal((await two).result,native.result);
  assert.equal(calls.filter(([m])=>m==='thread/start').length,2);
  console.log('PASS native result routed by image thread and one-at-a-time queue leaves ordinary chat running');
}finally{
  for(const [key,m] of created){const file=path.resolve(GENERATED_ROOT,key.replace(':','-'),m.runId,m.imageId+'.'+m.extension);if(!file.startsWith(path.resolve(GENERATED_ROOT)+path.sep))throw Error('Invalid generated cleanup path');if(fs.existsSync(file))fs.unlinkSync(file);const dir=path.dirname(file);if(fs.existsSync(dir)&&!fs.readdirSync(dir).length)fs.rmdirSync(dir);}
  if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'qq-image-test-'))throw Error('Invalid temp cleanup path');fs.rmSync(temp,{recursive:true,force:true});
}

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'}},globals:{loadGeneratedImage:(key)=>{assert.equal(key,'group:456');return {bytes:png,mimeType:'image/png'};}}});
const server=h.startConsoleServer();
try{
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const imageId=crypto.randomUUID(),url='http://127.0.0.1:'+server.address().port+'/api/chat/image-preview?imageId='+imageId+'&key=';
  h.modelChat.entry('group:456').images=[{imageId,runId:crypto.randomUUID()}];
  assert.equal((await fetch(url+'group%3A456')).status,401);
  const headers={'x-console-token':'fixture-console-token'};
  assert.equal((await fetch(url+'group%3A456',{headers:{...headers,origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(url+'group%3A789',{headers})).status,404);
  const response=await fetch(url+'group%3A456',{headers});assert.equal(response.status,200);
  assert.equal((await response.json()).image.data,png.toString('base64'));
  console.log('PASS generated image preview requires console authentication and conversation ownership');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await h.close();}

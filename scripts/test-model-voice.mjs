import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transcribeModelVoices} from '../src/model-voice.js';
import {ModelChat} from '../src/model-chat.js';
import {ModelPreferences} from '../src/model-preferences.js';

const ref=(id,source='message')=>({source,sourceMessageId:id,sender:'原说话人',time:'2026-09-29T00:00:00.000Z'});
const messages=[{messageId:'101',sender:'群友',voiceRefs:[ref('101'),ref('100','quote')]}];
const calls=[];
const result=await transcribeModelVoices(messages,{fetchText:async id=>{calls.push(id);return {text:id===101?'今天能开黑吗':'昨天说过八点'};}});
assert.deepEqual(calls,[101,100]);
assert.equal(result.transcribedCount,2);
assert.equal(result.records[1].source,'quote');
assert.equal(result.records[1].sourceMessageId,'100');
assert.equal(result.records[0].text,'今天能开黑吗');
assert.equal(JSON.stringify(result).includes('audio'),false);

const partial=await transcribeModelVoices([{messageId:'201',voiceRefs:[ref('201'),ref('202'),ref('203')]}],{fetchText:async id=>{if(id===201)return {text:'  '};if(id===202)throw Error('QQ 暂无转写');return {text:'最后一条成功'};}});
assert.deepEqual(partial.records.map(r=>r.status),['empty','failed','ok']);
assert.equal(partial.records[2].text,'最后一条成功');
const capped=await transcribeModelVoices([{messageId:'300',voiceRefs:Array.from({length:7},(_,i)=>ref(String(300+i)))}],{fetchText:async()=>({text:'好'})});
assert.equal(capped.records.filter(r=>r.status==='limit').length,2);
const timed=await transcribeModelVoices([{messageId:'400',voiceRefs:[ref('400')]}],{fetchText:()=>new Promise(()=>{}),perVoiceMs:5,budgetMs:10});
assert.equal(timed.records[0].status,'timeout');
const reused=await transcribeModelVoices([{messageId:'501',voiceRefs:[ref('500','quote')]}],{fetchText:()=>{throw Error('不应再次请求');},cached:id=>id==='500'?{status:'ok',text:'缓存文字'}:null});
assert.equal(reused.records[0].cached,true);

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qbot-voice-'));
try{
  const prefs=new ModelPreferences(path.join(dir,'preferences.json'));
  const global={model:'gpt-6-luna',reasoningEffort:'max',role:false,style:'',voiceEnabled:true};
  assert.equal(prefs.effective('group:1',global).voiceEnabled,true);
  prefs.updateConversation('group:1',{voiceEnabled:false},prefs.data.revision);
  assert.equal(prefs.effective('group:1',global).voiceEnabled,false);
  assert.equal(prefs.effective('group:2',global).voiceEnabled,true);
  prefs.updateConversation('group:1',{voiceEnabled:null},prefs.data.revision);
  assert.equal(prefs.effective('group:1',global).voiceEnabled,true);
  const prompts=[];let session=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const api={sessions:{create:async()=>({result:{ok:true,value:{sessionId:'voice-'+(++session)}}}),prompt:async p=>{prompts.push(p);return {result:{ok:true}}}},stopSessionWork:async()=>{}};
  const chat=new ModelChat({dir,api,allowed:()=>true,send:async()=>{},persona:()=>({}),settings:()=>({voiceEnabled:true}),transcribeVoice:async(key,batch,current,cached)=>{
    if(key==='group:1')await gate;
    return transcribeModelVoices(batch,{fetchText:async()=>({text:'语音说的是今晚开黑'}),isCurrent:current,cached});
  }});
  const slow=chat.receive('group:1',{sender:'甲',text:'[语音]',messageId:'1',voiceRefs:[ref('1')]});
  await chat.receive('group:2',{sender:'乙',text:'普通文字',messageId:'2'});
  assert.equal(prompts.length,1,'一群慢转写不阻塞另一群');
  await chat.receive('group:1',{sender:'甲',text:'后续消息',messageId:'3'});
  assert.equal(chat.pending.get('group:1').length,1,'同群后续消息排队');
  release();await slow;
  const voicePrompt=prompts.find(p=>p.context.conversation==='group:1');
  assert.equal(JSON.parse(voicePrompt.content[0].text).messages[0].voice[0].text,'语音说的是今晚开黑');
  assert.equal(chat.history('group:1').messages.find(m=>m.messageId==='1').voice[0].status,'ok');
  assert.equal(chat.entry('group:1').runs.at(-1).voiceSuccessCount,1);

  let unlock;const delayed=new Promise(resolve=>unlock=resolve);
  chat.transcribeVoice=async()=>delayed;
  const cancelled=chat.receive('private:4',{sender:'丙',text:'[语音]',messageId:'4',voiceRefs:[ref('4')]});
  await new Promise(resolve=>setImmediate(resolve));
  await chat.cancel('private:4');
  unlock({records:[{...ref('4'),source:'message',outerMessageId:'4',status:'ok',text:'迟到结果'}],readMs:1,voiceCount:1,transcribedCount:1});
  await cancelled;
  assert.equal(prompts.some(p=>p.context.conversation==='private:4'),false,'取消后的转写不能进入模型');
  assert.equal(chat.history('private:4').messages.find(m=>m.messageId==='4').voice,undefined);

  let releaseRevoked;const revokeGate=new Promise(resolve=>releaseRevoked=resolve);
  chat.transcribeVoice=async()=>revokeGate;
  const revoked=chat.receive('group:6',{sender:'戊',text:'[语音]',messageId:'6',voiceRefs:[ref('6')]});
  await new Promise(resolve=>setImmediate(resolve));
  chat.allowed=key=>key!=='group:6';
  releaseRevoked({records:[{...ref('6'),source:'message',outerMessageId:'6',status:'ok',text:'不应写入'}],readMs:1,voiceCount:1,transcribedCount:1});
  await revoked;
  assert.equal(prompts.some(p=>p.context.conversation==='group:6'),false,'白名单撤销后不得提交转写');
  assert.equal(chat.history('group:6').messages.find(m=>m.messageId==='6').voice,undefined);

  chat.transcribeVoice=async()=>{throw Error('暂停期间不应转写');};
  await chat.pause(true,'private:5');
  await chat.receive('private:5',{sender:'丁',text:'[语音]',messageId:'5',voiceRefs:[ref('5')]});
  assert.equal(prompts.some(p=>p.context.conversation==='private:5'),false);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS voice transcription: direct/quoted, cache, partial failure, limits, timeout, queue isolation, cancel, revoke and pause');

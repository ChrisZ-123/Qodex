import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatMemory} from '../src/chat-memory.js';
import {ModelChat} from '../src/model-chat.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-test-'));
try{
 const memory=new ChatMemory(path.join(temp,'memory'));
 assert.throws(()=>memory.read('../secrets'));
 let note=memory.update('group:1',{content:'甲：喜欢简短回答。',enabled:true,revision:0});
 assert.equal(memory.read('group:2').content,'');assert.equal(memory.read('private:1').content,'');
 assert.equal(new ChatMemory(path.join(temp,'memory')).read('group:1').content,note.content);
 assert.throws(()=>memory.update('group:1',{content:'旧值',enabled:true,revision:0}),/已被更新/);
 assert.throws(()=>memory.update('group:1',{content:'api_key=sk-abcdefghijklmnopqrstuv',enabled:true,revision:1}),/凭据/);
 const calls=[],sent=[];const api={sessions:{create:async()=>({result:{ok:true,value:{sessionId:'s1'}}}),prompt:async p=>{calls.push(p);return{result:{ok:true}}}},stopSessionWork:async()=>{}};
 const chat=new ModelChat({dir:path.join(temp,'chat'),api,memory,allowed:()=>true,send:async(k,t)=>sent.push(t),persona:()=>({})});
 const receive=()=>chat.receive('group:1',{sender:'甲',text:'我喜欢咖啡',time:'now'});
 const finish=async output=>{await chat.consume('s1',{type:'assistant/message',data:{message:{content:[{type:'text',text:output}]}}});await chat.consume('s1',{type:'turn/end',data:{reason:{kind:'completed'}}});};
 await receive();assert(calls[0].outputSchema);assert.equal(calls[0].context.longTermMemory.content,note.content);
 await finish(JSON.stringify({reply:'',memory:'甲：喜欢咖啡和简短回答。'}));assert.equal(sent.length,0);assert(memory.read('group:1').content.includes('咖啡'));
 await receive();note=memory.read('group:1');memory.update('group:1',{content:'管理员纠正',enabled:true,revision:note.revision});
 await finish(JSON.stringify({reply:'知道啦',memory:'旧模型记忆'}));assert.equal(memory.read('group:1').content,'管理员纠正');assert.equal(sent[0],'知道啦');
 note=memory.read('group:1');memory.update('group:1',{...note,enabled:false});await receive();assert.equal(calls.at(-1).context.longTermMemory.content,'');
 await finish(JSON.stringify({reply:'',memory:'不允许的更新'}));assert.equal(memory.read('group:1').content,'管理员纠正');
 await receive();await finish('非 JSON 原文');assert.equal(sent.length,1);assert.equal(chat.entry('group:1').messages.at(-1).kind,'error');
 console.log('PASS memory isolation, persistence, conflicts, credential rejection, same-turn learning, disabled memory and invalid output');
}finally{if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'qq-memory-test-'))throw Error('Unexpected test folder');fs.rmSync(temp,{recursive:true,force:true});}
